/**
 * Wait for an EVENT a test has set up, and fail by name rather than hang when it never comes.
 *
 * ## What it prevents
 *
 * A test that parks a write behind a gate awaits "the write reached the gate". If the code under test never writes
 * (the defect the test is hunting), that await has no end: node's runner waits on the file for ever and reports
 * nothing, which reads as a hung CI job rather than as the failing assertion it is. Every park, hold and latch a test
 * waits on goes through here, so the wait has a bound and the failure says what was being waited for.
 *
 * `eventually` (`_write-faults.mjs`) is the sibling for a PREDICATE polled until it holds; this one is for a promise.
 */

/** How long a test gives an event it has set up before it calls the wait a failure. */
export const EVENT_DEADLINE_MS = 10_000;

/**
 * `promise`'s value, or a rejection naming `what` once `ms` have passed.
 *
 * The timer is cleared as soon as `promise` settles, so a passing test leaves nothing behind to keep node's event loop
 * alive.
 */
export function within(promise, what, ms = EVENT_DEADLINE_MS) {
  let timer;
  const expired = new Promise((_, no) => {
    timer = setTimeout(() => no(new Error(`${what} was never reached within ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
