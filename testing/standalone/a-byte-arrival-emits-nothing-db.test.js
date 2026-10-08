/**
 * A write no user made emits nothing about a file — neither a webhook nor a live-view (SSE) event (bundle-48, Q-259, design D5).
 *
 * ## The rule, and why it is the brain family's and not a new one
 *
 * Every brain writer gates the WHOLE emit on the caller having handed it an actor: `if (actor) emitWebhookEvent(...)`
 * (`chrono.ts`, `edges.ts`, `entities.ts`, `fact.ts`). The surfaces a person uses (REST, MCP) pass one; sync, import and
 * housekeeping pass none and stay silent. `emitWebhookEvent` is also what mirrors the mutation onto the in-process bus that
 * drives the live view, so "no actor" means no webhook AND no SSE event, and the docs (`14-duplicates-and-webhooks`, the
 * brain API's "changes applied by the sync engine are not emitted here") already say so.
 *
 * The file family was the one place that broke it: `recordStoredFile`, `deleteFileCascade` and `moveFileCascade` emitted
 * unconditionally and spread `...(actor ?? {})`, so a PEER's byte push fired `file.created` at the operator's integrators,
 * and published to the Files page, for a file that peer had written and no person here had. They now follow the brain
 * family's rule exactly, and `emitWebhookEvent` is not split into a bus half and a webhook half: a second rule beside the
 * first would be the defect this repository produces most (one rule, two implementations).
 *
 * ## What is held, over every way a file changes here without a person
 *
 *   - a peer's byte push at the upload door, single request AND chunked: no webhook dispatch and nothing on the bus;
 *   - a file the manifest pull brings in: the same;
 *   - a peer's file tombstone applied, on the push door AND the pull door: the file goes, and nothing is emitted;
 *   - a delete or a move made with no actor (the shape every internal caller has): nothing is emitted.
 *
 * The controls, so a negative cannot pass for the wrong reason:
 *
 *   - a person's upload through the same door, single and chunked, still dispatches the webhook and publishes (a UI upload
 *     is a user act and keeps firing);
 *   - a person's delete and move (an actor, as REST and MCP pass) still dispatch and publish.
 *
 * What a pushed or pulled file no longer does is refresh an open Files page live; a reload shows it, as it does for a
 * synced record.
 *
 * ## What is observed, and why it is the dispatch and not the delivery
 *
 * The subscription points at an address the SSRF guard refuses at once (`127.0.0.1`), so every dispatch that reaches a
 * matching subscription fails its first attempt and enqueues a retry row, which carries the payload it would have sent
 * (`_webhook_retry_queue.body`). That row is the dispatch's own record, written by the dispatcher whether or not anything
 * could be delivered, and it is read by the PATH in the payload, so one subscription tells every case apart. Nothing is
 * delivered and nothing is waited on but the dispatcher's own asynchronous hop, which the control proves has finished: a
 * control upload is made last, and the negatives are read only after its row has appeared.
 *
 * ## Seen red
 *
 * On the base a peer's push publishes on the bus and dispatches (its retry row exists), and a delete or a move with no actor
 * publishes. The pulled file and the peer's tombstone were already silent on the base, and the whole of the controls are
 * green on it: they state what the change must keep.
 *
 * Run: node --test testing/standalone/a-byte-arrival-emits-nothing-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { openByteDoor, USER_TOKEN } from './_byte-door.mjs';
import { postWhole, postInHalves } from './_byte-door-uploads.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'bytesse';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const RETRY_QUEUE = '_webhook_retry_queue';
/** What REST and MCP hand a cascade for a person's act: the calling token's name (`webhookToken`, `ctx.actor`). */
const A_PERSON = Object.freeze({ tokenLabel: 'a person' });

let door, bytes, store, bus, deleteCascade, moveCascade;
let subscriptionId;
/** Every bus event this instance published for the space since the case began. */
let seen = [];
let unsubscribe;

/** The webhook dispatches made (a retry row per matching subscription), read from the payload each carries. */
const dispatches = async () => {
  const rows = await door.mongo.col(RETRY_QUEUE).find({ webhookId: subscriptionId }).toArray();
  return rows.map(r => ({ event: r.event, spaceId: r.spaceId, path: JSON.parse(r.body)?.entry?.path }));
};
const dispatchedFor = async (path) => (await dispatches()).filter(d => d.path === path);

