/**
 * Shared machinery for the /api/sync sub-routers.
 *
 * Extracted when the 1713-line api/sync.ts was split by concern (A17.6): the incoming-document
 * schemas, peer/space authorisation, cursor codec, fork-depth and implausible-seq guards, and the
 * strict-linkage violation recorders. Every sub-router draws on some of this.
 */
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { col, asFilter, asDoc, asUpdate } from '../../db/mongo.js';
import { getConfig } from '../../config/loader.js';
import { reachesSpace } from '../../auth/space-reach.js';
import { isInstanceAdmin } from '../../auth/instance-admin.js';
import { REF_KINDS } from '../../config/types-knowledge.js';
import type { KnowledgeType } from '../../config/types-knowledge.js';
import { enqueueIngestedRecord } from '../../brain/embed-queue.js';
import { isWellFormedRef, collectionForRefKind, edgeEndpointKind } from '../../brain/entity-refs.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { log } from '../../util/log.js';
import { isSeqImplausible, MAX_INGEST_SEQ } from '../../util/seq.js';
import { isStrictLinkage } from '../../spaces/proxy.js';
import { LINK_CLASSES } from '../../brain/link-adjacency.js';
import type { FileMetaDoc } from '../../config/types.js';
import { emitWebhookEvent } from '../../webhooks/dispatcher.js';
import type { FactDoc, EntityDoc, EdgeDoc, LinkViolationDoc, BrainEmbedRecordType } from '../../config/types.js';

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;



/**
 * Record a link violation detected during sync ingest.
 * Fire-and-forget: violations are informational, never block sync.
 */
export async function recordLinkViolation(
  spaceId: string,
  docId: string,
  docType: LinkViolationDoc['docType'],
  field: string,
  reason: string,
  peerInstanceId: string,
): Promise<void> {
  try {
    const doc: LinkViolationDoc = {
      _id: uuidv4(),
      spaceId,
      docId,
      docType,
      field,
      reason,
      peerInstanceId,
      detectedAt: new Date().toISOString(),
    };
    await col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations')).insertOne(asDoc<LinkViolationDoc>(doc));
    emitWebhookEvent({ event: 'link_violation.created', spaceId, entry: doc as unknown as Record<string, unknown> });
  } catch (err) {
    log.error(`Failed to record link violation for ${docType} ${docId}: ${err}`);
  }
}

/**
 * Validate an edge's from/to references against strict linkage rules.
 * Records violations but never blocks the ingest.
 *
 * Each endpoint is checked against the kind it DECLARES, not against entity. This function used to test both
 * ends with its own copy of `UUID_V4_RE` and look both up in `${spaceId}_entities`, which was right while
 * every endpoint was an entity and became a false alarm generator the moment one could be a file: a
 * legitimate `to` of `photos/party.jpg` fails a UUID test and is absent from the entities collection, so every
 * such edge would be recorded as two violations. The shape rule and the collection now come from
 * `brain/entity-refs.ts`, which is the module that decides both.
 */
export async function checkEdgeLinkViolations(
  spaceId: string,
  edge: EdgeDoc,
  peerInstanceId: string,
): Promise<void> {
  if (!isStrictLinkage(spaceId)) return;

  for (const field of ['from', 'to'] as const) {
    const val = edge[field];
    const kind = edgeEndpointKind(field === 'from' ? edge.fromKind : edge.toKind);
    if (!isWellFormedRef(kind, val)) {
      await recordLinkViolation(spaceId, edge._id, 'edge', field,
        `${field} '${val}' is not a valid ${kind} reference`, peerInstanceId);
    } else {
      const coll = `${spaceId}_${collectionForRefKind(kind)}`;
      const exists = await col<{ _id: string }>(coll).findOne(asFilter<{ _id: string }>({ _id: val }));
      if (!exists) {
        await recordLinkViolation(spaceId, edge._id, 'edge', field,
          `${field} references non-existent ${kind} '${val}'`, peerInstanceId);
      }
    }
  }
}

/**
 * Record what an arriving LINK points at that is not there.
 *
 * ## What it used to check, twice over
 *
 * The first version took `entityIds` and a `docType` of `'fact' | 'chrono'` and hardcoded the field name,
 * the target collection and the UUID shape, so it saw ONE of the six link classes. The second read an
 * arriving RECORD's six arrays. 5.0 removed those arrays and links replicate as their own documents, so
 * the subject is the LINK: one arriving row, one target, one question.
 *
 * That is the shape `CLAUDE.md` names as this codebase's commonest: one rule, several implementations, and
 * **the copy that RECORDS rather than refuses is the one to check hardest** — an operator reads a link
 * violation as real damage, and reads its absence as everything being fine.
 *
 * ## It still only RECORDS
 *
 * Owner's ruling `P-21`, 2026-08-29: sync ingest is *"validated, counted, and let in"*. A peer validated
 * these records against ITS schema, and a refusal here would hold the watermark and stop the channel
 * making progress. Nothing below throws.
 *
 * ## A file id is not a UUID
 *
 * The UUID check applies to the kinds whose ids are UUIDs. A file is keyed by its space-relative path, so
 * testing it against `UUID_V4_RE` would report every legitimate `file.` reference as malformed — a violation
 * log full of correct data, which is worse than an empty one.
 *
 * ## What is still not checked, and why it is not a half-done job here
 *
 * A link whose FROM is a file. `LinkViolationDoc.docType` has no `file` member, so reporting one would
 * mean widening a STORED shape and the screen that displays it. That gap predates the link migration:
 * sync has never checked a file's links at all, for any class. Tracked as its own row rather than
 * smuggled in here — `Q-39`.
 */
