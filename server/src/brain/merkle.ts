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
 *
 * A root may be built from leaves kept since an earlier call, per collection, while nothing has written to that
 * collection (`computeMerkleRoot`): it equals a full recompute by construction, and a gate holds it to that.
 */

import { createHash } from 'node:crypto';
import { col, asFilter } from '../db/mongo.js';
import { buildFileManifest } from '../files/manifest.js';
import { BRAIN_COLLECTIONS, type BrainCollection, type RefKind } from '../config/types-knowledge.js';
import { linkIdFor } from './link-id.js';
import { collectionStamp, joinStamps, readAtStamp, type Stamped } from '../db/space-generation.js';
import { spaceCollection } from '../db/space-collection.js';
import { LruMap } from '../util/lru-map.js';
import { LOCAL_ONLY_FIELDS } from '../sync/local-only-fields.js';
import { RETAGGED_FIELDS } from '../sync/retagged-fields.js';
import { isInstanceLocalFile } from '../sync/file-conflict.js';
import { LIVE_FILE_ROW } from '../files/live-file-row.js';
import { canonicalJsonHash } from '../util/canonical-json.js';

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
 * READ FROM `sync/local-only-fields.ts`, which is the same set for the same reason. The y-flows convention `convention-ythril-a-new-field-is-replicated-or-local-and-says-so` states
 * the equivalence as a rule — a field that is hashed must replicate — so a field excluded here is exactly
 * a field ingest must drop, and two lists of one set is how one of them goes wrong.
 *
 * ## And the fields the receiver RETAGS (`Q-307`)
 *
 * `spaceId` replicates, and every arrival is then stored under THIS instance's id for the space
 * (`sync/retagged-fields.ts`) — under a `spaceMap` alias, not the sender's. Hashed, two instances holding
 * identical data under two ids differed in every leaf, for ever: `MERKLE_DIVERGENCE` every cycle on a space
 * where nothing is wrong. It is its OWN list, never `LOCAL_ONLY_FIELDS`: the arrival writer strips those, and
 * would strip the space id from every arrival.
 */
const DERIVED_FIELDS: ReadonlySet<string> = new Set([...LOCAL_ONLY_FIELDS, ...RETAGGED_FIELDS]);

/**
 * A copy of `doc` without `fields` at its TOP LEVEL. The one spelling of "the record less its local fields": a derived field is a field of the
 * RECORD, so a key spelled like one inside `properties` (authored, free-form) is content and stays. The space hash left them out at every level until
 * Q-624, and two instances that differed in a nested `embedding`, `spaceId` or `syncBase` agreed they matched for ever.
 */
function withoutTopLevel(doc: Record<string, unknown>, fields: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !fields.has(key)));
}

/**
 * Hash of a document's canonical JSON: keys sorted at every level, derived fields dropped at the top level only. Two
 * instances holding the same document must produce byte-identical output regardless of field insertion order
 * (Mongo does not preserve it) — which is why the text is `util/canonical-json.ts`'s and nobody else's.
 */
