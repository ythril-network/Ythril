/**
 * What a recall answer says about the GRAPH it returned, as opposed to the matches.
 *
 * ## Its own module because `api.types.ts` is frozen, and the freeze is right
 *
 * The god-file ratchet refused these two fields with the instruction it always gives: *"put the new
 * behaviour beside it rather than inside it"*. That is the correct answer here rather than an obstacle —
 * these describe one subject, they carry more prose than the fields around them, and `RecallResponse`
 * extends this instead of absorbing it.
 *
 * ## The distinction the two fields exist for
 *
 * `truncated` on the response is the byte budget dropping whole MATCHES off the end of the ranking. This is
 * the WALK stopping, so what is missing are records the traversal never read. A caller who sees
 * `graphNodes: 7` cannot tell the whole neighbourhood from the first seven of forty, and before these were
 * typed the client could not tell either.
 */

import type { SpillLink } from './read-spill';

/**
 * The WHOLE graph, kept for the caller's own token, when the instance was able to keep it. What a spill is,
 * who may read it and for how long is `read-spill.ts`; a refused one is `spillRefused` on the answer.
 */
export interface GraphSpillLink extends SpillLink {
  /** How many traversed nodes the SPILL holds — the number the inline graph fell short of. */
  nodes: number;
  /**
   * The spill walk hit its OWN ceiling, so even the spill is not the whole graph.
   *
   * Rare and worth saying: without it a reader takes the download as the complete answer, which is the same
   * mistake one level down as taking the inline graph for it.
   */
  ceilingHit?: boolean;
}

/** The graph half of a recall or find-similar response. */
export interface RecallGraphReport {
  /** How many traversed nodes came back INLINE, counted from the payload actually sent. */
  graphNodes?: number;
  /**
   * The traversal stopped short, so the graph you were given is not the whole neighbourhood.
   *
   * Present only when it bit, which is the same shape as `truncated`: never read an absence as unknown.
   */
  graphTruncated?: boolean;
  /**
   * The whole graph, kept — present only when there WAS one to keep and it was not refused.
   *
   * Absent while `graphTruncated` is true is a real case rather than an omission, twice over: a bounded link
   * scan leaves nothing complete to keep, because the records missing from the graph are precisely the ones
   * never read; and a refused spill (`spillRefused` on the answer) keeps nothing.
   */
  graphComplete?: GraphSpillLink;
}
