/**
 * The one wait: poll a condition until it holds or a deadline passes, and say what never held (`Q-319`).
 *
 * ## What this prevents
 *
 * About forty tests and helpers polled by hand, in four dialects. They differed in exactly the places a wait is hard
 * to get right, and every difference has already cost a red CI run in this suite:
 *
 * - **what is said when the deadline passes** — a bare `timed out after 90000ms` hid a rejected trigger for weeks;
 * - **whether a thrown probe ends the wait or is ridden out** — a `waitForApi` that swallowed every error while a
 *   server restarted reported none of them, and one that swallowed none failed the first time a connection was refused;
 * - **whether a probe that never answers can outlast the deadline** — a `before` hook awaiting a hung request never
 *   ended, so the file was cancelled by its own parent instead of failing at the deadline with a name;
 * - **whether a timer is left armed** — a deadline timer not cleared when the wait returned held the process open
 *   for the rest of the budget.
 *
 * This module is the one place those four are decided. `a-poll-is-written-once` is how a copy does not come back: a
 * loop with a deadline, a sleep and a condition that is not in this file says why it waits differently or fails.
 * `settleWithin` (`standalone/_write-faults.mjs`) is the other question — nothing may arrive during a window — and
 * stays its own function, not a flag here. {@link holdsWithin} (a verdict instead of a throw), {@link waitForValue}
 * (the value it held with) and {@link waitForReading} (the reading of a state it accepted, the last one named when it
 * never did) are the same wait answering in the shape a caller needs, so they are built on it and cannot decide the
 * four things above again.
 *
 * ## The signature
 *
 *     waitFor(condition, timeout = 15_000, interval = 500, diagnose, { what, thinMargin, tolerate })
 *
 * The first four are positional because that is the shape of the ~117 call sites this grew from; the rest are
 * options so a caller that needs one does not need the others.
 *
 * - `condition`  returns (or resolves to) something truthy once the wait is over. The wait resolves to exactly `true`:
 *                several callers say `assert.ok(await waitFor(…))`, and an elapsed time would be `0` — falsy — for a
 *                wait that held at once.
 * - `diagnose`   a string, or a function (sync or async) returning one, appended to the timeout message after
 *                ` — `. AWAITED, so a diagnostic may go and look at something: the sender's watermark, the record's
 *                state. It used to be called synchronously and interpolated a promise as `[object Promise]`.
 * - `what`       the phrase completing "waiting for …". A timeout then names it and the LAST VALUE the condition
 *                returned, or that the last probe threw, or was still pending at the deadline. Without it the
 *                message stays `waitFor timed out after Nms`, the shape existing pins read.
 * - `thinMargin` report a pass that used most of its budget. OFF unless asked: a stack helper wants it (a stack
 *                wait one slow runner from a timeout), a poll of an in-process queue that drains in milliseconds
 *                against a budget chosen for a slow runner does not.
 * - `tolerate`   `(error) => boolean`. A probe that throws is ridden out when this says so (a server that is
 *                restarting refuses connections) and PROPAGATES otherwise, the original error, at once. There is
 *                no blanket catch, because a probe that is broken and a probe that is slow are different diagnoses.
 *
 * ## Measuring the waits
 *
 * When the environment variable named by {@link WAIT_TIMING_ENV} holds a path, every wait appends one line to it:
 * `{"type":"wait","what":…,"ms":…,"held":true|false,"file":<the test file that waited>}`. A timeout is time spent
 * waiting too, so it is recorded. The timing report subtracts the waits from a file's time, which is how "setup /
 * waits / work" exists. Recording is a side effect of the wait and its failure never becomes the wait's.
 */
import { appendFileSync } from 'node:fs';

/** The environment variable that carries the path waits are recorded to. Unset or empty: nothing is recorded. */
export const WAIT_TIMING_ENV = 'YTHRIL_TEST_WAIT_TIMING_FILE';

