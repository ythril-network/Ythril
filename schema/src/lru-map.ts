/**
 * A Map holding at most `max` entries, the least recently used dropped first — the one spelling of "a bounded
 * cache keyed by something a caller hands us".
 *
 * ## Why a module
 *
 * It was written three times, each as `delete` + `set` to move an entry to the end and `keys().next()` to drop the
 * first: the tool validators per reach (`mcp/validate-args.ts`), the reported keys of `util/warn-once.ts`, and the
 * Merkle leaves per space (`brain/merkle.ts`). Two halves a hand copy drops, and each copy is one edit from
 * dropping them:
 *
 *  - **the touch on use** — without the re-insert, the entry evicted is the oldest INSERTED, so the one key read on
 *    every call is the one thrown away;
 *  - **the bound on every insert** — a cache whose eviction runs only on a miss path, or not at all after a `set`
 *    that replaced a value, grows past its bound with nothing to say so.
 *
 * `get` touches; `peek` does not, for a caller whose use is not a read (warn-once re-inserts only when it
 * reports). `onEvict` is for a caller that counts what the bound costs.
 *
 * ## A weight bound, for entries that are not alike in size (Q-336)
 *
 * A count bound says how many entries, and an entry that holds a whole space's leaves is any size at all: sixteen
 * spaces of the Merkle cache was sixteen of the biggest. `weight` is the same question asked in the cache's own unit
 * (`weigh` of a value, at most `maxWeight` in all), answered on the same insert: the least recently used go while the
 * count is over `max` OR the total weight is over `maxWeight`. An entry is weighed when it is SET, so a caller that
 * grows a stored entry sets it again to say so. **An entry heavier than `maxWeight` on its own is dropped by its own
 * `set`**, after every older entry has been dropped trying to make room for it, and `onEvict` hears of it like any
 * other. A cache given no weight keeps none: `totalWeight` is 0.
 */
export interface LruWeight<V> {
  /** The cost of one value, in the cache's own unit. */
  weigh: (value: V) => number;
  /** The most the values may weigh together. */
  maxWeight: number;
}

export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly weights = new Map<K, number>();
  private weighed = 0;

  constructor(readonly max: number, private readonly onEvict?: (key: K, value: V) => void,
    private readonly weight?: LruWeight<V>) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`LruMap: max must be a positive integer, got ${max}`);
    if (weight && (!Number.isInteger(weight.maxWeight) || weight.maxWeight < 1)) {
      throw new Error(`LruMap: maxWeight must be a positive integer, got ${weight.maxWeight}`);
    }
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
    this.forget(key);
    this.entries.set(key, value);
    if (this.weight) {
      const cost = this.weight.weigh(value);
      this.weights.set(key, cost);
      this.weighed += cost;
    }
    while (this.entries.size > this.max || (this.weight !== undefined && this.weighed > this.weight.maxWeight)) {
      const [oldest, dropped] = this.entries.entries().next().value as [K, V];
      this.forget(oldest);
      this.onEvict?.(oldest, dropped);
    }
  }

  delete(key: K): boolean {
    return this.forget(key);
  }

  clear(): void {
    this.entries.clear();
    this.weights.clear();
    this.weighed = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** What the entries weigh together; 0 for a cache given no weight. */
  get totalWeight(): number {
    return this.weighed;
  }

  /** Remove an entry and take its weight off the total — the one place an entry leaves, so the two cannot disagree. */
  private forget(key: K): boolean {
    const had = this.entries.delete(key);
    const cost = this.weights.get(key);
    if (cost !== undefined) { this.weighed -= cost; this.weights.delete(key); }
    return had;
  }
}
