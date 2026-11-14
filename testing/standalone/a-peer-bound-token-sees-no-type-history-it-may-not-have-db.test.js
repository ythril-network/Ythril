/**
 * A peer-bound token sees no type history, standing or definition built from a version it may not have (Q-744, bundle-268 design r3 §3,
 * r4 §K "Peer scope" and §10 T2b).
 *
 * ## The contract (written before the code)
 *
 * - The three new forms (`kind`; `kind` + `type`; `fps` + `kind` + `type`) answer `404 unknown_fingerprint` when the current version
 *   is not one the caller may have (`mayHave`, the sync door's `servableTo`).
 * - Network ids in an answer are cut to the networks shared with the caller.
 * - `older` and `sameAs:<fp>` on the filter take the caller's scope: a version the caller may not have is not held for it, so its
 *   records are older (and counted unclassified), and `sameAs:<it>` matches only records stamped with it.
 * - The `fps` form answers `notHeld` for a stamp the caller may not have, whatever its text says.
 *
 * ## Fixture
 *
 * Space PB: v1 -> v2 (current; A renamed). X is a held row built from a network the peer is not in, defining A as v2 does. Records
 * A@v1, A@X, A@v2. Space PU: its current version is a layer of a network the peer is not in.
 *
 * ## Seen red at 327b105e
 *
 * `olderIn` takes no scope (the peer's `older` classifies X by its text, as the local token's does); the three forms do not exist.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-bound-token-sees-no-type-history-it-may-not-have-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { snapshotOf, snapshotRow, snapshotsOf, linksOf } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion } from './_schema-version-fixtures.mjs';
import { typeDoors } from './_type-history.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'thpeer';
const [PB, PU] = ['thpeerb', 'thpeeru'];
const META = { suppressEmbeddings: true };
/**
 * A network the peer is not in: the pull door's lateral club network, carrying PU only, with a member that is not the peer. It must be a
 * CONFIGURED network: `storeNetworkLayer` stores no layer for a network the config does not hold (it answers false and leaves the space's
 * meta as it was), so a made-up id left PU's current version the space's own and the 404 and the cut were never exercised (bundle-268 build).
 */
let OUTSIDE_NET;
const typed = (prop) => ({ ...META, typeSchemas: { entity: { A: { propertySchemas: { [prop]: { type: 'string' } } } } } });

let d, doors, local, peer, v1, v2, X;
const seeded = new Map();