/** Above this share of the budget, a PASS is worth reporting: it is one slow runner from being a failure. */
const TIGHT_MARGIN = 0.6;

/** What a probe that outlasted the deadline resolves to in the race against it. Never a value a condition returns. */
const DEADLINE = Symbol('the deadline came first');

/** Append one wait to the timing destination, if there is one. Never throws. */
function record(line) {
  const destination = process.env[WAIT_TIMING_ENV];
  if (!destination) return;
  try {
    appendFileSync(destination, `${JSON.stringify({ type: 'wait', file: process.argv[1], ...line })}\n`);
  } catch { /* measurement must not fail the test it measures */ }
}

/**
 * Say so when a wait only just made it.
 *
 * ## Why a passing wait needs to report anything
 *
 * `Subscriber-local content survives publisher tombstone` failed in CI on a diff of client CSS, docs and a
 * changelog — nothing that can touch sync propagation — and passed on rerun with no code change. The obvious
 * move is to raise the 25 s and move on. It is also a guess: nobody knows whether a green run takes 3 s or 24 s,
 * so nobody knows whether the margin is thin or whether something occasionally STALLS and the deadline is
 * merely how we found out. Those are different problems and only one of them is fixed by a bigger number.
 *
 * A pass that consumed most of its budget prints the numbers, so the next person deciding a timeout has evidence
 * instead of a hunch, and a wait that is drifting toward its ceiling says so BEFORE it starts failing.
 *
 * Deliberately not a failure. Turning a slow pass into a red build would make CI stricter than the product, and
 * propagation time legitimately varies with what else the runner is doing.
 */
function warnIfTight(elapsed, timeout) {
  if (elapsed <= timeout * TIGHT_MARGIN) return;
  const pct = Math.round((elapsed / timeout) * 100);
  console.warn(`[waitFor] passed after ${elapsed}ms of a ${timeout}ms budget (${pct}%) — thin margin, and a `
    + 'slower runner turns this into a timeout. Raise the budget only if this is normal rather than a stall.');
}

const show = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

/** A reading as JSON where it has one (`String(object)` names nothing), else as `show` says it. */
function showReading(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return show(value);
  }
}

/**
 * What a wait throws when its deadline passed with the condition unmet — as opposed to an error a probe threw, which
 * propagates as itself.
 *
 * It exists so a caller that wants a verdict instead of an exception ({@link holdsWithin}) can tell the two apart by
 * what the error IS. Recognising a timeout by its message would break the day the message is reworded, and the
 * failure would be a broken probe read as "it never held". Its `name` stays `Error`, so it prints as the message
 * always has.
 */
export class WaitTimeout extends Error {}

/**
 * Wait until `condition` holds, or throw saying what never did.
 *
 * Each probe is raced against the time that is left, so a probe that never answers ends the wait at its deadline
 * rather than never; the abandoned probe's late rejection is swallowed so it cannot surface after the wait is over.
 *
 * @param {() => unknown} condition
 * @param {number} [timeout]  ms
 * @param {number} [interval] ms between probes
 * @param {string | (() => string | undefined | Promise<string | undefined>)} [diagnose]
 * @param {{ what?: string, thinMargin?: boolean, tolerate?: (error: unknown) => boolean }} [options]
 * @returns {Promise<true>}
 */
