/**
 * What the dispatcher holds in memory when the process is told to stop is written to the retry queue, within the shutdown's budget, and what
 * cannot be written is counted and said (bundle-113, Q-469; the sweep's R-4, O2, P1).
 *
 * ## The defects it closes
 *
 *  - **A drain with no deadline, run once, early.** `drainFirstDeliveries` waited for the dispatcher's two queues with no bound, before the HTTP
 *    drain; a request that finished while the server drained emitted an event that went to the (closed) limiter and on to the queue of rows,
 *    which nothing awaited before the connection closed. Now it takes `withinMs` (the shutdown's own drain budget, so a database that stopped
 *    answering costs the budget and not the orchestrator's kill), and the shutdown calls it again after the server has closed.
 *  - **A failed retry-queue write drops events uncounted.** The write of an overflowed or shutdown-queued delivery failed with one warning, and
 *    the events were gone with nothing to count them: `ythril_webhook_first_deliveries_lost_total` counts them.
 *  - **The retry queue has no index.** The poll reads it `{ scheduledAt: { $lte: now } }` sorted by `scheduledAt`, and overflow is what makes it large.
 *
 * ## What is held
 *
 *  - **Queued-not-attempted deliveries are persisted at shutdown** (a drain that does nothing leaves them in memory to die): with a sink held, the
 *    deliveries beyond its running ones that were queued (not overflowed) are rows after the drain, and what was running is not.
 *  - **The final flush:** an event emitted AFTER the drain closed the limiter is a row by the time the second call returns.
 *  - **The drain is bounded:** with the retry-queue write held, the call returns within its `withinMs` (not after the write), and says so.
 *  - **A failed write is counted and said at warn:** the lost counter rises by the events, and the drain's line names how many.
 *  - **The index** `{ scheduledAt: 1 }` exists after `initRetryQueueIndexes`, which startup calls beside the store's own.
 *
 * The limiter is module-global and a drain closes it for the life of the process, so the cases below run in one order, in this file alone.
 *
 * Run: node --test testing/standalone/the-webhook-dispatcher-persists-what-it-never-attempted-at-shutdown-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'drainfirst';
const RETRY_QUEUE = '_webhook_retry_queue';
const BURST = 100;
const pathOf = (tag, i) => `${tag}/f${String(i).padStart(4, '0')}.txt`;

let acts, dispatcher, store, registry, logs, sub;
const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const rows = async () => (await acts.door.mongo.col(RETRY_QUEUE).find({ webhookId: sub }).toArray()).map(r => JSON.parse(r.body)?.entry?.path);
const emit = (tag, n) => { for (let i = 0; i < n; i++) dispatcher.emitWebhookEvent({ event: 'file.deleted', spaceId: S, entry: { path: pathOf(tag, i) } }); };
const counter = async (name) => {
  const text = await registry.register.getSingleMetricAsString(name);
  return text.split(/\r?\n/).filter(l => l.startsWith(name) && !l.startsWith('#')).reduce((n, l) => n + Number(l.trim().split(/\s+/).at(-1)), 0);
};

describe('the dispatcher persists what it never attempted at shutdown (Q-469)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'drainfirst', space: S });
    dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
    store = await import('../../server/dist/webhooks/store.js');
    registry = await import('../../server/dist/metrics/registry.js');
    logs = await import('../../server/dist/util/log.js');
    sub = (await store.createWebhook({ url: 'http://127.0.0.1:9/hook', secret: 'drain-secret' })).id;
  });
  after(async () => {
    dispatcher?.setFirstDeliveryDepsForTest?.(null);
    if (sub) await store?.deleteWebhook(sub).catch(() => {});
    await acts?.door.mongo.col(RETRY_QUEUE).deleteMany({}).catch(() => {});
    await acts?.close();
  });

  const hold = gate();
  const delivered = new Set();

  it('queued-not-attempted deliveries become retry rows at the drain, and the ones running do not', async () => {
    dispatcher.setFirstDeliveryDepsForTest({
      async deliver(s, body, event, spaceId, deliveryId) {
        await hold.p;
        delivered.add(JSON.parse(body)?.entry?.path);
        return { id: deliveryId, webhookId: s.id, event, spaceId, timestamp: new Date().toISOString(), responseStatus: 204, latencyMs: 1, success: true };
      },
    });
    emit('held', BURST);
    // The overflow is written without waiting for anything: BURST less the bound.
    const overflow = BURST - dispatcher.FIRST_DELIVERY_BOUND;
    await waitFor(async () => (await rows()).length === overflow, 30_000, 25, async () => `${(await rows()).length} overflow rows of ${overflow}`, { what: 'the overflow persisted' });

    const persisted = await dispatcher.drainFirstDeliveries({ withinMs: 10_000 });

    assert.equal(persisted, dispatcher.FIRST_DELIVERY_BOUND - dispatcher.FIRST_DELIVERY_CONCURRENCY,
      'the drain did not persist every delivery that was queued behind the running ones');
    const all = await rows();
    assert.equal(all.length, BURST - dispatcher.FIRST_DELIVERY_CONCURRENCY,
      `${all.length} rows after the drain: every event that was not running must be a row (the overflow, and what was queued and never attempted)`);
    assert.equal(new Set(all).size, all.length, 'an event was persisted twice');
    hold.release();
    await waitFor(() => delivered.size === dispatcher.FIRST_DELIVERY_CONCURRENCY, 30_000, 25, () => `${delivered.size} delivered`, { what: 'the running deliveries finished' });
    assert.deepEqual(all.filter(p => delivered.has(p)), [], 'an event that was running (and delivered) was also persisted: the sink is sent it twice');
  });

  it('the final flush: an event emitted after the drain is a row when the second call returns', async () => {
    const before = (await rows()).length;
    emit('late', 5);

    await dispatcher.drainFirstDeliveries({ withinMs: 10_000 });

    const after = (await rows()).filter(p => p.startsWith('late/'));
    assert.equal(after.length, 5, `${after.length} of the 5 events emitted after the drain were rows when the final flush returned (${before} rows before)`);
  });

  it('a retry-queue write that cannot finish costs the budget and not the shutdown, and is said at warn', async () => {
    const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
    const original = proto.insertMany;
    const stuck = gate();
    proto.insertMany = async function held(...args) {
      if (this.collectionName === RETRY_QUEUE) await stuck.p;
      return original.apply(this, args);
    };
    try {
      emit('stuck', 3);
      const t0 = Date.now();
      await dispatcher.drainFirstDeliveries({ withinMs: 400 });
      const took = Date.now() - t0;
      assert.ok(took < 5_000, `the drain took ${took}ms with its write held: it waits for the write, not for its budget`);
      assert.ok(took >= 300, `the drain returned after ${took}ms: before its budget, with the write still held`);
      assert.ok(logs.getLogLines(300).some(l => l.includes('did not finish writing within 400ms')), 'the drain that ran out of budget said nothing');
    } finally { stuck.release(); proto.insertMany = original; }
    await waitFor(async () => (await rows()).filter(p => p.startsWith('stuck/')).length === 3, 30_000, 25, 'the held write never landed', { what: 'the held write released' });
  });

  it('a failed write is counted as lost, and the drain says how many at warn', async () => {
    const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
    const original = proto.insertMany;
    proto.insertMany = async function failing(...args) {
      if (this.collectionName === RETRY_QUEUE) throw new Error('the retry queue is not answering');
      return original.apply(this, args);
    };
    const lostBefore = await counter('ythril_webhook_first_deliveries_lost_total');
    try {
      emit('lost', 4);
      await dispatcher.drainFirstDeliveries({ withinMs: 10_000 });
    } finally { proto.insertMany = original; }

    assert.equal(await counter('ythril_webhook_first_deliveries_lost_total') - lostBefore, 4, 'the events whose write failed were not counted lost');
    assert.deepEqual((await rows()).filter(p => p.startsWith('lost/')), [], 'fixture: the failing write landed rows');
    assert.ok(logs.getLogLines(300).some(l => l.includes('4 queued webhook deliveries could not be persisted for retry')), 'the shutdown said nothing at warn about the deliveries it could not persist');
  });

  it('the retry queue has an index on scheduledAt, ensured by the module that owns the queue at startup', async () => {
    await dispatcher.initRetryQueueIndexes();
    const indexes = await acts.door.mongo.col(RETRY_QUEUE).indexes();
    assert.ok(indexes.some(i => JSON.stringify(i.key) === JSON.stringify({ scheduledAt: 1 })), `no { scheduledAt: 1 } index on ${RETRY_QUEUE}: ${JSON.stringify(indexes.map(i => i.key))}`);
  });

  it('startup calls it: bootstrap awaits initRetryQueueIndexes', () => {
    const bootstrap = stripComments(readFileSync('server/src/bootstrap.ts', 'utf8'));
    assert.match(bootstrap, /await\s+initRetryQueueIndexes\(\)/, 'bootstrap.ts never ensures the retry queue\'s index: the function exists and nothing runs it');
  });
});