describe('a peer-bound token sees no type history it may not have (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: SUITE, openDoor: () => openPullDoor({
      suite: SUITE, spaces: [PB, PU], type: 'club', direction: 'both', meta: { [PB]: META, [PU]: META }, lateral: [PU],
    }) });
    OUTSIDE_NET = d.door.LATERAL_NET;
    assert.ok(typeof OUTSIDE_NET === 'string' && OUTSIDE_NET.length > 0, 'the pull door names no lateral network');
    doors = typeDoors(d);
    const rungs = d.row({ schema: 'read', knowledge: 'read' });
    local = await d.mint('thp-local', { [PB]: rungs, [PU]: rungs });
    peer = await d.mint('thp-peer', { [PB]: rungs, [PU]: rungs }, { peerInstanceId: PEER });
    v1 = await saveVersion(PB, typed('p'));
    v2 = await saveVersion(PB, typed('q'));
    // X defines A as v2 does, plus a type of its own so its text differs; built from a network the peer is not in.
    X = await snapshotOf({ typeSchemas: { entity: { A: { propertySchemas: { q: { type: 'string' } } }, Elsewhere: {} } } });
    await snapshotsOf(d.door.mongo, PB).insertOne(snapshotRow({ fp: X.fp, text: X.text, origin: 'fetched', from: 'another-member',
      links: linksOf(X.fp, [{ networkId: OUTSIDE_NET, fp: 'c'.repeat(64) }]), at: '2026-01-01T00:00:00.000Z' }));
    let i = 0;
    for (const [tag, fp] of [['v1', v1.fp], ['X', X.fp], ['v2', v2.fp]]) {
      const docs = [recordOf('entities', PB, ++i, { type: 'A', fp }), recordOf('entities', PB, ++i, { type: 'A', fp })];
      await d.door.coll(PB, 'entities').insertMany(docs);
      seeded.set(tag, docs.map(x => x._id));
    }
    const { readPeerMeta } = await import('../../schema/dist/internal.js');
    const layer = readPeerMeta({ typeSchemas: { entity: { L: { propertySchemas: { l: { type: 'string' } } } } } });
    assert.ok(layer.ok, layer.message);
    assert.ok((await import('../../server/dist/spaces/effective-meta.js')).storeNetworkLayer(OUTSIDE_NET, PU, layer.meta),
      'precondition: the layer of a network the peer is not in did not change PU\'s current version');
    await d.door.coll(PU, 'entities').insertOne(recordOf('entities', PU, ++i, { type: 'L', fp: (await import('../../server/dist/spaces/schema-stamp.js')).variationOf(PU).stamp.fp }));
  });
  after(async () => { await d?.close(); });

  const ids = (body) => ((body?.data ?? body)?.results ?? []).map(r => r._id).sort();
  const idsOf = (...tags) => tags.flatMap(t => seeded.get(t)).sort();

  it('older: the peer finds the records of a version it may not have; the local token, which may, does not', async () => {
    const args = { space: PB, collection: 'entities', schemaVersion: 'older', schemaChanged: 'any', limit: 100 };
    const mine = await d.rest(local.key, 'POST', '/api/filter', args);
    assert.equal(mine.status, 200, mine.text.slice(0, 300));
    assert.deepEqual(ids(mine.body), idsOf('v1'), 'precondition: for the local token, X (A as v2 defines it) is older');
    for (const [door, call] of [['REST', () => d.rest(peer.key, 'POST', '/api/filter', args)], ['MCP', () => d.mcp(peer.key, 'filter', args)]]) {
      const r = await call();
      const body = r.structured ?? r.body;
      assert.ok(!(r.isError || r.status >= 400), `${door}: ${r.text.slice(0, 300)}`);
      assert.deepEqual(ids(body), idsOf('v1', 'X'), `${door}: the peer's older classified X by a text it may not have`);
      const m = (body?.data ?? body)?.schemaVersion?.members?.find(x => x.spaceId === PB);
      assert.equal(m?.unclassified, 2, `${door}: X's records are not counted unclassified for the peer`);
    }
  });

  it('sameAs:<X> for the peer matches only the records stamped X; for the local token it matches v2\'s too', async () => {
    const args = { space: PB, collection: 'entities', schemaVersion: `sameAs:${X.fp}`, limit: 100 };
    const peerSide = await d.mcp(peer.key, 'filter', args);
    assert.ok(!peerSide.isError, peerSide.text.slice(0, 300));
    assert.deepEqual(ids(peerSide.structured), idsOf('X'), 'the peer\'s sameAs used a text it may not have');
    const mine = await d.mcp(local.key, 'filter', args);
    assert.ok(!mine.isError, mine.text.slice(0, 300));
    assert.deepEqual(ids(mine.structured), idsOf('X', 'v2'));
  });

  for (const door of ['REST', 'MCP']) {
    it(`${door}: the fps form answers notHeld for X to the peer, and older or current by its text to the local token`, async () => {
      const ask = { fps: [X.fp, v1.fp], kind: 'entity', type: 'A' };
      const theirs = await doors[door](peer.key, PB, ask);
      assert.ok(!theirs.refused, theirs.text.slice(0, 300));
      const t = new Map((theirs.body.standings ?? []).map(s => [s.fp, s.standing]));
      assert.equal(t.get(X.fp), 'notHeld', 'the peer is told X\'s standing from its text');
      assert.equal(t.get(v1.fp), 'older');
      assert.equal((theirs.body.standings ?? []).find(s => s.fp === X.fp)?.definition, undefined, 'the peer is given a definition for X');
      const mine = new Map(((await doors[door](local.key, PB, ask)).body.standings ?? []).map(s => [s.fp, s.standing]));
      assert.equal(mine.get(X.fp), 'current', 'for the local token X defines A as current does');
    });

    it(`${door}: the three forms answer 404 unknown_fingerprint when the current version is not the peer's`, async () => {
      const fp = (await import('../../server/dist/spaces/schema-stamp.js')).variationOf(PU).stamp.fp;
      for (const ask of [{ kind: 'entity' }, { kind: 'entity', type: 'L' }, { fps: [fp], kind: 'entity', type: 'L' }]) {
        const r = await doors[door](peer.key, PU, ask);
        assert.ok(r.refused, `${JSON.stringify(ask)} was answered to the peer: ${r.text.slice(0, 200)}`);
        if (door === 'REST') assert.equal(r.status, 404, JSON.stringify(ask));
        assert.match(r.text, /unknown_fingerprint/, JSON.stringify(ask));
        const mine = await doors[door](local.key, PU, ask);
        assert.ok(!mine.refused, `${JSON.stringify(ask)}: the local token is refused too: ${mine.text.slice(0, 200)}`);
      }
    });

    it(`${door}: network ids are cut to the networks shared with the peer`, async () => {
      const mine = await doors[door](local.key, PU, { kind: 'entity' });
      assert.ok(!mine.refused, mine.text.slice(0, 300));
      const row = (mine.body.types ?? []).find(r => r.type === 'L');
      assert.deepEqual(row?.networks, [OUTSIDE_NET], 'precondition: the layer row does not name its network to the local token');
      const hist = await doors[door](peer.key, PB, { kind: 'entity', type: 'A' });
      assert.ok(!hist.refused, hist.text.slice(0, 300));
      const named = (hist.body.definitions ?? []).flatMap(def => def.origin?.networks ?? []);
      assert.deepEqual(named.filter(n => n === OUTSIDE_NET), [], 'the peer is told a network it is not in');
      assert.ok(!(hist.body.definitions ?? []).some(def => def.rep === X.fp), 'the peer\'s history lists a definition from a version it may not have');
    });
  }
});
