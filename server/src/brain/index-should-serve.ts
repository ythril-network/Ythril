/**
 * Does this collection hold a record its vector index should be serving? (Q-326, Q-327; bundle-72)
 *
 * ## What it is for
 *
 * A vector index that answers nothing — absent, dropped, still being built, or refusing — says nothing about whether
 * the collection is empty. The reader that got the refusal or the empty window asks THIS, and only then: when no record
 * the index should serve exists, the empty answer is complete (a new collection, B1 and B2: a search straight after a
 * space's first write answers empty with no reason); when one exists, the answer may be missing it and must say so
 * (`index_not_ready` / `index_unavailable` on a recall, a deferred face on the gallery).
 *
 * ## The defect it prevents
 *
 * Every refusal read as "this collection holds nothing": a recall over an index being rebuilt answered a confident empty
 * list over thousands of records, and the gallery stored a labelled person's face unlabelled for good. The same read
 * was spelled once already, inside `predicate-recall.ts` `indexIsBehind`, for the ids a stage-2 batch did not return;
 * recall, predicate recall and the face gallery now ask this one copy.
 *
 * ## How it reads
 *
 * - An EXACT `findOne` with an `_id` projection, never `estimatedDocumentCount` (B11, `spaces/record-presence.ts`): the
 *   estimate is read from collection metadata and can say zero after an unclean shutdown, which is exactly when an
 *   index is being rebuilt and the answer matters.
 * - Only a record that CARRIES a vector at `vectorPath` counts: one not embedded yet is not the index's to serve.
 * - `maxAge` (recall): only a record older than the fresh-write window counts. A younger one is found by the recall's
 *   fresh-write scan, so a new collection's first seconds are not "degraded" (O1; `indexIsBehind` ruled the same way).
 *   A record with no `updatedAt` counts as aged, the safe side. Without it (the gallery, which has no fresh-write scan)
 *   any record counts, so a face labelled seconds ago is waited for.
 * - `ids` narrows to those records (stage 2's "is any of these missing"), `filter` to a predicate (labelled faces).
 * - Bounded by `maxTimeMS`; a timeout or any failure of the read answers `true`. The safe side: the answer is flagged
 *   "may be missing", or the face is deferred, rather than a confident empty answer read from a read that never ran.
 *   `whetherIndexShouldServe` is the same read with its third answer kept (`unknown`), and `indexMissedAMatch` the recall's
 *   decision over a FILTERED search the index answered with nothing (Q-696): this read, then a probe of the index.
 */
import { col } from '../db/mongo.js';
import { andPredicates } from '../db/and-predicates.js';
import { FRESH_WINDOW_MS } from './fresh-writes.js';
import { askIndexOnce, type ProbeTarget } from '../spaces/vector-index.js';
import { recallUndecidedTotal } from '../metrics/registry.js';
import { warnOnce } from '../util/warn-once.js';
import { log, peerText } from '../util/log.js';

export interface IndexShouldServeOptions {
  /** Only these records (the ids a batch of the index did not return). */
  ids?: string[];
  /** Only records satisfying this predicate (the gallery: a labelled face). */
  filter?: Record<string, unknown>;
  /** Only records older than the fresh-write window — set by recall, whose fresh-write scan finds the younger ones. */
  maxAge?: boolean;
  /** The bound on the read. A timeout answers `true`. */
  maxTimeMS: number;
}

/** What the read said: a record the index should serve exists (`yes`), none does (`no`), or the read could not tell (`unknown`). */
export type IndexShouldServe = 'yes' | 'no' | 'unknown';

/**
 * Does `collName` hold a record carrying a vector at `vectorPath` that its index should serve? Three answers, never two.
 *
 * `unknown` is the read that timed out or failed. The boolean `holdsRecordTheIndexShouldServe` folds it into "yes" (the safe
 * side); a caller that can ask a second question when the first could not tell (`indexMissedAMatch`) reads it as it is. The
 * query is spelled ONCE, here: a second copy is how the boolean and the three-way answer would come to disagree about which
 * records count.
 */
