/**
 * A virtual clock, for tests of code that backs off for minutes and retries for hours.
 *
 * ## Why this is a module
 *
 * The search-readiness watcher waits 5 s, doubling to 5 min, for as long as the database's search is down, and a
 * test that means "it is still retrying after six hours, at the cap" cannot spend six hours, and must not spend
 * real seconds on timers either (a real timer makes a test slow and, worse, dependent on the machine's load).
 * `mock.timers` only covers the global timer functions, and the code under test is handed its scheduler, its
 * clock and its sleep as arguments precisely so none of them is global. So every one of the three reads from
 * this one queue: `sleep` and `setTimer` are the same kind of thing here, and `advance` runs whichever is due.
 *
 * **One queue for all three is the point.** A timeout written with `sleep` and one written with `setTimer` both
 * fire when time is advanced, so a test does not have to know which the implementation chose — only that a hung
 * call does not hang for ever.
 *
 * `settle` lets every promise chain that can make progress do so. It uses `setImmediate`, which is the event loop
 * rather than a timer the code under test can see, so it is not a second clock.
 */

/** `await settle()` — let every pending promise continuation run, as deep as the chains go. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
}

export function createVirtualTime(startMs = 1_700_000_000_000) {
  let t = startMs;
  let seq = 0;
  /** @type {{ at: number, fn: () => void, seq: number }[]} */
  let timers = [];
  const slept = [];

  const setTimer = (fn, ms) => {
    const handle = { at: t + Math.max(0, Number(ms) || 0), fn, seq: seq++ };
    timers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => { timers = timers.filter(x => x !== handle); };
  const sleep = (ms) => new Promise(resolve => { slept.push(ms); setTimer(resolve, ms); });
  const now = () => t;

  /** Run every timer due within `ms` of virtual time, in order, letting promises settle between them. */
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      await settle();
      const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      timers = timers.filter(x => x !== due);
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
    scheduler: { setTimer, clearTimer },
    /** Every `sleep(ms)` argument, in order. */
    slept,
    pendingTimers: () => timers.length,
  };
}

/** A logger that records every line by level, and the error it was handed only as text. */
export function captureLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const log = {};
  for (const level of Object.keys(lines)) log[level] = (...args) => { lines[level].push(args.map(String).join(' ')); };
  return { log, lines, all: () => Object.values(lines).flat() };
}