export async function checkLinkViolations(
  spaceId: string,
  link: { _id: string; from: string; fromKind: string; to: string; toKind: string } | undefined,
  peerInstanceId: string,
): Promise<void> {
  if (!isStrictLinkage(spaceId) || !link) return;
  if (link.fromKind !== 'fact' && link.fromKind !== 'chrono') return;

  const field = `${link.fromKind}.${link.toKind}`;
  if (link.toKind !== 'file' && !UUID_V4_RE.test(link.to)) {
    await recordLinkViolation(spaceId, link.from, link.fromKind, field,
      `${field} contains non-UUID value '${link.to}'`, peerInstanceId);
    return;
  }
  const coll = `${spaceId}_${collectionForRefKind(link.toKind as RefKind)}`;
  const exists = await col<{ _id: string }>(coll).findOne(asFilter<{ _id: string }>({ _id: link.to }));
  if (!exists) {
    await recordLinkViolation(spaceId, link.from, link.fromKind, field,
      `${field} references non-existent ${link.toKind} '${link.to}'`, peerInstanceId);
  }
}

/**
 * Write one arriving brain document and offer it to this instance's embedder — in that order, together.
 *
 * ## Why the two are one function
 *
 * There were THIRTEEN ingest write sites in `api/sync/docs.ts`: four single-document routes, four batch
 * loops, and the fork paths, because a document arrives four ways and each type has its own conflict rules.
 * Each one wrote the document and then queued its embedding as a separate following statement, which works for
 * exactly as long as everyone writing the fourteenth remembers the second line.
 *
 * Forgetting it produces a record that is stored, listed, traversable, and absent from every meaning-ranked
 * search on that peer — with no error, no counter and nothing to grep for. That was the state of every synced
 * record before the queue call existed at all, and it went unnoticed until an operator went looking.
 *
 * So there is no way to write an arriving document without queueing it: this is the only thing in the ingest
 * router that may call `replaceOne` or `insertOne` on a brain collection, and
 * `a-receiver-embeds-by-its-own-rules.test.js` fails on any that reappears.
 *
 * ## `upsert: true`, always
 *
 * Three of the four types passed it and facts did not, which is a difference with no reason behind it: the
 * caller has already decided the incoming document should land, and `replaceOne` without upsert silently
 * writes nothing when the local copy has been deleted in the meantime. It is a `replaceOne` rather than an
 * `insertOne` even on the no-local-copy path for the same reason — the two paths differ in what they REPORT,
 * not in what the database should end up holding.
 *
 * Whether to embed is not decided here: `enqueueIngestedRecord` asks this instance's own
 * `record > schema > space` resolution, per the owner's 2026-09-01 ruling that the receiver applies its rules.
 */
export async function ingestBrainDoc<T extends { _id: string; suppressEmbeddings?: boolean;}>(
  spaceId: string,
  recordType: BrainEmbedRecordType | null,
  collection: string,
  incoming: T,
): Promise<void> {
  await col<T>(`${spaceId}_${collection}`).replaceOne(
    asFilter<T>({ _id: incoming._id }),
    asDoc<T>(incoming),
    { upsert: true },
  );
  /*
   * `null` means this record kind has NOTHING TO EMBED — not "skip the queue this time".
   *
   * A link record (`M-2`) is the first: it says one record concerns another and carries no text at all, so
   * there is no `BrainEmbedRecordType` for it and `VECTOR_INDEXED_COLLECTIONS` states in its own comment
   * why its collection must never get a vector index.
   *
   * Made an explicit argument rather than a second ingest function on purpose. This is the only thing in the
   * ingest router permitted to write a brain document, precisely so that a new ingest site cannot be written
   * without the queue — and a separate `ingestLinkDoc` would be exactly that second site. A caller that
   * embeds nothing now has to say `null` out loud, at the call, where a reviewer sees it.
   */
  if (recordType !== null) await enqueueIngestedRecord(spaceId, recordType, incoming);

  /*
   * NO LINK RECONCILE HERE ANY MORE, and it was load-bearing until 5.0.
   *
   * A document reaching us from a peer carried its six array fields and no link records — the sender might
   * be on a build that had none — so this derived them, because nothing else would: the reconcile hooks
   * live in the writer functions and this path bypasses all three by replacing the whole document.
   *
   * 5.0 removed the arrays, so an arriving record carries no links to derive and LINKS REPLICATE AS THEIR
   * OWN DOCUMENTS, through `/api/sync/links` and the `links` family in the push body. Deriving them from a
   * record would now read fields that are not there and quietly reconcile every arriving record to "no
   * links at all" — which, because the reconcile REPLACES a named class, would delete the very rows that
   * arrived beside it.
   */
}

