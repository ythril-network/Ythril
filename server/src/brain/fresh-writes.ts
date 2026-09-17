/**
 * The records the vector index has not seen yet.
 *
 * ## The defect this exists for
 *
 * `checkDuplicates` asks "is anything already in this space very similar to what I am about to write?" —
 * and it asked the **vector index**, which is eventually consistent. A document committed a moment ago is
 * not in it. So the one check whose entire job is to compare against the neighbourhood of a record being
 * written *now* was the one check guaranteed not to see that neighbourhood.
 *
 * Reported independently by two integrators, symptoms an order of magnitude apart: a 0.98-similar record
 * missed at ~14 s and caught at ~2 min on the **same** threshold (which is what proves elapsed time was
 * the variable, not the threshold), and a record invisible to recall for **150 s** while write-time
 * duplicate detection saw new records immediately.
 *
 * It bites exactly where it hurts. An agent writing a set of related records in one turn is *when*
 * duplicates get created, and that is precisely the window in which the check could not fire — every
 * warning named an older record, none named anything from the same batch.
 *
 * ## Why not `exact: true`
 *
 * The obvious fix, and it does not work. `$vectorSearch` with `exact: true` is an exhaustive scan of the
 * **index**, not of the collection — it skips the approximate traversal, it does not skip mongot. Measured
 * against the test stack (MongoDB 8.3.4, atlas-local), inserting a document and polling both paths:
 *
 * | path | first saw the fresh write |
 * |---|---|
 * | ANN (`numCandidates`) | 1088 ms |
 * | ENN (`exact: true`) | 1083 ms |
 *
 * Identical. Anything that goes through the search index inherits the lag, so the only thing that can see
 * a fresh write is the collection.
 *
 * ## What this does instead
 *
 * Scores the newest records **in the collection**, bounded twice over so the cost cannot run away:
 *
 *  - `$sort { seq: -1 }` + `$limit` — `seq` is already indexed (sync depends on it) and is monotonic per
 *    space, so "the newest N" is an index walk whose cost does not grow with the collection;
 *  - then a time window, applied *before* the vector math, so a quiet space scores nothing.
 *
 * Measured on 20,000 entities at 768 dimensions: **8.9 ms** when the window is empty, **51.8 ms** when it
 * is full. The existing ANN query costs 13.5 ms, so a busy space pays roughly four times one search — and
 * a busy space is the one that needs this. Both numbers are flat in collection size.
 *
 * The pipeline computes `dot` and the document's norm and **nothing else**: the mapping from those to a
 * score lives once, in {@link atlasScoreFromParts}. Restating Atlas's formula in MQL would have been the
 * two-implementations-of-one-rule shape that keeps costing this repo bugs.
 */
import { col } from '../db/mongo.js';
import { getEmbeddingConfig } from '../config/loader.js';
import { atlasScoreFromParts, norm } from './vector-score.js';
import { log } from '../util/log.js';
import { envInt } from '../config/env-num.js';
import { recallFreshWritesFoundTotal } from '../metrics/registry.js';

/**
 * How far back "fresh" reaches.
 *
 * Sized from the worst report rather than the local measurement: index lag was ~1 s on an idle test stack
 * and **150 s** on the loaded deployment that reported it. A window shorter than the lag it compensates
 * for would close exactly when the deployment is busy enough to need it.
 */
export const FRESH_WINDOW_MS = envInt('DUPE_FRESH_WINDOW_MS', 180_000);

/**
 * Hard ceiling on documents scored per check, whatever the window says.
 *
 * The window alone is not a bound: a bulk import writes thousands of records inside it. 200 costs ~52 ms
 * at 768 dimensions and covers the newest — which, ordered by `seq`, are the ones a just-written record is
 * most likely to duplicate. When it truncates, that is logged rather than swallowed: a silent cap reads as
 * "checked everything" to whoever is looking at the result.
 */
export const FRESH_SCAN_CAP = envInt('DUPE_FRESH_SCAN_CAP', 200);

/** A candidate found in the collection rather than the index. */
export interface FreshMatch {
  _id: string;
  /** On the same scale as `$meta: 'vectorSearchScore'` — see {@link atlasScoreFromParts}. */
  score: number;
}

/**
 * Score the most recently written records in a collection against a query vector.
 *
 * Best-effort by design: every caller already has the index result in hand, so a failure here degrades to
 * exactly today's behaviour rather than failing the write it was invoked from.
 *
 * @param collName full collection name, e.g. `general_entities`
 * @param queryVector the vector being checked
 * @param now injectable clock — the window is the thing under test, so a test must be able to set it
 */
