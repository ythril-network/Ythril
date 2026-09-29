/**
 * What a recall answer says about the GRAPH it returned, as opposed to the matches.
 *
 * ## Its own module because `api.types.ts` is frozen, and the freeze is right
 *
 * The god-file ratchet refused these fields with the instruction it always gives: *"put the new behaviour
 * beside it rather than inside it"*. They describe one subject, they carry more prose than the fields around
 * them, and `RecallResponse` extends this instead of absorbing it.
 *
 * ## The rule these fields report (Q-126)
 *
 * Owner, 2026-09-28: *"if the requested graph doesnt fit the whole resultrow including the root should be not
 * returned"*. Every match in `results` carries its WHOLE graph. A match whose graph could not be read whole is
 * not shown with part of it — it is left out and named in `incompleteRows`. So a returned graph is never
 * short, and what this module reports is which matches were withheld and why, and which bound ended the
 * answer. `graphComplete`, the link to a spilled whole graph beside a shortened inline one, is gone with the
 * shortened graph it came with.
 */

/** Why a match was left out. The server's `INCOMPLETE_ROW_REASONS`, which this mirrors. */
export type IncompleteRowReason = 'walk_ceiling' | 'link_scan' | 'paths' | 'deadline';

/** One match left out because its graph could not be read whole — named so the reader knows it exists. */
export interface IncompleteRow {
  _id: string;
  spaceId: string;
  type: string;
  /** Its name, title or a one-line summary. */
  name: string;
  reason: IncompleteRowReason | string;
}

/** The graph half of a recall or find-similar response. */
export interface RecallGraphReport {
  /** How many traversed nodes came back, counted from the payload actually sent. */
  graphNodes?: number;
  /**
   * At least one match was left out because its graph could not be read whole — exactly when
   * `incompleteCount` is present. It never means a returned graph is short: none is.
   */
  graphTruncated?: boolean;
  /** How many matches were left out that way, named or not. */
  incompleteCount?: number;
  /** The left-out matches, at most a fixed number named; `incompleteCount` counts them all. */
  incompleteRows?: IncompleteRow[];
  /**
   * Beside `truncated` and `nextSkip`: which bound ended the answer. `budget` is the byte budget; the other two
   * are the graph walk's — the most one search may walk, and its deadline.
   */
  truncatedBy?: 'budget' | 'walk_budget' | 'deadline' | string;
}
