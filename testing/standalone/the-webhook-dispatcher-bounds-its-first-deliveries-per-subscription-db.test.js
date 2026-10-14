/**
 * The dispatcher's FIRST deliveries are bounded per subscription: a burst of events, or a sink that hangs, cannot open an unbounded number
 * of connections, and a hung sink holds only its own slots (bundle-113, Q-469).
 *
 * ## The defect it closes
 *
 * `emitWebhookEvent` resolved the matching subscriptions and started `deliverFirst` for each, un-awaited and with no limit: ten thousand
 * `file.deleted` events were ten thousand simultaneous outbound connections (a fresh pinned agent and an SSRF-guarded fetch each), and a
 * sink that stayed down turned each into a retry row at once. Only the RETRIES were bounded (`RETRY_BATCH`, `RETRY_CONCURRENCY`). Every
 * emitter shared it — a directory delete, an edge removal, an entity merge — and a directory delete is the first to make a burst of N.
 *
 * ## What is held
 *
 *  - **There is a seam to observe it:** `setFirstDeliveryDepsForTest({ deliver })` on `webhooks/dispatcher.ts`, the retry worker's
 *    `RetryPollDeps` precedent for the first attempt (plan T-S10): a delivery is an outbound request the SSRF guard would refuse to send to
 *    anything a test could listen on, so the bound can only be seen in flight through a handed-in `deliver(sub, body, event, spaceId,
 *    deliveryId)`. `null` restores production. THE NAME IS THIS TEST'S READING OF THE PLAN'S "delivery dependency seam": if the
 *    implementation names it differently, this file is the one place that changes.
 *  - **Bounded per subscription:** with sink A held, the deliveries to A in flight at once stay far below the number of events (the value
 *    of the bound is the dispatcher's, not pinned here: a quarter of the burst is the ceiling asserted, well above any sane limit and
 *    well below "all of them").
 *  - **A hung sink holds only its own slots:** while A is held, every event reaches sink B.
 *  - **Nothing is lost to the bound:** each event is delivered, or held in the sink's queue, or — beyond the queue's bound — persisted to
 *    the retry queue. After A is released, every event path is accounted for as a delivery or a retry row, and at least one overflowed
 *    to the queue (the burst is larger than any queue bound the plan allows).
 *  - **The bound is counted:** `ythril_webhook_first_deliveries_overflowed_total` rises by exactly the events persisted for overflow, and
 *    `ythril_webhook_first_deliveries_queued_total` is on the scrape (the operator's reading of whether a sink is being outrun).
 *  - **A success writes nothing:** a first delivery that succeeds to a subscription that is already active and has no failures does not
 *    write the subscription (`markWebhookSuccess` writes only on a status change): a burst of N is not N writes of an unchanged row.
 *
 * ## Seen red
 *
 * On the base the dispatcher has no seam, so the first case fails: the bound cannot be observed because the first delivery is
 * hard-wired to `attemptDelivery` over the network. Every other case needs the seam and fails on it first.
 *
 * Run: node --test testing/standalone/the-webhook-dispatcher-bounds-its-first-deliveries-per-subscription-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'firstdeliv';
const RETRY_QUEUE = '_webhook_retry_queue';
/** More events than any per-sink bound the plan allows ("e.g. 64 in flight and queued"), so some must overflow to the retry queue. */
const BURST = 1500;
const pathOf = (tag, i) => `${tag}/f${String(i).padStart(5, '0')}.txt`;

let acts, dispatcher, store, registry;
let a, b;

const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const ok = (sub, event, spaceId, deliveryId) => ({ id: deliveryId, webhookId: sub.id, event, spaceId, timestamp: new Date().toISOString(), responseStatus: 204, latencyMs: 1, success: true });

