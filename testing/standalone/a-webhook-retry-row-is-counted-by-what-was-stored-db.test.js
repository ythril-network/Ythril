/**
 * A webhook retry row is counted by what the store HOLDS after the write, not by whether the write answered (bundle-169, Q-580).
 *
 * ## The defect it closes
 *
 * Three paths write a retry row, and each counted by the write's answer:
 *
 *  - **The overflow flush** (`pendingRetryRows`) counted its whole batch `lost` on any failure, "an upper bound". A write whose rows
 *    LANDED and whose reply was lost (a store that went away after applying it, a timeout that fired after the server wrote) said every
 *    one of those events was never sent and nothing would send it, while the retry poll went on to deliver each of them. And
 *    `overflowed` stayed 0 for rows the queue held. The counters' own docblocks say `overflowed` is the rows persisted and `lost` the
 *    rows not.
 *  - **The first-delivery requeue** (one row, after a failed first delivery) counted `lost` on any failure, with the same blindness.
 *  - **The poll's requeue** (a failed retry put back for its next attempt) counted nothing at all: a refused requeue lost the event and
 *    only said so (N12).
 *
 * `insertedIds` cannot answer it: on a timeout it reports every attempted row while 0 or all of them were stored (probe P2). Only a read
 * back of the ids is exact, and a row that is not found may have been delivered and removed already, so `lost` carries a `reason`:
 * `not_stored` when the write is known to have ended without it, `not_known_stored` otherwise (design rev 3.2, N2).
 *
 * ## What is held
 *
 *  - **Rows land, reply lost** (the batch): `overflowed` rises by the rows the queue holds, and nothing is counted lost.
 *  - **Refused outright** (the batch): `lost{reason="not_stored"}` rises by the overflow, and `overflowed` by nothing.
 *  - **The first-delivery requeue**: a refused row is `lost{not_stored}`; a row that landed with its reply lost is not counted lost.
 *  - **The poll's requeue**: a refused requeue is `lost{not_stored}`; one that landed with its reply lost is not counted lost.
 *  - **A request's write bound does not end the flush** (C5, N1): an event emitted inside an active `withinWriteBound` whose deadline is
 *    nearly spent is flushed by a write that deadline does not end, and its rows are counted as overflowed.
 *
 * The errors injected are the driver's own (`driverWriteFailures`): a duplicate key for a refusal, and the store gone for a reply that
 * did not come back after the rows landed (`failWrites`' `land`).
 *
 * ## Seen red
 *
 * At cf89b68a: the landed batch counts every row lost and none overflowed; the refused batch and the refused first-delivery requeue are
 * counted lost with no `reason`, so `lost{not_stored}` reads 0; the landed first-delivery requeue is counted lost; the refused poll
 * requeue is counted nowhere. The landed poll requeue was never counted, so it is green at the base and guards the read-back. The bound
 * case: see its own comment.
 *
 * Run: node --test testing/standalone/a-webhook-retry-row-is-counted-by-what-was-stored-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { driverWriteFailures, failWrites, setWriteBoundForTest } from './_write-faults.mjs';
import { parkDriverCall } from './_parked-driver-call.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const SUITE = 'retrycounted';
const S = 'retrycounted';
const RETRY_QUEUE = '_webhook_retry_queue';
const LOST = 'ythril_webhook_first_deliveries_lost_total';
const OVERFLOWED = 'ythril_webhook_first_deliveries_overflowed_total';
/** Events beyond the held sink's bound: each overflows to the retry queue. */
const OVER = 30;
const pathOf = (tag, i) => `${tag}/f${String(i).padStart(4, '0')}.txt`;

let acts, dispatcher, store, registry, writeBound, signals, F, faults;
let a, b;

const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const ok = (sub, event, spaceId, deliveryId) => ({ id: deliveryId, webhookId: sub.id, event, spaceId, timestamp: new Date().toISOString(), responseStatus: 204, latencyMs: 1, success: true });
const refusedBySink = (sub, event, spaceId, deliveryId) => ({ ...ok(sub, event, spaceId, deliveryId), responseStatus: 500, success: false, error: 'HTTP 500' });

/** Sink A held behind `holdA`, or failing every first delivery (`failA`); sink B answers. Records what was delivered. */
function rig({ holdA, failA = false } = {}) {
  const state = { delivered: new Map() };
  const note = (id, path) => { let s = state.delivered.get(id); if (!s) { s = new Set(); state.delivered.set(id, s); } s.add(path); };
  dispatcher.setFirstDeliveryDepsForTest({
    async deliver(sub, body, event, spaceId, deliveryId) {
      const path = JSON.parse(body)?.entry?.path;
      if (holdA && sub.id === a) await holdA.p;
      if (failA && sub.id === a) return refusedBySink(sub, event, spaceId, deliveryId);
      note(sub.id, path);
      return ok(sub, event, spaceId, deliveryId);
    },
  });
  return state;
}

