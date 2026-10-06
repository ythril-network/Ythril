/**
 * The webhook retry poll is an interval job that skips an overlapping tick and delivers its due retries four at a time
 * (`Q-317`, `Q-274`, bundle-53 G23).
 *
 * ## The two defects it closes
 *
 * `processRetryQueue` ran on a bare `setInterval(…, 10_000)` with no guard, and delivered the due jobs ONE AT A TIME:
 *
 * - **Overlap.** A tick that was still delivering when the next one fired (a sink that takes its whole 10 s delivery timeout is
 *   enough) read the same due rows. The job removes its row BEFORE it delivers, so two ticks do not deliver the same row twice
 *   by that route, but a failed delivery re-enqueues, and every tick that ran beside it paid for another full pass of the
 *   queue. Skipping the overlap is right for a poll (the next tick takes what the skipped one would have), and a skipped tick is
 *   counted (`ythril_interval_tick_skipped_total{job}`), not hidden.
 * - **Head of line.** A skip makes the sequential delivery worse: one slow sink at the head of the batch held every other sink's
 *   retries behind it for as long as it took, and with the skip, the next tick did not even start. Delivery now runs with a
 *   concurrency of four (`mapLimit`), so one slow sink holds one slot of four, and the others finish.
 *
 * ## What is pinned
 *
 * A second tick while the first runs is skipped and counted, and a tick after it ends polls again; six due deliveries to six sinks
 * with the FIRST one held: at most four are in flight at once, four are reached, and the five others are delivered while the slow
 * one is still held; a delivery that throws does not stop the others of its tick; a job is removed from the queue BEFORE its
 * delivery (at-least-once: a crash mid-delivery gives a duplicate, not a loss); a failed delivery is re-queued with the next
 * attempt number and the last attempt marks the webhook failing; the timer is unref'd and `stop` disarms it.
 *
 * No timer fires here: the job is handed an `arm` that keeps the tick function, and the test calls it (`IntervalJobDeps`).
 *
 * Run: node --test testing/standalone/the-webhook-retry-poll-skips-an-overlap-and-delivers-four-at-a-time.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './_virtual-time.mjs';

let dispatcher, onHousekeepingSignal;

before(async () => {
  dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
  ({ onHousekeepingSignal } = await import('../../server/dist/util/housekeeping-signals.js'));
});

const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

const job = (n, over = {}) => ({
  _id: `job-${n}`, webhookId: `sink-${n}`, body: '{}', event: 'entity.created', spaceId: 's', deliveryId: `d-${n}`,
  attempt: 2, scheduledAt: new Date(0), createdAt: new Date(0), ...over,
});
const ok = { id: 'x', webhookId: 'x', event: 'entity.created', spaceId: 's', timestamp: '', responseStatus: 204, latencyMs: 1, success: true };
const failed = { ...ok, responseStatus: 500, success: false, error: 'HTTP 500' };

/** A worker over fakes: every door it uses is recorded, and the timer is a function the test calls. */
function rig({ due = [], deliver = async () => ok } = {}) {
  const events = [];
  const state = { dueCalls: 0, inFlight: 0, peak: 0, delivered: [], handle: null, tickFn: null, disarmed: 0 };
  const deps = {
    dueJobs: async () => { state.dueCalls++; return typeof due === 'function' ? due(state.dueCalls) : due; },
    removeJob: async (id) => { events.push(`remove ${id}`); },
    getWebhook: async (id) => ({ id, url: `https://example.invalid/${id}`, secret: 's' }),
    deliver: async (sub, j) => {
      events.push(`deliver ${j._id}`);
      state.inFlight++; state.peak = Math.max(state.peak, state.inFlight);
      try { const r = await deliver(sub, j); state.delivered.push(j._id); return r; } finally { state.inFlight--; }
    },
    markSuccess: async (id) => { events.push(`success ${id}`); },
    markFailure: async (id) => { events.push(`failing ${id}`); },
    requeue: async (j) => { events.push(`requeue ${j._id} attempt ${j.attempt + 1}`); },
  };
  const lines = { warn: [], error: [] };
  const worker = dispatcher.createRetryWorker(deps, {
    arm: (fn) => { state.tickFn = fn; state.handle = { refed: true, unref() { state.handle.refed = false; return state.handle; } }; return state.handle; },
    disarm: () => { state.disarmed++; },
    warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m),
  });
  const fire = async () => { state.tickFn(); await settle(); };
  return { worker, deps, events, state, lines, fire };
}

const skipsOf = [];
let off = () => {};
afterEach(() => { off(); off = () => {}; skipsOf.length = 0; });
const watchSkips = () => { off = onHousekeepingSignal((e) => { if (e.type === 'tick-skipped' && e.job === dispatcher.RETRY_JOB_LABEL) skipsOf.push(e); }); };

