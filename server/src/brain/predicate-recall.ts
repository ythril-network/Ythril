/**
 * The `topK` records satisfying a predicate the vector index cannot apply natively — every one of them,
 * whatever its vector rank.
 *
 * ## The defect this exists for (Q-102)
 *
 * A filter the index cannot apply — an undeclared `properties.*` key, `$exists`, `$ne`, most of the raw grammar
 * — took the "exhaustive" path: `$vectorSearch exact:true` with a window of `min(10000, max(topK*100, 1000))`,
 * THEN `$match`. So it scored only the nearest window and filtered after, and a matching record outside that
 * window was dropped. Measured on a 40k-record space: 39 of 40 single-record filters on an undeclared property
 * answered `count: 0`, `truncated: false`, while `filter` found the record. The schema description, `help()`
 * and CLAUDE.md all promised the opposite, and a canary integrator built on the promise.
 *
 * ## Two stages, and the first one is usually the whole answer
 *
 * **Stage 1** is the old window, with the facts needed to know whether it was enough: how many records the
 * window held and the score of the last one. Its answer is EXACT, and accepted, when either
 *
 *  - the window came back shorter than asked for — the index is exhausted, every record was seen; or
 *  - it holds `topK` matches and the `topK`-th scores STRICTLY above the window's last record — nothing
 *    outside the window can outrank it. Equal is not enough: a tie across the cut means records beyond it are
 *    as good as the last one inside, and the window's arbitrary cut would be deciding the answer.
 *
 * **Stage 2** runs otherwise: the ids of every record satisfying the predicate are read from the COLLECTION,
 * and each batch of them is scored by the index through a native `_id` filter — then the predicate is applied
 * AGAIN, so a record changed between the two reads never returns. A running top-K is merged across batches by
 * the engine's own score. No score formula is written here: the engine scores, always (an MQL reproduction was
 * measured 350× slower, and it would be a second copy of Atlas's normalisation).
 *
 * ## What it costs, and what bounds it
 *
 * Stage 2 is a pass over the collection's matching ids, so a filter the index cannot apply costs in proportion
 * to how many records match it. Declaring a heavily filtered property in the space schema keeps it on the
 * index. Three bounds: every round trip gets only what is left of the caller's budget; at most
 * {@link PREDICATE_SCAN_CONCURRENCY} stage-2 passes run in the process at once; and past
 * {@link MAX_PREDICATE_IDS} matching ids it stops and says so rather than scanning on.
 *
 * ## It never answers less than stage 1, and never less silently
 *
 * A stage-2 failure keeps what stage 1 found and reports why: `search_timeout` when the budget ran out,
 * `filter_window` when the answer could not be completed — the index refusing the `_id` filter (an index still
 * on the definition shipped before `_id` joined it), or the id cap reached. Never an empty type, and never an
 * incomplete answer with nothing saying so.
 */
import { col } from '../db/mongo.js';
import { isMaxTimeExpired } from '../db/max-time.js';
import { log } from '../util/log.js';
import { andPredicates } from './recall-filter.js';
import type { DegradedReason } from './degraded-reasons.js';

/** Ids per stage-2 search. A native `_id $in` over 40k ids measured 79–92 ms; this keeps each call well under. */
export const ID_CHUNK = 20_000;

/** Past this many matching ids stage 2 stops and discloses `filter_window` rather than scanning on. */
export const MAX_PREDICATE_IDS = 500_000;

/** Stage-2 collection passes allowed to run at once in this process. Queued passes spend their own budget. */
export const PREDICATE_SCAN_CONCURRENCY = 4;

/** The window stage 1 scores. The same figure the exhaustive path always used, so stage 1 costs what it did. */
export function stageOneWindow(topK: number): number {
  return Math.min(10000, Math.max(topK * 100, 1000));
}

/** A matching-id set, computed once per recall and shared by its floor and main searches. `null` = over the cap. */
export type PredicateIdMemo = Map<string, Promise<string[] | null>>;

