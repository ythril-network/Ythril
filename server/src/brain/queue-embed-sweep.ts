/**
 * Which records of a space to queue for embedding — the one walk a reindex and a backfill share.
 *
 * ## Why this is a module
 *
 * A backfill (`reembed.ts`) queues every record with no vector; a reindex (`reindex.ts`) queues every record. Until
 * Q-99 part 2 the reindex did not queue at all: it ran five hand-written loops of its own, each with its own
 * projection and its own call to an embed-text builder, and the copy had drifted from the one the queue uses. An
 * edge's projection dropped its endpoint kinds, so a fact or file end embedded its raw id; a file's dropped
 * `excerpt`, so every converted document re-embedded without its own text; and derived records (passages, captions)
 * were never rebuilt at all. One walk, one text builder (`buildEmbedText`), and the drift has nowhere to live.
 *
 * ## What it holds so neither caller can drop it
 *
 *  - **Suppression, in the QUERY.** A suppressed record matches "has no vector" by construction, so a sweep that
 *    skipped them in a loop over `find(...).limit(n)` returned the same suppressed page on every call and never
 *    reached the records behind it. One rule serves both callers: skip a suppressed record unless it still holds a
 *    vector to remove. For a backfill that is every suppressed record; for a reindex it is the suppressed ones a
 *    toggle left a vector on, which the worker then removes.
 *  - **Textless derived records.** A face chunk or a converted copy has no text, the worker leaves it vectorless,
 *    and a backfill that queued it would queue it again on every call for ever. `derivedHasText` lives beside the
 *    text builder so the two cannot disagree.
 *  - **The bulk enqueue**, which throws, so a batch that never landed is never reported as queued.
 *
 * It decides WHICH records; it never embeds. The record's own ancestors (a chunk of a suppressed file) are the
 * worker's to read, one record at a time, because they are not expressible as a filter on the record.
 */

import { col, asFilter } from '../db/mongo.js';
import { COLLECTION, derivedHasText } from './embed-record.js';
import { enqueueEmbedJobs, type EmbedPriority } from './embed-queue.js';
import { embeddingSuppressedFor, recordNotSuppressedFilter, RECORD_SUPPRESS_FIELD } from './suppress-embeddings.js';
import { TYPE_FIELD } from './ttl.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { spaceCollection } from '../db/space-collection.js';
import { NOT_A_FLAGGED_ROW } from '../files/live-file-row.js';
import type { KnowledgeType } from '../config/types-knowledge.js';
import type { BrainEmbedRecordType } from '../config/types.js';

/** Every record kind that carries a vector. Derived from `COLLECTION` so a new kind cannot be missed by a sweep. */
export const EMBED_SWEEP_KINDS = Object.keys(COLLECTION) as BrainEmbedRecordType[];

/** Records read per round trip of the walk. */
const WALK_BATCH = 500;

/** Just the fields the exclusion decision reads, so a test can build the tiers by hand. */
export interface SuppressMeta {
  suppressEmbeddings?: boolean | undefined;
  typeSchemas?: Partial<Record<KnowledgeType, Record<string, { suppressEmbeddings?: boolean } | undefined>>> | undefined;
}

/**
 * The three suppression tiers as a Mongo filter fragment — or `'all'` when nothing can be embedded.
 *
 * Exported for testing because this is the part with the reasoning in it. Each tier separately:
 *
 *  - **record**: `suppressEmbeddings: true` is a plain field, so `$ne: true` excludes it. It must be
 *    `$ne` rather than `{ $exists: false }` — the flag can legitimately be present and `false`, and a record
 *    that explicitly opts IN must not be excluded.
 *  - **schema**: the suppressed type NAMES are enumerable from `meta.typeSchemas`, so they become a `$nin` on
 *    the type field. Edges key on `label` while everything else keys on `type`, which `TYPE_FIELD` already
 *    encodes — reading `type` for an edge would find no schema, look like it worked, and silently exclude
 *    nothing for the one record kind this was widened to cover.
 *  - **space**: knowable before any query. On its own it suppresses everything, so the sweep can say "no work"
 *    instead of reporting a backlog it can never clear. But a type schema saying `false` OVERRIDES it, and so
 *    does a record — `record > schema > space`, where "not stated" falls through. So `'all'` is only correct
 *    when no lower tier can lift a record back out, which is what `releasedTypes` checks.
 *
 * Takes the meta rather than a space id, so it is **pure** and a test can build the three tiers by hand.
 */