/** The seam handed to the dispatcher: records each delivery by subscription, and holds sink A's behind `holdA`. */
function rig({ holdA } = {}) {
  const state = { inFlight: new Map(), peak: new Map(), delivered: new Map() };
  const note = (map, id, path) => { let s = map.get(id); if (!s) { s = new Set(); map.set(id, s); } s.add(path); };
  const deps = {
    async deliver(sub, body, event, spaceId, deliveryId) {
      const path = JSON.parse(body)?.entry?.path;
      state.inFlight.set(sub.id, (state.inFlight.get(sub.id) ?? 0) + 1);
      state.peak.set(sub.id, Math.max(state.peak.get(sub.id) ?? 0, state.inFlight.get(sub.id)));
      try {
        if (holdA && sub.id === a) await holdA.p;
        note(state.delivered, sub.id, path);
        return ok(sub, event, spaceId, deliveryId);
      } finally { state.inFlight.set(sub.id, state.inFlight.get(sub.id) - 1); }
    },
  };
  return { deps, state };
}

/** A counter's total over every label set, read from a scrape as an operator reads it; throws when it is not on the scrape. */
async function counted(name) {
  const text = await registry.register.getSingleMetricAsString(name);
  const values = text.split(/\r?\n/).filter(l => l.startsWith(name) && !l.startsWith('#')).map(l => Number(l.trim().split(/\s+/).at(-1)));
  if (values.length === 0) throw new Error(`${name} is not on the scrape`);
  return values.reduce((a, b) => a + b, 0);
}

/** The paths of the retry rows persisted for `sub`. */
const retried = async (sub) => (await acts.door.mongo.col(RETRY_QUEUE).find({ webhookId: sub }).toArray()).map(r => JSON.parse(r.body)?.entry?.path);

function burst(tag, n = BURST) {
  for (let i = 0; i < n; i++) dispatcher.emitWebhookEvent({ event: 'file.deleted', spaceId: S, entry: { path: pathOf(tag, i) } });
}

/**
 * Release sink A and wait until every event of the burst is accounted for at A — delivered through the seam or persisted to the retry
 * queue — so no queued delivery outlives its case (the limiter is module-global: a slot left held, or a delivery left queued, is the next
 * case's).
 */
async function drainA(hold, state, tag, n = BURST) {
  hold?.release();
  await waitFor(async () => new Set([...(state.delivered.get(a) ?? []), ...(await retried(a))].filter(p => p.startsWith(`${tag}/`))).size === n, 60_000, 50,
    async () => `${state.delivered.get(a)?.size ?? 0} delivered and ${(await retried(a)).length} persisted of ${n} events for sink A: some were dropped by the bound`,
    { what: `every event of ${tag} delivered or persisted` });
}

