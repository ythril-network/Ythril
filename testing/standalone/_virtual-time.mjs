/**
 * A virtual clock and scheduler a test drives by hand, for code that backs off for minutes and retries for hours.
 *
 * ## What it answers
 *
 * "How does this code behave over ten idle minutes, a fifteen-minute model load, six hours of a search service
 * being down, or a day of crash loops" without a test that takes that long, and without one that asserts on a
 * real timer's jitter (a real timer makes a test slow and, worse, dependent on the machine's load). Code that
 * takes its clock, its scheduler and its sleep as arguments is tested by handing it these, and its timing rules
 * become ordinary assertions.
 *
 * ## One module, one queue, and why
 *
 * Two families of tests arrived at this at the same time, each with its own copy: the search-readiness watcher
 * (Q-113) and the supervised worker host (Q-99). They asked the same question, so they share one answer. The
 * code under test spells the scheduler two ways — `setTimer`/`clearTimer` in `spaces/search-readiness.ts`,
 * `setTimeout`/`clearTimeout` in `util/supervised-worker.ts` — and `scheduler` offers both spellings over the
 * SAME queue, as does `sleep`. So a timeout written with `sleep` and one written with a timer both fire when time
 * is advanced, and a test does not have to know which the implementation chose, only that a hung call does not
 * hang for ever.
 *
 * ## What it does NOT do
 *
 * It does not patch globals. `setTimeout` and `Date.now` keep meaning what they mean; the code under test has to
 * accept the injected ones. A test that patched the globals would also be patching the timers of `node:test`
 * itself, and `mock.timers` only covers globals.
 *
 * ## Why `advance` is async
 *
 * The code under test is promise-based. Firing a timer and then asserting on the same tick reads state before its
 * `await`s have run. Before each timer fires, and once at the end, `advance` lets every promise chain that can make
 * progress do so (`settle`). So a test reads "what is true once everything that could happen at this instant has
 * happened". A timer scheduled inside the window fires in the same `advance` call if it falls due before the
 * target, in time order (ties in the order they were set), which is what a real clock does.
 *
 * `settle` and `flush` use `setImmediate`, which is the event loop rather than a timer the code under test can
 * see, so neither is a second clock.
 */

/** `await settle()` — let every pending promise continuation run, as deep as the chains go. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
}

/** `await flush()` — one turn of the event loop: every microtask queued so far runs, and no deeper. */
export const flush = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {number} [startMs] the virtual epoch, ms. Not zero, so a bug that treats `0` as "never" cannot hide.
 */
export function createVirtualTime(startMs = 1_700_000_000_000) {
  let t = startMs;
  let seq = 0;
  /** @type {Set<{ at: number, ms: number, fn: () => void, seq: number }>} */
  const timers = new Set();
  const slept = [];

  /** A handle shaped like a Node timer, so code that calls `unref()` on it works unchanged. */
  const setTimer = (fn, ms) => {
    const delay = Math.max(0, Number(ms) || 0);
    const handle = {
      at: t + delay, ms: delay, fn, seq: seq++,
      unref() { return handle; },
      ref() { return handle; },
      hasRef() { return true; },
      refresh() { if (timers.has(handle)) handle.at = t + handle.ms; return handle; },
    };
    timers.add(handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle && typeof handle === 'object') timers.delete(handle); };
  const sleep = (ms) => new Promise(resolve => { slept.push(ms); setTimer(resolve, ms); });
  const now = () => t;

  /** Run every timer due within `ms` of virtual time, in order, letting promises settle between them. */
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      await settle();
      let due = null;
      for (const x of timers) if (x.at <= end && (!due || x.at < due.at || (x.at === due.at && x.seq < due.seq))) due = x;
      if (!due) break;
      timers.delete(due);
      t = Math.max(t, due.at);
      due.fn();
    }
    t = end;
    await settle();
  }

  /** Advance in `stepMs` steps until `promise` settles (or `limitMs` passes). Returns its value, or throws. */
  async function drive(promise, { stepMs = 1_000, limitMs = 10 * 60_000 } = {}) {
    let done = false; let value; let error; let failed = false;
    promise.then(v => { done = true; value = v; }, e => { done = true; failed = true; error = e; });
    for (let spent = 0; !done && spent <= limitMs; spent += stepMs) await advance(stepMs);
    if (!done) throw new Error(`still pending after ${limitMs} ms of virtual time`);
    if (failed) throw error;
    return value;
  }

  /** Has `promise` settled, without advancing time? (A caller that must not wait should pass this.) */
  async function settledWithoutWaiting(promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await settle();
    return done;
  }

  return {
    setTimer, clearTimer, sleep, now, advance, drive, settledWithoutWaiting,
    /** Both spellings the code under test uses, over the one queue. */
    scheduler: { setTimer, clearTimer, setTimeout: setTimer, clearTimeout: clearTimer },
    /** Every `sleep(ms)` argument, in order. */
    slept,
    /** How many timers are waiting. A leak reads as a number that never comes back down. */
    pendingTimers: () => timers.size,
    /** ms until the next timer, or null when none is scheduled. */
    nextDueIn: () => {
      let min = null;
      for (const x of timers) if (min === null || x.at - t < min) min = x.at - t;
      return min;
    },
  };
}

/** A logger that records every line by level, and the error it was handed only as text. */
export function captureLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const log = {};
  for (const level of Object.keys(lines)) log[level] = (...args) => { lines[level].push(args.map(String).join(' ')); };
  return { log, lines, all: () => Object.values(lines).flat() };
}
