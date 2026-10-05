/**
 * A Map holding at most `max` entries, the least recently used dropped first — the one spelling of "a bounded
 * cache keyed by something a caller hands us".
 *
 * ## Why a module
 *
 * It serves `util/warn-once.ts`, whose map of reported keys is keyed by what a peer or a model sent and so must be
 * bounded. The hand spelling of this is `delete` + `set` to move an entry to the end and `keys().next()` to drop the
 * first. Two halves a hand copy drops, and each copy is one edit from dropping them:
 *
 *  - **the touch on use** — without the re-insert, the entry evicted is the oldest INSERTED, so the one key read on
 *    every call is the one thrown away;
 *  - **the bound on every insert** — a cache whose eviction runs only on a miss path, or not at all after a `set`
 *    that replaced a value, grows past its bound with nothing to say so.
 *
 * `get` touches; `peek` does not, for a caller whose use is not a read (warn-once re-inserts only when it
 * reports). `onEvict` is for a caller that counts what the bound costs.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly max: number, private readonly onEvict?: (key: K, value: V) => void) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`LruMap: max must be a positive integer, got ${max}`);
  }

  /** The value for `key`, which becomes the most recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** The value for `key`, leaving the order as it is. */
  peek(key: K): V | undefined {
    return this.entries.get(key);
  }

  /** Store `value` as the most recently used, dropping the least recently used past `max`. */
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const [oldest, dropped] = this.entries.entries().next().value as [K, V];
      this.entries.delete(oldest);
      this.onEvict?.(oldest, dropped);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