// ── Safety limits ─────────────────────────────────────────────────────────

/**
 * Upper bound on any seq value accepted from a remote peer.
 * Prevents an attacker from submitting seq = Number.MAX_SAFE_INTEGER (9007199254740991)
 * to permanently poison the high-water mark, causing all future legitimate
 * writes by other peers to be silently ignored.
 *
 * 2^50 ≈ 1.1 quadrillion — larger than any realistic counter, but safely
 * below MAX_SAFE_INTEGER so that nextSeq() arithmetic stays in safe range.
 */
export const MAX_SYNC_SEQ = 2 ** 50; // 1_125_899_906_842_624

/**
 * Maximum chain depth for forkOf links.
 * Prevents a "fork chain bomb" where an attacker creates A→B→C→...
 * by repeatedly submitting equal-seq docs with different content.
 *
 * Two independent checks enforce this:
 *  1. Chain depth: walk forkOf pointers upward — caps nested chains.
 *  2. Sibling fan-out: count existing forks of the same parent — caps
 *     repeated same-seq attacks against one document.
 */
export const MAX_FORK_DEPTH = 10;

// ── Incoming document schemas (Zod validation for peer-submitted docs) ─────

import type { RefKind } from '../../config/types-knowledge.js';
import { CHRONO_STATUSES } from '../../config/types.js';
import { validateEntity, validateEdge, validateChrono, validateFact, getSpaceMeta, type SchemaViolation }
  from '../../spaces/schema-validation.js';
import { spaceCollection } from '../../db/space-collection.js';

export const AuthorRefSchema = z.object({
  instanceId: z.string().min(1),
  instanceLabel: z.string().min(1),
});

export const IncomingFactDoc = z.object({
  _id: z.string().min(1),
  /*
   * A fact's TYPE, which was hashed by the divergence check and stripped on push — found by deriving the
   * rule from `merkle.ts` rather than from a list kept by hand, 2026-09-01.
   *
   * Not cosmetic: the type is what selects the fact's type schema, so a fact arriving without it is
   * validated against nothing on the receiver, misses every type filter, and hashes differently from the
   * sender's copy for ever. Optional, because a fact is not required to have one.
   */
  type: z.string().optional(),
  /*
   * The RECORD tier of suppression, and it has to cross the wire for the rest of the rule to work.
   *
   * Suppression resolves `record > schema > space`. The schema and space tiers are the RECEIVER's and always
   * were — read from its own configuration — which is most of what the owner's 2026-09-01 ruling asks for:
   * *"on transfer the receiver applies its rules."* The record tier is a field on the document, so it reaches
   * the receiver only if declared here, and it was not.
   *
   * Stripped, the rule would be half-implemented in the worst direction: an author marks one record "never
   * embed this", it syncs, the receiver finds no mark and embeds it — so a record deliberately kept out of
   * meaning-ranked search enters one on every peer. That is not the receiver applying its rules; it is the
   * receiver being denied a fact it needs.
   *
   * BOTH spellings, because a peer sends whichever its build knows and the resolver reads them together.
   * Optional, because absent means included — and requiring a field here is exactly how every suppressed
   * fact came to be dropped from its batch in silence.
   */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  fact: z.string(),
  tags: z.array(z.string()).max(100),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  forkOf: z.string().optional(),
});

/**
 * A file's METADATA as a peer sends it — the AUTHORED half, and nothing the receiver can work out itself.
 *
 * ## Why this schema is so much narrower than the document
 *
 * `FileMetaDoc` holds three different kinds of field and only one of them may cross a wire:
 *
  *   - **AUTHORED** — somebody decided these. They are here.
  *   - **DERIVED FROM THE LOCAL BLOB** — `sizeBytes`, `sha256`, `excerpt`, `embedding`, `chunkCount`,
  *     `embeddingStatus`, `conversionError`, `convertedFileId`, `mediaType`. The receiver computed these
  *     from bytes it already holds, and a sender's copy of them is a claim about a different disk.
  *   - **CHUNK-ONLY** — `parentFileId`, `chunkIndex`, `content`, `faceEntityId`. Those are on records that
  *     must not travel AT ALL, which is what `parentFileId` refuses below.
 *
 * ## `parentFileId` is refused rather than stripped
 *
 * Zod strips an undeclared key silently, which is the right behaviour for a field a peer should not have
 * sent and the wrong one here: a stripped `parentFileId` turns a CHUNK into a file. It would arrive as a
 * document whose `_id` is `notes/spec.md#0`, carrying another instance's passage text, and every file list
 * in the product would show it as a file.
 *
 * A chunk is derived from the blob and the receiver makes its own. Refusing is the only reading that says
 * so.
 */
