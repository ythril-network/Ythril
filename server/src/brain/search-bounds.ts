/**
 * How much work one search may do — the bounds on the WORK, which the owner ruled is where they belong.
 *
 * `topK` has no ceiling on either door (owner, P-34, 2026-09-04: *"why do we need a cap? Only thing that
 * matters is we only get full records and it warns when anything is truncated"*). What a cap on the request
 * used to bound is bounded here instead, on the work each request drives, and every door reads the same
 * numbers from this one module.
 *
 * Every bound here ends an answer the way the byte budget does (owner, 2026-09-28: *"all budgets and ceilings
 * should work that way on all doors"*): whole rows or absent, the cut stated, nothing written unless asked.
 * None of them shortens a row.
 */

/**
 * The most nodes one result row's graph may hold. A row whose neighbourhood is larger is not returned — it is
 * named in `incompleteRows` with reason `walk_ceiling` — because a shortened graph would not be what the
 * caller asked for, and an unbounded one would let one hub make a single row unbounded.
 */
export const MAX_ROW_GRAPH_NODES = 5000;

/**
 * The most nodes all the rows of ONE call may walk, rows that turn out incomplete included — they cost the
 * walk even though they add nothing to the answer, which is exactly why they must count. Past it the answer
 * ends at the first unwalked row with `truncatedBy: 'walk_budget'`.
 */
export const MAX_CALL_WALK_NODES = 50_000;

export interface WalkBounds { rowNodes: number; callNodes: number }

let override: Partial<WalkBounds> | null = null;

/** The bounds in force. Read per call, so a test can lower them without restarting the module. */
export function walkBounds(): WalkBounds {
  return {
    rowNodes: override?.rowNodes ?? MAX_ROW_GRAPH_NODES,
    callNodes: override?.callNodes ?? MAX_CALL_WALK_NODES,
  };
}

/**
 * Lower the bounds for a test, or restore them with `null`. The real numbers are far too large for a fixture to
 * reach, and a bound nobody has seen bite is a claim.
 */
export function overrideWalkBoundsForTest(bounds: Partial<WalkBounds> | null): void {
  override = bounds;
}

/**
 * The most candidates one TYPE may be fetched for a single recall, however large `topK` is (moved here from
 * `recall.ts`, `Q-103`).
 *
 * The per-type over-fetch is the reranking mechanism and scales with `topK`, so without this a `topK: 100000` becomes
 * a query for a million candidates rather than a slow answer. 2000 sits between the vector search's own candidate
 * default (1000) and its ceiling (10000): no realistic request meets it, and an unrealistic one is bounded, not refused.
 */
export const MAX_PER_TYPE_CANDIDATES = 2000;

/** How many of one type a recall fetches: `topK` over-fetched by `multiplier`, never past the per-type bound. */
export function perTypeFetch(topK: number, multiplier: number): number {
  return Math.min(Math.ceil(topK * multiplier), MAX_PER_TYPE_CANDIDATES);
}

/**
 * How many of one type a `minPerType` floor fetches. The guide promises the floor is clamped to `topK`, and without the
 * per-type bound as well a floor of 1001 was a second route to the vector stage's `limit > numCandidates` failure.
 */
export function floorFetch(floor: number, topK: number): number {
  return Math.min(floor, topK, MAX_PER_TYPE_CANDIDATES);
}

/**
 * The vector stage's sizing for `limit` results (`Q-103`). The index refuses `limit > numCandidates`, and the
 * candidate count stopped at 1000 while `limit` followed `topK` — so any per-type fetch above 1000 answered a 500
 * labelled retryable. 15x oversampling up to 1000 as before, and never fewer candidates than the limit asks for; with
 * `limit` bounded by `MAX_PER_TYPE_CANDIDATES` this stays well inside the index's 10000.
 */
export function annCandidates(limit: number): { numCandidates: number; limit: number } {
  return { limit, numCandidates: Math.max(limit, Math.min(limit * 15, 1000)) };
}

/** Milliseconds left of a deadline that started at `startedAt` and lasts `budgetMs`. Negative once spent. */
export function deadlineFrom(startedAt: number, budgetMs: number): () => number {
  return () => budgetMs - (Date.now() - startedAt);
}
