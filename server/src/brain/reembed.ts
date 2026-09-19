/**
 * Backfill missing embeddings for a space.
 *
 * ## Why this exists
 *
 * `suppressEmbeddings` shipped without a way back. Records written while suppression was on have no vector, and
 * nothing revisited them — so turning the setting off left the space permanently half-indexed, with recall blind
 * to everything written during the suppressed period and no symptom beyond worse results. The owner's call was
 * blunt: *"there should be a way to backfill"*.
 *
 * It is not only for suppression. The same gap opens whenever an enqueue fails: `enqueueEmbedJob` deliberately
 * swallows its error rather than failing the caller's write, and its comment claimed "the periodic backfill sweep
 * will find it". **There was no such sweep** — the comment described a repair mechanism that had never been
 * built, which is exactly the kind of reassurance that stops anyone looking. This is that sweep, on demand.
 *
 * ## It ENQUEUES, and does not embed
 *
 * A space can hold a million records and the model is the slow part. Embedding inline would time out the request
 * somewhere in the middle, having done partial work with no record of where it stopped. Enqueuing is idempotent
 * per record (`enqueueEmbedJob` upserts by job id), so a repeated call over the same space converges instead of
 * duplicating.
 *
 * ## A backfill must not fight the setting
 *
 * A record that is STILL suppressed is skipped, and the same `embeddingSuppressed` resolver the write path uses
 * decides it. Re-deriving the rule here would let a backfill re-index exactly what an operator asked to keep out
 * of recall — the resolver is imported for that reason, not for convenience.
 *
 * So the operator's sequence is: turn suppression off, then backfill. Running it while still suppressed is not an
 * error and reports honestly — every candidate comes back under `skippedSuppressed`, which tells the operator the
 * setting is still on rather than leaving them to wonder why nothing happened.
 *
 * ## Suppression is excluded in the QUERY, and that is what makes the sweep terminate
 *
 * The first version filtered on "has no vector" alone and skipped suppressed documents inside the loop. It did
 * not converge, and the failure was worse than a misleading counter:
 *
 *  - a suppressed record matches "has no vector" **by construction** — suppression is what removed the vector;
 *  - `find(filter).limit(n)` has no sort, so the same first `n` documents come back on every call;
 *  - the sweep never writes to a suppressed record, so they never leave the result set.
 *
 * So a page of suppressed records at the front of a collection **blocked every embeddable record behind it,
 * permanently**, while `truncated: true` told the caller to keep calling. All three tiers are expressible as a
 * filter (see `suppressionExclusion`), so now the cursor advances: enqueued records gain a vector and drop out,
 * and suppressed records were never in.
 *
 * ## Nothing is capped silently
 *
 * `limit` bounds one call. When more candidates remain, `remaining` says how many and `truncated` is `true`. A
 * backfill that quietly stopped at a round number would read as "the space is fully indexed now", which is the
 * same class of lie as the missing sweep this replaces.
 *
 * `remaining` counts only work that CAN be done. A space whose suppression is still on reports `remaining: 0`
 * with every candidate under `skippedSuppressed` — "there is no work", which is a different statement from
 * "there is work left", and the one an operator can act on.
 */

import { col, asFilter } from '../db/mongo.js';
import { COLLECTION, } from './embed-record.js';
import { enqueueEmbedJob } from './embed-queue.js';
import {
  embeddingSuppressed, schemaKeyFor, recordSuppression, recordNotSuppressedFilter,
} from './suppress-embeddings.js';
import { TYPE_FIELD } from './ttl.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import type { KnowledgeType } from '../config/types-knowledge.js';
import type { BrainEmbedRecordType } from '../config/types.js';

/** Every record kind that carries a vector. Derived from `COLLECTION` so a new kind cannot be missed here. */
export const REEMBED_KINDS = Object.keys(COLLECTION) as BrainEmbedRecordType[];

/** Default and ceiling for one call. The ceiling exists so a single request cannot enqueue unbounded work. */
export const REEMBED_DEFAULT_LIMIT = 5_000;
export const REEMBED_MAX_LIMIT = 50_000;

