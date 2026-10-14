/**
 * A queue that ONE drain at a time empties, started by the push that finds it idle and ended by the check that finds it empty.
 *
 * ## The question it answers
 *
 * *"Work arrives in a burst from callers that must not wait for it: who does it, one run at a time, in arrival order, and how does a
 * shutdown wait for it?"* The webhook dispatcher asked it twice — the emitted events resolved one at a time, and the overflow rows
 * written to the retry queue in batches — and each wrote the same four parts by hand: the array, the `Promise | null` that says a drain
 * is running, `drain ??= run()` at the push, and a `finally` that clears the flag.
 *
 * ## What it prevents
 *
 * **The flag cleared at the wrong place.** The drain's last statement is the loop's final emptiness check, and the flag is cleared in a
 * `finally` reached with no `await` after it, so an item pushed while the last batch ran is taken by the loop and an item pushed after is
 * taken by a new drain. A copy that cleared the flag before the final check, or only after a successful pass, left items waiting for a
 * push that never came, or ran two drains over one array. **A throw ending the drain with items still queued**: `handle`'s failure goes
 * to `onError` (required, so a caller must say where it is reported) and the loop goes on to the next batch; a copy that let it escape
 * stranded everything behind it and, with nobody awaiting the drain, raised an unhandled rejection. **A drain nobody can wait for**:
 * {@link DrainedQueue.settled} resolves when what is queued NOW, and everything pushed while it ran, has been handled, which is what a
 * shutdown awaits before it closes what the handler writes to.
 *
 * `batchSize` is how many items one call of `handle` takes (default: everything queued, which is how a burst becomes one write; `1`
 * for work that must go one at a time). `beforeFirstBatch` runs once at the start of each drain, before the first take: the retry
 * writer yields a tick there so the rest of a burst joins its batch.
 */
export interface DrainedQueue<T> {
  /** Queue an item, and start a drain if none is running. Never throws and never waits. */
  push(item: T): void;
  /** Resolves once the drain running now (if any) has handled everything queued, including what was pushed while it ran. */
  settled(): Promise<void>;
  /** How many items wait for a drain. */
  readonly size: number;
}

export interface DrainedQueueOptions {
  /** Where a failure of `handle` is reported. The drain goes on to the next batch, and the failed batch is not retried here. */
  onError: (err: unknown) => void;
  /** Items one call of `handle` takes, in arrival order. Default: everything queued. */
  batchSize?: number;
  /** Runs once at the start of each drain, before the first batch is taken. */
  beforeFirstBatch?: () => Promise<void>;
}

export function drainedQueue<T>(handle: (batch: T[]) => Promise<void>, { onError, batchSize = Number.POSITIVE_INFINITY, beforeFirstBatch }: DrainedQueueOptions): DrainedQueue<T> {
  const items: T[] = [];
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    try {
      await beforeFirstBatch?.();
      for (let batch = items.splice(0, batchSize); batch.length > 0; batch = items.splice(0, batchSize)) {
        try { await handle(batch); } catch (err) { onError(err); }
      }
    } catch (err) {
      onError(err);   // a failing `beforeFirstBatch`: the items stay queued for the next push's drain, and the failure is said
    } finally {
      draining = null; // reached with no await after the loop's last check, so an item pushed meanwhile was taken by the loop
    }
  }

  return {
    push(item: T): void {
      items.push(item);
      draining ??= drain();
    },
    settled: async () => { await draining; },
    get size() { return items.length; },
  };
}
