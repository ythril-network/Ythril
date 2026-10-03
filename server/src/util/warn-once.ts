/**
 * Has this been reported already? — the one answer for every warning that must be said once, not once per cycle.
 *
 * ## Why a module
 *
 * The same question was answered by hand six times, each its own way: a Set of hosts (`sync/peer-fetch.ts`), a Set
 * of labels (`brain/nli-client.ts`), the last key alone (`files/media/stall-floor.ts`), a key-to-version Map that also
 * serves a security-posture count (`files/unreadable-files.ts`), and two key-to-time Maps for "once per window"
 * (`sync/stray-filemeta-drain.ts`, `brain/fresh-writes.ts`). A seq hold that stalls (`Q-200`) needed it a seventh
 * time.
 *
 * ## What a hand-written copy drops
 *
 * **The bound.** Every one of those Sets and Maps grew for as long as the process lived, keyed by what a peer or a
 * model sent — a host, a label, a path — so a peer could grow them without limit. This one forgets its least
 * recently reported key past `max`; a forgotten key that comes back is reported again, which is the safe direction
 * for a warning. And **`forget`**, so a condition that cleared is reported again when it returns.
 *
 * ## One question, and what is a parameter rather than a flag
 *
 * "Has (key, version) been reported?" A key seen with a NEW version is news (an unreadable file that changed, a
 * stall floor raised from a different hop). A WINDOW is the same question asked of time — "reported within the
 * last `every` ms?" — so it is an option of the constructor, not a second module.
 */

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
  const seen = new Map<K, Seen>();
  const fn = ((key: K, report: () => void, version?: unknown): boolean => {
    const t = now();
    const was = seen.get(key);
    if (was && Object.is(was.version, version) && (every === undefined || t - was.at < every)) return false;
    // Re-inserted, so iteration order is least-recently-reported first and the oldest is the one forgotten.
    seen.delete(key);
    seen.set(key, { version, at: t });
    if (seen.size > max) seen.delete(seen.keys().next().value as K);
    report();
    return true;
  }) as WarnOnce<K>;
  fn.forget = (key: K) => { seen.delete(key); };
  Object.defineProperty(fn, 'size', { get: () => seen.size });
  return fn;
}
