/**
 * A clock and a scheduler a test drives by hand.
 *
 * ## What it answers
 *
 * "How does this code behave over ten idle minutes, a fifteen-minute model load, or a day of crash loops" without
 * a test that takes that long or one that asserts on a real timer's jitter. A host that takes `now` and a
 * `scheduler` as arguments is tested by handing it this, and its timing rules become ordinary assertions.
 *
 * ## What it does NOT do
 *
 * It does not patch globals. `setTimeout` and `Date.now` keep meaning what they mean; the code under test has to
 * accept the pair. A test that patched the globals would also be patching the timers of `node:test` itself.
 *
 * ## Why `advance` is async
 *
 * The code under test is promise-based. Firing a timer and then asserting on the same tick reads state before its
 * `await`s have run. After each timer, and once at the start and the end, `advance` lets every pending microtask
 * drain (one `setImmediate`, because the microtask queue is emptied completely before the next macrotask). So a
 * test reads "what is true once everything that could happen at this instant has happened".
 *
 * A timer that schedules another inside the window fires in this same `advance` call if it falls due before the
 * target, in time order, which is what a real clock does.
 */

/** Let every promise continuation that can run, run. */
export const flush = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {number} [start] the virtual epoch, ms. Not zero, so a bug that treats `0` as "never" cannot hide.
 */
export function createVirtualTime(start = 1_000_000) {
  let t = start;
  let seq = 0;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();

  const scheduler = {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn });
      const handle = {
        id,
        unref() { return handle; },
        ref() { return handle; },
        hasRef() { return true; },
        refresh() { const e = timers.get(id); if (e) e.at = t; return handle; },
      };
      return handle;
    },
    clearTimeout(handle) {
      if (handle && typeof handle === 'object') timers.delete(handle.id);
    },
  };

  /** Move the clock forward, firing every timer that falls due, in order. */
  async function advance(ms) {
    const target = t + ms;
    await flush();
    for (;;) {
      let nextId = null;
      let nextAt = Infinity;
      for (const [id, e] of timers) if (e.at <= target && e.at < nextAt) { nextId = id; nextAt = e.at; }
      if (nextId === null) break;
      const e = timers.get(nextId);
      timers.delete(nextId);
      t = Math.max(t, e.at);
      e.fn();
      await flush();
    }
    t = target;
    await flush();
  }

  return {
    now: () => t,
    scheduler,
    advance,
    /** How many timers are waiting. A leak reads as a number that never comes back down. */
    pendingTimers: () => timers.size,
    /** ms until the next timer, or null when none is scheduled. */
    nextDueIn: () => {
      let min = null;
      for (const e of timers.values()) if (min === null || e.at - t < min) min = e.at - t;
      return min;
    },
  };
}