export async function whetherIndexShouldServe(
  collName: string,
  vectorPath: string,
  { ids, filter, maxAge, maxTimeMS }: IndexShouldServeOptions,
): Promise<IndexShouldServe> {
  if (ids && ids.length === 0) return 'no';
  const cutoff = new Date(Date.now() - FRESH_WINDOW_MS).toISOString();
  try {
    const one = await col(collName).findOne(andPredicates(
      filter,
      ids ? { _id: { $in: ids } } : undefined,
      { [vectorPath]: { $type: 'array' }, ...(maxAge ? { updatedAt: { $not: { $gte: cutoff } } } : {}) },
    )!, { projection: { _id: 1 }, maxTimeMS });
    return one !== null ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

/** True when `collName` holds a record carrying a vector at `vectorPath` that its index should serve (or the read failed). */
export async function holdsRecordTheIndexShouldServe(
  collName: string,
  vectorPath: string,
  options: IndexShouldServeOptions,
): Promise<boolean> {
  return await whetherIndexShouldServe(collName, vectorPath, options) !== 'no';
}

/**
 * The bound on the holds-read a search with no deadline of its own makes (`findSimilar`, the insert-time check), and the cap of
 * each read `indexMissedAMatch` makes inside the recall's deadline.
 *
 * An UNFILTERED holds-read is one indexed `findOne`, so 2 s is generous and a timeout answers "holds", the safe side. A FILTERED
 * one applies the caller's predicate and can scan a field no index covers (`type` is indexed on the five collections and `tags` on
 * facts; a chrono `status`, an edge `label` and `properties.*` are not), so it is bounded by this 2 s too, and a scan that does not
 * finish is `unknown`, never a wait.
 */
export const HOLDS_READ_MS = 2_000;

/** What `indexMissedAMatch` found: no miss, an index serving nothing, an index that missed a match, or a read that could not tell. */
export type IndexMiss = 'none' | 'index_not_ready' | 'filter_window' | 'undecided';

/** `undecided` is said once per collection per ten minutes: a read that keeps timing out would otherwise say it on every recall. */
const undecidedSaid = warnOnce<string>({ every: 10 * 60_000 });

export interface IndexMissOptions {
  collName: string;
  indexName: string;
  /** The path the index indexes and the width it was built at (the probe's query vector is that wide). */
  target: ProbeTarget;
  /** The caller's predicate, in MongoDB's grammar: what the index's native filter selected. */
  predicate: Record<string, unknown> | undefined;
  /** What the recall's deadline has left; the two reads below share it. `Infinity` for a caller with no deadline. */
  budgetMs: number;
}

/**
 * A filtered search the index answered with NOTHING: did the index miss a match? (Q-696)
 *
 * ## The defect it prevents
 *
 * The unfiltered recall over an absent or dropped index says `index_not_ready` over aged records; the same recall with a declared
 * flat filter went to the index's native filter, got no hits, and answered a confident empty over the same collection. An empty
 * answer from an index that served nothing is not "no match", and one from an index that is behind is not either.
 *
 * ## The two reads, in this order, under these caps (all inside this module, so no caller can reorder or uncap them)
 *
 *  1. the filtered holds-read, under `min(HOLDS_READ_MS, budgetMs)`: does an aged vectored record satisfy the predicate?
 *     `no` is `none`: the empty answer is complete, and an empty or new collection never reaches the index (B1, B2).
 *  2. when step 1 said `yes` or `unknown`, the probe of the index (`askIndexOnce`), under `min(HOLDS_READ_MS, what is left)`:
 *     - 0 records: `index_not_ready`, the index serves nothing (the unfiltered path's reason);
 *     - 1 or more, step 1 `yes`: `filter_window`, the index serves and missed matching records older than the fresh window (the
 *       predicate path's reason for a lagging index, so the two paths agree);
 *     - 1 or more, step 1 `unknown`: `undecided`, the one named fail-open. The empty answer stands; it is said (once per
 *       collection per ten minutes) and counted as `ythril_recall_undecided_total`.
 *
 * A probe the index REFUSES is thrown as the store gave it, so the caller's refusal classifier (`answerRefusal`) gives it its
 * own reason or its 503: this module does not classify store faults.
 *
 * ## Asked once
 *
 * A recall with a `minPerType` floor searches each collection twice (the floor and the main search), and both would ask the same
 * question over the same predicate. `memo` is the recall's own map: the PROMISE is stored, so two searches running at once share
 * the one read, and a refusal is shared as well. Without it the second search is a second pair of reads and a second count.
 */
export function indexMissedAMatch(opts: IndexMissOptions, memo?: IndexMissMemo): Promise<IndexMiss> {
  if (!memo) return askWhetherIndexMissed(opts);
  const key = [opts.collName, opts.indexName, JSON.stringify(opts.predicate)].join('\0');
  let asked = memo.get(key);
  if (!asked) { asked = askWhetherIndexMissed(opts); memo.set(key, asked); }
  return asked;
}

/** The questions already asked in one recall, by collection, index and predicate. Holds the promise, not the answer. */
export type IndexMissMemo = Map<string, Promise<IndexMiss>>;

async function askWhetherIndexMissed({ collName, indexName, target, predicate, budgetMs }: IndexMissOptions): Promise<IndexMiss> {
  const started = Date.now();
  // `maxTimeMS: 0` is "no limit" to the store: a cap is never rounded down to it.
  const cap = (leftMs: number): number => Math.max(1, Math.floor(Math.min(HOLDS_READ_MS, leftMs)));
  const holds = await whetherIndexShouldServe(collName, target.vectorPath,
    { filter: predicate, maxAge: true, maxTimeMS: cap(budgetMs) });
  if (holds === 'no') return 'none';
  const answer = await askIndexOnce(col(collName), indexName, target, cap(budgetMs - (Date.now() - started)));
  if ('error' in answer) throw answer.error;
  if (answer.records === 0) return 'index_not_ready';
  if (holds === 'yes') return 'filter_window';
  recallUndecidedTotal.inc();
  undecidedSaid(collName, () => log.warn(`Recall: could not tell whether the vector index ${peerText(indexName)} missed a match for a `
    + `filtered search of ${peerText(collName)} (the read of matching records did not finish) — the empty answer stands, counted `
    + 'as ythril_recall_undecided_total'));
  return 'undecided';
}
