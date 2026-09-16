/**
 * Merkle root computation for a space.
 *
 * The root is a SHA-256 hash over a binary Merkle tree whose leaves are:
 *   - For each fact / entity / edge / chrono document (excluding tombstones):
 *       SHA-256( "doc:<type>:<_id>:<seq>:<contentHash>" )
 *   - For each file in the space:
 *       SHA-256( "file:<relative-path>:<sha256>" )
 *
 * `contentHash` is a SHA-256 over the document's canonical JSON (keys sorted,
 * derived fields excluded — see canonicalDocHash). Hashing only `_id:seq`, as
 * this did previously, detects a missing or version-skewed document but NOT a
 * tampered one: a peer could serve altered content under the same `_id`/`seq`
 * and the roots would still agree. Files were already content-hashed; brain
 * documents now are too.
 *
 * Leaves are sorted lexicographically before tree construction so the root is
 * deterministic regardless of insertion order.
 *
 * If the space contains no documents and no files the root is the SHA-256 of
 * the empty string — a well-defined sentinel value.
 *
 * Enabled per-network via `network.merkle === true` (opt-in, advisory: a
 * mismatch is reported as MERKLE_DIVERGENCE, it does not block sync).
 */

import { createHash } from 'node:crypto';
import { col, asFilter } from '../db/mongo.js';
import { buildFileManifest } from '../files/manifest.js';
import { BRAIN_COLLECTIONS } from '../config/types-knowledge.js';
import { LOCAL_ONLY_FIELDS } from '../sync/local-only-fields.js';

// ── Internal helpers ─────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Fields excluded from the content hash.
 *
 * `embedding` (and its companions) are DERIVED from the document text by the
 * local embedding model. Two peers running different models — or different
 * versions of one — legitimately hold different vectors for identical content,
 * so including them would report divergence on every heterogeneous network.
 * The text they are derived from is hashed, which is what actually matters.
 *
 * ## The retention stamps are local in exactly the same way (W-10)
 *
 * `_expireAt` is when THIS instance will delete the record, computed from its own space policy at its own
 * write time; `_contentExpireAt` is the same for a chrono entry's content window. Neither is on any
 * `Incoming*` schema, so both are stripped on push — and while they were hashed, the sender's copy carried
 * the key and the receiver's did not, so the two roots differed **for ever on identical content**.
 *
 * The symptom was worse than a wrong number. On any network with `merkle: true`, every sync cycle logged a
 * `MERKLE_DIVERGENCE` warning for every space with a retention policy — a permanent false alarm, which
 * teaches an operator to ignore the one signal that means data really is missing. The check is advisory and
 * blocks nothing, so nothing else ever contradicted it.
 *
 * Replicating them instead is not the answer: two peers with different retention legitimately hold different
 * stamps, and shipping the sender's would let one instance decide when another deletes its data.
 *
 * **What a lapsed window leaves behind is NOT excluded.** `contentRedacted` and `contentRedactedAt` say what
 * the record IS — that it had a description and the description is gone — and they replicate. Excluding them
 * would make a redacted entry hash identically to one that still has its detail, which is real divergence
 * going unreported. The schedule is local; what it did to the record is not.
 */
/*
 * READ FROM `sync/local-only-fields.ts`, which is the same set for the same reason. `CLAUDE.md` states
 * the equivalence as a rule — a field that is hashed must replicate — so a field excluded here is exactly
 * a field ingest must drop, and two lists of one set is how one of them goes wrong.
 */
const DERIVED_FIELDS = LOCAL_ONLY_FIELDS;

/**
 * Canonical JSON of a document: keys sorted at every level, derived fields
 * dropped. Two instances holding the same document must produce byte-identical
 * output regardless of field insertion order (Mongo does not preserve it).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (DERIVED_FIELDS.has(key)) continue;
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalDocHash(doc: Record<string, unknown>): string {
  return sha256hex(JSON.stringify(canonicalize(doc)));
}

/**
 * Build a binary Merkle tree from a sorted array of leaf hashes and return the
 * root hash.
 *
 * If `leaves` is empty, returns SHA-256("") — a stable empty-tree sentinel.
 * If `leaves` has one element, that element IS the root.
 * If the number of nodes at any level is odd, the last node is duplicated
 * (standard Bitcoin/RFC-style Merkle tree convention).
 */
function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256hex('');

  let level = leaves.slice();

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // duplicate last if odd
      next.push(sha256hex(left + right));
    }
    level = next;
  }

  return level[0]!;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface MerkleResult {
  spaceId: string;
  root: string;      // hex SHA-256
  leafCount: number;
  computedAt: string; // ISO 8601
}

/** Leaf string for one brain document (exported for tests). */
export function docLeaf(collType: string, doc: Record<string, unknown>): string {
  return sha256hex(`doc:${collType}:${String(doc['_id'])}:${String(doc['seq'])}:${canonicalDocHash(doc)}`);
}

