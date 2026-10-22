/**
 * The webhook retry poll run over fakes, one tick at a time: what the two poll test files share (bundle-169, the reuse rule's second site).
 *
 * `the-webhook-retry-poll-skips-an-overlap-and-delivers-four-at-a-time` and `a-webhook-retry-poll-shares-each-tick-across-subscriptions`
 * each built the same worker: `createRetryWorker` handed `IntervalJobDeps` whose `arm` keeps the tick function, so no timer fires and the
 * test calls the tick itself. What each file fakes behind `RetryPollDeps` (an event log, an in-memory queue) stays in that file; this is
 * the part that was copied.
 *
 * **What a hand-written copy drops: the settle.** `fire` runs the tick and then lets every promise it started run to its first real wait
 * (`settle`), so an assertion after it reads what the tick did, not what it had begun.
 */
import { settle } from './_virtual-time.mjs';

/** A latch the test opens: `p` resolves when `release` is called. */
export const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

/** A delivery the sink accepted, and one it refused with a 500. */
export const ok = { id: 'x', webhookId: 'x', event: 'entity.created', spaceId: 's', timestamp: '', responseStatus: 204, latencyMs: 1, success: true };
export const failed = { ...ok, responseStatus: 500, success: false, error: 'HTTP 500' };

/**
 * A retry worker over `deps` whose timer is a function the test calls. The timer's state is written into `state` (`tickFn`, `handle`
 * with `refed`, `disarmed`), so a file keeps its own state object for everything else it records; `lines` (optional) collects the job's
 * `warn` and `error` lines.
 *
 * @param {object} dispatcher  the built `webhooks/dispatcher.js`
 * @param {object} deps  the `RetryPollDeps` fakes
 * @param {object} state  where the timer's state is written
 * @param {{ warn: string[], error: string[] }} [lines]
 * @returns {{ worker: { job: object }, fire: () => Promise<void> }}
 */
export function armedRetryWorker(dispatcher, deps, state, lines) {
  state.tickFn = null;
  state.handle = null;
  state.disarmed = 0;
  const worker = dispatcher.createRetryWorker(deps, {
    arm: (fn) => { state.tickFn = fn; state.handle = { refed: true, unref() { state.handle.refed = false; return state.handle; } }; return state.handle; },
    disarm: () => { state.disarmed++; },
    warn: (m) => { lines?.warn.push(m); }, error: (m) => { lines?.error.push(m); },
  });
  const fire = async () => { state.tickFn(); await settle(); };
  return { worker, fire };
}
