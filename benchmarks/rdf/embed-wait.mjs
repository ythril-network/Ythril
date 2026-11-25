/**
 * The wait for the instance's embed queue to drain before a measured run.
 *
 * Embedding a freshly imported space runs in the instance for as long as it takes (the first 1 000-product load left
 * 117 822 jobs pending), and it competes with the queries for the CPU. The measured runs wait until nothing is pending
 * and nothing is being processed, up to a deadline; past it the run goes on and the record says how many were left.
 *
 * ## What this prevents
 *
 * - **A timing taken while the instance embeds.** The run starts on a drained queue, or the record says it did not.
 * - **A silent stall.** The wait is bounded; at the deadline the pending count is recorded and `drained` is false.
 * - **A failed probe read as an empty queue.** A probe that throws, or answers no pending count, throws: absent is not zero.
 */

/**
 * Polls `probe()` (answers `{ pending, processing }`) every `pollMs` until both are zero or `deadlineMs` has passed.
 * Answers `{ waitedMs, pending, drained }`; `pending` counts the jobs being processed too. `now` and `sleep` are the
 * clock, handed in so the wait is testable without waiting.
 */
export async function waitForDrain({ probe, now = Date.now, sleep, pollMs, deadlineMs }) {
  const start = now();
  for (;;) {
    const s = await probe();
    if (!Number.isInteger(s?.pending)) throw new Error('the queue report holds no pending count: it cannot be told from an empty queue');
    const left = s.pending + (Number.isInteger(s.processing) ? s.processing : 0);
    const waitedMs = now() - start;
    if (left === 0) return { waitedMs, pending: 0, drained: true };
    if (waitedMs >= deadlineMs) return { waitedMs, pending: left, drained: false };
    await sleep(pollMs);
  }
}
