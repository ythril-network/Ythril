/**
 * A file's bytes that ARRIVE are published to this instance's live view (SSE) and fire no webhook (bundle-48, Q-259, design D5).
 *
 * ## The defect
 *
 * `emitWebhookEvent` is one function with two jobs: it mirrors the mutation onto the in-process bus that drives the live
 * Files page (`publishBrainChange`), and it delivers the event to every matching webhook subscription. A caller that wants
 * the first cannot avoid the second, so a PEER's byte push (`recordStoredFile`'s arrival branch) fired `file.created` at the
 * operator's integrators for a file that peer had written, not any person here. The docs (`14-duplicates-and-webhooks`)
 * already promise that a synced write fires no webhook, and the record families keep it by passing no actor and never
 * publishing at all. The other half is the mirror image: the byte PULL (`syncFiles`) publishes to nobody, so the Files page
 * of an instance that pulled a file does not refresh.
 *
 * ## The rule (D5)
 *
 * Over every way a file's bytes arrive at this instance, and its control:
 *
 *   - a peer's byte push at the upload door, single request AND chunked: published on the bus as `file.created`, and NO
 *     webhook dispatch is made for it;
 *   - a file the manifest pull brings in: published on the bus as `file.created`, and no webhook dispatch either;
 *   - the control, so the negative cannot pass for the wrong reason: a person's upload through the same door, single and
 *     chunked, still dispatches the webhook (a UI upload is a user act and keeps firing).
 *
 * ## What is observed, and why it is the dispatch and not the delivery
 *
 * The subscription points at an address the SSRF guard refuses at once (`127.0.0.1`), so every dispatch that reaches a
 * matching subscription fails its first attempt and enqueues a retry row, which carries the payload it would have sent
 * (`_webhook_retry_queue.body`). That row is the dispatch's own record, written by the dispatcher whether or not anything
 * could be delivered, and it is read by the PATH in the payload, so one subscription tells every case apart. Nothing is
 * delivered and nothing is waited on but the dispatcher's own asynchronous hop, which the control proves has finished: the
 * control upload is made last, and the negatives are read only after its row has appeared.
 *
 * ## Seen red
 *
 * On the base the peer's push dispatches (its retry row exists) and the pulled file is published to nobody. The bus half of
 * the push and the whole of the control are green on the base: they state what the change must keep.
 *
 * Run: node --test testing/standalone/a-byte-arrival-publishes-to-sse-and-no-webhook-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { peerToken } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { openByteDoor, USER_TOKEN } from './_byte-door.mjs';
import { postWhole, postInHalves } from './_byte-door-uploads.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'bytesse';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const RETRY_QUEUE = '_webhook_retry_queue';

let door, bytes, store, bus;
let subscriptionId;
/** Every bus event this instance published for the space since the case began. */
let seen = [];
let unsubscribe;

/** The paths a webhook dispatch was made for (a retry row per matching subscription), read from the payload it carries. */
const dispatchedPaths = async () => {
  const rows = await door.mongo.col(RETRY_QUEUE).find({ webhookId: subscriptionId }).toArray();
  return rows.map(r => ({ event: r.event, spaceId: r.spaceId, path: JSON.parse(r.body)?.entry?.path }));
};

/** Wait (bounded) until `predicate` holds; the dispatcher's hop is asynchronous and the control proves when it has ended. */
async function until(predicate, what, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - t0 > ms) assert.fail(`timed out after ${ms}ms waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

/** The bus events for a path: what the live Files page would have been told. */
const busFor = (p) => seen.filter(e => e.entry?.path === p);

/** A person's upload as the control: it MUST dispatch, and the dispatch is awaited, so every earlier dispatch has ended. */
async function controlDispatches(shape) {
  const path = `control-${shape}.txt`;
  const content = `a person wrote ${shape}`;
  const send = shape === 'chunked' ? postInHalves : postWhole;
  const r = await send(bytes, { space: S, path, content, token: USER_TOKEN });
  assert.ok([201, 202].includes((r.last ?? r).code), `the control upload was refused: ${JSON.stringify(r)}`);
  await until(async () => (await dispatchedPaths()).some(d => d.path === path),
    `the webhook dispatch for the person's ${shape} upload (the control)`);
  const rows = (await dispatchedPaths()).filter(d => d.path === path);
  assert.ok(rows.every(d => d.event === 'file.created' && d.spaceId === S), `the control dispatched something else: ${JSON.stringify(rows)}`);
  return path;
}