/** A counter's total over the series whose labels include `label` (every series when none), as an operator's query reads it. */
async function counted(name, label) {
  const text = await registry.register.getSingleMetricAsString(name);
  const lines = text.split(/\r?\n/).filter(l => l.startsWith(name) && !l.startsWith('#'));
  if (lines.length === 0) throw new Error(`${name} is not on the scrape`);
  return lines.filter(l => label === undefined || l.includes(label)).reduce((n, l) => n + Number(l.trim().split(/\s+/).at(-1)), 0);
}
const NOT_STORED = 'reason="not_stored"';
const NOT_KNOWN_STORED = 'reason="not_known_stored"';

/** Every counter this file reads, at once: a case compares two of these. */
async function reading() {
  return {
    overflowed: await counted(OVERFLOWED),
    lost: await counted(LOST),
    notStored: await counted(LOST, NOT_STORED),
    notKnownStored: await counted(LOST, NOT_KNOWN_STORED),
  };
}
const minus = (x, y) => Object.fromEntries(Object.keys(x).map(k => [k, x[k] - y[k]]));

const rowsOf = async (sub, tag) => (await acts.door.mongo.col(RETRY_QUEUE).find({ webhookId: sub }).toArray())
  .map(r => JSON.parse(r.body)?.entry?.path).filter(p => p?.startsWith(`${tag}/`));
const emit = (tag, n) => { for (let i = 0; i < n; i++) dispatcher.emitWebhookEvent({ event: 'file.deleted', spaceId: S, entry: { path: pathOf(tag, i) } }); };

/**
 * The overflow flush has settled: through the dispatcher's own answer where it has one, else (the base) once every overflow row is
 * counted one way or the other — the counters' contract, which the base keeps on a failure because it counts in the same tick.
 */
async function flushSettled(before, expected) {
  if (typeof dispatcher.settledRetryWrites === 'function') { await dispatcher.settledRetryWrites(); return; }
  await waitFor(async () => { const d = minus(await reading(), before); return d.overflowed + d.lost >= expected; }, 30_000, 25,
    async () => `the overflow flush never counted its ${expected} rows: ${JSON.stringify(minus(await reading(), before))}`, { what: 'the flush counted' });
}

/**
 * Burst sink A past its bound with A held, the fault armed first (`arm`: the flush starts as soon as the first event overflows), run
 * `during` once every event is resolved, then release A and wait for its deliveries.
 */
async function overflowA(tag, arm, during) {
  const hold = gate();
  const state = rig({ holdA: hold });
  const n = dispatcher.FIRST_DELIVERY_BOUND + OVER;
  try {
    arm();
    emit(tag, n);
    await waitFor(() => (state.delivered.get(b)?.size ?? 0) === n, 30_000, 25, 'sink B never received every event', { what: 'every event resolved' });
    return await during();
  } finally {
    hold.release();
    await waitFor(() => (state.delivered.get(a)?.size ?? 0) === dispatcher.FIRST_DELIVERY_BOUND, 30_000, 25,
      () => `${state.delivered.get(a)?.size ?? 0} of the held sink's ${dispatcher.FIRST_DELIVERY_BOUND} queued deliveries finished`, { what: 'the held sink drained' });
  }
}

