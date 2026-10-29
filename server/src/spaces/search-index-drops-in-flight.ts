/**
 * The search-index drops of a deleted space that are still running, and the wait a space of the same id makes for them.
 *
 * ## What it prevents
 *
 * `dropSpaceData` bounds each collection's index drop by `SPACE_ACT_SEARCH_INDEX_MS` (Q-176), and a bound does not cancel the
 * call: mongot's list and drop go on running after the delete has moved on and committed. A space created under the same id (or
 * a rename INTO it) then builds `<id>_<suffix>_embedding`, and the orphaned drop, which names an index by the collection's
 * prefix, drops the NEW one and forgets it in `liveIndexNames`: a space that is up with no vector search, and nothing says so.
 *
 * ## The one question
 *
 * "Is a drop of this id's indexes still running?" Every drop of a deleted space's indexes is registered here for as long as
 * it runs (`trackSearchIndexDrop`: the entry leaves in a `finally`, when the drop SETTLES, not when its bound ends), and a door
 * that is about to give the id to a space asks {@link settleSearchIndexDropsOf}. The bound sits inside it, so a caller cannot
 * wait for ever or forget to wait: it waits up to `SPACE_ACT_SEARCH_INDEX_MS` for the drop to settle and, when one is still
 * running, refuses with {@link SpaceStillBeingRemoved}, which every door answers as a retryable `503` with the same code.
 *
 * In memory only: the drops it tracks die with the process, and a boot resume of a delete (`dropSpaceData` again) registers its own.
 */
import { spaceActKnob } from './space-act-contract.js';
import { isTimeBoundEnded, withinTimeBound } from '../util/time-bound.js';

/** The machine name of the refusal, in `body.code` on REST and `structuredContent.code` on MCP. */
export const SPACE_STILL_BEING_REMOVED = 'space_still_being_removed';

/** Seconds a REST door puts in `Retry-After` for it: a drop that is still running is mongot's, and ends within a few. */
export const SPACE_STILL_BEING_REMOVED_RETRY_AFTER_S = 5;

/** The id is not free yet: a search-index drop of the space that held it is still running. Retryable; nothing was written. */
export class SpaceStillBeingRemoved extends Error {
  override readonly name = 'SpaceStillBeingRemoved';
  readonly code = SPACE_STILL_BEING_REMOVED;
  constructor(readonly spaceId: string) {
    super(`The id '${spaceId}' is not free yet: the search indexes of the space that held it are still being removed. Try again in a few seconds.`);
  }
}

const running = new Map<string, Set<Promise<unknown>>>();

/**
 * Register `drop` against `spaceId` until it settles and return it unchanged. The entry is removed in a `finally`, however the drop
 * ends, so a failed drop never holds an id.
 */
export function trackSearchIndexDrop<T>(spaceId: string, drop: Promise<T>): Promise<T> {
  let set = running.get(spaceId);
  if (!set) running.set(spaceId, set = new Set());
  const mine = set;
  const entry = drop.then(() => undefined, () => undefined).finally(() => {
    mine.delete(entry);
    if (mine.size === 0 && running.get(spaceId) === mine) running.delete(spaceId);
  });
  mine.add(entry);
  return drop;
}

/**
 * Wait until no drop of `spaceId`'s search indexes is running, up to `SPACE_ACT_SEARCH_INDEX_MS`; throw {@link SpaceStillBeingRemoved}
 * when one still is. Returns at once when none is registered, which is every call but the one that races a slow mongot.
 */
export async function settleSearchIndexDropsOf(spaceId: string): Promise<void> {
  const set = running.get(spaceId);
  if (!set || set.size === 0) return;
  try {
    await withinTimeBound(Promise.all([...set]), spaceActKnob('SPACE_ACT_SEARCH_INDEX_MS'), `the search-index drops of ${spaceId}`);
  } catch (err) {
    if (isTimeBoundEnded(err)) throw new SpaceStillBeingRemoved(spaceId);
    throw err;
  }
}