describe('a byte arrival is published to the live view and fires no webhook', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'bytesse', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
    store = await import('../../server/dist/webhooks/store.js');
    bus = await import('../../server/dist/brain/brain-events.js');
    // One subscription to every event of every space, aimed where the SSRF guard refuses at once: a dispatch leaves a retry row.
    const made = await store.createWebhook({ url: 'http://127.0.0.1:9/hook', secret: 'bytesse-secret' });
    subscriptionId = made.id;
  });
  after(async () => {
    if (subscriptionId) await store?.deleteWebhook(subscriptionId).catch(() => {});
    await door?.mongo.col(RETRY_QUEUE).deleteMany({}).catch(() => {});
    await door?.close();
  });
  // The subscription is dropped by the case that reads it and, if that case failed first, by the next case's start: it never leaks.
  const stopBus = () => { unsubscribe?.(); unsubscribe = undefined; };
  beforeEach(async () => {
    stopBus();
    await door.reset();
    await door.mongo.col(RETRY_QUEUE).deleteMany({});
    seen = [];
    unsubscribe = bus.subscribeBrainChanges(S, (ev) => { seen.push(ev); });
  });

  for (const shape of ['single', 'chunked']) {
    it(`a peer's ${shape} byte push is published on the bus and dispatches no webhook`, async () => {
      const path = `peer-${shape}.txt`;
      const content = `bytes a peer pushed ${shape}`;
      const send = shape === 'chunked' ? postInHalves : postWhole;
      const r = await send(bytes, { space: S, path, content, token: peerToken(PEER) });
      assert.ok([201, 202].includes((r.last ?? r).code), `fixture: the peer's push was refused: ${JSON.stringify(r)}`);
      const row = await door.coll(S, 'files').findOne({ _id: path });
      assert.equal(row?.sha256, sha(content), 'fixture: the arrival is recorded under the bytes it carried');

      const control = await controlDispatches(shape);
      stopBus();

      const events = busFor(path);
      assert.ok(events.length >= 1, `the arrival of ${path} was not published to the live view (bus saw ${JSON.stringify(seen.map(e => [e.event, e.entry?.path]))})`);
      assert.ok(events.every(e => e.event === 'file.created' && e.entry?.sha256 === sha(content)),
        `the published event does not name the file's bytes: ${JSON.stringify(events)}`);
      assert.ok(busFor(control).length >= 1, 'the control upload is published too');

      const dispatched = (await dispatchedPaths()).filter(d => d.path === path);
      assert.deepEqual(dispatched, [], `a peer's byte push dispatched a webhook: a synced write is not a user act (${JSON.stringify(dispatched)})`);
    });
  }

  it('a file the manifest pull brings in is published on the bus and dispatches no webhook', async () => {
    const path = 'pulled.txt';
    const content = 'bytes this instance pulled';
    door.seedPeerFile(S, path, content);
    await door.sync();
    const row = await door.coll(S, 'files').findOne({ _id: path });
    assert.equal(row?.sha256, sha(content), 'fixture: the pull did not record the file it fetched');
    assert.ok(door.localFileExists(S, path), 'fixture: the pull did not write the bytes');

    const control = await controlDispatches('single');
    stopBus();

    const events = busFor(path);
    assert.ok(events.length >= 1,
      `the pulled file was published to nobody, so the Files page does not refresh (bus saw ${JSON.stringify(seen.map(e => [e.event, e.entry?.path]))})`);
    assert.ok(events.every(e => e.event === 'file.created' && e.entry?.sha256 === sha(content)),
      `the published event does not name the file's bytes: ${JSON.stringify(events)}`);
    assert.ok(busFor(control).length >= 1, 'the control upload is published too');

    const dispatched = (await dispatchedPaths()).filter(d => d.path === path);
    assert.deepEqual(dispatched, [], `a pulled file dispatched a webhook (${JSON.stringify(dispatched)})`);
  });

  it('the control: a person\'s upload, single and chunked, still dispatches the webhook and is published', async () => {
    const single = await controlDispatches('single');
    const chunked = await controlDispatches('chunked');
    stopBus();
    for (const p of [single, chunked]) {
      assert.equal((await dispatchedPaths()).filter(d => d.path === p).length, 1, `${p}: one dispatch for one upload`);
      assert.equal(busFor(p).length, 1, `${p}: one bus event for one upload`);
    }
  });
});
