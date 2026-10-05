/**
 * A fixed delay: resolve after `ms` milliseconds. The one `sleep` a test file or fixture imports instead of typing
 * `new Promise(r => setTimeout(r, ms))` again.
 *
 * ## What it is NOT
 *
 * It is not a wait. A test that sleeps and then reads a result has guessed how long the thing takes; waiting for a
 * CONDITION is `wait-for.mjs` (`waitFor`, `holdsWithin`, `waitForReading`), and `a-poll-is-written-once` refuses a hand-written
 * loop that sleeps while it tests one. This is for the cases where time itself is the subject — a fixture that must take
 * a measurable while (the timing-reporter fixtures), or a window that has to elapse in full before something is asserted
 * absent.
 *
 * A leaf module with no imports, so a fixture that the reporter under test runs never depends on a helper.
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