export interface ReembedResult {
  spaceId: string;
  /** Records with no vector that are not suppressed — the ones a job was queued for. */
  enqueued: number;
  /** Candidates skipped because suppression still applies at some tier. */
  skippedSuppressed: number;
  /** Per-kind breakdown of what was enqueued, so an operator can see WHERE the gap was. */
  byKind: Record<string, number>;
  /** Candidates left over after `limit`. Zero when the space is fully swept. */
  remaining: number;
  /** True when `remaining > 0` — call again to continue. */
  truncated: boolean;
}

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
 *    that explicitly opts IN must not be excluded. `recordNotSuppressedFilter` covers the pre-3.1.0 spelling
 *    too, because a sweep that read only the new key would re-embed every record suppressed before the rename.
 *  - **schema**: the suppressed type NAMES are enumerable from `meta.typeSchemas`, so they become a `$nin` on
 *    the type field. Edges key on `label` while everything else keys on `type`, which `TYPE_FIELD` already
 *    encodes — reading `type` for an edge would find no schema, look like it worked, and silently exclude
 *    nothing for the one record kind this was widened to cover.
 *  - **space**: knowable before any query. On its own it suppresses everything, so the sweep can say "no work"
 *    instead of reporting a backlog it can never clear. But a type schema saying `false` OVERRIDES it, and so
 *    does a record — `record > schema > space`, where "not stated" falls through. So `'all'` is only correct
 *    when no lower tier can lift a record back out, which is what `releasedTypes` checks.
 *
 * Takes the meta rather than a space id, so it is **pure** and a test can build the three tiers by hand —
 * the same idiom `embeddingSuppressed` and `changesCutoff` already use here: the part with a decision in it
 * is the part that must be testable without a database.
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

/**
 * Whether this stored document is still suppressed.
 *
 * Mirrors `embedStoredRecord` exactly, including the file asymmetry: a file has no type and therefore no type
 * schema, so it skips the middle tier. Narrowed rather than cast — a cast would index `typeSchemas` with
 * `'file'` and miss every time, which here would mean re-embedding files an operator had suppressed.
 *
 * Still consulted per document even though `suppressionExclusion` now removes suppressed records in the query.
 * The query is derived from `meta`; this reads the record. A tier the query cannot express keeps working.
 */
function stillSuppressed(spaceId: string, kind: BrainEmbedRecordType, doc: Record<string, unknown>): boolean {
  const meta = getSpaceMeta(spaceId);
  const knowledgeType: KnowledgeType | undefined = kind === 'file' ? undefined : kind;
  const schemaKey = knowledgeType === undefined ? undefined : schemaKeyFor(knowledgeType, doc);
  return embeddingSuppressed({
    record: recordSuppression(doc),
    schema: knowledgeType === undefined || schemaKey === undefined
      ? undefined
      : meta?.typeSchemas?.[knowledgeType]?.[schemaKey],
    space: meta?.suppressEmbeddings === true,
  });
}

/**
 * Queue an embedding job for every record in the space that has no vector and is not suppressed.
 *
 * `kinds` narrows the sweep; omitted means all of them. `limit` bounds one call — see the class comment on why
 * the remainder is reported rather than hidden.
 */
