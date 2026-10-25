/**
 * How a traversal narrows, and the Mongo predicate that applies it.
 *
 * ## Why its own module
 *
 * A-4 moved the recall seed traversal out of `edges.ts`, and this is the piece BOTH halves use: the standalone
 * `traverseGraph` stayed, `traverseFromSeeds` left, and each asks the same question of the same collection.
 *
 * It went sideways rather than travelling with either, for the reason `files-request.ts` records for the file
 * routes: taking a shared helper along leaves a copy behind, and one rule with two implementations is the
 * defect this codebase produces most. `frontierEdgeQuery` exists BECAUSE of that defect — it was written twice
 * and the copies disagreed, the standalone path honouring direction and labels while recall's did neither — so
 * duplicating it again during the extraction that separates its two callers would have been the same mistake a
 * second time.
 */

import type { LinkInclusion } from './link-frontier.js';
import { CHOSEN_VERSION_ROWS } from './chosen-versions.js';

/**
 * How a traversal narrows: which edge labels it follows and which way.
 *
 * One shape, shared by the standalone `traverse` and by recall's expansion, because they were two
 * implementations of one rule and recall had the weaker — it followed EVERY edge in BOTH directions, with no
 * way for a caller to say otherwise. On a corpus where a few nodes hold most of the edges, that is the
 * difference between a deliberate neighbourhood and whichever neighbours the node cap happened to keep.
 */
export interface TraverseNarrowing extends LinkInclusion {
  /** Follow only these labels. Absent or empty means every label, which is what it meant before. */
  edgeLabels?: string[] | undefined;
  /** Which way to walk. Defaults to `both`, which is what recall's expansion always did. */
  direction?: 'outbound' | 'inbound' | 'both' | undefined;
}

/**
 * The Mongo predicate for "edges touching this frontier, narrowed".
 *
 * Extracted because it was written twice and the copies disagreed: the standalone path applied a label filter
 * and honoured direction, recall's did neither. Writing the rule once is the only fix that cannot drift again —
 * `CLAUDE.md` names this exact shape as the defect this repo produces most.
 *
 * **A fork edge is not a neighbour** (Q-624): it carries its subject's endpoints, so following it would walk the same relationship twice. The clause
 * (`CHOSEN_VERSION_ROWS`) is inside this builder, so no traversal can drop it.
 */
export function frontierEdgeQuery(
  spaceId: string,
  frontier: string[],
  narrowing?: TraverseNarrowing,
): Record<string, unknown> {
  const labels = narrowing?.edgeLabels;
  const labelFilter = labels && labels.length > 0 ? { label: { $in: labels } } : {};
  const direction = narrowing?.direction ?? 'both';
  if (direction === 'outbound') return { spaceId, from: { $in: frontier }, ...labelFilter, ...CHOSEN_VERSION_ROWS };
  if (direction === 'inbound') return { spaceId, to: { $in: frontier }, ...labelFilter, ...CHOSEN_VERSION_ROWS };
  return { spaceId, $or: [{ from: { $in: frontier } }, { to: { $in: frontier } }], ...labelFilter, ...CHOSEN_VERSION_ROWS };
}
