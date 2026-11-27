/**
 * How long the upkeep waits before it starts a rebuild of a space again after rebuilds of it failed (bundle-273, Q-764, pre-ship lens finding R1).
 *
 * ## The question it answers
 *
 * "May the upkeep start a rebuild of this space now?" The upkeep tick (`verify.ts`) asks it for every space whose index needs a rebuild. A
 * rebuild reads every record of its space; one that fails every time (a record the form cannot state, a store that refuses the swap) would be
 * started at each tick for ever, a full scan of a large space each minute.
 *
 * ## The rule
 *
 * A space's failures are counted in a row. After the n-th the next rebuild waits `2^(n - 1)` upkeep intervals (1, 2, 4, ...), at most
 * {@link REBUILD_BACKOFF_MAX_MS}. A rebuild that ends `built` clears the count. What is no failure of the space never counts and never clears:
 * `busy` (another instance builds it), `stopped`, `no-form`, `form-changed`.
 *
 * ## What it prevents
 *
 * - **A retry loop with no bound.** The wait grows with each failure and has a ceiling, so a failing space costs at most one scan an hour.
 * - **A count that outlives the failure.** `settled` takes the outcome itself, so a caller cannot clear the count for an outcome that is no
 *   success, nor count one that is no failure. The count lives in memory: a restart is a new start, which the first tick retries.
 */
import { LruMap } from '../../util/lru-map.js';
import type { RebuildResult } from './rebuild.js';

/** The longest wait between two rebuilds of a space whose rebuilds keep failing. */
export const REBUILD_BACKOFF_MAX_MS = 60 * 60_000;
/** The spaces whose failures are remembered at most (the least recently failed is forgotten past it, and retried at the next tick). */
const SPACES_REMEMBERED = 10_000;

/** The backoff of the rebuilds of every space, for an upkeep that ticks every `intervalMs`. */
export interface RebuildBackoff {
  /** Whether a rebuild of `spaceId` may start at `now` (ms). */
  mayStart(spaceId: string, now: number): boolean;
  /** A rebuild of `spaceId` that was started ended: `outcome` is its result's, `null` when it threw. */
  settled(spaceId: string, outcome: RebuildResult['outcome'] | null, now: number): void;
}

export function rebuildBackoff(intervalMs: number): RebuildBackoff {
  const failures = new LruMap<string, { count: number; at: number }>(SPACES_REMEMBERED);
  return {
    mayStart(spaceId, now) {
      const f = failures.peek(spaceId);
      return f === undefined || now >= f.at + Math.min(2 ** (f.count - 1) * intervalMs, REBUILD_BACKOFF_MAX_MS);
    },
    settled(spaceId, outcome, now) {
      if (outcome === 'built') failures.delete(spaceId);
      else if (outcome === null) failures.set(spaceId, { count: (failures.peek(spaceId)?.count ?? 0) + 1, at: now });
    },
  };
}
