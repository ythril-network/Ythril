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
 *
 * ## Rows are walked a window at a time, and each is still its own walk (Q-136)
 *
 * Handed the page's `seeds`, the walker walks up to `ROW_WALK_WINDOW` rows ahead together (`walk-in-step.ts`):
 * one edge read and one record read per kind per hop for the whole window, each row keeping its own visited
 * set, paths and bookkeeping. Every row's graph is byte-for-byte its per-seed graph, because each row's reads
 * are answered with exactly what its own reads would have returned — and a row whose share of an edge read
 * would fill its own `limit` (a hub over the row ceiling, a node whose edges all lead back) is answered by its
 * own read, alone, for that read. See `walk-in-step.ts` for the rule and why a union cannot be trusted to
 * reproduce a capped edge read.
 *
 * Everything that decides the ANSWER still happens here, one row at a time and in order, when the row is
 * asked for: the call's walked-node total, the deadline check before a later row, and the judgement of the
 * row. So a row walked ahead that the answer never reaches — past the byte budget, the call's walk bound or
 * the deadline — changes nothing but the time spent; and a walk the deadline stopped is reported for the row
 * it belongs to, `deadline` for the first and `stop` after it, exactly as a row walked alone reports it.
 *
 * Without `seeds` each row is walked alone, as it always was — the reference the window is tested against.
 */
import { traverseFromSeeds, WalkDeadlineExceeded, type SeedTraverse, type WalkReads } from './recall-seed-traversal.js';
import { walkInStep, newRecordCache } from './walk-in-step.js';
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
 * How many rows are walked together. Sixteen is a page of a typical `topK` in one window, so most answers
 * walk once; a larger window walks further past a byte budget that stops the answer early, for rows nobody
 * receives.
 */
export const ROW_WALK_WINDOW = 16;

type WalkSeed = { _id: string; spaceId: string };

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
  /**
   * Every row of the answer, in order — the rows a window may walk ahead of the one asked for. Absent, each
   * row is walked alone. A seed not in this list is walked alone too.
   */
  seeds?: readonly WalkSeed[];
  /** Rows per window; `ROW_WALK_WINDOW` unless a test says otherwise. */
  window?: number;
}): (seed: WalkSeed, first: boolean) => Promise<RowGraph> {
  const allowed = new Set(opts.memberIds);
  let walked = 0;
  const window = Math.max(1, opts.window ?? ROW_WALK_WINDOW);
  const seeds = opts.seeds ?? [];
  /** A row by what it IS, not by which object carries it — a caller may hand the same row in a new object. */
  const keyOf = (s: WalkSeed): string => `${s.spaceId}\u0000${s._id}`;
  const position = new Map<string, number>();
  seeds.forEach((s, i) => { if (!position.has(keyOf(s))) position.set(keyOf(s), i); });
  /** Rows a window has started walking — each is walked ahead once; asked for again, it is walked alone. */
  const started = new Set<string>();
  const ahead = new Map<string, Promise<SeedTraverse>>();
  const cache = newRecordCache();
  const walkable = (s: WalkSeed): boolean => opts.maxDepth >= 1 && allowed.has(s.spaceId);

  /** Walk the window starting at `from`, one step per space, each row's walk held until its row is asked for. */
  const walkWindow = (from: number, rowNodes: number): void => {
    const bySpace = new Map<string, WalkSeed[]>();
    for (let i = from; i < Math.min(seeds.length, from + window); i++) {
      const s = seeds[i]!;
      if (started.has(keyOf(s)) || !walkable(s)) continue;
      started.add(keyOf(s));
      const group = bySpace.get(s.spaceId);
      if (group) group.push(s); else bySpace.set(s.spaceId, [s]);
    }
    for (const group of bySpace.values()) {
      const walks = walkInStep(group.map(s => (reads: WalkReads) =>
        traverseFromSeeds(s.spaceId, [s._id], opts.maxDepth, rowNodes + 1, opts.narrowing, opts.deadline, reads)), cache);
      group.forEach((s, i) => {
        const w = walks[i]!;
        // Held, not awaited: a row the answer never reaches must not surface its failure as an unhandled one.
        w.catch(() => undefined);
        ahead.set(keyOf(s), w);
      });
    }
  };

  /** This row's walk: from its window, or alone when it has none. */
  const walkOf = (seed: WalkSeed, rowNodes: number): Promise<SeedTraverse> => {
    const key = keyOf(seed);
    const at = position.get(key);
    if (at !== undefined && !started.has(key)) walkWindow(at, rowNodes);
    const held = ahead.get(key);
    if (held) { ahead.delete(key); return held; }
    // One node MORE than the ceiling is the probe: exactly the ceiling is a complete row.
    return traverseFromSeeds(seed.spaceId, [seed._id], opts.maxDepth, rowNodes + 1, opts.narrowing, opts.deadline);
  };

  return async (seed, first) => {
    const bounds = walkBounds();
    if (!first && walked >= bounds.callNodes) return { stop: 'walk_budget' };
    if (!first && opts.deadline() <= 0) return { stop: 'deadline' };
    // Fail closed: a seed outside the caller's spaces is never walked. It cannot reach here through a search —
    // the seeds come from the same space list — so this is a guard, not a path.
    if (!walkable(seed)) return { nodes: undefined };
    try {
      const walk = await walkOf(seed, bounds.rowNodes);
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
