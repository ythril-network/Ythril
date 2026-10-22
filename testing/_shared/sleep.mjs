/**
 * A fixed delay that says which KIND of delay it is: `await elapse(ms, '<kind>: <detail>')`, the one fixed delay a test
 * file, fixture or script imports instead of typing `new Promise(r => setTimeout(r, ms))` again (`Q-375`, `Q-401`).
 *
 * ## What it prevents
 *
 * A test that sleeps and then reads a result has guessed how long the thing takes, and on a slow runner the guess is a
 * flake. Waiting for a CONDITION is `wait-for.mjs` (`waitFor`, `holdsWithin`, `waitForReading`), and
 * `a-poll-is-written-once` refuses a hand-written loop that sleeps while it tests one. A fixed delay is right only where
 * time itself is the subject, and those subjects are few: they are {@link DELAY_KINDS}. A free-text reason was not
 * enough — "let the server settle" reads like a reason and is exactly the guess it was meant to rule out — so the reason
 * has to name one of the kinds, and `elapse` refuses one that does not before any timer is armed.
 *
 * ## What holds it so
 *
 * The reason is checked HERE, at the call, so no caller can leave it out. `a-test-waits-and-listens-through-one-helper`
 * reads every tracked test and script out of the syntax tree and refuses a call whose reason is not a literal of a known
 * kind, any other way of reaching this module (a namespace or default import, a re-export), and a hand-written delay
 * anywhere but here and in `wait-for.mjs`' own poll interval. A delay that is none of the kinds (a browser page's own
 * wait, a vendor helper) says why in the comment directly above it, `// waits-differently: <reason>`.
 *
 * A leaf module with no imports, so a fixture that the reporter under test runs never depends on a helper.
 */

/** The kinds of fixed delay a test may have. Closed: a delay that is none of these is a wait, or says why it is not. */
export const DELAY_KINDS = Object.freeze([
  'absence window',          // nothing may happen during it; the positive control was awaited first
  'ttl elapses',             // a time-to-live or a window has to run out before the next step
  'timestamps differ',       // two writes must carry different millisecond stamps
  'simulated latency',       // a fake does slow work on purpose
  'pacing',                  // a rate the subject enforces, or one the test keeps to on purpose
  'bind-mount propagation',  // a file written on the host is not yet seen inside the container
  'sampler interval',        // a sampler takes readings at a fixed rate until it is told to stop
  'race timeout',            // the losing side of a Promise.race
]);

/**
 * Why `reason` is not a delay's reason, or null when it is: `<kind>: <detail>`, the kind from {@link DELAY_KINDS} and a
 * detail that says something. The one reading of a reason — `elapse` asks it at run time, the gate of the source.
 *
 * @param {unknown} reason
 * @returns {string|null}
 */
export function reasonProblem(reason) {
  if (typeof reason !== 'string') return 'the reason is not a string';
  const colon = reason.indexOf(':');
  if (colon < 0) return `"${reason}" names no kind: write "<kind>: <detail>", the kind one of ${DELAY_KINDS.join(', ')}`;
  const kind = reason.slice(0, colon).trim();
  if (!DELAY_KINDS.includes(kind)) return `"${kind}" is not a kind of delay: one of ${DELAY_KINDS.join(', ')}`;
  if (reason.slice(colon + 1).trim() === '') return `the reason "${reason}" names its kind and nothing more: say what elapses`;
  return null;
}

/** The timer itself, spelled once: the one delay promise the gate allows outside `wait-for.mjs`. */
const afterTimer = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve after `ms` milliseconds — after checking, synchronously, that `reason` names its kind. It throws rather than
 * rejecting, so a refused delay fails where it is written, inside a `Promise.race` as much as anywhere.
 *
 * @param {number} ms
 * @param {string} reason `<kind>: <detail>`
 * @returns {Promise<void>}
 */
export function elapse(ms, reason) {
  const problem = reasonProblem(reason);
  if (problem) throw new TypeError(`elapse(${ms}): ${problem}`);
  return afterTimer(ms);
}