function canonicalDocHash(doc: Record<string, unknown>): string {
  return canonicalJsonHash(withoutTopLevel(doc, DERIVED_FIELDS));
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

// Derived from DERIVED_FIELDS itself: a hand-written copy here missed `syncBase` the day it was added (Q-66).
const DERIVED_PROJECTION: Readonly<Record<string, 0>> = Object.fromEntries([...DERIVED_FIELDS].map(f => [f, 0]));


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
 *
 * Exported because the complement is the other half of the rule: every `FileMetaDoc` key NOT named here is local to
 * this instance, and `files/derived-fields.ts` derives its local-only set from this list instead of keeping a second
 * one (`Q-240`). Gates parse the declaration below from this file's source: keep its spelling, and do not write that
 * spelling anywhere above it, comments included.
 */
export const FILE_HASH_PROJECTION = {
  _id: 1, path: 1, description: 1, descriptionSource: 1, tags: 1,
  properties: 1,
  suppressEmbeddings: 1,
  author: 1, createdAt: 1, updatedAt: 1, seq: 1,
} as const;

/**
 * The hash of a file row's AUTHORED content, with chosen keys blanked — what two copies of one file row have to agree
 * on for a receiver to call them the same content.
 *
 * ## Why it lives here and not at its caller
 *
 * It is the hash's own projection, read through the hash's own canonicaliser. The equal-seq convergence (`Q-419`) has
 * to ask *"is the authored content equal, ignoring the timestamp"*, and `docLeaf` cannot answer it: that hashes `seq`
 * and the timestamp too, so two rows differing ONLY in the timestamp never compare equal through it — which is exactly
 * the pair the verdict must recognise. A caller that built its own comparison would be a second definition of "the same
 * file row", and the day the projection above gains a key the two would disagree about a divergence.
 *
 * `blank` names the keys to IGNORE rather than the keys to compare, so a key added to the projection is compared by
 * default. That is the safe direction: a new authored field makes two rows differ until somebody decides it should not,
 * where the other way round it would be silently outside every comparison.
 */
export function fileContentHash(doc: Record<string, unknown>, blank: readonly string[] = []): string {
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(FILE_HASH_PROJECTION)) {
    if (blank.includes(key)) continue;
    if (doc[key] !== undefined) projected[key] = doc[key];
  }
  return canonicalDocHash(projected);
}

/**
 * A link's document with its `_id` turned into the id its endpoints derive (`linkIdFor`) — what its leaf is taken over (Q-222).
 *
 * ## What this prevents
 *
 * A link's body IS its identity: two rows naming one relationship are one record to the hash. Hashed by the stored `_id`, a
 * relationship held under an id that does not derive (a row a peer pushed before the planner refused such ids, or one a
 * conversion left beside the derived row) and the same relationship under its derived id on another instance gave two
 * different leaves for one record, so their roots differed for ever with nothing missing on either side — a permanent false
 * alarm, which teaches an operator to ignore the signal that means data is missing.
 *
 * A delete of one id of two that name one relationship still shows: the identity is then held on one side only.
 *
 * ## And what it leaves out: the link's author and its two stamps (the second half of Q-222)
 *
 * A link has no authored content beyond its endpoints, and its `author`, `createdAt` and `updatedAt` are who made THIS row and when. A
 * relationship linked independently on two instances therefore gives each its own author and its own stamps at the one seq 1, and an
 * equal-seq link is skipped on arrival (there is nothing to converge on: the two rows say the same thing), so each instance kept its own
 * author and stamps, and with them in the leaf the roots differed for ever between two instances holding one relationship — the
 * permanent false alarm, with nothing missing. They replicate (a delete's author proof reads them) and are left out of the hash for
 * that reason alone: a field excluded from the hash is free not to agree, which is the rule's own allowance. The leaf is the
 * relationship (its derived id, endpoints and kinds) and its `seq`, which is what says one instance holds a newer version.
 *
 * Its own list, never `DERIVED_FIELDS`: those are what the arrival writer strips, and a link's author must travel.
 */
const LINK_LEAF_OMITTED_FIELDS: ReadonlySet<string> = new Set(['author', 'createdAt', 'updatedAt']);

function byRelationship(link: Record<string, unknown>): Record<string, unknown> {
  return {
    ...withoutTopLevel(link, LINK_LEAF_OMITTED_FIELDS),
    _id: linkIdFor(String(link['from']), link['fromKind'] as RefKind, String(link['to']), link['toKind'] as RefKind),
  };
}

/**
 * The sorted leaves of one record collection of a space, read in full.
 *
 * ALL SIX COLLECTIONS are hashed, and `files` joined the list on the owner's `P-32` ruling — each for the same
 * reason, stated once: **a replicated document that is not hashed makes two instances holding different data report
 * themselves IDENTICAL.** `MERKLE_DIVERGENCE` is the only signal that says data really is missing, and a permanent
 * false NEGATIVE is silent for ever. `links` was added when a link became a record; `files` when its metadata began
 * to replicate.
 *
 * **What is hashed for a file is the AUTHORED half only**, and the two halves fail in opposite directions. Hash
 * `sizeBytes` or the vector and two instances that agree about everything anybody wrote diverge for ever over a
 * number they each computed from their own copy of the bytes — a permanent false POSITIVE, which teaches an operator
 * to ignore the warning. Hash nothing and you get the false negative.
 *
 * Streamed with a cursor (not `toArray`), because the content hash needs the whole document and a large space would
 * otherwise be materialised at once; the vectors are excluded at the projection, so the largest field never leaves
 * MongoDB.
 */
