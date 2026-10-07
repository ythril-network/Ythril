/**
 * A fixed delay: resolve after `ms` milliseconds. The one `sleep` a test file, fixture or script imports instead of
 * typing `new Promise(r => setTimeout(r, ms))` again.
 *
 * ## What holds it so
 *
 * `a-test-waits-and-listens-through-one-helper` reads every tracked test and script out of the syntax tree and refuses
 * a hand-written fixed delay (the promise over `setTimeout`, `timers/promises`' `setTimeout`, or a local helper whose
 * whole body is that promise) anywhere but here and in `wait-for.mjs`' own poll interval. A delay that asks a different
 * question says so in the comment directly above it, `// waits-differently: <reason of two words or more>`.
 *
 * ## What it is NOT
 *
 * It is not a wait. A test that sleeps and then reads a result has guessed how long the thing takes; waiting for a
 * CONDITION is `wait-for.mjs` (`waitFor`, `holdsWithin`, `waitForReading`), and `a-poll-is-written-once` refuses a hand-written
 * loop that sleeps while it tests one. Importing this is the honest spelling of a guess, not a cure for it: where time
 * itself is the subject (a fixture that must take a measurable while, a window that has to elapse in full before something
 * is asserted absent) the delay is right, and everywhere else it is a wait that has not been written yet.
 *
 * A leaf module with no imports, so a fixture that the reporter under test runs never depends on a helper.
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