export interface PredicateRecallArgs {
  collName: string;
  indexName: string;
  /** The indexed vector field: `embedding` for the five text indexes, `faceEmbedding` for the face gallery. */
  vectorPath: string;
  queryVector: number[];
  topK: number;
  /** The WHOLE predicate a result must satisfy. Applied in stage 1's `$match` and again after stage 2. */
  predicate: Record<string, unknown>;
  /**
   * Stages applied to the chosen records, after `score` has been set from the engine. Shaping only — a stage
   * here that filtered would change which records fill `topK`, the one thing this module must decide alone.
   */
  shape: object[];
  /** What is left of the caller's budget, in ms. Read before EVERY round trip, never once up front. */
  remaining: () => number;
  memo?: PredicateIdMemo;
}

export interface PredicateRecallResult {
  docs: Record<string, unknown>[];
  degraded: DegradedReason[];
  /** Which stage produced the answer — for logging and tests, never for a caller's contract. */
  stage: 1 | 2;
}

/**
 * Does this error say the index cannot filter on `_id`?
 *
 * Its OWN test, checked before anything that classifies index errors generally: the recall path swallows
 * "index not ready" as an empty collection, and an `_id` refusal read that way would be an incomplete answer
 * reported as a complete one.
 */
export function isIdFilterRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b_id\b/.test(msg) && /(needs to be indexed|not indexed|indexed as)/i.test(msg);
}

let activeScans = 0;
const waitingScans: Array<() => void> = [];

async function acquireScanSlot(): Promise<void> {
  if (activeScans < PREDICATE_SCAN_CONCURRENCY) { activeScans++; return; }
  // Handed over directly by `releaseScanSlot`, so a newcomer cannot take the slot between release and wake.
  await new Promise<void>(resolve => waitingScans.push(resolve));
}

function releaseScanSlot(): void {
  const next = waitingScans.shift();
  if (next) next(); else activeScans--;
}

/** Engine score descending, then id ascending — the order every recall channel merges by. */
function byScoreThenId(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const d = (b['score'] as number ?? 0) - (a['score'] as number ?? 0);
  if (d !== 0) return d;
  const x = String(a['_id']), y = String(b['_id']);
  return x < y ? -1 : x > y ? 1 : 0;
}

export async function predicateRecall(args: PredicateRecallArgs): Promise<PredicateRecallResult> {
  const { collName, indexName, vectorPath, queryVector, topK, predicate, shape, remaining } = args;
  const window = stageOneWindow(topK);
  const score = { $addFields: { score: { $meta: 'vectorSearchScore' } } };

  // ── Stage 1. Errors propagate: the caller already classifies a stage-1 failure (deadline, index state).
  const [facet] = await col(collName).aggregate<{ window: Array<{ n: number; min: number }>; hits: Record<string, unknown>[] }>([
    { $vectorSearch: { index: indexName, path: vectorPath, queryVector, exact: true, limit: window } },
    score,
    { $facet: {
      window: [{ $group: { _id: null, n: { $sum: 1 }, min: { $min: '$score' } } }],
      hits: [{ $match: predicate }, { $limit: topK }, ...shape],
    } },
  ]).maxTimeMS(remaining()).toArray();

  const seen = facet?.window?.[0] ?? { n: 0, min: 0 };
  const hits = facet?.hits ?? [];
  const exhausted = seen.n < window;
  const clearOfTheCut = hits.length >= topK && (hits[topK - 1]!['score'] as number) > seen.min;
  if (exhausted || clearOfTheCut) return { docs: hits, degraded: [], stage: 1 };

  // ── Stage 2.
  await acquireScanSlot();
  try {
    return await stageTwo(args, hits);
  } finally {
    releaseScanSlot();
  }
}