/** Wait (bounded) until `predicate` holds; the dispatcher's hop is asynchronous and the control proves when it has ended. */
async function until(predicate, what, ms = 10_000) {
  await waitFor(predicate, ms, 50, () => `timed out after ${ms}ms waiting for ${what}`);
}

/** The bus events for a path: what the live Files page would have been told. */
const busFor = (p) => seen.filter(e => e.entry?.path === p);
const busSummary = () => JSON.stringify(seen.map(e => [e.event, e.entry?.path]));

/** A person's upload of `content` at `path`; the dispatch it makes is awaited, so every earlier dispatch has ended. */
async function personUploads(path, content, shape = 'single') {
  const send = shape === 'chunked' ? postInHalves : postWhole;
  const r = await send(bytes, { space: S, path, content, token: USER_TOKEN });
  assert.ok([201, 202].includes((r.last ?? r).code), `a person's upload of ${path} was refused: ${JSON.stringify(r)}`);
  await until(async () => (await dispatchedFor(path)).length > 0, `the webhook dispatch for the person's upload of ${path}`);
}

/** The control a negative waits behind: a person's upload, whose dispatch has appeared by the time this returns. */
async function controlDispatches(shape) {
  const path = `control-${shape}.txt`;
  await personUploads(path, `a person wrote ${shape}`, shape);
  const rows = await dispatchedFor(path);
  assert.ok(rows.every(d => d.event === 'file.created' && d.spaceId === S), `the control dispatched something else: ${JSON.stringify(rows)}`);
  return path;
}