describe('the dispatcher bounds its first deliveries per subscription (Q-469)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'firstdeliv', space: S, monitorCommands: true });
    dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
    store = await import('../../server/dist/webhooks/store.js');
    registry = await import('../../server/dist/metrics/registry.js');
    a = (await store.createWebhook({ url: 'http://127.0.0.1:9/a', secret: 'first-a' })).id;
    b = (await store.createWebhook({ url: 'http://127.0.0.1:9/b', secret: 'first-b' })).id;
  });
  after(async () => {
    dispatcher?.setFirstDeliveryDepsForTest?.(null);
    for (const id of [a, b]) if (id) await store?.deleteWebhook(id).catch(() => {});
    await acts?.door.mongo.col(RETRY_QUEUE).deleteMany({}).catch(() => {});
    await acts?.close();
  });
  beforeEach(async () => { await acts.door.mongo.col(RETRY_QUEUE).deleteMany({}); });
  afterEach(() => { dispatcher.setFirstDeliveryDepsForTest?.(null); });

  it('the dispatcher has a seam for its first delivery, so the bound can be observed in flight', () => {
    assert.equal(typeof dispatcher.setFirstDeliveryDepsForTest, 'function',
      'webhooks/dispatcher.ts exports no setFirstDeliveryDepsForTest: the first delivery cannot be observed, and nothing bounds it');
  });

  it('with one sink held, its deliveries in flight stay far below the burst, and every event still reaches the other sink', async () => {
    assert.equal(typeof dispatcher.setFirstDeliveryDepsForTest, 'function', 'webhooks/dispatcher.ts exports no setFirstDeliveryDepsForTest');
    const hold = gate();
    const { deps, state } = rig({ holdA: hold });
    dispatcher.setFirstDeliveryDepsForTest(deps);
    try {
      burst('held');
      // B is not held: all of its deliveries must land while A is.
      await waitFor(() => (state.delivered.get(b)?.size ?? 0) === BURST, 30_000, 50,
        () => `a held sink starved the other: ${state.delivered.get(b)?.size ?? 0} of ${BURST} events reached sink B while sink A hung`, { what: 'every event to the sink that is not held' });
      assert.equal(state.delivered.get(a)?.size ?? 0, 0, 'fixture: sink A was not held');
      assert.ok((state.peak.get(a) ?? 0) >= 1, 'no delivery to the held sink was ever started: the case is not the one it is about');
      assert.ok(state.peak.get(a) <= BURST / 4,
        `${state.peak.get(a)} first deliveries to ONE sink were in flight at once for ${BURST} events: nothing bounds a burst per subscription`);
    } finally { await drainA(hold, state, 'held').catch(() => {}); }
  });

  it('nothing is lost to the bound: every event is delivered or persisted to the retry queue, and the overflow is persisted', async () => {
    assert.equal(typeof dispatcher.setFirstDeliveryDepsForTest, 'function', 'webhooks/dispatcher.ts exports no setFirstDeliveryDepsForTest');
    const hold = gate();
    const { deps, state } = rig({ holdA: hold });
    dispatcher.setFirstDeliveryDepsForTest(deps);
    const overflowedBefore = await counted('ythril_webhook_first_deliveries_overflowed_total').catch(() => undefined);
    try {
      burst('kept');
      await waitFor(() => (state.delivered.get(b)?.size ?? 0) === BURST, 30_000, 50, 'sink B never received every event');
      // The events beyond the sink's bound are in the retry queue now, without waiting for the held sink to answer.
      await waitFor(async () => (await retried(a)).length > 0, 30_000, 50, () => 'no event of the held sink overflowed to the retry queue', { what: 'overflow persisted' });
    } finally { await drainA(hold, state, 'kept'); }

    const persisted = await retried(a);
    assert.equal(new Set(persisted).size, persisted.length, 'an overflowed event was persisted twice');
    assert.deepEqual(persisted.filter(p => state.delivered.get(a)?.has(p)), [],
      'an event was both delivered and persisted for retry: the sink is sent it twice');
    assert.equal(await acts.door.mongo.col(RETRY_QUEUE).countDocuments({ webhookId: b }), 0, 'an event of the sink that answered was queued for retry');
    // The bound is counted, as the operator reads it: the overflow by exactly the rows it persisted, and the queue's own counter is declared.
    assert.notEqual(overflowedBefore, undefined, 'ythril_webhook_first_deliveries_overflowed_total is not on the scrape');
    assert.equal(await counted('ythril_webhook_first_deliveries_overflowed_total') - overflowedBefore, persisted.length,
      'the overflow counter does not equal the events persisted for overflow');
    assert.ok(await counted('ythril_webhook_first_deliveries_queued_total') >= 0, 'ythril_webhook_first_deliveries_queued_total is not on the scrape');
  });

  it('a first delivery that succeeds to an active subscription writes nothing to the subscription', async () => {
    assert.equal(typeof dispatcher.setFirstDeliveryDepsForTest, 'function', 'webhooks/dispatcher.ts exports no setFirstDeliveryDepsForTest');
    const { deps, state } = rig();
    dispatcher.setFirstDeliveryDepsForTest(deps);
    const N = 200;
    // Counted at the driver: the subscription is the `_webhooks` collection, and an unchanged row is not a write.
    const commands = await acts.door.commandsDuring(async () => {
      burst('quiet', N);
      await waitFor(() => (state.delivered.get(a)?.size ?? 0) === N && (state.delivered.get(b)?.size ?? 0) === N, 30_000, 50, 'the deliveries did not complete', { what: 'every delivery' });
    });
    const writes = commands.filter(c => c === 'update _webhooks');
    assert.deepEqual(writes, [], `${writes.length} writes of an unchanged subscription for ${2 * N} successful deliveries: markWebhookSuccess writes on every delivery`);
  });
});