export async function matchFreshWrites(
  collName: string,
  queryVector: number[],
  now: number = Date.now(),
  /**
   * The caller's own predicate, applied with the freshness window.
   *
   * **Required for correctness, not an optimisation.** This scan adds records the index has not ingested,
   * and it used to add them UNFILTERED — which was survivable while it was opt-in and became a silent
   * wrong answer the moment it ran on every recall: `filter: {type: 'x'}` came back with a record whose
   * type is not `x`, at 200. A filtered search returning unfiltered results is the defect class this whole
   * area keeps producing, and the fix has to live here because this is the only `$match` the scan has.
   */
  predicate?: Record<string, unknown>,
): Promise<FreshMatch[]> {
  if (queryVector.length === 0) return [];

  // Everything, including reading the config, is inside the try.
  //
  // `getEmbeddingConfig()` throwing here would propagate into `checkDuplicates`, whose own catch returns
  // `[]` for the WHOLE check — discarding the index results it had already collected. A best-effort
  // addition that can take the working half down with it is not best-effort, and the two lines that used
  // to sit above this were the only way that could happen.
  try {
    const similarity = getEmbeddingConfig().similarity;
    const queryNorm = norm(queryVector);
    const cutoff = new Date(now - FRESH_WINDOW_MS).toISOString();

    const rows = await col(collName).aggregate<{ _id: string; dot: number; norm: number }>([
      // Newest first, capped, BEFORE anything expensive. This is the index walk that keeps the cost flat.
      { $sort: { seq: -1 } },
      { $limit: FRESH_SCAN_CAP },
      // Then the window, and then the vector math — in that order, so a quiet space pays for neither.
      // `embedding` is absent on a record still queued for embedding, and on one excluded from vector
      // search; both are correctly invisible to a similarity check.
      { $match: { updatedAt: { $gte: cutoff }, embedding: { $type: 'array' }, ...(predicate ?? {}) } },
      {
        $project: {
          _id: 1,
          dot: {
            $reduce: {
              input: { $zip: { inputs: ['$embedding', queryVector] } },
              initialValue: 0,
              in: {
                $add: ['$$value', {
                  $multiply: [{ $arrayElemAt: ['$$this', 0] }, { $arrayElemAt: ['$$this', 1] }],
                }],
              },
            },
          },
          norm: {
            $sqrt: {
              $reduce: {
                input: '$embedding',
                initialValue: 0,
                in: { $add: ['$$value', { $multiply: ['$$this', '$$this'] }] },
              },
            },
          },
          // `$zip` truncates to the shorter input, so a document embedded by a different model would score
          // against a prefix of itself and land anywhere. Carry the length and drop those below.
          dims: { $size: '$embedding' },
        },
      },
    ]).toArray() as Array<{ _id: string; dot: number; norm: number; dims: number }>;

    if (rows.length === FRESH_SCAN_CAP) {
      log.warn(
        `Fresh-write duplicate scan hit its ${FRESH_SCAN_CAP}-document cap on ${collName}: only the newest ` +
        `${FRESH_SCAN_CAP} records of the last ${Math.round(FRESH_WINDOW_MS / 1000)}s were compared. ` +
        'Raise DUPE_FRESH_SCAN_CAP if this space sustains that write rate.',
      );
    }

    const out: FreshMatch[] = [];
    for (const r of rows) {
      if (r.dims !== queryVector.length) continue;    // mid-migration between embedding models
      const score = atlasScoreFromParts(r.dot, r.norm, queryNorm, similarity);
      if (score === null) continue;                    // unrecognised metric — no opinion
      out.push({ _id: r._id, score });
    }
    return out;
  } catch (err) {
    log.debug(`Fresh-write scan skipped for ${collName}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Add the records the vector index has not ingested yet to a recall's results, in place.
 *
 * ## Why this is here and not in `recall.ts`
 *
 * *"What has the index not caught up with"* is one question, and {@link matchFreshWrites} — the scan that
 * answers it — already lives in this file. The orchestration around it sat in `recall.ts` instead, which is
 * the largest file in the brain and the last place a reader looks for the fresh-write behaviour. The
 * god-file ratchet objected to it growing there, correctly.
 *
 * ## Best-effort in the strongest sense
 *
 * A failure here contributes nothing rather than taking the index results down with it: a search that
 * answers less is a worse outcome than a search that answers without the newest few seconds. That is why
 * the per-collection scan catches, and why this function has no failure mode of its own to report.
 *
 * ## It runs unconditionally since 5.0
 *
 * It was `includeFreshWrites`, opt-in, and the flag was removed. Measured: a plain recall answered nothing
 * for three seconds after a write, then found the record. The cost with 220 records inside the window is
 * 91–101 ms against 159–167 ms, and nothing at all on a quiet space — the time filter matches no documents
 * and no vector arithmetic runs. Owner: *"if checking the parameter takes >10ms remove the parameter and
 * just always do it."*
 *
 * @param hydrate the caller's loader, so a fresh hit comes back through the SAME projection the index
 *   results did. A caller must not be able to tell which channel found a record — the moment they can, this
 *   stops being "search harder" and becomes a second result type to handle.
 * @param collectionOf maps a knowledge type to its per-space collection suffix. Passed in rather than
 *   imported, so this module keeps its one question — *what has the index not caught up with* — and does
 *   not acquire an opinion about how a space names its collections.
 */
export async function addFreshWrites<T extends string, R extends { _id: string }>(
  spaceId: string,
  activeTypes: readonly T[],
  queryVector: number[],
  results: R[],
  collectionOf: (type: T) => string,
  hydrate: (spaceId: string, hits: { type: T; id: string; score: number }[]) => Promise<R[]>,
  /** The recall's own tag and filter predicate — see {@link matchFreshWrites}. Omitted means unfiltered. */
  predicate?: Record<string, unknown>,
): Promise<void> {
  const seen = new Set(results.map(r => r._id));
  const perType = await Promise.all(activeTypes.map(async type => ({
    type,
    matches: await matchFreshWrites(`${spaceId}_${collectionOf(type)}`, queryVector, Date.now(), predicate)
      .catch(() => []),
  })));
  const missing = perType.flatMap(({ type, matches }) =>
    matches.filter(m => !seen.has(m._id)).map(m => ({ type, id: m._id, score: m.score })));
  if (missing.length === 0) return;

  const hydrated = await hydrate(spaceId, missing);
  results.push(...hydrated);
  /*
   * Counted, NOT reported as `degraded`. This search found MORE than the index could offer, which is the
   * opposite of degradation, and `ythril_recall_degraded_total` documents its own reason set as closed
   * precisely so it does not accumulate labels that mean unrelated things.
   *
   * What the count is worth is turning "the index lags" from an anecdote into a measurement: every
   * increment is a record a plain recall would have missed.
   */
  recallFreshWritesFoundTotal.inc(hydrated.length);
}