async function stageTwo(args: PredicateRecallArgs, stageOneHits: Record<string, unknown>[]): Promise<PredicateRecallResult> {
  const { collName, indexName, vectorPath, queryVector, topK, predicate, shape, remaining, memo } = args;
  const best = new Map(stageOneHits.map(d => [String(d['_id']), d]));
  const answer = (degraded: DegradedReason[]): PredicateRecallResult =>
    ({ docs: [...best.values()].sort(byScoreThenId).slice(0, topK), degraded, stage: 2 });

  const scoreBatch = async (ids: string[]): Promise<void> => {
    const docs = await col(collName).aggregate<Record<string, unknown>>([
      { $vectorSearch: { index: indexName, path: vectorPath, queryVector, exact: true, filter: { _id: { $in: ids } }, limit: topK } },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      // AGAIN: the ids were read a moment ago, and a record that stopped matching since must not return.
      { $match: predicate },
      ...shape,
    ]).maxTimeMS(remaining()).toArray();
    for (const d of docs) best.set(String(d['_id']), d);
    // Keep only the running top-K, so a million-id pass holds topK records and never the whole answer.
    if (best.size > topK) {
      const keep = [...best.values()].sort(byScoreThenId).slice(0, topK);
      best.clear();
      for (const d of keep) best.set(String(d['_id']), d);
    }
  };

  const key = `${collName}\u0000${indexName}\u0000${JSON.stringify(predicate)}`;
  try {
    const known = memo?.get(key);
    if (known) {
      const ids = await known;
      if (ids === null) return answer(['filter_window']);
      for (let i = 0; i < ids.length; i += ID_CHUNK) await scoreBatch(ids.slice(i, i + ID_CHUNK));
      return answer([]);
    }

    // Streamed, and scored batch by batch as they arrive: an index that refuses the `_id` filter says so on the
    // FIRST batch, so a refusal costs one batch of the id read rather than the whole of it.
    let collected: string[] | null = [];
    // Built unconditionally: inside `memo?.set(…)` the constructor would be skipped with the call when there is
    // no memo, leaving `settle` unassigned.
    let settle!: (v: string[] | null) => void;
    const pending = new Promise<string[] | null>(r => { settle = r; });
    memo?.set(key, pending);
    try {
      const cursor = col(collName)
        .find(andPredicates(predicate, { [vectorPath]: { $type: 'array' } })!, { projection: { _id: 1 } })
        .batchSize(ID_CHUNK)
        .maxTimeMS(remaining());
      let batch: string[] = [];
      let total = 0;
      try {
        for await (const d of cursor) {
          if (++total > MAX_PREDICATE_IDS) {
            log.warn(`Filtered recall on ${collName}: more than ${MAX_PREDICATE_IDS} records match a filter the index `
              + 'cannot apply — answered from the first of them and flagged filter_window. Declare the filtered '
              + 'property in the space schema to keep this filter on the index.');
            collected = null;
            break;
          }
          const id = String((d as { _id: unknown })._id);
          batch.push(id);
          collected?.push(id);
          if (batch.length === ID_CHUNK) { await scoreBatch(batch); batch = []; }
        }
      } finally {
        await cursor.close().catch(() => {});
      }
      if (batch.length > 0) await scoreBatch(batch);
      settle(collected);
      return answer(collected === null ? ['filter_window'] : []);
    } catch (err) {
      memo?.delete(key);
      settle(null);
      throw err;
    }
  } catch (err) {
    if (isMaxTimeExpired(err)) {
      log.warn(`Filtered recall on ${collName}: the budget ran out completing the answer — returning what was found`);
      return answer(['search_timeout']);
    }
    if (isIdFilterRefusal(err)) {
      log.warn(`Filtered recall on ${collName}: ${indexName} cannot filter on _id yet (an index built before it `
        + 'was declared, updating in place) — the answer may be missing matching records and says filter_window');
      return answer(['filter_window']);
    }
    // Anything else, after stage 1 answered: the collection is readable and the completion is not. Throwing would
    // discard stage 1's hits with it (the caller reads an unknown index error as an empty collection), so the
    // answer keeps them and says it is incomplete — and the reason reaches the log rather than vanishing.
    log.warn(`Filtered recall on ${collName}: completing the answer failed (${err instanceof Error ? err.message : String(err)}) `
      + '— returning what the first stage found, flagged filter_window');
    return answer(['filter_window']);
  }
}