async function collectionLeaves(spaceId: string, collType: BrainCollection): Promise<string[]> {
  const leaves: string[] = [];
  const cursor = col<Record<string, unknown>>(spaceCollection(spaceId, collType))
    // A CHUNK never replicates: it is derived from the blob and the receiver makes its own, with its own
    // chunker and its own model. Hashed, two correct instances report divergence whenever those differ.
    // And a row a soft delete FLAGGED is this instance's own audit record (`Q-257`): the deletion travels as a file
    // tombstone and each receiver keeps or drops its row by its own setting, so hashed, a publisher that keeps the row
    // and a receiver that removed it would report a divergence for ever between instances that hold the same data.
    .find(asFilter(collType === 'files' ? LIVE_FILE_ROW : {}))
    // The same set as `DERIVED_FIELDS`, and it has to STAY the same set: this one decides what is fetched,
    // that one decides what is skipped while canonicalising. A field in only one of them is either hashed
    // when it must not be, or pulled out of MongoDB for nothing.
    // `a-replicated-field-reaches-its-incoming-schema.test.js` asserts the two agree.
    .project(collType === 'files' ? FILE_HASH_PROJECTION : DERIVED_PROJECTION);

  for await (const doc of cursor) {
    // A file that never leaves this instance — a conflict copy, a schema snapshot, a legacy spill (Q-92) —
    // replicates in neither direction, so hashing its record reports a divergence every cycle between two
    // members that hold the same data. The predicate the peer manifest uses, imported (`Q-307`, `R8`).
    if (collType === 'files' && isInstanceLocalFile(String((doc as { _id?: unknown })._id ?? ''))) continue;
    leaves.push(docLeaf(collType, collType === 'links' ? byRelationship(doc as Record<string, unknown>) : doc as Record<string, unknown>));
  }
  return leaves.sort();
}

/**
 * The sorted lists merged into one sorted list — which is the global sort of their union, the invariant the cached
 * root rests on: leaves sorted per collection and merged give the same order as all of them sorted at once, so a
 * root built from cached leaves is the root a full recompute builds (`a-cached-merkle-root-equals-a-recompute-db`).
 * Hex digests of one length compare as plain strings, as `Array.prototype.sort` compares them.
 */
function mergeSorted(lists: readonly (readonly string[])[]): string[] {
  let out: string[] = [];
  for (const list of lists) {
    const merged: string[] = new Array(out.length + list.length);
    let i = 0, j = 0, k = 0;
    while (i < out.length && j < list.length) merged[k++] = out[i]! <= list[j]! ? out[i++]! : list[j++]!;
    while (i < out.length) merged[k++] = out[i++]!;
    while (j < list.length) merged[k++] = list[j++]!;
    out = merged;
  }
  return out;
}

/** Spaces whose leaves are kept, least recently asked for dropped first: one sync cycle asks for a handful. */
const MERKLE_CACHE_SPACES = 16;

/**
 * Leaves the cache keeps in all, across spaces (Q-336). A count of spaces alone bounds nothing: one entry holds every
 * leaf of a space, so sixteen of them was sixteen of the largest. A leaf is a 64-character one-byte string, about
 * 80 bytes on the V8 heap, and a slot of 8 bytes in its array, so about 90 bytes as measured: this many is a heap of about 45 MB,
 * and at most `MERKLE_LEAF_BYTES_CEILING` each, which is 60 MB. The cost is measured and held to that ceiling by
 * `a-merkle-leaf-costs-what-its-ceiling-says`, so the sentence cannot go stale while the numbers in it read as true.
 */
export const MERKLE_CACHE_MAX_LEAVES = 500_000;

/** What one cached leaf may cost on the heap, in bytes: the figure `MERKLE_CACHE_MAX_LEAVES` is counted in. */
export const MERKLE_LEAF_BYTES_CEILING = 120;

