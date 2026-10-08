/**
 * One writer per key at a time, in the order they asked — the in-process mutex every "read, decide, write" over a key was
 * about to write by hand.
 *
 * ## Why a module
 *
 * The same chain was written by authors who each needed "no two of these at once for one key": a path's writers
 * (`files/stored-bytes.ts`, `withPathLock`), a collection's search-index reconciles (`spaces/search-index-presence.ts`) and a
 * file tombstone's publish — it reads a path's rows, decides, and writes, and two publishers that each read before the other
 * wrote published the path twice (`Q-352`). Single-flight and coalescing are the wrong semantics for every one of them: a
 * caller that waits must still RUN, after the one before it, with what that one left behind.
 *
 * ## What a hand-written copy drops
 *
 * **The release.** It is in a `finally`, so a callback that throws releases the key, and the chain behind it is never a
 * rejected promise: a failure is the caller's to see and never poisons the next caller. A copy that chained on the
 * callback's own promise made one failed writer fail every writer behind it.
 *
 * **The tidy-up.** A key whose last waiter has gone leaves the map, so a key space that a peer influences (paths) does not
 * grow for as long as the process lives.
 *
 * ## What it is not
 *
 * In-process only: one server process owns a data root, which is the assumption every hold in this codebase already makes.
 * Not re-entrant: a callback that asks for its own key waits for itself for ever, so a caller that may be nested takes the
 * lock at its outermost call and the inner steps run without it.
 */

export interface KeyedLock {
  /** Run `fn` once every earlier `run` for `key` has finished, and hold `key` until it ends — whichever way. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Resolves when every `run` for `key` asked so far has finished (at once when none is running). */
  idle(key: string): Promise<void>;
}

/** A lock of its own: its keys are not shared with any other instance's. */
export function keyedLock(): KeyedLock {
  /** The end of each key's chain. Only ever resolves, never rejects, so waiting on it cannot throw. */
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prior = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>(r => { release = r; });
      const tail = prior.then(() => mine);
      tails.set(key, tail);
      await prior;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
    idle(key: string): Promise<void> {
      return tails.get(key) ?? Promise.resolve();
    },
  };
}
