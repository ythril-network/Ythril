/**
 * Has this been reported already? — the one answer for every warning that must be said once, not once per cycle.
 *
 * ## Why a module
 *
 * A warning that must be said once, and not once per cycle or per call, asks this: the pulled page's diverged and refused
 * ids (`sync/pull-page.ts`) and a driver failure that recurs at the rate of its callers (`util/report-failure.ts`). A
 * hand-written latch (a `Set` of reported keys) is the copy to replace when it is next touched, not a second spelling to
 * add; the older ones (`sync/peer-fetch.ts`, `brain/nli-client.ts`, `files/media/stall-floor.ts`,
 * `files/unreadable-files.ts`, `sync/stray-filemeta-drain.ts`, `brain/fresh-writes.ts`) are moved in a release, not in a
 * patch, which carries fixes only.
 *
 * ## What a hand-written copy drops
 *
 * **The bound.** A Set or Map of reported keys grows for as long as the process lives when it is keyed by what a peer
 * or a model sent — a host, a label, a path — so a peer could grow it without limit. This one forgets its least
 * recently reported key past `max`; a forgotten key that comes back is reported again, which is the safe direction
 * for a warning. And **`forget`**, so a condition that cleared is reported again when it returns.
 *
 * ## One question, and what is a parameter rather than a flag
 *
 * "Has (key, version) been reported?" A key seen with a NEW version is news (an unreadable file that changed, a
 * stall floor raised from a different hop). A WINDOW is the same question asked of time — "reported within the
 * last `every` ms?" — so it is an option of the constructor, not a second module.
 */
import { LruMap } from './lru-map.js';

export interface WarnOnce<K> {
  /**
   * Run `report` when `(key, version)` is news — never seen, seen with another version, or (with `every`) last
   * reported longer ago than the window. Returns whether it ran. `report` throwing is the caller's to see.
   */
  (key: K, report: () => void, version?: unknown): boolean;
  /** Forget `key`: the next sighting is news. For a condition that cleared. */
  forget(key: K): void;
  /** How many keys are currently remembered — a count of live conditions, when each is forgotten as it clears. */
  readonly size: number;
}

export interface WarnOnceOptions {
  /** The most keys remembered; the least recently reported is forgotten past it. Default 1 000. */
  max?: number;
  /** Report a key again once this many ms have passed since it was last reported. Default: never. */
  every?: number;
  /** The clock, for a test. */
  now?: () => number;
}

interface Seen { version: unknown; at: number }

export function warnOnce<K>({ max = 1_000, every, now = Date.now }: WarnOnceOptions = {}): WarnOnce<K> {
  if (!Number.isInteger(max) || max < 1) throw new Error(`warnOnce: max must be a positive integer, got ${max}`);
  const seen = new LruMap<K, Seen>(max);
  const fn = ((key: K, report: () => void, version?: unknown): boolean => {
    const t = now();
    // Peeked, not touched: a key is "used" when it is REPORTED, so the oldest forgotten is the least recently reported.
    const was = seen.peek(key);
    if (was && Object.is(was.version, version) && (every === undefined || t - was.at < every)) return false;
    seen.set(key, { version, at: t });
    report();
    return true;
  }) as WarnOnce<K>;
  fn.forget = (key: K) => { seen.delete(key); };
  Object.defineProperty(fn, 'size', { get: () => seen.size });
  return fn;
}