/** What is kept for one space: each collection's leaves at the stamp they were read at, and the last root. */
interface CachedSpace {
  collections: Map<BrainCollection, Stamped<string[]>>;
  last?: { stamps: string; files: string[]; result: MerkleResult };
}

/** The leaves an entry holds: every collection's, and the file leaves of its last root. */
function leavesHeld(entry: CachedSpace): number {
  let n = entry.last?.files.length ?? 0;
  for (const stamped of entry.collections.values()) n += stamped.value.length;
  return n;
}
const cached = new LruMap<string, CachedSpace>(MERKLE_CACHE_SPACES, undefined,
  { weigh: leavesHeld, maxWeight: MERKLE_CACHE_MAX_LEAVES });

function cacheOf(spaceId: string): CachedSpace {
  const hit = cached.get(spaceId);
  if (hit) return hit;
  const entry: CachedSpace = { collections: new Map() };
  cached.set(spaceId, entry);
  return entry;
}

/** Drop what is kept for a space — when it is deleted, so its leaves do not outlive it. */
export function forgetMerkleLeaves(spaceId: string): void {
  cached.delete(spaceId);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Compute the Merkle root for a single space — reading only what changed since the last one (`Q-107` part 4).
 *
 * It is asked on every sync cycle for every `merkle: true` space and on every peer's `GET /api/sync/merkle`, and it
 * used to stream every record of all six collections each time, whether or not one had moved. Now each collection's
 * sorted leaves are kept at the stamp they were read at (`db/space-generation.ts`: a write this process makes, or a
 * database replaced under it, moves the stamp), and a collection is read again only when its stamp moved. The file
 * manifest is built on every call — it stats every file, and its own hash cache spares re-hashing unchanged bytes —
 * and a call whose stamps and file leaves are both unchanged returns the stored root, `computedAt` included: that is
 * when THIS root was computed.
 *
 * The leaves of a collection whose stamp moved while it was read are used for this answer and not kept, so a write
 * that landed during the read is never cached away.
 */
export async function computeMerkleRoot(spaceId: string): Promise<MerkleResult> {
  const entry = cacheOf(spaceId);
  try {
    return await computeInto(spaceId, entry);
  } finally {
    // The entry grew or shrank while it was filled, and the cache weighs an entry when it is SET (Q-336). Only an
    // entry the cache still holds: one dropped meanwhile (the space deleted, or the budget) is not brought back.
    if (cached.peek(spaceId) === entry) cached.set(spaceId, entry);
  }
}

async function computeInto(spaceId: string, entry: CachedSpace): Promise<MerkleResult> {
  const parts: string[][] = [];
  const stamps: string[] = [];
  let stable = true;

  // DERIVED: every brain collection is hashed, so the list IS the tuple.
  for (const collType of BRAIN_COLLECTIONS) {
    // Kept only if nothing was written while it read — `readAtStamp`, the one spelling of that rule.
    const read = await readAtStamp(entry.collections, collType,
      () => collectionStamp(spaceId, collType), () => collectionLeaves(spaceId, collType));
    parts.push(read.value);
    if (!read.kept) stable = false;
    stamps.push(read.stamp);
  }

  // ── File manifest ──────────────────────────────────────────────────────
  // Only the files that replicate: a conflict copy or a schema snapshot is this instance's own, and the peer
  // manifest leaves it out for the same reason (`isInstanceLocalFile`).
  const files = (await buildFileManifest(spaceId))
    .filter(f => !isInstanceLocalFile(f.path))
    .map(f => sha256hex(`file:${f.path}:${f.sha256}`))
    .sort();

  const key = joinStamps(stamps);
  if (entry.last && entry.last.stamps === key && sameList(entry.last.files, files)) return entry.last.result;

  const leaves = mergeSorted([...parts, files]);
  const result: MerkleResult = {
    spaceId,
    root: merkleRoot(leaves),
    leafCount: leaves.length,
    computedAt: new Date().toISOString(),
  };
  if (stable) entry.last = { stamps: key, files, result };
  else delete entry.last;
  return result;
}