export const IncomingFileMetaDoc = z.object({
  // The path IS the id. Both are carried, as the document does.
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
  descriptionSource: z.enum(['generated', 'extracted']).optional(),
  tags: z.array(z.string()).max(100),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  /**
   * Present on a CHUNK and never on a file, so it is the discriminator — and it is `never()` rather than
   * absent from the schema, because zod strips what it does not declare and a stripped `parentFileId` turns
   * a chunk into a file.
   */
  parentFileId: z.never().optional(),
}).strict();

/**
 * Write an arriving file's metadata — a `$set` of the authored keys, NOT a whole-document replace.
 *
 * ## The one collection that cannot be replaced
 *
 * Every other brain collection ingests through `ingestBrainDoc`, which replaces the document. A file meta
 * record cannot: the receiver derived `sizeBytes`, `sha256`, `excerpt`, the vector and the chunk count from
 * bytes it holds, and a replace would leave the file reporting the SENDER's size and hash with no vector at
 * all — findable by neither its own text nor its own name, with nothing having failed.
 *
 * ## `$set`, never `$unset`
 *
 * A key the sender omits is left alone. A peer on an older build sends fewer fields, and reading absence as
 * deletion would let it erase a description it has never heard of — the same rule the PATCH doors follow,
 * for the same reason.
 *
 * ## Embedding is enqueued only when this instance HAS the bytes
 *
 * A file whose metadata arrives before its blob has nothing to embed yet, and queueing it would put a
 * failed job in front of an operator for every file on a first sync. The file transfer path calls
 * `upsertFileMeta` when the bytes land, which enqueues — so the work happens either way, once, at the
 * moment there is something to do.
 */
export async function ingestFileMeta(spaceId: string, incoming: z.infer<typeof IncomingFileMetaDoc>): Promise<void> {
  const $set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== undefined) $set[k] = v;
  }

  const existing = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .findOne(asFilter<FileMetaDoc>({ _id: incoming._id }), { projection: { sha256: 1, sizeBytes: 1 } });

  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
    asFilter<FileMetaDoc>({ _id: incoming._id }),
    asUpdate<FileMetaDoc>({ $set }),
    { upsert: true },
  );

  const haveBytes = existing?.sha256 !== undefined || existing?.sizeBytes !== undefined;
  if (haveBytes) await enqueueIngestedRecord(spaceId, 'file', incoming);
}
/**
 * Apply a whole PAGE of arriving file metadata — the pull side, using the same merge as the push side.
 *
 * ## Why the pull path cannot use the engine's bulk write
 *
 * Every other collection applies a page as a `bulkWrite` of `replaceOne`. A file meta record cannot: the
 * receiver derived `sizeBytes`, `sha256`, the excerpt, the vector and the chunk count from bytes it holds,
 * and a replace would leave the file reporting the SENDER's size and hash with no vector at all — findable
 * by neither its own text nor its own name, with nothing having failed.
 *
 * Here rather than in the engine so PUSH and PULL share one implementation. Two copies of a merge rule with
 * the weaker winning silently is the shape this codebase produces most, and the weaker one would be
 * whichever direction nobody tested.
 *
 * ## A chunk arriving is skipped, not stored
 *
 * One means a peer on a build that sends them, or a corrupt page. Stored, it would appear in every file
 * list as a FILE — an id ending in `#0`, carrying another instance's passage text.
 */
export async function applyFileMetaPage(
  spaceId: string, docs: readonly (z.infer<typeof IncomingFileMetaDoc> & { parentFileId?: string })[],
): Promise<void> {
  for (const doc of docs) {
    if (doc.parentFileId !== undefined) continue;
    await ingestFileMeta(spaceId, doc);
  }
}