export async function waitFor(condition, timeout = 15_000, interval = 500, diagnose, options = {}) {
  const { what, thinMargin = false, tolerate } = options;
  const start = Date.now();
  const deadline = start + timeout;
  let last = { kind: 'value', value: undefined };
  let polled = false;

  // A zero budget still asks once: a condition that already holds is not a timeout.
  while (Date.now() < deadline || !polled) {
    polled = true;
    let cutOff;
    const cut = new Promise((resolve) => { cutOff = setTimeout(() => resolve(DEADLINE), Math.max(0, deadline - Date.now())); });
    try {
      const probe = Promise.resolve().then(() => condition());
      probe.catch(() => {}); // a probe cut off at the deadline may reject later; nobody is left to hear it
      const answer = await Promise.race([probe, cut]);
      if (answer === DEADLINE) {
        last = { kind: 'pending' };
      } else if (answer) {
        const ms = Date.now() - start;
        record({ what, ms, held: true });
        if (thinMargin) warnIfTight(ms, timeout);
        return true;
      } else {
        last = { kind: 'value', value: answer };
      }
    } catch (error) {
      if (!(typeof tolerate === 'function' && tolerate(error))) {
        record({ what, ms: Date.now() - start, held: false });
        throw error;
      }
      last = { kind: 'threw', message: error?.message ?? String(error) };
    } finally {
      clearTimeout(cutOff);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
  }

  record({ what, ms: Date.now() - start, held: false });
  const detail = typeof diagnose === 'function' ? await diagnose() : diagnose;
  const lastSaid = last.kind === 'threw' ? `last probe threw: ${last.message}`
    : last.kind === 'pending' ? 'last probe still pending'
      : `last value: ${show(last.value)}`;
  const named = what ? ` waiting for ${what} (${lastSaid})` : (last.kind === 'threw' ? ` (${lastSaid})` : '');
  throw new WaitTimeout(`waitFor timed out after ${timeout}ms${named}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Wait like {@link waitFor}, but answer `false` at the deadline instead of throwing.
 *
 * For the caller whose next step depends on whether it held — a `before` hook that must still reach its skip
 * decision when the index never came up, a test that skips on a peer that was never wired. ONLY a timeout is an
 * answer: a probe that throws (and is not tolerated) still propagates, because "it never held" and "the probe is
 * broken" are different diagnoses and a verdict that swallowed the second would report it as the first.
 *
 * @returns {Promise<boolean>}
 */
export async function holdsWithin(condition, timeout, interval, options = {}) {
  try {
    await waitFor(condition, timeout, interval, undefined, options);
    return true;
  } catch (error) {
    if (error instanceof WaitTimeout) return false;
    throw error;
  }
}

/**
 * Wait like {@link waitFor}, and return the value the condition held with.
 *
 * `waitFor` resolves to exactly `true` on purpose (`assert.ok(await waitFor(…))` must keep working); a caller that
 * wants the thing it waited for — the record, the status document — gets it here, so it does not keep the last
 * answer in a variable beside the wait and risk reading one the wait did not accept.
 */
export async function waitForValue(condition, timeout, interval, diagnose, options = {}) {
  let held;
  await waitFor(async () => { held = await condition(); return held; }, timeout, interval, diagnose, options);
  return held;
}

/**
 * Wait until a READING of something satisfies `accept`, and resolve with the reading that did.
 *
 * ## What it prevents
 *
 * A wait on a state the test cannot see inside — a file's `embeddingStatus`, a job's phase — gets the same wait written
 * twice: `waitFor(async () => { last = await read(); return accept(last); }, …, () => `last status: ${last}`)`, with the
 * variable beside the wait. A copy that forgets the diagnostic times out saying `last value: false` (the PREDICATE's
 * answer), which names nothing; a copy that forgets to return `last` makes the caller read the state a second time, after
 * the wait, and assert on a reading the wait did not accept. Both are decided here: the reading is the thing returned and
 * the thing the timeout names.
 *
 * It throws at the deadline like {@link waitFor}. A caller whose question is "must this NOT happen within the window"
 * asks {@link holdsWithin} and asserts the verdict is `false`.
 *
 * @param {() => unknown} read  the probe: the current state, as a value the caller can name
 * @param {(reading: any) => unknown} accept  truthy when the reading is the one waited for
 * @returns {Promise<any>} the reading `accept` took
 */
export async function waitForReading(read, accept, timeout, interval, options = {}) {
  let last;
  await waitFor(async () => { last = await read(); return accept(last); }, timeout, interval,
    () => `last reading: ${showReading(last)}`, options);
  return last;
}
