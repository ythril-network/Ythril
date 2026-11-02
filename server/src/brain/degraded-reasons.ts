/**
 * Every reason a recall can answer `degraded` for — one closed vocabulary, in one place.
 *
 * The reasons used to be string literals at each `noteDegraded` call, with the metric's pre-declared series a
 * third hand-written list in `metrics/registry.ts` and the docs three more. It had already drifted:
 * `search_timeout` was in the integration guide's reason table and missing from the metric's documented row.
 * `filter_window` is the reason whose absence IS the defect it reports (a filtered answer that may be missing
 * matching records, said nowhere), so it is the worst one to lose from a copy.
 *
 * Closed on purpose: the same values label `ythril_recall_degraded_total`, and an unbounded set here would be an
 * unbounded metric label there. A client must still treat a reason it does not know as "degraded" — the set
 * grows between releases. `every-degraded-reason-is-one-constant-and-documented.test.js` holds the docs to it.
 */
export const DEGRADED_REASONS = [
  /** The reranker was configured and did not answer; the fused order was returned. */
  'rerank_unavailable',
  /** Too little of the budget was left to start the reranker; the fused order was returned. */
  'rerank_skipped_budget',
  /** A collection's search ran out of time; what the others found was returned. */
  'search_timeout',
  /** A filtered answer could not be completed, so it may be missing records that satisfy the filter. */
  'filter_window',
  /**
   * `topK` asked for more of one type than a recall fetches (`MAX_PER_TYPE_CANDIDATES`), and that type filled the
   * bound — so it may hold matches the recall never considered (`Q-103`).
   */
  'candidate_cap',
  /**
   * A collection's vector index is absent or still being built (or rebuilt) over records it should serve — records
   * older than the fresh-write window — so the answer may be missing them (`Q-326`). Never on a new or empty
   * collection: the fresh-write scan already holds every record of one.
   */
  'index_not_ready',
  /**
   * A collection's vector index exists and refused for another reason (a dimension mismatch, a path not indexed as
   * vector, a failed index), over records it should serve: that collection's records are missing until an operator
   * repairs the index; what the other collections found was returned (`Q-326`).
   */
  'index_unavailable',
] as const;

export type DegradedReason = typeof DEGRADED_REASONS[number];
