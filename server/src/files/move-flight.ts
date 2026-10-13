/**
 * One run of a move at a time, and the answer to "is a move of this path running right now" — a leaf, so the job queue can ask it
 * without importing the cascade that imports the job queue.
 *
 * ## The question it answers
 *
 * *"Is some run already moving this path, and which?"* A move is begun by a request, retried by the same request, and finished by
 * housekeeping; two of those at once would both carry the same rows (the second finding the first's half-finished batches and
 * racing its link and job steps). The in-process keyed lock (`util/keyed-lock.ts`) makes the runs of one `(space, src, dst)` take
 * turns, and a run that waited sees the state the one before it left. One server process owns a data root, which is the
 * assumption every hold in this codebase makes.
 *
 * ## What it prevents
 *
 * A manual `retry_embedding` of a file whose move is running cleared the move's hold on the file's job (`retryJob` sets
 * `claimableAfter` to null), so the worker claimed the job at the OLD path in the middle of the move. The job queue asks
 * {@link moveIsRunningAt} and answers "not now" instead.
 */
import { keyedLock } from '../util/keyed-lock.js';
import { isAtOrUnder, moveKey, movedRoot, parentOfSidecar } from './moved-paths.js';

const locks = keyedLock();
/** The moves running now, by lock key: what {@link moveIsRunningAt} reads. */
const running = new Map<string, { spaceId: string; src: string }>();

const keyOf = (spaceId: string, src: string, dst: string): string => moveKey({ from: src, to: dst }, spaceId);

/** Run `fn` as the move `src` → `dst` of `spaceId`, after any earlier run of the same move has ended; the lock is released in a `finally`. */
export function runMoveOnce<T>(spaceId: string, src: string, dst: string, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(spaceId, src, dst);
  return locks.run(key, async () => {
    running.set(key, { spaceId, src: movedRoot(src) });
    try { return await fn(); } finally { running.delete(key); }
  });
}

/**
 * Whether a run of a move is carrying `path` now: a move whose source is the path, an ancestor of it, or — for a sidecar — the file
 * the sidecar belongs to (or an ancestor of that file).
 */
export function moveIsRunningAt(spaceId: string, path: string): boolean {
  const at = movedRoot(path);
  const owner = parentOfSidecar(at)?.parent;
  for (const m of running.values()) {
    if (m.spaceId !== spaceId || m.src === '') continue;
    for (const p of owner ? [at, owner] : [at]) if (isAtOrUnder(p, m.src)) return true;
  }
  return false;
}
