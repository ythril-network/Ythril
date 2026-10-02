/**
 * A counter that cannot be moved fails the arrival on the doors that do not move it themselves — the pull and the
 * import (`Q-218` round R, item R3).
 *
 * ## The rule
 *
 * Every door that stores an arrival must not report it delivered while this instance's seq counter is behind it:
 * the next local write would then take a seq below a record already stored, and a peer that has pulled past that
 * seq never asks for the new record. The push doors await their own `bumpSeq` (`PUSH_CLOCK` in `api/sync/docs.ts`)
 * and fail when it fails. The PULL and the IMPORT rely on the arrival writer's bump — and the writer's bump only
 * LOGS a failure (`E1`), while its docblock says every door awaits its own bump before it answers. So:
 *
 *  - **pull**: when the bump fails, that family's watermark (`lastSeqReceived`) does not advance past the page;
 *  - **import**: when the bump fails, the import does not answer a clean success (it throws, or counts errors).
 *
 * The fault is injected below the driver API, on every write method of `ythril_counters` only, the seam the `E1`
 * case of `a-pushed-record-is-queued-by-the-receivers-rules-db.test.js` uses; every injected promise is awaited
 * before the case reads anything.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-counter-that-cannot-move-fails-the-arrival-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateHostAddress, privateAddressSkipReason } from './_private-address.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
process.env['SYNC_ALLOW_INSECURE_PEERS'] = 'true';

const PULLED = 'ctr-pull';
const RESTORED = 'ctr-import';
const PEER = 'ctr-peer';
const NET = 'ctr-net';
const author = { instanceId: PEER, instanceLabel: 'Peer' };
const WRITES = ['updateOne', 'updateMany', 'bulkWrite', 'insertOne', 'insertMany', 'findOneAndUpdate', 'replaceOne'];

let door, peer, engine, loader, importDocuments, served = {};

/** Run `fn` with every write to the counter collection failing; resolve once every injected failure has settled. */
async function counterCannotMove(fn) {
  const proto = Object.getPrototypeOf(door.mongo.col('probe'));
  const originals = Object.fromEntries(WRITES.map(m => [m, proto[m]]));
  const injected = [];
  for (const m of WRITES) {
    proto[m] = function faulty(...args) {
      if (this.collectionName !== 'ythril_counters') return originals[m].apply(this, args);
      const p = Promise.reject(new Error(`injected: ythril_counters ${m} failed`));
      injected.push(p.catch(() => {}));
      return p;
    };
  }
  let outcome;
  try {
    outcome = await fn().then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 50 && injected.length === 0; i++) await new Promise(res => setImmediate(res));
    await Promise.all(injected);
  } finally {
    Object.assign(proto, originals);
  }
  return { ...outcome, injected: injected.length };
}

function startPeer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/api\/sync\/([a-z]+)$/);
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' || !m) return send(404, { error: 'not served by the fake peer' });
    if (m[1] === 'tombstones') return send(200, {});
    send(200, { items: served[url.searchParams.get('spaceId')]?.[m[1]] ?? [], nextCursor: null });
  });
  return new Promise(resolve => server.listen(0, '0.0.0.0', () => resolve(server)));
}

describe('a counter that cannot move fails the arrival on the pull and the import', { skip }, () => {
  before(async () => {
    peer = await startPeer();
    door = await openPushDoor({
      suite: 'ctrfail',
      spaces: [{ id: PULLED, label: 'Pulled', folders: [], meta: {} }, { id: RESTORED, label: 'Restored', folders: [], meta: {} }],
      networks: [{ id: NET, label: 'Pull net', type: 'pubsub', spaces: [PULLED], votes: [],
        members: [{ instanceId: PEER, label: 'Peer', url: `http://${privateHostAddress()}:${peer.address().port}`,
          tokenHash: 'x', direction: 'pull' }] }],
    });
    loader = await import('../../server/dist/config/loader.js');
    loader.saveSecrets({ peerTokens: { [PEER]: 'peer-token' } });
    engine = await import('../../server/dist/sync/engine.js');
    ({ importDocuments } = await import('../../server/dist/api/admin-import.js'));
  });
  after(async () => {
    await new Promise(r => peer?.close(r));
    await door?.close();
  });

  it('pull: the watermark does not pass a page the counter could not be moved over', async () => {
    served = { [PULLED]: { facts: [build.fact(PULLED, 'p-1', 701, { author }), build.fact(PULLED, 'p-2', 702, { author })] } };
    const { error, injected } = await counterCannotMove(() => engine.runSyncForPeer(PEER));
    assert.ok(injected > 0, 'fixture check: the counter was never written, so no bump failed');
    assert.equal(error, undefined, `the pull threw: ${error}`);
    assert.ok(await door.coll(PULLED, 'facts').findOne({ _id: 'p-2' }), 'fixture check: the page did not land');
    const through = loader.getConfig().networks.find(n => n.id === NET).members.find(m => m.instanceId === PEER)
      .lastSeqReceived?.[PULLED] ?? 0;
    assert.ok(through < 701,
      `the watermark moved to ${through} although the counter could not be moved past the page (max 702): the next `
      + 'local write takes a seq below a record already stored, and a peer that pulled past it never asks for it');
  });

  it('import: a restore whose counter could not be moved does not answer a clean success', async () => {
    const { value, error, injected } = await counterCannotMove(() =>
      importDocuments(RESTORED, { facts: [build.fact(RESTORED, 'i-1', 801), build.fact(RESTORED, 'i-2', 802)] }));
    assert.ok(injected > 0, 'fixture check: the counter was never written, so no bump failed');
    assert.ok(await door.coll(RESTORED, 'facts').findOne({ _id: 'i-2' }), 'fixture check: the restore did not land');
    const clean = error === undefined && Object.values(value.results).every(r => r.errors === 0);
    assert.ok(!clean,
      `the import answered success (${JSON.stringify(value?.results?.facts)}) although the counter could not be moved `
      + 'past what it restored: the next local write sorts below a restored record every peer already holds');
  });
});
