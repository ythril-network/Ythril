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
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