export function suppressionExclusion(
  meta: SuppressMeta | undefined,
  kind: BrainEmbedRecordType,
): 'all' | { query: Record<string, unknown> } {
  const spaceWide = meta?.suppressEmbeddings === true;
  const knowledgeType: KnowledgeType | undefined = kind === 'file' ? undefined : kind;
  const schemas = knowledgeType === undefined ? undefined : meta?.typeSchemas?.[knowledgeType];

  const suppressedTypes: string[] = [];
  const releasedTypes: string[] = [];
  for (const [name, schema] of Object.entries(schemas ?? {})) {
    const v = (schema as { suppressEmbeddings?: boolean } | undefined)?.suppressEmbeddings;
    if (v === true) suppressedTypes.push(name);
    else if (v === false) releasedTypes.push(name);
  }

  const field = knowledgeType === undefined ? undefined : TYPE_FIELD[knowledgeType];

  if (spaceWide) {
    // A record-level opt-in can also lift a record out, and unlike a type name that is not enumerable from
    // meta — so `'all'` is claimed only when neither escape hatch exists for this kind.
    if (releasedTypes.length === 0) return 'all';
    // Some types are explicitly released: only those, minus any record opting out.
    return { query: { ...(field ? { [field]: { $in: releasedTypes } } : {}), ...recordNotSuppressedFilter() } };
  }

  const query: Record<string, unknown> = { ...recordNotSuppressedFilter() };
  if (field && suppressedTypes.length > 0) query[field] = { $nin: suppressedTypes };
  return { query };
}

/** Where a walk has got to: the kind it is in and the last record id it queued there. */
export interface SweepCursor {
  kind: BrainEmbedRecordType;
  lastId: string;
}

export interface SweepOptions {
  /** The kinds to walk, in `EMBED_SWEEP_KINDS` order. Omitted means all of them. */
  kinds?: BrainEmbedRecordType[];
  /**
   * `vectorless` — a backfill: records with no vector (the key ABSENT, never null: suppression `$unset`s it).
   * `all` — a reindex: every record, including derived records with text and any derived record still carrying
   * a vector to remove.
   */
  match: 'vectorless' | 'all';
  /** Records to queue at most, over all kinds; the rest are counted in `remaining`. */
  limit?: number;
  priority: EmbedPriority;
  rebuild?: boolean;
  /** Resume after this point: earlier kinds are skipped, and in its kind only ids after `lastId` are walked. */
  after?: SweepCursor;
  /** Called after each batch's enqueue is acknowledged, so a cursor saved there never runs ahead of the queue. */
  onBatch?: (cursor: SweepCursor) => Promise<void>;
}

export interface SweepResult {
  enqueued: number;
  skippedSuppressed: number;
  byKind: Record<string, number>;
  /** Candidates left over after `limit`. Zero when the space is fully swept. */
  remaining: number;
}

/** The records of a kind a sweep considers at all, before suppression. */
function candidates(kind: BrainEmbedRecordType, match: SweepOptions['match']): Record<string, unknown> {
  const topLevel = { parentFileId: { $exists: false } };
  /*
   * NEVER a row a soft delete flagged. The flag strips the vector, so a flagged file is a vectorless candidate for
   * ever: a backfill queued a job for every deleted file on every pass, re-embedded the audit record, and inflated
   * `total` and `remaining` with work nobody asked for. The any-tier predicate, because a chunk or caption row is a
   * legitimate candidate — it is vacuous on one, which is correct: a flagged file's children go with it.
   */
  const live = kind === 'file' ? NOT_A_FLAGGED_ROW : {};
  if (match === 'vectorless') {
    const vectorless = { embedding: { $exists: false } };
    return kind === 'file' ? { ...vectorless, ...live, $or: [topLevel, derivedHasText] } : vectorless;
  }
  return kind === 'file'
    ? { ...live, $or: [topLevel, derivedHasText, { parentFileId: { $exists: true }, embedding: { $exists: true } }] }
    : {};
}

/**
 * The filters a sweep walks one kind by: `base`, the records it considers at all, and `allowed`, the ones suppression
 * lets it queue. One rule for both callers: a suppressed record is skipped unless it still holds a vector to remove.
 */
function kindFilters(spaceId: string, kind: BrainEmbedRecordType, match: SweepOptions['match']) {
  const base = candidates(kind, match);
  const exclusion = suppressionExclusion(getSpaceMeta(spaceId), kind);
  const holdsVector = { embedding: { $exists: true } };
  const allowed = exclusion === 'all' ? holdsVector : { $or: [exclusion.query, holdsVector] };
  return { base, allowed };
}

/** The kinds a walk still has ahead of it, and the `_id` bound inside the kind it stopped in. */
function kindsFrom(kinds: BrainEmbedRecordType[], after: SweepCursor | undefined) {
  const startAt = after ? EMBED_SWEEP_KINDS.indexOf(after.kind) : -1;
  return kinds
    .filter(kind => !(startAt >= 0 && EMBED_SWEEP_KINDS.indexOf(kind) < startAt))
    .map(kind => ({ kind, resumeHere: after && after.kind === kind ? { _id: { $gt: after.lastId } } : {} }));
}