const DERIVED_PROJECTION = { embedding: 0, embeddingModel: 0, matchedText: 0, _expireAt: 0, _contentExpireAt: 0 } as const;

/**
 * What is INCLUDED from a file's metadata — and it is an inclusion projection, unlike every other collection.
 *
 * Deliberately the opposite shape, because the risk is the opposite way round. `FileMetaDoc` has thirty-odd
 * fields and all but a dozen are derived from the local blob: an exclusion list would have to name every
 * one, and the field somebody forgets is then hashed — so two instances that agree about everything anybody
 * WROTE diverge for ever over a chunk count.
 *
 * Listed inclusively, a field nobody thought about is simply not hashed. That is the safe direction here
 * precisely because `IncomingFileMetaDoc` is the other half of the rule: a field that REPLICATES and is not
 * hashed is caught by `a-replicated-field-reaches-its-incoming-schema.test.js`, which compares the two.
 *
 * **The two lists must name the same fields.** That gate is what says so.
 */
const FILE_HASH_PROJECTION = {
  _id: 1, spaceId: 1, path: 1, description: 1, descriptionSource: 1, tags: 1,
  entityIds: 1, memoryIds: 1, chronoIds: 1, properties: 1,
  suppressEmbeddings: 1,
  author: 1, createdAt: 1, updatedAt: 1, seq: 1,
} as const;
/**
 * Compute the Merkle root for a single space.
 *
 * Documents are streamed with a cursor (not `toArray`) because the content hash
 * needs the full document, and a large space would otherwise be materialised in
 * fact all at once. Embedding vectors are excluded at the projection level, so
 * the biggest field never leaves MongoDB.
 */
/**
 * What is EXCLUDED from the hash for the five document collections — the derived five.
 *
 * An EXCLUSION projection, which is the right shape here: a new AUTHORED field joins the hash on the commit
 * that declares it, and a new DERIVED one has to be added here deliberately. The reverse would make every
 * new field silently unhashed, and an unhashed replicated field is the false negative this module exists to
 * prevent.
 */
export async function computeMerkleRoot(spaceId: string): Promise<MerkleResult> {
  const leaves: string[] = [];

  /*
   * ── Brain documents ────────────────────────────────────────────────────
   *
   * ALL SIX COLLECTIONS, and `files` joined the list on the owner's `P-32` ruling — each for the same
   * reason, stated once: **a replicated document that is not hashed makes two instances holding different
   * data report themselves IDENTICAL.** `MERKLE_DIVERGENCE` is the only signal that says data really is
   * missing, and a permanent false NEGATIVE is silent for ever.
   *
   * `links` was added when a link became a record. `files` was excluded while a file's metadata did not
   * replicate — the comment here said so, and it was right at the time: the bytes were hashed from the
   * manifest below and the document was meta about a blob. `P-32` made the metadata replicate, so leaving
   * it out became exactly the false negative the paragraph above describes.
   *
   * **What is hashed for a file is the AUTHORED half only**, and the two halves fail in opposite
   * directions. Hash `sizeBytes` or the vector and two instances that agree about everything anybody wrote
   * diverge for ever over a number they each computed from their own copy of the bytes — a permanent false
   * POSITIVE, which teaches an operator to ignore the warning. Hash nothing and you get the false negative.
   */
  // DERIVED. This was the sixth place the collection names were written out, and it is no longer a SUBSET
  // of them: `files` joining the hash means every brain collection is hashed, so the list IS the tuple.
  for (const collType of BRAIN_COLLECTIONS) {
    const collName = `${spaceId}_${collType}`;
    const cursor = col<Record<string, unknown>>(collName)
      // A CHUNK never replicates: it is derived from the blob and the receiver makes its own, with its own
      // chunker and its own model. Hashed, two correct instances report divergence whenever those differ.
      .find(asFilter(collType === 'files' ? { parentFileId: { $exists: false } } : {}))
      // The same set as `DERIVED_FIELDS`, and it has to STAY the same set: this one decides what is fetched,
      // that one decides what is skipped while canonicalising. A field in only one of them is either hashed
      // when it must not be, or pulled out of MongoDB for nothing.
      // `a-replicated-field-reaches-its-incoming-schema.test.js` asserts the two agree.
      .project(collType === 'files' ? FILE_HASH_PROJECTION : DERIVED_PROJECTION);

    for await (const doc of cursor) {
      leaves.push(docLeaf(collType, doc as Record<string, unknown>));
    }
  }

  // ── File manifest ──────────────────────────────────────────────────────
  const files = await buildFileManifest(spaceId);
  for (const f of files) {
    leaves.push(sha256hex(`file:${f.path}:${f.sha256}`));
  }

  // Deterministic ordering
  leaves.sort();

  return {
    spaceId,
    root: merkleRoot(leaves),
    leafCount: leaves.length,
    computedAt: new Date().toISOString(),
  };
}
