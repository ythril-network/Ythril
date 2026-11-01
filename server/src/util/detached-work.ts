/**
 * Work an act starts and does not wait for — and that a test has to be able to wait for.
 *
 * ## Why a module
 *
 * Two acts start work behind their answer: a push door's strict-linkage check, which only records and must not hold
 * the answer while the store stalls (`sync/linkage-check.ts`, bundle-30 I13), and the drop of a failed act's pending
 * file tombstones, which must not make the act's `503` wait on the store a second time (`files/tombstones.ts`,
 * bundle-30 I14, I15). Each kept a set of what it had started so a test could wait for it to finish; the second is
 * where a copy becomes a rule.
 *
 * ## The part a hand-written copy drops
 *
 * **A rejection.** Nobody awaits detached work, so a rejection it lets escape is an unhandled rejection, which ends
 * the process by default — an outage turned into a crash by the code meant to clean up after it. `start` catches it
 * and logs it under the name the work was given. And the set: an entry removed only on success is a leak.
 */
import { log, peerText } from './log.js';
import { settledWithin, type SettledWithin } from './time-bound.js';

export class DetachedWork {
  private readonly inFlight = new Set<Promise<unknown>>();

  /** @param what names the work in the one log line a rejection gets */
  constructor(private readonly what: string) {}

  /** Run `work` behind the caller: never awaited, never rejecting, forgotten once it settles. */
  start(work: () => Promise<unknown>): void {
    const settled: Promise<void> = Promise.resolve()
      .then(work)
      .then(() => undefined, err => { log.error(`${this.what} failed: ${peerText(err)}`); })
      .finally(() => { this.inFlight.delete(settled); });
    this.inFlight.add(settled);
  }

  /**
   * Count work a caller already started and awaits itself (a sync cycle: its caller wants the answer), so a shutdown can wait for it.
   * Returns the work's own outcome — its value or its rejection — to that caller, and forgets it the moment it settles, BEFORE the caller
   * resumes: a caller that reads {@link size} right after its await sees the work gone. A rejection stays the caller's: nothing is logged here.
   */
  track<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<T> = work.finally(() => { this.inFlight.delete(tracked); });
    this.inFlight.add(tracked);
    return tracked;
  }

  /** How much work is running now, started or tracked. */
  get size(): number { return this.inFlight.size; }

  /** Resolves once everything started so far — and anything it started in turn — has settled, whether it succeeded or not. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /**
   * {@link settled}, waited for at most `ms` (`settledWithin`, `util/time-bound.ts`): says whether everything finished. The work goes on when the
   * bound wins; only this wait ends. What it prevents: a shutdown that waits for a cycle with a hand-written race, and so forgets the timer.
   */
  settledWithin(ms: number): Promise<SettledWithin<void>> {
    return settledWithin(this.settled(), ms);
  }
}