/**
 * How many records a sweep stopped at `after` has still to queue — what a reindex's progress adds to the jobs already
 * queued while its sweep is incomplete. Counted with the walk's own filters, so the number is the walk's work and not
 * an estimate of it; without it the first poll of a run read "0 left" while every record waited.
 */
export async function countUnswept(
  spaceId: string,
  { match, after }: { match: SweepOptions['match']; after?: SweepCursor },
): Promise<number> {
  let n = 0;
  for (const { kind, resumeHere } of kindsFrom(EMBED_SWEEP_KINDS, after)) {
    const { base, allowed } = kindFilters(spaceId, kind, match);
    n += await col(spaceCollection(spaceId, COLLECTION[kind] as 'facts'))
      .countDocuments(asFilter({ $and: [base, allowed, resumeHere] }));
  }
  return n;
}

/** Queue the records of a space a sweep owes a job, kind by kind. See the module comment for what it guarantees. */
export async function queueEmbedSweep(spaceId: string, opts: SweepOptions): Promise<SweepResult> {
  const cap = opts.limit ?? Number.POSITIVE_INFINITY;
  const result: SweepResult = { enqueued: 0, skippedSuppressed: 0, byKind: {}, remaining: 0 };

  for (const { kind, resumeHere } of kindsFrom(opts.kinds ?? EMBED_SWEEP_KINDS, opts.after)) {
    const coll = col(spaceCollection(spaceId, COLLECTION[kind] as 'facts'));
    const { base, allowed } = kindFilters(spaceId, kind, opts.match);

    /*
     * BOTH COUNTS FROM ONE SNAPSHOT, and the subtraction is why that matters. Two live counts over a population
     * the embed worker is draining — every record it finishes gains a vector and leaves "vectorless" — go POSITIVE
     * when subtracted with nothing suppressed at all, which tells an operator the setting is still on when it is
     * not. `$facet` evaluates every branch over one pass of the same input.
     */
    const [counts] = await coll.aggregate([
      { $match: asFilter(base) },
      { $facet: { all: [{ $count: 'n' }], allowed: [{ $match: asFilter(allowed) }, { $count: 'n' }] } },
    ]).toArray() as Array<{ all: Array<{ n: number }>; allowed: Array<{ n: number }> }>;
    const total = counts?.allowed?.[0]?.n ?? 0;
    result.skippedSuppressed += (counts?.all?.[0]?.n ?? 0) - total;

    const budget = cap - result.enqueued;
    if (budget <= 0) { result.remaining += total; continue; }

    const knowledgeType: KnowledgeType | undefined = kind === 'file' ? undefined : kind;
    const projection: Record<string, unknown> = {
      _id: 1,
      [RECORD_SUPPRESS_FIELD]: 1,
      ...(knowledgeType ? { [TYPE_FIELD[knowledgeType]]: 1 } : {}),
      holdsVector: { $isArray: '$embedding' },
    };
    const walk = coll.aggregate([
      { $match: asFilter({ $and: [base, allowed, resumeHere] }) },
      { $sort: { _id: 1 } },
      ...(Number.isFinite(budget) ? [{ $limit: budget }] : []),
      { $project: projection },
    ], { batchSize: WALK_BATCH });

    let walked = 0;
    let batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const { queued } = await enqueueEmbedJobs(spaceId, kind, batch, { priority: opts.priority, rebuild: opts.rebuild });
      result.enqueued += queued;
      result.byKind[kind] = (result.byKind[kind] ?? 0) + queued;
      const lastId = batch[batch.length - 1]!;
      batch = [];
      if (opts.onBatch) await opts.onBatch({ kind, lastId });
    };
    for await (const doc of walk as AsyncIterable<Record<string, unknown>>) {
      walked++;
      const id = doc['_id'];
      if (typeof id !== 'string') continue;
      // Belt and braces: the query already applied the tiers it can express, and THE resolver — the one the worker
      // asks — is consulted per document, so a tier the query cannot express still keeps a suppressed record out,
      // unless it holds a vector the worker must remove. A derived record's ancestors are the worker's to read.
      if (doc['holdsVector'] !== true && embeddingSuppressedFor(spaceId, kind, doc)) { result.skippedSuppressed++; continue; }
      batch.push(id);
      if (batch.length >= WALK_BATCH) await flush();
    }
    await flush();
    // A resumed walk counted the whole kind but walked only past the cursor, so it has no remainder to report.
    if (!opts.after && total > walked) result.remaining += total - walked;
  }
  return result;
}