describe('a webhook retry row is counted by what the store holds after the write (Q-580)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: SUITE, space: S });
    dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
    store = await import('../../server/dist/webhooks/store.js');
    registry = await import('../../server/dist/metrics/registry.js');
    writeBound = await import('../../server/dist/db/write-bound.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
    F = await driverWriteFailures(`ythril_harness_${SUITE}`);
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'insertOne']);
    a = (await store.createWebhook({ url: 'http://127.0.0.1:9/a', secret: 'counted-a' })).id;
    b = (await store.createWebhook({ url: 'http://127.0.0.1:9/b', secret: 'counted-b' })).id;
  });
  after(async () => {
    faults?.restore();
    dispatcher?.setFirstDeliveryDepsForTest?.(null);
    for (const id of [a, b]) if (id) await store?.deleteWebhook(id).catch(() => {});
    await acts?.door.mongo.col(RETRY_QUEUE).deleteMany({}).catch(() => {});
    await acts?.close();
  });
  beforeEach(async () => { await acts.door.mongo.col(RETRY_QUEUE).deleteMany({}); });
  afterEach(() => { faults.clear(); dispatcher.setFirstDeliveryDepsForTest(null); });

  describe('the read-back verdict (retryRowsStored), per branch', () => {
    // The rows are written or not by the test itself, so each verdict is read against a queue whose state is known; the errors are the
    // driver's own. A row id no write ever stored is what a lost row looks like to the read-back.
    let stored;
    before(async () => { stored = await import('../../server/dist/webhooks/retry-rows-stored.js'); });
    const past = () => new Date(Date.now() - 60_000);
    const future = () => new Date(Date.now() + 60_000);

    it('found: stored, whatever the write answered', async () => {
      await acts.door.mongo.col(RETRY_QUEUE).insertOne({ _id: 'verdict-found', webhookId: 'v', scheduledAt: future() });
      const v = await stored.retryRowsStored(RETRY_QUEUE, [{ _id: 'verdict-found', scheduledAt: future() }], F.storeGone.bulk);
      assert.equal(v.get('verdict-found'), 'stored');
    });

    it('absent, not due, and the store refused the write: not_stored', async () => {
      const v = await stored.retryRowsStored(RETRY_QUEUE, [{ _id: 'verdict-refused', scheduledAt: future() }], F.refused.duplicateKey);
      assert.equal(v.get('verdict-refused'), 'not_stored');
    });

    it('absent and already due: not_known_stored, even after a refusal (the poll may have delivered and removed it)', async () => {
      const v = await stored.retryRowsStored(RETRY_QUEUE, [{ _id: 'verdict-due', scheduledAt: past() }], F.refused.duplicateKey);
      assert.equal(v.get('verdict-due'), 'not_known_stored');
    });

    it('absent, not due, and the store went away: not_known_stored (the write may still land)', async () => {
      const v = await stored.retryRowsStored(RETRY_QUEUE, [{ _id: 'verdict-gone', scheduledAt: future() }], F.storeGone.bulk);
      assert.equal(v.get('verdict-gone'), 'not_known_stored');
    });

    it('the read-back has no time left: not_known_stored for every row, found or not, and no throw', async () => {
      await acts.door.mongo.col(RETRY_QUEUE).insertOne({ _id: 'verdict-unread', webhookId: 'v', scheduledAt: future() });
      const rows = [{ _id: 'verdict-unread', scheduledAt: future() }, { _id: 'verdict-unread-absent', scheduledAt: future() }];
      const v = await stored.retryRowsStored(RETRY_QUEUE, rows, F.refused.duplicateKey, { timeLeft: () => 0 });
      assert.deepEqual([...v.values()], ['not_known_stored', 'not_known_stored'], 'a read-back that could not run claimed to know');
    });
  });

  describe('the overflow flush', () => {
    it('rows land and the reply is lost: overflowed by the rows stored, and nothing lost', async () => {
      const before = await reading();
      // Every flush of this overflow lands, then fails as a write to a store that went away fails.
      const stored = await overflowA('landed', () => faults.fail('insertMany', RETRY_QUEUE, F.storeGone.bulk, { times: 1_000, land: true }), async () => {
        await waitFor(async () => (await rowsOf(a, 'landed')).length === OVER, 30_000, 25, async () => `${(await rowsOf(a, 'landed')).length} of ${OVER} overflow rows stored`, { what: 'the overflow stored' });
        await flushSettled(before, OVER);
        assert.ok(faults.fired('insertMany', RETRY_QUEUE) >= 1, 'fixture: no flush reached the injected failure');
        return (await rowsOf(a, 'landed')).length;
      });
      const d = minus(await reading(), before);
      assert.equal(stored, OVER, 'fixture: the landed write did not store every overflow row');
      assert.equal(d.overflowed, stored, `overflowed rose by ${d.overflowed} for ${stored} overflow rows the queue holds: a write whose reply was lost is not a write that stored nothing`);
      assert.equal(d.notStored, 0, `${d.notStored} rows the queue holds were counted lost as not stored`);
      // None of these rows is due (the first retry is seconds away), so none may be counted as not known stored either.
      assert.equal(d.lost, 0, `${d.lost} rows were counted lost, every one of them stored and due for delivery: ${JSON.stringify(d)}`);
    });

    it('refused outright: lost{reason="not_stored"} by the overflow, and nothing overflowed', async () => {
      const before = await reading();
      await overflowA('refused', () => faults.fail('insertMany', RETRY_QUEUE, F.refused.duplicateKey, { times: 1_000 }), async () => {
        await flushSettled(before, OVER);
        assert.ok(faults.fired('insertMany', RETRY_QUEUE) >= 1, 'fixture: no flush reached the injected refusal');
      });
      const d = minus(await reading(), before);
      assert.deepEqual(await rowsOf(a, 'refused'), [], 'fixture: the refused write stored rows');
      assert.equal(d.overflowed, 0, `overflowed rose by ${d.overflowed} for a write the store refused`);
      assert.equal(d.notStored, OVER, `lost{reason="not_stored"} rose by ${d.notStored} for ${OVER} rows the store refused (lost by every reason: ${d.lost})`);
      assert.equal(d.notKnownStored, 0, 'a refusal is known to have stored nothing, and was counted as not known stored');
    });
  });

  describe('the first-delivery requeue (one row, after a failed first delivery)', () => {
    it('a refused row is lost{not_stored}; a row that landed with its reply lost is not counted lost', async () => {
      rig({ failA: true });
      const before = await reading();
      // First the landed one: its row is visible before the refused one is even emitted, so the refused one's count is the latch that
      // the landed one's own accounting has been done (it was handed its failure first).
      faults.fail('insertOne', RETRY_QUEUE, F.storeGone.single, { land: true });
      emit('requeue-landed', 1);
      await waitFor(async () => (await rowsOf(a, 'requeue-landed')).length === 1, 30_000, 25, 'the landed requeue never stored its row', { what: 'the landed row' });
      await waitFor(() => faults.fired('insertOne', RETRY_QUEUE) === 1, 30_000, 10, 'fixture: the requeue never reached the injected failure');
      faults.fail('insertOne', RETRY_QUEUE, F.refused.duplicateKey);
      emit('requeue-refused', 1);
      await waitFor(() => faults.fired('insertOne', RETRY_QUEUE) === 1, 30_000, 10, 'fixture: the second requeue never reached the injected refusal');
      await waitFor(async () => minus(await reading(), before).lost >= 1, 30_000, 25,
        async () => `the refused requeue was never counted lost: ${JSON.stringify(minus(await reading(), before))}`, { what: 'the refused requeue counted' });
      const d = minus(await reading(), before);
      assert.deepEqual(await rowsOf(a, 'requeue-refused'), [], 'fixture: the refused requeue stored its row');
      assert.equal(d.lost, 1, `${d.lost} first-delivery requeues counted lost, of one refused and one stored: the row the queue holds was counted lost (${JSON.stringify(d)})`);
      assert.equal(d.notStored, 1, `the refused requeue was not counted as lost{reason="not_stored"}: ${JSON.stringify(d)}`);
      assert.equal(d.overflowed, 0, 'a requeue after a failed first delivery is not an overflow');
    });
  });

  describe('the poll\'s requeue (a failed retry put back for its next attempt, N12)', () => {
    /**
     * One tick of the REAL poll (production deps) over a due row for sink A, whose delivery fails (the SSRF guard refuses loopback), so
     * the row is requeued. The job's timer is a function this test calls; the tick has ended when a tick fired after it is not skipped.
     */
    async function pollOnce(tag, arm) {
      const due = { _id: `due-${tag}`, webhookId: a, body: JSON.stringify({ entry: { path: `${tag}/f0000.txt` } }), event: 'file.deleted', spaceId: S,
        deliveryId: `d-${tag}`, attempt: 2, scheduledAt: new Date(0), createdAt: new Date(0) };
      await acts.door.mongo.col(RETRY_QUEUE).insertOne(due);
      arm();   // after the seed, or the seed's own insertOne takes the fault
      let tickFn;
      const skips = [];
      const off = signals.onHousekeepingSignal((e) => { if (e.type === 'tick-skipped' && e.job === dispatcher.RETRY_JOB_LABEL) skips.push(e); });
      const worker = dispatcher.createRetryWorker(undefined, { arm: (fn) => { tickFn = fn; return { unref() { return this; } }; }, disarm: () => {} });
      try {
        worker.job.start();
        tickFn();
        await waitFor(() => faults.fired('insertOne', RETRY_QUEUE) === 1, 30_000, 25, 'fixture: the poll never requeued the failed retry');
        await waitFor(async () => {
          const n = skips.length;
          tickFn();
          await new Promise(r => setImmediate(r));
          return skips.length === n;
        }, 30_000, 25, 'the poll\'s tick never ended', { what: 'the tick ended' });
      } finally { worker.job.stop(); off(); }
    }

    it('a refused requeue is lost{not_stored}', async () => {
      const before = await reading();
      await pollOnce('poll-refused', () => faults.fail('insertOne', RETRY_QUEUE, F.refused.duplicateKey));
      const d = minus(await reading(), before);
      assert.equal(await acts.door.mongo.col(RETRY_QUEUE).countDocuments({ webhookId: a }), 0, 'fixture: the refused requeue stored a row, or the due row was not removed');
      assert.equal(d.lost, 1, `a requeue the store refused lost the event, and ${d.lost} were counted lost: the poll's requeue is counted nowhere (${JSON.stringify(d)})`);
      assert.equal(d.notStored, 1, `the refused poll requeue was not counted as lost{reason="not_stored"}: ${JSON.stringify(d)}`);
    });

    it('a requeue that landed with its reply lost is not counted lost', async () => {
      const before = await reading();
      await pollOnce('poll-landed', () => faults.fail('insertOne', RETRY_QUEUE, F.storeGone.single, { land: true }));
      const d = minus(await reading(), before);
      assert.equal(await acts.door.mongo.col(RETRY_QUEUE).countDocuments({ webhookId: a, attempt: 3 }), 1, 'fixture: the landed requeue did not store its next attempt');
      assert.equal(d.lost, 0, `a requeue the queue holds was counted lost: ${JSON.stringify(d)}`);
    });
  });

  describe('a request\'s write bound does not end the flush (C5, N1)', () => {
    /**
     * The flush is started from an emit inside an ACTIVE `withinWriteBound`, and its write is issued while that scope is still active
     * (the scope's function waits for it). Its deadline then passes with the write in flight — parked before the driver, after the
     * bound was planned. Under the request's bound the write is ended by that deadline (`StoreTimeout`) and its rows counted lost; under
     * a bound of its own it lands once the park opens, and its rows are overflowed.
     *
     * At the base the flush's write inherits the request's scope through AsyncLocalStorage while the scope is active, so this is red by
     * the rule; once the request's scope has ended, a dead scope binds nothing (`write-bound.ts`), which is why the scope is held open.
     */
    it('an overflow emitted inside a nearly spent request bound is flushed past that bound, and counted overflowed', async () => {
      const HOLD_MS = 2_000;
      const restoreBound = await setWriteBoundForTest({ holdDeadlineMs: HOLD_MS, writeTimeoutMs: 20_000 });
      let planned;
      const park = parkDriverCall(acts.door.mongo, '', RETRY_QUEUE.slice(1), 'insertMany', (_docs, options) => { planned = options; return true; }, { before: true });
      try {
        // Not `overflowA`: the emit has to be inside the request's scope.
        const hold = gate();
        const state = rig({ holdA: hold });
        const n = dispatcher.FIRST_DELIVERY_BOUND + OVER;
        const before = await reading();
        const t0 = Date.now();
        try {
          await writeBound.withinWriteBound(async () => {
            emit('bounded', n);
            await park.reached;
            await waitFor(() => (state.delivered.get(b)?.size ?? 0) === n, HOLD_MS, 10, 'sink B never received every event inside the bound', { what: 'every event resolved' });
            // The request's deadline passes with the write in flight: the backstop aborts it (the base), or the deadline is simply past.
            const past = t0 + HOLD_MS + writeBound.SERVER_FIRST_MARGIN_MS + writeBound.KILL_WAIT_MS + 1_000;
            await waitFor(() => planned?.signal?.aborted === true || Date.now() > past, past - Date.now() + 5_000, 25, 'the request\'s deadline never passed', { what: 'the deadline passed' });
          });
          park.release();
          if (typeof dispatcher.settledRetryWrites === 'function') await dispatcher.settledRetryWrites();
          else await flushSettled(before, OVER);
        } finally {
          park.release();
          hold.release();
          await waitFor(() => (state.delivered.get(a)?.size ?? 0) === dispatcher.FIRST_DELIVERY_BOUND, 30_000, 25, 'the held sink never drained', { what: 'the held sink drained' });
        }
        const d = minus(await reading(), before);
        const stored = (await rowsOf(a, 'bounded')).length;
        assert.equal(d.lost, 0, `the request's write bound ended the flush: ${d.lost} overflow rows were counted lost (${JSON.stringify(d)}; the write's signal was ${planned?.signal?.aborted ? 'aborted' : 'not aborted'})`);
        assert.equal(stored, OVER, `${stored} of ${OVER} overflow rows stored`);
        assert.equal(d.overflowed, OVER, `overflowed rose by ${d.overflowed} for ${OVER} overflow rows stored`);
      } finally { park.restore(); restoreBound(); }
    });
  });
});