export async function reembedSpace(
  spaceId: string,
  { kinds = REEMBED_KINDS, limit = REEMBED_DEFAULT_LIMIT }: { kinds?: BrainEmbedRecordType[]; limit?: number } = {},
): Promise<ReembedResult> {
  const cap = Math.min(Math.max(1, Math.floor(limit)), REEMBED_MAX_LIMIT);
  const result: ReembedResult = {
    spaceId, enqueued: 0, skippedSuppressed: 0, byKind: {}, remaining: 0, truncated: false,
  };

  for (const kind of kinds) {
    const collName = `${spaceId}_${COLLECTION[kind]}`;

    // `$exists: false` on `embedding`, NOT a null check: the suppressed path `$unset`s the field, so a record
    // that was suppressed and later released has no key at all rather than a null one. A `null` filter would
    // find nothing and report a clean sweep over a space that is entirely unindexed.
    const vectorless = { embedding: { $exists: false } } as Record<string, unknown>;

    // ── Suppression is EXCLUDED IN THE QUERY, and that is a correctness requirement, not a speed one ──
    //
    // Suppressed records match `vectorless` by construction — suppression is what removed their vector. The
    // first version of this sweep filtered on `vectorless` alone and skipped suppressed docs in the loop.
    // That does not converge, and the failure is worse than a wrong counter:
    //
    //   `find(vectorless).limit(50)` has no sort, so it returns the same first 50 documents on every call.
    //   The sweep never modifies a suppressed record, so those 50 never leave the result set. A page of
    //   suppressed records at the front of a collection therefore BLOCKS every embeddable record behind it,
    //   permanently, while `truncated: true` tells the caller to "call again to continue".
    //
    // All three tiers are expressible here, so the cursor advances: enqueued records gain a vector and drop
    // out, and suppressed ones were never in.
    const exclusion = suppressionExclusion(getSpaceMeta(spaceId), kind);
    if (exclusion === 'all') {
      // The space-wide tier is on with nothing that can override it upward. Every candidate is suppressed, so
      // report them as skipped and leave `remaining` at zero: there is no work, as opposed to work left.
      result.skippedSuppressed += await col(collName).countDocuments(asFilter(vectorless));
      continue;
    }

    const filter = asFilter({ ...vectorless, ...exclusion.query });
    /*
     * BOTH COUNTS FROM ONE SNAPSHOT, and the subtraction is why that matters.
     *
     * This read the collection TWICE and subtracted: `count(vectorless) - count(vectorless AND allowed)`.
     * Both are live counts over a population the embed worker is actively draining — every record it
     * finishes gains a vector and leaves `vectorless`. Shrink the second count after taking the first and
     * the difference goes POSITIVE with nothing suppressed at all, which tells an operator the setting is
     * still on when it is not.
     *
     * Measured as an intermittent `skippedSuppressed: 1` in a loaded full-suite run of
     * `reembed-both-doors`, against a space whose suppression had just been turned off — passing when the
     * file ran alone, which is the signature this same file documents twelve lines from that assertion.
     *
     * `$facet` evaluates every branch over ONE pass of the same input, so `all` and `allowed` describe the
     * same instant and their difference is the number the exclusion removed rather than the number the
     * worker happened to finish in between. `a-parity-assertion-over-a-moving-quantity` is the general
     * form: two reads of a live value assert nothing about each other.
     */
    const [counts] = await col(collName).aggregate([
      { $match: asFilter(vectorless) },
      { $facet: { all: [{ $count: 'n' }], allowed: [{ $match: asFilter(exclusion.query) }, { $count: 'n' }] } },
    ]).toArray() as Array<{ all: Array<{ n: number }>; allowed: Array<{ n: number }> }>;
    const allVectorless = counts?.all?.[0]?.n ?? 0;
    const total = counts?.allowed?.[0]?.n ?? 0;

    // Candidates the filter removed — reported so "nothing happened" is never silent, which is what tells an
    // operator the setting is still on.
    result.skippedSuppressed += allVectorless - total;

    const budget = cap - result.enqueued;
    if (budget <= 0) { result.remaining += total; continue; }

    const docs = await col(collName).find(filter).limit(budget).toArray() as Array<Record<string, unknown>>;
    for (const doc of docs) {
      const id = doc['_id'];
      if (typeof id !== 'string') continue;
      // Belt and braces: the query already excluded suppressed records, and the resolver is still consulted
      // per document. The query is derived from `meta`, so a shape the exclusion cannot express — a future
      // fourth tier, say — would otherwise re-index exactly what an operator asked to keep out of recall.
      if (stillSuppressed(spaceId, kind, doc)) { result.skippedSuppressed++; continue; }
      await enqueueEmbedJob(spaceId, kind, id);
      result.enqueued++;
      result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
    }
    if (total > docs.length) result.remaining += total - docs.length;
  }

  result.truncated = result.remaining > 0;
  return result;
}