export const IncomingEntityDoc = z.object({
  _id: z.string().min(1),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  tags: z.array(z.string()).max(100),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

/**
 * The kinds an edge endpoint may declare, built from `REF_KINDS` rather than spelled out here.
 *
 * Written out, this would be the second list of the same four strings, and it would go stale the moment a
 * fifth kind is added — a valid enum refusing a kind the database happily stores, on the push door only.
 */
const RefKindSchema = z.enum(REF_KINDS);

export const IncomingEdgeDoc = z.object({
  _id: z.string().min(1),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /**
   * Declared in the same commit that put them on `EdgeDoc`, and that is the whole point of them being here.
   *
   * This object strips what it does not name. A field added to a replicated document and not added here is
   * kept when the record arrives by PULL and deleted when the same record arrives by PUSH — same version, one
   * direction, no error and no statistic. So an edge that says its `to` is a chrono event would reach half the
   * network meaning "an entity with that id", and the half that got the stripped copy would go looking in the
   * wrong collection.
   *
   * Optional, matching the document: absent means entity, on the wire exactly as in the database.
   */
  fromKind: RefKindSchema.optional(),
  toKind: RefKindSchema.optional(),
  label: z.string(),
  type: z.string().optional(),
  weight: z.number().optional(),
  tags: z.array(z.string()).max(100).default([]),
  description: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

/**
 * A link record on the wire.
 *
 * Short because a link IS short: two endpoints, their kinds, and the bookkeeping every replicated document
 * carries. What is missing is the point — no label, no type, no weight, no properties, no tags, no
 * description, and no suppression marks, because a record with nothing to embed needs no way to say so.
 *
 * **Both kinds are REQUIRED here, where an edge's are optional.** An edge's absent kind means `entity`,
 * which every edge in every existing space is. A link has no such default: three of the six classes have a
 * non-entity at each end, so absent would mean "unknown" — and an unknown endpoint kind is a link nothing
 * can resolve. There is no legacy link on any wire to be lenient towards, because this schema and the
 * document arrive together.
 *
 * **Every field of `LinkDoc` is here, and that is not a courtesy.** `brain/merkle.ts` hashes every field
 * except the five in `DERIVED_FIELDS`, a link has none of those, so every field of a link is hashed — and a
 * hashed field that does not replicate makes the sender's copy carry a key the receiver's lacks. The two
 * roots then differ for ever on identical data, and every cycle logs a `MERKLE_DIVERGENCE` for a space
 * where nothing is wrong. `a-replicated-field-reaches-its-incoming-schema.test.js` derives that rule from
 * `merkle.ts` rather than keeping a list.
 */
export const IncomingLinkDoc = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  from: z.string().min(1),
  fromKind: RefKindSchema,
  to: z.string().min(1),
  toKind: RefKindSchema,
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

export const IncomingChronoDoc = z.object({
  _id: z.string().min(1),
  /*
   * The content-redaction marks. Their whole purpose is to let a reader tell *"this entry never had a
   * description"* from *"it had one, and its retention window lapsed"* — and stripping them on push destroys
   * exactly that distinction on the receiving side, where the description is already gone.
   *
   * The retention STAMP that drives them (`_contentExpireAt`) deliberately does not travel: like `_expireAt`,
   * it is computed from each instance's own policy, and shipping it would let one peer dictate when another
   * deletes its data. It was nonetheless hashed, which is what `W-10` was; both stamps are now in
   * `DERIVED_FIELDS` and excluded, so a local retention schedule no longer moves the space's hash.
   */
  contentRedacted: z.boolean().optional(),
  contentRedactedAt: z.string().optional(),
  /** See `IncomingFactDoc`: the record tier of suppression, which the receiver needs in order to honour it. */
  suppressEmbeddings: z.boolean().optional(),
  superseded: z.boolean().optional(),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  // THE ONE TUPLE. This spelled the five names itself — a copy on the INGEST path, where a peer's chrono
  // entry is validated, so a list two words wrong here would refuse a status the rest of the product
  // accepts and hold the sync watermark on it (`Q-6`, 2026-09-07).
  status: z.enum(CHRONO_STATUSES),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).max(100).default([]),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  recurrence: z.object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive(),
    until: z.string().optional(),
  }).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

// ── Paginated cursor helpers ─────────────────────────────────────────────────

export function encodeCursor(seq: number): string {
  return Buffer.from(String(seq)).toString('base64url');
}
export function decodeCursor(token: string): number {
  try { return parseInt(Buffer.from(token, 'base64url').toString(), 10) || 0; }
  catch { return 0; }
}

// ── Space access guard ─────────────────────────────────────────────────────

/**
 * Walk the forkOf chain upward from a document to measure how deep
 * this fork is in the chain.  Returns 0 for a root document.
 *
 * Uses a visited set to break any hypothetical cycle in O(depth) time.
 * Hard-caps the walk at MAX_FORK_DEPTH + 1 to avoid slow queries on
 * corrupted data.
 */
export async function forkChainDepth(spaceId: string, docId: string | undefined): Promise<number> {
  if (!docId) return 0;
  const coll = col<FactDoc>(spaceCollection(spaceId, 'facts'));
  const visited = new Set<string>();
  let depth = 0;
  let currentId: string | undefined = docId;

  while (currentId && depth <= MAX_FORK_DEPTH) {
    if (visited.has(currentId)) break; // cycle guard
    visited.add(currentId);
    const doc = await coll.findOne(asFilter<FactDoc>({ _id: currentId })) as FactDoc | null;
    if (!doc?.forkOf) break;
    depth++;
    currentId = doc.forkOf;
  }
  return depth;
}

/**
 * Refuse a document whose `seq` is implausibly far ahead of the space counter
 * (see util/seq.ts — MAX_INGEST_SEQ). Responds 400 and returns true when rejected.
 */
export function rejectImplausibleSeq(
  spaceId: string,
  seq: number,
  res: import('express').Response,
  peerInstanceId?: string,
): boolean {
  if (!isSeqImplausible(seq)) return false;
  log.warn(
    `Refused document with implausible seq ${seq} for space '${spaceId}' ` +
    `from peer '${peerInstanceId ?? 'unknown'}' (max ingest seq ${MAX_INGEST_SEQ}).`,
  );
  res.status(400).json({ error: `seq ${seq} is too close to the protocol ceiling and was refused` });
  return true;
}

/** The peer identity bound to a production peer PAT (set by the invite handshake). */
export function callerPeerId(authToken: Record<string, unknown> | undefined): string | undefined {
  const v = authToken?.['peerInstanceId'];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Networks (local view) in which `peerInstanceId` is a member.
 *
 * An EMPTY result means the token is bound to a peer we do not list as a member
 * anywhere. That happens for manually-provisioned peer tokens and for
 * single-side-configured (asymmetric) networks, where the sender holds the
 * network config and we do not. Those callers fall back to plain token-space
 * scoping — see spaceAllowed.
 */
export function peerMemberNetworks(peerInstanceId: string) {
  return getConfig().networks.filter(n => n.members.some(m => m.instanceId === peerInstanceId));
}

/**
 * Does this token's own scope reach `spaceId`? **The matrix, and nothing else** — no matrix, no reach.
 *
 * This line read *"the matrix first, the legacy allowlist only as a fallback"* while the section further
 * down explained that the fallback is gone. One docblock, two answers, and the summary is the half a reader
 * skimming for the shape of the function actually takes away.
 *
 * ## This closes a hole, it does not tidy one
 *
 * `spaceAllowed` used to take the legacy `spaces` array as a separate parameter and open with
 * `if (tokenSpaces && !tokenSpaces.includes(spaceId)) return false`. Read that guard against a token minted
 * today: the rights editor writes `rights.perSpace` and NOTHING writes `spaces` — the owner's ruling was
 * *"only matrix from now on"*, `createToken` stores `spaces: opts.spaces` verbatim, and the mint route's own
 * refusal map tells a caller to use `rights.perSpace` instead. So `tokenSpaces` is `undefined` on a modern
 * token, the `&&` short-circuits, and the token-level check never runs.
 *
 * What is downstream of it is not a second line of defence. With no `networkId` in the query the function
 * ends at *"does this space exist?"* — so every `/api/sync/*` GET, all behind plain `requireAuth`, answered
 * for ANY space to ANY token whose reach lives only in the matrix. Writes were never exposed
 * (`isNonPeerSyncWrite` admits only peers and instance admins), so this was a read gap, and it is the exact
 * defect class this repo produces most: one rule, two implementations, and the weaker one silently reachable.
 *
 * ## Why the legacy fallback is GONE
 *
 * The heading here read *"why the legacy fallback stays for now"* while everything under it explained that
 * it does not — the sentence that was true when the branch existed, left standing over the paragraph that
 * removed it. A reader skimming headings got the opposite of the behaviour.
 *
 * **NO MATRIX MEANS NO REACH.** Owner, 2026-09-05: *"no matrix = refuse - no fallback no backwards
 * compatibility anymore"*.
 *
 * This fell back to the pre-3.0 `spaces` allowlist and read an ABSENT one as unrestricted —
 * `return !legacy || legacy.includes(spaceId)`. So a token carrying neither a matrix nor an allowlist
 * reached every space on the instance. That is the absent-means-permission shape this codebase has
 * shipped three times as an empty allowlist read as "unrestricted", arriving once more.
 *
 * The branch's own comment said dropping it *"would REFUSE those tokens rather than widen them, which is
 * the safe direction but still an outage. It goes with the field itself in D-8d."* D-8d happened in 3.1:
 * `spaces` left `TokenRecord`, and there is no token shape left that this refuses —
 *
 *  - a PAT gets a matrix from `createToken` (`opts.rights ?? migrateToken(…)`);
 *  - one predating the matrix gets it from `migrateTokenRightsOnBoot`, in memory, on every start;
 *  - an OIDC session carries `rights` as a REQUIRED field, derived per request from its claim mapping.
 *
 * So the branch was unreachable AND failed open, which is the worse of the two ways to be unreachable:
 * nothing exercises it, and anything that ever did would be handed the whole instance.
 */
export function tokenReachesSpace(authToken: Record<string, unknown> | undefined, spaceId: string): boolean {
  const rights = authToken?.['rights'] as TokenRights | undefined;
  if (!rights) return false;
  return reachesSpace(rights, spaceId);
}

/**
 * Returns true if the caller may touch `spaceId` (optionally within `networkId`).
 *
 * Checks, in order:
 *  1. Token space scope (a space-scoped token may only touch its own spaces).
 *  2. **Network membership** — a peer-bound token may only reach spaces shared
 *     through a network that peer is actually a member of. Space scope alone is
 *     not enough: two networks with overlapping spaces but disjoint membership
 *     would otherwise leak into each other (a peer of network X reading a space
 *     that X and Y both carry, while being no member of Y).
 *  3. The space is actually shared by that network.
 *
 * Local/admin tokens (no `peerInstanceId`) keep the previous behaviour — they
 * are this instance's own credentials, not a remote peer's.
 */
export function spaceAllowed(
  spaceId: string,
  networkId: string | undefined,
  authToken?: Record<string, unknown>,
): boolean {
  const cfg = getConfig();
  // Enforce token-level space scope before any network check.
  if (!tokenReachesSpace(authToken, spaceId)) return false;

  const peerId = callerPeerId(authToken);
  if (peerId) {
    const memberNets = peerMemberNetworks(peerId);
    if (memberNets.length > 0) {
      // A known peer: it may only reach spaces via networks it belongs to.
      const usable = networkId
        ? memberNets.filter(n => n.id === networkId)
        : memberNets;
      return usable.some(n => n.spaces.includes(spaceId));
    }
    // A peer whose join is still being voted on (or was denied) holds a
    // provisioned PAT but no membership — it must NOT fall through to plain
    // space scoping, or the vote hold would be meaningless (S9). A passed
    // round implies membership, which is handled above.
    const heldByJoinRound = cfg.networks.some(n =>
      n.pendingRounds?.some(r =>
        r.type === 'join' && r.subjectInstanceId === peerId && !r.passed));
    if (heldByJoinRound) return false;
    // Unknown peer (manual token / asymmetric network): fall through to the
    // legacy space-existence check below — the token's own scope still applies.
  }

  // If no networkId given, allow any known space
  if (!networkId) return cfg.spaces.some(s => s.id === spaceId);
  const net = cfg.networks.find(n => n.id === networkId);
  // networkId not found locally — fall back to checking the space exists.
  // This handles asymmetric networks where the caller has the network config
  // but the recipient does not (e.g. single-side configured networks).
  if (!net) return cfg.spaces.some(s => s.id === spaceId);
  return net.spaces.includes(spaceId);
}

/**
 * S10: the sync data-write surface is for peers. A write must be presented by
 * a server-issued peer token (`peerInstanceId`, set by the invite handshake or
 * minted explicitly via POST /api/tokens) or by an admin token — the local
 * operator, who could write through the regular REST API anyway. Space-scoped
 * user PATs are refused: unlike the REST API (which assigns seq/_id/author
 * server-side), sync writes carry raw sync metadata, so accepting them would
 * let any user-PAT holder forge stream state — e.g. a downstream operator in
 * a directional network pushing content upstream with a leaked upstream PAT,
 * defeating the documented one-way flow.
 *
 * Returns true if the write must be REJECTED (403).
 *
 * ## The admin half asks the matrix (D-8d)
 *
 * This read `authToken['admin']` — bracket notation, which is exactly why it survived the audit that moved
 * every other instance-admin check onto `isInstanceAdmin`. A `git grep` for `record.admin` / `.admin` in
 * dotted form does not match it, so the sweep reported clean while this one kept reading a field that was
 * being deleted.
 *
 * The consequence was not subtle and was not a 403 anybody would have puzzled over: with the field gone,
 * every admin token became a non-peer here, and the whole sync WRITE surface refused it. CI caught it as
 * fifty-one failures in brain CRUD, because the integration suite seeds records through this endpoint.
 */
export function isNonPeerSyncWrite(authToken: Record<string, unknown> | undefined): boolean {
  if (authToken && isInstanceAdmin(authToken as { admin?: boolean; rights?: TokenRights | null })) return false;
  return !callerPeerId(authToken);
}

export const NON_PEER_WRITE_MESSAGE =
  'Sync writes require a peer token (peerInstanceId) or an admin token — use the regular REST API for user writes';

/**
 * For directional networks (braintree, pubsub), reject inbound writes from
 * members whose direction is 'push'. Direction is stored from THIS instance's
 * perspective:
 *   direction='push'  → we push TO them → they must NOT push to us
 *   direction='pull'  → we pull FROM them → they may push to us (data source)
 *   direction='both'  → bidirectional → accept
 *
 * Enforcement is against an IDENTIFIED member and derived from THIS instance's
 * own membership records covering the TARGET SPACE — never from the caller-
 * supplied `networkId` query param, which a push-only peer could previously
 * simply omit (or point at a non-directional network sharing the space) to
 * slip past the guard. The write is space-level, so it is allowed only when
 * at least one of the caller's network relationships carrying that space
 * permits inbound flow (direction pull/both, or a non-directional type).
 *
 * A token with NO `peerInstanceId` never reaches this check on the write
 * endpoints (isNonPeerSyncWrite gates first); a peer that is a member of no
 * local network carrying the space is governed by token space scope and the
 * pending-join hold in spaceAllowed (braintree receivers legitimately do not
 * list their parent as a member).
 *
 * Returns true if the write should be REJECTED (403).
 */
export function isDirectionalWriteBlocked(spaceId: string, authToken: Record<string, unknown> | undefined): boolean {
  const peerInstanceId = callerPeerId(authToken);
  if (!peerInstanceId) return false;
  const nets = peerMemberNetworks(peerInstanceId).filter(n => n.spaces.includes(spaceId));
  if (nets.length === 0) return false;
  return !nets.some(n => {
    if (n.type !== 'braintree' && n.type !== 'pubsub') return true;
    const member = n.members.find(m => m.instanceId === peerInstanceId);
    // direction='push' means WE push to THEM — they should not be writing to us
    return member ? member.direction !== 'push' : false;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/facts?spaceId=&networkId=&sinceSeq=&limit=&cursor=&full=
 * Returns paginated stubs by default.  Add ?full=true to return complete docs
 * in a single pass (eliminates the N per-document fetches on the pull side).
 */

/**
 * Validate an incoming record against the LOCAL space's schema, and never refuse it.
 *
 * ## Why sync validates at all, and why it does not refuse
 *
 * Owner's ruling, 2026-08-29 (P-21 = C): import, restore and sync **check, let everything in, and hand back a
 * list of what broke the rules**. Refusing is the option that hurts most here — a peer validated these records
 * against ITS schema, which may differ from yours, so a refusal discards data the sender believes it delivered
 * and no operator asked for that.
 *
 * ## What it replaces
 *
 * Across the five ingest paths in `docs.ts` there was exactly ONE validation check: the chrono type allowlist,
 * on the single-record path, which returned a 400. `batch-upsert` — the path a real peer uses, because that is
 * how a sync cycle ships more than one record — checked nothing at all. So the only check lived where the
 * traffic is not, and it did the one thing the ruling says not to do.
 *
 * ## The count is the point
 *
 * The ruling's stated cost was that a report nobody reads is the do-nothing option with extra steps, so this
 * returns violations to the caller rather than writing a log line. `batch-upsert` carries them in its per-type
 * stats; the single-record routes return them beside the stored document — all four of them, which the first
 * pass claimed in this docblock while implementing only `/chrono`. See `withSchemaViolations`.
 */
export function violationsAgainstLocalSchema(
  spaceId: string,
  kind: KnowledgeType,
  doc: Record<string, unknown>,
): SchemaViolation[] {
  const meta = getSpaceMeta(spaceId);
  if (!meta) return [];
  const properties = doc['properties'] as Record<string, unknown> | undefined;
  const tags = Array.isArray(doc['tags']) ? doc['tags'] as string[] : undefined;
  const type = typeof doc['type'] === 'string' ? doc['type'] : undefined;
  switch (kind) {
    case 'entity':
      return validateEntity(meta, { name: doc['name'] as string, type, properties });
    case 'edge':
      return validateEdge(meta, { label: doc['label'] as string, properties });
    case 'chrono':
      return validateChrono(meta, { type, properties });
    case 'fact':
      return validateFact(meta, { type, properties });
  }
}

/**
 * Attach the violations to a single-record ingest response — the one spelling of that rule.
 *
 * ## Why this is a function and not four inline spreads
 *
 * It was four inline spreads, and only one of them was written. `/chrono` carried
 * `...(v.length > 0 ? { schemaViolations: v } : {})` while `/facts`, `/entities` and `/edges` stored the
 * peer's record and answered `{ status: 'ok' }` with nothing computed at all — so a peer shipping records one
 * at a time got silent acceptance while the same records through `batch-upsert` were counted. One rule, two
 * implementations, the weaker one winning silently, which `CLAUDE.md` names as the defect this repo produces
 * most. The docblock above even asserted the plural.
 *
 * **Absent when empty, deliberately.** A clean ingest keeps its existing response byte for byte, so nothing a
 * peer already parses changes and `schemaViolations` present always means something to look at.
 */
/**
 * Is this write failure ONLY duplicate-key rejections — the shape two peers produce independently?
 *
 * ## The stall it removes
 *
 * A new edge gets a random `uuidv4()` id, and a space carries a UNIQUE index on `{ from, to, label }`. So when
 * two peers create the same relationship independently there is one triplet under two ids, and the receiver's
 * upsert — keyed on the unknown `_id` — inserts and hits that index.
 *
 * The PULL side was fixed: `sync/engine.ts` writes with `ordered: false` and absorbs 11000. **The push side
 * was not**, and it is the worse half. `POST /api/sync/edges` and the batch loop let E11000 reach the route's
 * catch, which answers `500`; on the sender, a non-ok push `break`s without advancing `seqCursor`, and
 * `resolveWatermark` then caps the watermark at the last batch that DID land. The next cycle re-selects the
 * same batch and fails identically — **the edges channel to that peer stops making progress permanently**,
 * which is precisely the wedge the pull fix was written to remove.
 *
 * ## Only duplicates, deliberately
 *
 * Any other write fault still throws. Swallowing those would hide genuine corruption, which is the opposite
 * defect and the harder one to find later — the same reasoning the pull side records.
 *
 * Both shapes, because both reach here: a single `replaceOne` rejects with `code: 11000` directly, while a
 * `bulkWrite` collects them into `writeErrors` and the top-level error carries no code at all. A predicate
 * that knew only one of the two would return false for the other and re-throw the very thing it exists to
 * absorb.
 */
export function isDuplicateKeyOnly(err: unknown): boolean {
  const e = err as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
  const writeErrors = e?.writeErrors;
  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    return writeErrors.every(w => (w.code ?? w.err?.code) === 11000);
  }
  return e?.code === 11000;
}

export function withSchemaViolations<T extends Record<string, unknown>>(
  body: T,
  violations: SchemaViolation[],
): T & { schemaViolations?: SchemaViolation[] } {
  return violations.length > 0 ? { ...body, schemaViolations: violations } : body;
}
