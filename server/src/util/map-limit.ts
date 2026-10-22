/**
 * Map over items with at most `limit` calls in flight, keeping the input order in the result.
 *
 * One module because the worker-pool shape was hand-written in several places, and the hand-written copies
 * are where it goes wrong: an index counter shared by the workers, a pool sized larger than the list, a
 * result written out of order. The restore route shows what the missing version costs — it rebuilt every
 * space's vector indexes one awaited space at a time, so a restore's HTTP request grew by several seconds
 * per space and timed out on an instance with a few dozen of them.
 *
 * A rejection from `fn` rejects the whole map, as `Promise.all` would; a caller that must finish every item
 * and report which failed (the restore does) catches inside `fn`.
 *
 * It is {@link mapLimitPerKey} with one key and a cap per key equal to the pool: one loop, so the two cannot drift.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  return runPool(items, limit, null, fn);
}

/**
 * {@link mapLimit} with a second bound: at most `perKey` calls in flight for any one key (`keyOf(item)`), and an item whose key is
 * full NEVER holds one of the `limit` slots while it waits — the slot goes to the next item whose key has room (bundle-169, Q-483).
 *
 * ## What it prevents
 *
 * The webhook retry poll delivers a tick four at a time; one subscription whose sink hangs held all four slots for its delivery timeout
 * and every other subscription waited behind it. A cap per key fixes that only if a waiting item does not sit in a slot (that is the same
 * head-of-line block under another name). The guard is inside: a caller cannot hand in an item that holds a slot while its key is full.
 *
 * **Not `keyedLimiter`** (`util/keyed-limiter.ts`): that one admits ARRIVING work per key and does not tell its caller when the work
 * ends. This pool is awaited — it resolves when every item has finished — so a caller that re-reads its source after it (the poll's next
 * tick) never sees an item that is still running.
 *
 * The pick is O(1) per item (each item's key is read once when the pool reaches it, and a full key's items wait in that key's own
 * queue, so a backlog of one key is never rescanned). Results keep the input order; `fn` is given `(item, index)`; a rejection rejects
 * the whole map, as `mapLimit`'s does.
 */
export async function mapLimitPerKey<T, R, K>(
  items: readonly T[], limit: number, keyOf: (item: T) => K, perKey: number, fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  return runPool(items, limit, { keyOf, perKey }, fn);
}

/** The one pool loop. `keyed` null: no cap per key (every item's key is the same and its cap is the pool). */
function runPool<T, R, K>(
  items: readonly T[], limit: number, keyed: { keyOf: (item: T) => K; perKey: number } | null, fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return Promise.resolve(results);
  let slots = Math.max(1, Math.min(limit, items.length));
  const cap = keyed ? Math.max(1, Math.floor(keyed.perKey)) : Number.POSITIVE_INFINITY;
  const inFlight = new Map<K | null, number>();
  /** Items reached while their key was full, per key, in input order (a queue: `head` is the next to start). */
  const waiting = new Map<K | null, { idx: number[]; head: number }>();
  const keys = new Array<K | null>(items.length);
  let next = 0;
  let running = 0;
  let waitingCount = 0;
  let failed = false;

  return new Promise<R[]>((resolve, reject) => {
    /** The next item that may start now: a waiter of `freed` (the key that just made room), else the next unread item whose key has room. */
    const pick = (freed: K | null | undefined): number | undefined => {
      if (freed !== undefined) {
        const w = waiting.get(freed);
        if (w && w.head < w.idx.length) {
          const i = w.idx[w.head++]!;
          waitingCount--;
          if (w.head === w.idx.length) waiting.delete(freed);
          return i;
        }
      }
      while (next < items.length) {
        const i = next++;
        const k = keyed ? keyed.keyOf(items[i]!) : null;
        keys[i] = k;
        if ((inFlight.get(k) ?? 0) < cap) return i;
        let w = waiting.get(k);
        if (!w) { w = { idx: [], head: 0 }; waiting.set(k, w); }
        w.idx.push(i);
        waitingCount++;
      }
      return undefined;
    };
    const start = (i: number): void => {
      const k = keys[i]!;
      inFlight.set(k, (inFlight.get(k) ?? 0) + 1);
      running++;
      let ran: Promise<R>;
      try { ran = fn(items[i]!, i); } catch (err) { ran = Promise.reject(err); }
      ran.then(
        (r) => { results[i] = r; done(k, true); },
        (err) => { if (!failed) { failed = true; reject(err); } done(k, false); },
      );
    };
    const done = (k: K | null, refill: boolean): void => {
      running--;
      const n = (inFlight.get(k) ?? 1) - 1;
      if (n === 0) inFlight.delete(k); else inFlight.set(k, n);
      // A rejected item's slot is not refilled: `mapLimit`'s worker that saw the rejection stopped, and the others went on.
      if (refill) { const i = pick(k); if (i !== undefined) start(i); } else slots--;
      if (running === 0 && !failed) {
        if (next < items.length || waitingCount > 0) { fill(); return; }
        resolve(results);
      }
    };
    const fill = (): void => {
      while (running < slots) { const i = pick(undefined); if (i === undefined) break; start(i); }
    };
    fill();
  });
}
