/**
 * The whole `_graph` of one result row — or why this row cannot have one.
 *
 * ## The rule it serves (Q-126)
 *
 * Owner, 2026-09-28: *"if the requested graph doesnt fit the whole resultrow including the root should be not
 * returned"*, and *"if i get a result i want to be sure i get what i asked for"*. A returned row is its record
 * and its WHOLE neighbourhood to the depth asked for, or it is not returned.
 *
 * It replaces `buildGraphWithSpill`, which walked every seed together, cut the merged neighbourhood to an inline
 * node cap (`slice(0, inlineCap)`) and wrote the complete graph to a spill nobody had asked for. So a row came
 * back with part of its graph — whichever nodes the cut happened to keep — and the answer said `graphTruncated`
 * about all of it at once. That reversed the 2026-08-13 ruling that asked for the spill, and the owner's ruling
 * of 2026-09-28 supersedes it: a spill only when `remainderDump: true` is sent.
 *
 * ## One seed at a time, and what that changes
 *
 * Each seed is walked on its own, so its graph is exactly the neighbourhood asked for. Another matched record
 * can therefore appear inside a row's graph, and a node reached from two rows appears, complete, under both
 * (owner, 2026-08-13: *"a node appearing under more than one parent must be COMPLETE wherever it appears"*).
 * The walk runs only in the seed's own space, and only when that space is in `memberIds` — the caller's rights
 * decide `memberIds`, and an empty list walks nothing.
 *
 * ## Why a row is incomplete
 *
 * - `walk_ceiling` — its neighbourhood holds more than `MAX_ROW_GRAPH_NODES`.
 * - `link_scan` — a bounded read of its edges or links stopped before it ran out, so nodes were never read.
 * - `paths` — a node in it can be reached more ways than `MAX_ALT_PATHS_PER_NODE`, so `paths` would be short.
 * - `deadline` — the page's FIRST row could not be walked before the deadline. It is consumed, so the next page
 *   does not start on it again; every page makes progress.
 *
 * A later row that meets the deadline or the call's walk bound is not walked at all: the answer ends there
 * (`stop`) and `nextSkip` points at it, because it may well be complete given time.
 */
import { traverseFromSeeds, WalkDeadlineExceeded } from './recall-seed-traversal.js';
import { nestNeighbours, type GraphNode } from './recall-graph.js';
import type { TraverseNarrowing } from './frontier-query.js';
import { walkBounds } from './search-bounds.js';
import { isMaxTimeExpired } from '../db/max-time.js';

export const INCOMPLETE_ROW_REASONS = ['walk_ceiling', 'link_scan', 'paths', 'deadline'] as const;
export type IncompleteRowReason = typeof INCOMPLETE_ROW_REASONS[number];

/** Why an answer ended before its last row, when it was not the byte budget. */
export const WALK_STOPS = ['walk_budget', 'deadline'] as const;
export type WalkStop = typeof WALK_STOPS[number];

export type RowGraph =
  | { nodes: GraphNode[] | undefined }
  | { incomplete: IncompleteRowReason }
  | { stop: WalkStop };

/**
 * Whether one finished walk is the WHOLE neighbourhood, and if not, why. Pure, so every reason can be seen to
 * bite without a database; the walker is its only production caller.
 *
 * The walk was asked for `rowNodes + 1` nodes, so more than `rowNodes` coming back is the probe firing: exactly
 * `rowNodes` is a complete row and is returned.
 */
export function whyRowIsShort(
  walk: { neighbours: readonly { altPathsTruncated?: boolean }[]; scanCapped: boolean },
  rowNodes: number,
): IncompleteRowReason | null {
  if (walk.neighbours.length > rowNodes) return 'walk_ceiling';
  if (walk.scanCapped) return 'link_scan';
  if (walk.neighbours.some(n => n.altPathsTruncated)) return 'paths';
  return null;
}

/**
 * A walker for one call. It keeps the call's running total, so every row it walks — complete or not — counts
 * against `MAX_CALL_WALK_NODES`.
 *
 * `first` is true for the first row of the page: that row is always walked (bounded by the row ceiling and the
 * per-query deadline) so a page can never come back empty for want of time.
 */
export function rowGraphWalker(opts: {
  memberIds: readonly string[];
  maxDepth: number;
  narrowing?: TraverseNarrowing;
  /** Milliseconds left of the call's ONE deadline. */
  deadline: () => number;
}): (seed: { _id: string; spaceId: string }, first: boolean) => Promise<RowGraph> {
  const allowed = new Set(opts.memberIds);
  let walked = 0;
  return async (seed, first) => {
    const bounds = walkBounds();
    if (!first && walked >= bounds.callNodes) return { stop: 'walk_budget' };
    if (!first && opts.deadline() <= 0) return { stop: 'deadline' };
    // Fail closed: a seed outside the caller's spaces is never walked. It cannot reach here through a search —
    // the seeds come from the same space list — so this is a guard, not a path.
    if (opts.maxDepth < 1 || !allowed.has(seed.spaceId)) return { nodes: undefined };
    try {
      // One node MORE than the ceiling is the probe: exactly the ceiling is a complete row.
      const walk = await traverseFromSeeds(
        seed.spaceId, [seed._id], opts.maxDepth, bounds.rowNodes + 1, opts.narrowing, opts.deadline);
      walked += walk.neighbours.length;
      const short = whyRowIsShort(walk, bounds.rowNodes);
      if (short) return { incomplete: short };
      return { nodes: nestNeighbours(walk.neighbours, [seed._id]).bySeed.get(seed._id) };
    } catch (err) {
      if (!(err instanceof WalkDeadlineExceeded) && !isMaxTimeExpired(err)) throw err;
      return first ? { incomplete: 'deadline' } : { stop: 'deadline' };
    }
  };
}
