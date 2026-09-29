/**
 * Score one recall's candidate pool with the cross-encoder, in ONE request, and stamp `rerankScore` in place.
 *
 * Its own module because it has two callers that must not drift: `recall` reranks a single space's pool, and
 * `recallGlobal` reranks the MERGED pool of every space it fanned out to. Until 2026-09-23 the second did
 * not exist — each per-space `recall` ran its own pass, so a recall over 15 spaces sent 13 concurrent
 * requests of up to `MAX_CANDIDATES` passages to one model, ten of which died under the shared deadline
 * (platform operator, 2026-09-23T1842Z). The embedding stage had the same fan-out and was fixed the same way:
 * do the per-query work once, at the point where the per-space results meet.
 *
 * Both lists are passed because a floor-guaranteed result competes for order with the global ones — a
 * reranker that saw only half the pool would produce two incomparable orderings in one response. Deduped by
 * `_id` so a record appearing in both lists is scored once and every reference updated.
 *
 * Best-effort throughout: a `null` from the reranker leaves every result untouched, and the caller falls back
 * to the fused order. It never throws, because a reranker outage must not turn into a failed search.
 */
import { rerank, MAX_CANDIDATES } from './rerank-client.js';
import { rerankTextOf } from './recall-shape.js';
import type { RecallResult } from './recall.js';
import type { DegradedReason } from './degraded-reasons.js';

/** The scorer's contract: `null` means no opinion. Injectable so the one-request property can be tested. */
export type RerankScorer = typeof rerank;

export async function rerankPool(
  query: string,
  guaranteed: RecallResult[],
  allResults: RecallResult[],
  /** What is left of the call's budget. The reranker's own timeout is capped to it. */
  budgetMs: number,
  /**
   * How this step says it did not run — the SAME channel the budget skip uses, so a reranker that is down
   * is visible to the caller holding the answer and not only on a dashboard. Found when every call came
   * back `413` from a stock text-embeddings-inference server while `degraded` was null and the results
   * looked fine.
   */
  noteDegraded: (reason: DegradedReason) => void,
  score: RerankScorer = rerank,
  /**
   * Which key picks the candidates the cap keeps, and only the CALLER can say. `fused` when one fusion ranked
   * the whole pool — a single space whose lexical channel ran — so a record the lexical channel rescued from a
   * low vector score is scored rather than cut. `vector` otherwise, and always across spaces: RRF is
   * rank-based, so every space's rank 1 fuses to the same value, while vector scores compare across spaces
   * (one model, one query vector).
   */
  opts: { order?: 'fused' | 'vector' } = {},
): Promise<void> {
  // One entry per distinct record, holding every reference to it so a single score updates all of them.
  const byId = new Map<string, RecallResult[]>();
  for (const r of [...guaranteed, ...allResults]) {
    const refs = byId.get(r._id);
    if (refs) refs.push(r); else byId.set(r._id, [r]);
  }
  /*
   * What the cap keeps: floor results first, then the pool by the caller's key, then `_id`.
   *
   * The cap is a cost ceiling, not a sampling strategy, so it drops the least plausible candidates — and a
   * scored result now outranks every unscored one (`byRankThenId`), so a candidate the cap cuts cannot reach
   * the top. A floor result is in the answer whatever its score, so it is always scored; ordering it by vector
   * score would cut exactly the low-scoring record the floor exists to keep (`Q-79`). The key is read from the
   * POOL copy of a record, because a floor copy has not been through fusion.
   */
  const floorIds = new Set(guaranteed.map(r => r._id));
  const poolCopy = new Map<string, RecallResult>();
  for (const r of allResults) if (!poolCopy.has(r._id)) poolCopy.set(r._id, r);
  // Computed once per record, not per comparison: a pool reaches thousands of candidates.
  const key = new Map<string, number>();
  for (const [id, refs] of byId) {
    const r = poolCopy.get(id) ?? refs[0]!;
    key.set(id, (opts.order === 'fused' ? r.fusedScore ?? r.score : r.score) ?? 0);
  }
  const ids = [...byId.keys()]
    .sort((a, b) => Number(floorIds.has(b)) - Number(floorIds.has(a)) || key.get(b)! - key.get(a)! || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
  if (ids.length === 0) return;

  const passages = ids.map(id => rerankTextOf(byId.get(id)![0]));
  const scores = await score(query, passages, budgetMs);
  if (!scores) {
    noteDegraded('rerank_unavailable');
    return; // no opinion — the fused order stands
  }

  for (const { index, score: s } of scores) {
    const id = ids[index];
    if (id === undefined) continue; // parseScores bounds this, but the pairing is worth not assuming
    for (const ref of byId.get(id)!) ref.rerankScore = s;
  }
}