describe('a write no user made emits nothing about a file', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'bytesse', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
    store = await import('../../server/dist/webhooks/store.js');
    bus = await import('../../server/dist/brain/brain-events.js');
    deleteCascade = await import('../../server/dist/files/delete-cascade.js');
    moveCascade = await import('../../server/dist/files/move-cascade.js');
    // One subscription to every event of every space, aimed where the SSRF guard refuses at once: a dispatch leaves a retry row.
    const made = await store.createWebhook({ url: 'http://127.0.0.1:9/hook', secret: 'bytesse-secret' });
    subscriptionId = made.id;
  });
  after(async () => {
    stopBus();
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

  describe('bytes that arrive', () => {
    for (const shape of ['single', 'chunked']) {
      it(`a peer's ${shape} byte push publishes nothing on the bus and dispatches no webhook`, async () => {
        const path = `peer-${shape}.txt`;
        const content = `bytes a peer pushed ${shape}`;
        const send = shape === 'chunked' ? postInHalves : postWhole;
        const r = await send(bytes, { space: S, path, content, token: peerToken(PEER) });
        assert.ok([201, 202].includes((r.last ?? r).code), `fixture: the peer's push was refused: ${JSON.stringify(r)}`);
        const row = await door.coll(S, 'files').findOne({ _id: path });
        assert.equal(row?.sha256, sha(content), 'fixture: the arrival is recorded under the bytes it carried');

        const control = await controlDispatches(shape);
        stopBus();

        assert.deepEqual(busFor(path), [], `a peer's byte push was published to the live view: a synced write is not a user act (bus saw ${busSummary()})`);
        assert.ok(busFor(control).length >= 1, 'the control upload is published (the bus was listening throughout)');
        const dispatched = await dispatchedFor(path);
        assert.deepEqual(dispatched, [], `a peer's byte push dispatched a webhook: a synced write is not a user act (${JSON.stringify(dispatched)})`);
      });
    }

    it('a file the manifest pull brings in publishes nothing on the bus and dispatches no webhook', async () => {
      const path = 'pulled.txt';
      const content = 'bytes this instance pulled';
      door.seedPeerFile(S, path, content);
      await door.sync();
      const row = await door.coll(S, 'files').findOne({ _id: path });
      assert.equal(row?.sha256, sha(content), 'fixture: the pull did not record the file it fetched');
      assert.ok(door.localFileExists(S, path), 'fixture: the pull did not write the bytes');

      const control = await controlDispatches('single');
      stopBus();

      assert.deepEqual(busFor(path), [], `a pulled file was published to the live view (bus saw ${busSummary()})`);
      assert.ok(busFor(control).length >= 1, 'the control upload is published (the bus was listening throughout)');
      const dispatched = await dispatchedFor(path);
      assert.deepEqual(dispatched, [], `a pulled file dispatched a webhook (${JSON.stringify(dispatched)})`);
    });
  });

  describe('a peer\'s file tombstone applied', () => {
    const GONE = 'docs/gone.txt';
    const tomb = { _id: `ft-${GONE}`, spaceId: S, path: GONE, deletedAt: '2026-09-01T00:00:01.000Z', issuer: PEER, rowSeq: 3 };
    const seedPeersFile = async () => {
      door.writeLocalFile(S, GONE, 'bytes the peer authored');
      await door.coll(S, 'files').insertOne(build.filemeta(S, GONE, 3, { author: PEER_AUTHOR, sizeBytes: 23 }));
    };
    const DOORS = {
      push: () => door.push('/file-tombstones', { spaceId: S, tombstones: [tomb] }, { spaceId: S, token: peerToken(PEER) }),
      pull: async () => {
        await door.seedPeerFileTombstones(S, [{ ...tomb, spaceId: door.peerSide(S), positionAt: tomb.deletedAt }]);
        return door.sync();
      },
    };
    for (const [name, deliver] of Object.entries(DOORS)) {
      it(`on the ${name} door removes the file and publishes nothing, dispatches nothing`, async () => {
        await seedPeersFile();
        await deliver();
        assert.equal(door.localFileExists(S, GONE), false, 'fixture: the tombstone did not remove the bytes');
        assert.equal(await door.coll(S, 'files').findOne({ _id: GONE }), null, 'fixture: the tombstone did not remove the row');

        await controlDispatches('single');
        stopBus();

        assert.deepEqual(busFor(GONE), [], `a peer's tombstone published to the live view (bus saw ${busSummary()})`);
        assert.deepEqual(await dispatchedFor(GONE), [], 'a peer\'s tombstone dispatched a webhook');
      });
    }
  });

  describe('a delete or a move', () => {
    it('with no actor (every internal caller) emits nothing', async () => {
      await personUploads('internal-del.txt', 'to be deleted by housekeeping');
      await personUploads('internal-mv-src.txt', 'to be moved by an internal caller');
      await deleteCascade.deleteFileCascade(S, 'internal-del.txt');
      await moveCascade.moveFileCascade(S, 'internal-mv-src.txt', 'internal-mv-dst.txt');
      assert.equal(door.localFileExists(S, 'internal-del.txt'), false, 'fixture: the delete did not remove the file');
      assert.ok(door.localFileExists(S, 'internal-mv-dst.txt'), 'fixture: the move did not move the file');

      await controlDispatches('single');
      stopBus();

      const quiet = ['internal-del.txt', 'internal-mv-dst.txt'];
      for (const p of quiet) {
        assert.deepEqual(busFor(p).filter(e => e.event !== 'file.created'), [], `${p}: an actorless cascade published to the live view (bus saw ${busSummary()})`);
        assert.deepEqual((await dispatchedFor(p)).filter(d => d.event !== 'file.created'), [], `${p}: an actorless cascade dispatched a webhook`);
      }
    });

    it('the control: a person\'s delete and move (an actor) still publish and dispatch, once each', async () => {
      await personUploads('user-del.txt', 'to be deleted by a person');
      await personUploads('user-mv-src.txt', 'to be moved by a person');
      await deleteCascade.deleteFileCascade(S, 'user-del.txt', A_PERSON);
      await moveCascade.moveFileCascade(S, 'user-mv-src.txt', 'user-mv-dst.txt', A_PERSON);
      await until(async () => (await dispatchedFor('user-del.txt')).some(d => d.event === 'file.deleted')
        && (await dispatchedFor('user-mv-dst.txt')).some(d => d.event === 'file.updated'), 'the dispatches for the person\'s delete and move');
      stopBus();

      assert.equal(busFor('user-del.txt').filter(e => e.event === 'file.deleted').length, 1, 'one bus event for one delete');
      assert.equal(busFor('user-mv-dst.txt').filter(e => e.event === 'file.updated').length, 1, 'one bus event for one move');
      assert.equal((await dispatchedFor('user-del.txt')).filter(d => d.event === 'file.deleted').length, 1, 'one dispatch for one delete');
      assert.equal((await dispatchedFor('user-mv-dst.txt')).filter(d => d.event === 'file.updated').length, 1, 'one dispatch for one move');
    });
  });

  it('the control: a person\'s upload, single and chunked, still dispatches the webhook and is published', async () => {
    const single = await controlDispatches('single');
    const chunked = await controlDispatches('chunked');
    stopBus();
    for (const p of [single, chunked]) {
      assert.equal((await dispatchedFor(p)).length, 1, `${p}: one dispatch for one upload`);
      assert.equal(busFor(p).length, 1, `${p}: one bus event for one upload`);
    }
  });
});