describe('the retry poll skips an overlapping tick', () => {
  it('a second tick while the first is still delivering is skipped and counted; a tick after it ends polls again', async () => {
    watchSkips();
    const hold = gate();
    const r = rig({ due: (n) => (n === 1 ? [job(1)] : []), deliver: () => hold.p.then(() => ok) });
    r.worker.job.start();
    await r.fire();                       // tick 1 starts and waits in the delivery
    assert.equal(r.state.dueCalls, 1);
    await r.fire();                       // tick 2 fires beside it
    await r.fire();                       // and tick 3
    assert.equal(r.state.dueCalls, 1, 'an overlapping tick read the queue again');
    assert.equal(skipsOf.length, 2, `the skipped ticks were not counted: ${skipsOf.length}`);
    hold.release();
    await settle();
    await r.fire();
    assert.equal(r.state.dueCalls, 2, 'a tick after the first ended did not poll');
    assert.equal(skipsOf.length, 2, 'a tick that ran was counted as skipped');
  });

  it('the job is named for the poll, and the label is a constant', () => {
    assert.equal(dispatcher.RETRY_JOB_LABEL, 'Webhook retry poll');
  });
});

describe('the retry poll delivers four at a time', () => {
  it('six due deliveries, the first sink held: at most four in flight, four reached, the five others delivered meanwhile', async () => {
    const hold = gate();
    const jobs = [1, 2, 3, 4, 5, 6].map(n => job(n));
    const r = rig({
      due: [...jobs],
      deliver: async (_sub, j) => {
        if (j._id === 'job-1') { await hold.p; return ok; }
        await new Promise(res => setImmediate(res));   // a short delivery, long enough for the others to be in flight with it
        return ok;
      },
    });
    r.worker.job.start();
    await r.fire();
    assert.equal(dispatcher.RETRY_CONCURRENCY, 4);
    assert.ok(r.state.peak <= dispatcher.RETRY_CONCURRENCY, `${r.state.peak} deliveries were in flight at once`);
    assert.equal(r.state.peak, dispatcher.RETRY_CONCURRENCY, 'the poll did not use its four slots');
    assert.deepEqual([...r.state.delivered].sort(), ['job-2', 'job-3', 'job-4', 'job-5', 'job-6'],
      'one slow sink held the retries of the others behind it');
    assert.equal(r.state.inFlight, 1, 'only the held delivery is still running');
    hold.release();
    await settle();
    assert.equal(r.state.delivered.length, 6);
    assert.equal(r.state.inFlight, 0);
  });
});

describe('what the poll did before is kept', () => {
  it('a job is removed from the queue before its delivery is attempted', async () => {
    const r = rig({ due: [job(1)] });
    r.worker.job.start();
    await r.fire();
    assert.deepEqual(r.events, ['remove job-1', 'deliver job-1', 'success sink-1']);
  });

  it('a delivery that throws does not stop the others of its tick', async () => {
    const r = rig({
      due: [job(1), job(2), job(3)],
      deliver: async (_s, j) => { if (j._id === 'job-1') throw new Error('socket hang up'); return ok; },
    });
    r.worker.job.start();
    await r.fire();
    assert.deepEqual([...r.state.delivered].sort(), ['job-2', 'job-3']);
    assert.ok(r.events.includes('success sink-2') && r.events.includes('success sink-3'));
  });

  it('a failed delivery is re-queued with the next attempt; the last attempt marks the webhook failing', async () => {
    const last = dispatcher.MAX_RETRY_ATTEMPTS;
    const r = rig({ due: [job(1, { attempt: 2 }), job(2, { attempt: last })], deliver: async () => failed });
    r.worker.job.start();
    await r.fire();
    assert.ok(r.events.includes('requeue job-1 attempt 3'), r.events.join(' | '));
    assert.ok(r.events.includes('failing sink-2'), r.events.join(' | '));
    assert.ok(!r.events.some(e => e.startsWith('requeue job-2')), 'the last attempt was re-queued');
  });

  it('a webhook deleted while its retry was queued is dropped without a delivery', async () => {
    const r = rig({ due: [job(1)] });
    r.deps.getWebhook = async () => null;
    r.worker.job.start();
    await r.fire();
    assert.deepEqual(r.events, ['remove job-1']);
  });
});

describe('the timer', () => {
  it('is unref\'d, armed once, and cleared by stop', () => {
    const r = rig();
    r.worker.job.start();
    r.worker.job.start();
    assert.equal(r.state.handle.refed, false, 'the retry poll holds the process open');
    assert.equal(r.worker.job.armed, true);
    r.worker.job.stop();
    r.worker.job.stop();
    assert.equal(r.state.disarmed, 1, 'stop did not clear the timer exactly once');
    assert.equal(r.worker.job.armed, false);
  });

  it('is an interval job of the production module: started and stopped through startRetryWorker / stopRetryWorker', async () => {
    const { declaredJobs } = await import('../../server/dist/util/housekeeping-signals.js');
    assert.ok(declaredJobs().includes(dispatcher.RETRY_JOB_LABEL),
      `'${dispatcher.RETRY_JOB_LABEL}' is not a declared interval job: its timer is a bare setInterval`);
    assert.doesNotThrow(() => { dispatcher.startRetryWorker(); dispatcher.startRetryWorker(); dispatcher.stopRetryWorker(); dispatcher.stopRetryWorker(); });
  });
});
