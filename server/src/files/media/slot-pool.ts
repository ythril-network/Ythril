/**
 * A pool of job slots that refills a slot the moment it frees (`Q-114`).
 *
 * The media worker used to claim up to `workerConcurrency` jobs and then await ALL of them before claiming
 * again. One 30-minute document conversion beside a 2-second image left the second slot idle for 28 minutes
 * with a queue behind it. This is the supervisor that replaces the batch.
 *
 * ## The rules it keeps, each one a case in `a-slot-pool-refills-a-slot-as-it-frees.test.js`
 *
 * - **One claimer.** Claims stay serial, as they were, because the work-signal hint that decides which spaces a
 *   claim probes is consumed once per claim and two claims racing would read it twice.
 * - **Capacity is read on every pass** (`limits()`), so a hot-reloaded `workerConcurrency` takes effect. A pass
 *   wakes on a slot finishing, on the work signal, or after the poll interval, so a RAISED limit starts a slot
 *   within one poll interval even while every slot is busy on a half-hour job. A lowered one simply stops
 *   refilling until the running count falls below it.
 * - **The epoch is sampled before each claim** and handed to the wait that follows it, so work announced while
 *   the claim was in flight ends the wait at once instead of waiting out the backoff.
 * - **`onClaimed` runs on the claim's own resolution**, in the continuation of the `await`, with nothing between.
 *   The worker records the claim in `_heldJobs` there, so a shutdown that reads the set a tick later already sees
 *   the job and can hand it back. An `.then()` chain or an extra await in front of it would open that window.
 * - **A claim that throws counts as nothing found.** The pool sleeps with backoff and carries on.
 * - **A job claimed after stop is released, never run.** One claimed before stop runs to completion.
 * - **Every pass yields a macrotask.** A job that fails at once would otherwise turn the loop into a spin that
 *   starves the event loop; its retries are bounded by `failJob`'s `claimableAfter` and `maxAttempts`.
 *
 * `drained` settles when the loop has stopped and every job it started has finished. Only a caller that must not
 * start a second pool awaits it; stopping stays synchronous for everyone else.
 */

export interface SlotPoolLimits {
  /** How many jobs may run at once. 0 (or less) runs none. */
  concurrency: number;
  /** The poll interval after work was found, and the longest a pass waits while every slot is busy. */
  pollMs: number;
  /** The ceiling the idle backoff doubles up to. */
  maxPollMs: number;
}

export interface SlotPoolOptions<Job> {
  /** Re-read on every pass, never captured. */
  limits(): SlotPoolLimits;
  /** One claim: a job, or null when nothing is claimable. A rejection is read as nothing found. */
  claim(): Promise<Job | null>;
  /** Called synchronously when a claim resolves with a job, before anything else happens to it. */
  onClaimed(job: Job): void;
  /** Runs the job. Its outcome is the job's own business: a rejection frees the slot and nothing else. */
  run(job: Job): Promise<unknown>;
  /** Hands back a job claimed after stop, so it is pending again instead of waiting out a stall timeout. */
  release(job: Job): Promise<unknown>;
  /** The work-signal epoch, sampled before each claim. */
  sampleEpoch(): number;
  /** The interruptible sleep; true when woken by announced work. */
  waitForWork(ms: number, epoch: number): Promise<boolean>;
  isRunning(): boolean;
  /** Told why a claim threw, so the caller can log it. The pool itself only backs off. */
  onClaimError?(err: unknown): void;
}

export function runSlotPool<Job>(opts: SlotPoolOptions<Job>): { drained: Promise<void> } {
  const inFlight = new Set<Promise<void>>();
  /** Resolved by the next job to finish; replaced each time it is used. */
  let notifyFreed: (() => void) | null = null;

  const startJob = (job: Job): void => {
    let outcome: Promise<unknown>;
    try { outcome = opts.run(job); } catch (err) { outcome = Promise.reject(err); }
    const slot: Promise<void> = outcome.then(() => undefined, () => undefined).then(() => {
      inFlight.delete(slot);
      const n = notifyFreed;
      notifyFreed = null;
      n?.();
    });
    inFlight.add(slot);
  };

  const yieldMacrotask = () => new Promise<void>(resolve => setImmediate(resolve));

  const loop = async (): Promise<void> => {
    let currentPollMs = opts.limits().pollMs;
    while (opts.isRunning()) {
      const { concurrency, pollMs, maxPollMs } = opts.limits();
      // A lowered ceiling takes effect at once, not at the next reset.
      currentPollMs = Math.min(currentPollMs, maxPollMs);
      const epoch = opts.sampleEpoch();

      if (inFlight.size >= concurrency) {
        // Every slot is busy (or the limit is 0): wait for one to free, for announced work, or for the poll
        // interval, whichever is first. The interval is what lets a raised limit start a slot while the jobs
        // in flight are still running.
        await Promise.race([
          opts.waitForWork(Math.max(1, pollMs), epoch),
          new Promise<void>(resolve => {
            // One supervisor, so one waiter: a stale callback from a pass the poll interval ended is replaced,
            // not chained (a half-hour job would otherwise pile up one closure per poll).
            notifyFreed = resolve;
          }),
        ]);
        continue;
      }

      let job: Job | null;
      try {
        job = await opts.claim();
      } catch (err) {
        job = null;
        try { opts.onClaimError?.(err); } catch { /* a logger must not stop the pool */ }
      }
      // Nothing may sit between the claim's resolution and onClaimed: see the header.
      if (job !== null && job !== undefined) {
        opts.onClaimed(job);
        if (!opts.isRunning()) {
          // Claimed after stop: handed back, never run.
          try { await opts.release(job); } catch { /* the stall sweep recovers a claim that could not be released */ }
          break;
        }
        currentPollMs = pollMs;
        startJob(job);
        await yieldMacrotask();
        continue;
      }

      // Nothing found (or the claim threw). Exponential backoff, but interruptible.
      currentPollMs = Math.min(currentPollMs * 2, maxPollMs);
      const woken = await opts.waitForWork(currentPollMs, epoch);
      // Real work arrived: drop straight back to the fast interval rather than carry the idle backoff into a busy queue.
      if (woken) currentPollMs = pollMs;
      await yieldMacrotask();
    }
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  };

  return { drained: loop() };
}
