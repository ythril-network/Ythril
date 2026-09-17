/**
 * Which path a recall's FILTER took, as a channel the search writes into.
 *
 * Its own module because three unrelated things need it and none of them owns it: `recall` and
 * `recallGlobal` write to it, and both doors' result builders read it to decide whether to disclose
 * `filterPath`. Living inside `recall.ts` made it a thing you had to already know about to find, in the
 * largest file in the brain — and the god-file ratchet objected to it growing there, correctly.
 */
/**
 * Whether the FILTER could be pushed into the index — observed at the branch that decides it, never
 * predicted from the filter's keys.
 *
 * Predicting is close and can be wrong: a key can be index-servable in general and undeclared in THIS
 * space's schema, and a plausible wrong answer is worse here than none, because it is the number somebody
 * will use to decide their filter is fine.
 *
 * ## It reports the PLAN, and the index-error fallback is deliberately outside it
 *
 * `recallByType` retries on the exhaustive path when a native-filtered query throws — the index is still
 * building, or the collection has none because it is empty. That retry was counted here at first, on the
 * reasoning that *the caller paid for a scan whatever the plan said*. Measured against a real instance, it
 * made the disclosure useless: a recall spans five collections, most spaces do not hold all five kinds, and
 * the empty ones have no queryable index — so **every recall in such a space reported `exhaustive`**,
 * including one whose filter pushed perfectly for the collection that had the data. A signal that is on
 * almost always is not a signal, and a permanent false alarm teaches a caller to ignore the real one.
 *
 * The question this answers is *"did MY FILTER force a scan?"*, because that is the one the caller can act
 * on — they can rewrite the filter or declare the property. They can do nothing about an index warming up,
 * and a scan of an empty collection is not a cost anybody paid.
 *
 * Mutable and passed in, rather than returned, because `recallByType` answers per collection and is called
 * from three places that all want `RecallResult[]` and nothing else. One collection planning a scan is the
 * answer for the whole call.
 */
export interface RecallPathObservation {
  /** A collection was restricted by the index before scoring. */
  prefilter(): void;
  /** A collection was scored exhaustively and filtered after — the expensive path. */
  scanned(): void;
}

/** A fresh observation. `path` is `undefined` until something is observed, so an unfiltered recall
 *  reports no path at all rather than a plausible one — the same reason a removed gauge beats a
 *  gauge pinned at zero. `exhaustive` wins: one collection scanning is the cost the caller paid. */
export function observeRecallPath(): RecallPathObservation & { path(): 'prefilter' | 'exhaustive' | undefined } {
  let seen: 'prefilter' | 'exhaustive' | undefined;
  return {
    prefilter() { if (seen === undefined) seen = 'prefilter'; },
    scanned() { seen = 'exhaustive'; },
    path() { return seen; },
  };
}
