/**
 * Work an act starts and does not wait for — and that a test has to be able to wait for.
 *
 * ## Why a module
 *
 * Two acts start work behind their answer: a push door's strict-linkage check, which only records and must not hold
 * the answer while the store stalls (`sync/linkage-check.ts`, bundle-30 I13), and the withdrawal of a file tombstone
 * whose write was reported failed, which retries until the store takes it (`files/tombstones.ts`, bundle-30 I14). Each
 * kept a set of what it had started so a test could wait for it to finish; the second is where a copy becomes a rule.
 *
 * ## The part a hand-written copy drops
 *
 * **A rejection.** Nobody awaits detached work, so a rejection it lets escape is an unhandled rejection, which ends
 * the process by default — an outage turned into a crash by the code meant to clean up after it. `start` catches it
 * and logs it under the name the work was given. And the set: an entry removed only on success is a leak.
 */
import { log, peerText } from './log.js';

export class DetachedWork {
  private readonly inFlight = new Set<Promise<void>>();

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

  /** Resolves once everything started so far — and anything it started in turn — has settled. For tests. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }
}
