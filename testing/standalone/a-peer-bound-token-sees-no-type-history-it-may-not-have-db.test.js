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
 * ## What holds now (bundle-47, Q-244)
 *
 * Q-244 confines a peer-bound token to the sync doors: token resolution answers it `403 { code: 'peer_door' }` on every route but `/api/sync/*`,
 * `GET`/`POST /api/files/:spaceId` and `POST /api/notify`, `/mcp` included (an HTTP `403` with a JSON body, never a tool result). The schema-versions
 * door, the filter door and their tools are not among them, so a peer token no longer reaches them to be narrowed to what it may have: it is refused
 * before any version, standing, definition or network id is read. The contract above holds for a token that does reach the doors (the local token,
 * the control of every row); the peer's half of each row is the refusal:
 *
 * - `older` and `sameAs:<fp>` on the filter, the `fps` form, and the three forms on the schema-versions door, are answered `403 peer_door` to the peer
 *   token on REST and MCP, where the local token is answered as the contract says;
 * - the history of a type is refused to the peer, so no network id it is not in reaches it; the local token's row names the layer's network.
 *
 * ## Fixture
 *
 * Space PB: v1 -> v2 (current; A renamed). X is a held row built from a network the peer is not in, defining A as v2 does. Records
 * A@v1, A@X, A@v2. Space PU: its current version is a layer of a network the peer is not in.
 *
 * ## Seen red at 327b105e
 *
 * `olderIn` takes no scope (the peer's `older` classifies X by its text, as the local token's does); the three forms do not exist. At the bundle-47
 * server the peer's rows as Q-744 wrote them (answered, narrowed) fail with the `peer_door` refusal.
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
import { typeDoors, queryOf } from './_type-history.mjs';

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

/**
 * What a peer-bound token is answered at each door: the HTTP status and the refusal's code. `/mcp` answers a peer token an HTTP 403 with a JSON
 * body (the door never reaches the tool), so the code is read from that body, not from a tool result.
 */
const asPeer = {
  REST: async (key, method, url, body) => { const r = await d.rest(key, method, url, body); return { status: r.status, code: r.body?.code, text: r.text }; },
  MCP: async (key, name, args) => { const r = await d.rpc(key, 'tools/call', { name, arguments: args }); return { status: r.status, code: r.messages[0]?.code, text: JSON.stringify(r.messages[0] ?? {}) }; },
};
const schemaVersionsAsPeer = {
  REST: (key, space, params = {}) => asPeer.REST(key, 'GET', `/api/spaces/${encodeURIComponent(space)}/schema-versions${queryOf(params)}`),
  MCP: (key, space, params = {}) => asPeer.MCP(key, 'space_schema_versions', { space, ...params }),
};
const assertPeerDoor = (a, what) => assert.ok(a.status === 403 && a.code === 'peer_door', `${what}: the peer-bound token was not refused as a peer: ${a.status} ${a.text.slice(0, 200)}`);

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

  it('older: the peer is refused 403 peer_door on the filter, on both doors, and finds no record; the local token, which may, is answered', async () => {
    const args = { space: PB, collection: 'entities', schemaVersion: 'older', schemaChanged: 'any', limit: 100 };
    const mine = await d.rest(local.key, 'POST', '/api/filter', args);
    assert.equal(mine.status, 200, mine.text.slice(0, 300));
    assert.deepEqual(ids(mine.body), idsOf('v1'), 'precondition: for the local token, X (A as v2 defines it) is older');
    assertPeerDoor(await asPeer.REST(peer.key, 'POST', '/api/filter', args), 'REST');
    assertPeerDoor(await asPeer.MCP(peer.key, 'filter', args), 'MCP');
  });

  it('sameAs:<X> is refused to the peer on both doors (403 peer_door); for the local token it matches the records stamped X and v2', async () => {
    const args = { space: PB, collection: 'entities', schemaVersion: `sameAs:${X.fp}`, limit: 100 };
    assertPeerDoor(await asPeer.MCP(peer.key, 'filter', args), 'MCP');
    assertPeerDoor(await asPeer.REST(peer.key, 'POST', '/api/filter', args), 'REST');
    const mine = await d.mcp(local.key, 'filter', args);
    assert.ok(!mine.isError, mine.text.slice(0, 300));
    assert.deepEqual(ids(mine.structured), idsOf('X', 'v2'));
  });

  for (const door of ['REST', 'MCP']) {
    it(`${door}: the fps form is refused to the peer (403 peer_door) and gives it no standing of X; the local token is told X's standing from its text`, async () => {
      const ask = { fps: [X.fp, v1.fp], kind: 'entity', type: 'A' };
      assertPeerDoor(await schemaVersionsAsPeer[door](peer.key, PB, ask), door);
      const mine = new Map(((await doors[door](local.key, PB, ask)).body.standings ?? []).map(s => [s.fp, s.standing]));
      assert.equal(mine.get(X.fp), 'current', 'for the local token X defines A as current does');
    });

    it(`${door}: the three forms are refused to the peer (403 peer_door), where the current version is not the peer's, and not to the local token`, async () => {
      const fp = (await import('../../server/dist/spaces/schema-stamp.js')).variationOf(PU).stamp.fp;
      for (const ask of [{ kind: 'entity' }, { kind: 'entity', type: 'L' }, { fps: [fp], kind: 'entity', type: 'L' }]) {
        assertPeerDoor(await schemaVersionsAsPeer[door](peer.key, PU, ask), `${door} ${JSON.stringify(ask)}`);
        const mine = await doors[door](local.key, PU, ask);
        assert.ok(!mine.refused, `${JSON.stringify(ask)}: the local token is refused too: ${mine.text.slice(0, 200)}`);
      }
    });

    it(`${door}: a type's history is refused to the peer (403 peer_door), so no network id it is not in reaches it; the local token's row names the layer's network`, async () => {
      const mine = await doors[door](local.key, PU, { kind: 'entity' });
      assert.ok(!mine.refused, mine.text.slice(0, 300));
      const row = (mine.body.types ?? []).find(r => r.type === 'L');
      assert.deepEqual(row?.networks, [OUTSIDE_NET], 'precondition: the layer row does not name its network to the local token');
      assertPeerDoor(await schemaVersionsAsPeer[door](peer.key, PB, { kind: 'entity', type: 'A' }), door);
      const hist = await doors[door](local.key, PB, { kind: 'entity', type: 'A' });
      assert.ok(!hist.refused, `the local token's history of the same type: ${hist.text.slice(0, 300)}`);
    });
  }
});
