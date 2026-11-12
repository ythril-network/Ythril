/**
 * `GET /api/sync/schema-snapshot?spaceId=&networkId=&fp=` hands a peer one schema version this server keeps privately - to the peers that may read the
 * schema, for the networks they share, with every refusal coded - and `GET /api/sync/meta` asks the same schema rung (bundle-265, Q-738; design 3.1,
 * R4-1..R4-4, S-N2).
 *
 * ## What is asked of the route
 *
 * In the order the design gives the handler's steps:
 *
 * 1. `400 { code: 'bad_fingerprint' }` unless `fp` is 64 lowercase hex;
 * 2. reach: a peer that does not reach the space is refused `403` (`refusePeerReach`) - before the rung, before the row is looked at;
 * 3. the schema rung: `satisfies(effectiveRung(rights, space, 'schema'), 'read')`, else `403 { code: 'schema_rung' }`. A files-only token holds none, a
 *    token holding `knowledge: write` holds it by implication, a token with no matrix is refused;
 * 4. an unknown space: what `sendLostSpace` answers, as `/meta` answers it (404 with the sentence and no code; 410 `space_retired` for a retired id), after reach and
 *    the rung, so a caller that may not reach a space cannot tell a space that does not exist from one that does. Reach itself refuses a name this instance does
 *    not configure (`403 Forbidden`, for an admin token too), so the lost-space answer is what a space that vanishes between the reach check and the lookup gets;
 * 5. no row: `404 { code: 'unknown_fingerprint' }` - the only 404 that carries a code, because the receiver reads a 404 WITHOUT one as "this peer has no such
 *    route" and stops asking it;
 * 6. a row built from a layer of a network the peer does not share with this space (a layer row of it, an own row linking it, a fetched row whose sender's
 *    links name it, a fetched row of unknown provenance): `409 { code: 'not_shared' }`; a non-peer token shares by reach and is served the row whole;
 * 7. `200 { fp, text, links }` with `links.layers` and `links.served` cut to the shared networks.
 *
 * ## The ONE rung check
 *
 * `GET /meta` asks the rung through the same helper (`refuseSchemaRung`, in `api/sync/_shared.ts` beside `refusePeerReach`), so the two schema doors cannot
 * differ: a files-only peer token reaches the space and is refused `schema_rung` on both. The route is registered on `syncMetaRouter`, inside the exempt
 * `syncRouter`, so `route-guard-coverage` needs no new row; this file asserts the registration so a later move to a new router fails HERE.
 *
 * ## How it is driven
 *
 * The routers' own handlers over a real Mongo layer (`openPullDoor`, as `a-peer-meets-a-held-space-on-every-sync-door-db` does); the rows are written
 * straight into `<space>_schema_snapshots` in the Q-735 row shape (`_id` = fingerprint, `origin`, `networkId` on a layer row, `links`), because who
 * WROTE a row is Q-735's question and who may be SERVED it is this one.
 *
 * ## Seen red
 *
 * At ce37b83a `syncMetaRouter` has no `/schema-snapshot`, so every case that calls it fails at the harness ("no GET /schema-snapshot on that router"),
 * and `GET /meta` answers `200` to a files-only token (it asks reach only), which the two `/meta` cases name.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-schema-snapshot-route-serves-only-what-the-requester-shares-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { ADMIN_TOKEN, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { callRoute } from './_vote-round-instance.mjs';
import { snapshotNamed, snapshotRow, snapshotsOf, linksOf, sha256 } from './_schema-snapshot-peer.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'snaproute';
const OUTSIDE = 'snaprouteoutside';
const OTHER_NET = 'a-network-the-peer-is-not-in';
const NONE = { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none', networks: 'none' };

/** A peer-bound token holding exactly these rungs in `S` (and no floor): what a hand-made per-area token for a sync peer looks like. */
const peerHolding = (rungs) => Object.freeze({
  rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: { ...NONE, ...rungs } }, spaceAdmin: { floor: false, spaces: [] } },
  peerInstanceId: PEER,
});

let door, routers, syncRouter;

const route = (token, query = {}) => callRoute(routers.meta, 'get', '/schema-snapshot', { query: { spaceId: S, networkId: door.NET, ...query }, authToken: token });
const rowOf = (extra) => snapshotsOf(door.mongo, S).insertOne(extra);

describe('GET /api/sync/schema-snapshot', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'snaproute', spaces: [S], extraSpaces: [OUTSIDE], type: 'club', direction: 'both', lateral: true });
    routers = { meta: (await import('../../server/dist/api/sync/meta.js')).syncMetaRouter };
    syncRouter = (await import('../../server/dist/api/sync/index.js')).syncRouter;
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await snapshotsOf(door.mongo, S).deleteMany({});
  });

  it('is registered on syncMetaRouter, which the exempt syncRouter mounts', () => {
    const layer = routers.meta.stack.find(l => l.route?.path === '/schema-snapshot' && l.route.methods.get);
    assert.ok(layer, 'GET /schema-snapshot is not on syncMetaRouter: on any other router route-guard-coverage needs an EXEMPT row for it');
    assert.ok(syncRouter.stack.some(l => l.handle === routers.meta), 'syncMetaRouter is not mounted on syncRouter, so the route is not under /api/sync');
  });

  describe('the answer to a peer that may read the schema', () => {
    it('serves the row whole: the fingerprint, the text it names, and the links', async () => {
      const { text, fp } = await snapshotNamed('served');
      const links = linksOf(fp, [{ networkId: door.NET, fp: 'a'.repeat(64) }], [{ networkId: door.NET, fp: 'b'.repeat(64) }]);
      await rowOf(snapshotRow({ fp, text, origin: 'own', links }));
      const r = await route(peerToken(PEER), { fp });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(r.body.fp, fp);
      assert.equal(r.body.text, text);
      assert.equal(sha256(r.body.text), r.body.fp, 'the served text is not the text its fingerprint names');
      assert.deepEqual(r.body.links, links);
    });

    it('serves a layer row of a network the peer shares', async () => {
      const { text, fp } = await snapshotNamed('layer');
      await rowOf(snapshotRow({ fp, text, origin: 'layer', networkId: door.NET, links: null }));
      const r = await route(peerToken(PEER), { fp });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(r.body.fp, fp);
    });

    it('serves an own row of a space no network has a layer for (nothing mixed in it)', async () => {
      const { text, fp } = await snapshotNamed('plain');
      await rowOf(snapshotRow({ fp, text, origin: 'own', links: linksOf(fp) }));
      assert.equal((await route(peerToken(PEER), { fp })).code, 200);
    });

    it('serves a fetched row whose sender built it from a network the peer shares', async () => {
      const { text, fp } = await snapshotNamed('relayed');
      await rowOf(snapshotRow({ fp, text, origin: 'fetched', from: 'upstream', links: linksOf(fp, [{ networkId: door.NET, fp: 'c'.repeat(64) }]) }));
      assert.equal((await route(peerToken(PEER), { fp })).code, 200);
    });
  });

  describe('the coded refusals', () => {
    it('400 bad_fingerprint for a fingerprint that is not 64 lowercase hex', async () => {
      for (const fp of ['', 'abc', 'A'.repeat(64), `${'a'.repeat(63)}g`, 'a'.repeat(65)]) {
        const r = await route(peerToken(PEER), { fp });
        assert.equal(r.code, 400, `fp ${JSON.stringify(fp)} was answered ${r.code} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 'bad_fingerprint', `fp ${JSON.stringify(fp)}`);
      }
    });

    it('404 unknown_fingerprint when no row has the fingerprint - the coded 404, so the asker does not read it as a missing route', async () => {
      const r = await route(peerToken(PEER), { fp: 'd'.repeat(64) });
      assert.equal(r.code, 404);
      assert.equal(r.body.code, 'unknown_fingerprint');
    });

    it('a space this instance does not have is answered as GET /meta answers it, token for token: the reach check refuses it first, and sendLostSpace answers only what reach let through', async () => {
      const GONE = 'a-space-this-instance-never-had';
      for (const token of [ADMIN_TOKEN, peerToken(PEER)]) {
        const r = await route(token, { spaceId: GONE, networkId: undefined, fp: 'd'.repeat(64) });
        const viaMeta = await callRoute(routers.meta, 'get', '/meta', { query: { spaceId: GONE }, authToken: token });
        assert.equal(r.code, viaMeta.code, `${JSON.stringify(r.body)} against ${JSON.stringify(viaMeta.body)}`);
        assert.deepEqual(r.body, viaMeta.body, 'the two schema doors answer a lost space in different words');
        assert.equal(r.body.code, undefined, 'a code on it would be read as an unknown fingerprint or another refusal');
      }
    });

    it('a caller that does not reach the space is answered alike whether the space exists or not: reach comes before the lookup, so the door does not say which spaces exist', async () => {
      const { text, fp } = await snapshotNamed('exists-outside');
      await snapshotsOf(door.mongo, OUTSIDE).insertOne(snapshotRow({ fp, text, origin: 'own', links: linksOf(fp) }));
      const exists = await route(peerToken(PEER), { spaceId: OUTSIDE, fp });
      const gone = await route(peerToken(PEER), { spaceId: 'a-space-this-instance-never-had', fp });
      assert.equal(exists.code, 403, JSON.stringify(exists.body));
      assert.equal(gone.code, exists.code, `a space that does not exist was answered ${gone.code} ${JSON.stringify(gone.body)}, one that exists ${exists.code}: the door tells a caller without reach which spaces exist`);
      assert.deepEqual(gone.body, exists.body);
      await snapshotsOf(door.mongo, OUTSIDE).deleteMany({});
    });

    it('403 for a peer that does not reach the space - before its rung and before the row is looked at', async () => {
      const { text, fp } = await snapshotNamed('outside');
      await snapshotsOf(door.mongo, OUTSIDE).insertOne(snapshotRow({ fp, text, origin: 'own', links: linksOf(fp) }));
      const r = await route(peerToken(PEER), { spaceId: OUTSIDE, fp });
      assert.equal(r.code, 403);
      assert.notEqual(r.body.code, 'schema_rung', 'the rung was asked of a peer that does not even reach the space: reach is the first question');
      await snapshotsOf(door.mongo, OUTSIDE).deleteMany({});
    });
  });

  describe('the schema rung', () => {
    const SERVED = async () => {
      const { text, fp } = await snapshotNamed('rung');
      await rowOf(snapshotRow({ fp, text, origin: 'own', links: linksOf(fp) }));
      return fp;
    };

    it('a token that reaches the space with files only is refused 403 schema_rung', async () => {
      const fp = await SERVED();
      const r = await route(peerHolding({ files: 'write' }), { fp });
      assert.equal(r.code, 403, JSON.stringify(r.body));
      assert.equal(r.body.code, 'schema_rung');
    });

    it('schema: read is enough, and so is knowledge: write, which entails it', async () => {
      const fp = await SERVED();
      assert.equal((await route(peerHolding({ schema: 'read' }), { fp })).code, 200);
      assert.equal((await route(peerHolding({ knowledge: 'write' }), { fp })).code, 200);
    });

    it('a token with no rights matrix is refused', async () => {
      const fp = await SERVED();
      const r = await route({ peerInstanceId: PEER }, { fp });
      assert.equal(r.code, 403, JSON.stringify(r.body));
    });
  });

  describe('not_shared: a row built from a layer of a network the peer is not in is never served on', () => {
    const lateral = () => door.LATERAL_NET;
    // The pull door carries the space through a second CLUB network the peer is no member of (`lateral: true`), so "a network that holds this space
    // and the peer does not share" is a real network of this instance's config, not only a name in a row.

    it('409 not_shared for the layer row of another network', async () => {
      const { text, fp } = await snapshotNamed('other-layer');
      await rowOf(snapshotRow({ fp, text, origin: 'layer', networkId: OTHER_NET, links: null }));
      const r = await route(peerToken(PEER), { fp });
      assert.equal(r.code, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'not_shared');
    });

    it('409 not_shared for an own row that links the layer of a network the peer does not share, and no text leaves in the refusal', async () => {
      const { text, fp } = await snapshotNamed('two-layers');
      await rowOf(snapshotRow({ fp, text, origin: 'own', links: linksOf(fp, [{ networkId: door.NET, fp: 'a'.repeat(64) }, { networkId: lateral(), fp: 'b'.repeat(64) }]) }));
      const r = await route(peerToken(PEER), { fp });
      assert.equal(r.code, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'not_shared');
      assert.ok(!JSON.stringify(r.body).includes('two-layers'), 'the refusal carries the schema text it refused to serve');
    });

    it('409 not_shared for a fetched row of unknown provenance (no links, no layer to say what it was built from)', async () => {
      const { text, fp } = await snapshotNamed('unknown-origin');
      await rowOf(snapshotRow({ fp, text, origin: 'fetched', from: 'somewhere', links: null }));
      const r = await route(peerToken(PEER), { fp });
      assert.equal(r.code, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'not_shared');
    });

    it('409 not_shared for a fetched row whose sender\'s links name a network the peer does not share', async () => {
      const { text, fp } = await snapshotNamed('relayed-mixed');
      await rowOf(snapshotRow({ fp, text, origin: 'fetched', from: 'upstream', links: linksOf(fp, [{ networkId: OTHER_NET, fp: 'a'.repeat(64) }]) }));
      assert.equal((await route(peerToken(PEER), { fp })).body.code, 'not_shared');
    });

    it('serves the links of a one-layer row cut to the networks the peer shares', async () => {
      const { text, fp } = await snapshotNamed('one-layer');
      const mine = { networkId: door.NET, fp: 'a'.repeat(64) };
      await rowOf(snapshotRow({ fp, text, origin: 'own', links: linksOf(fp, [mine], [{ networkId: door.NET, fp: 'c'.repeat(64) }, { networkId: OTHER_NET, fp: 'd'.repeat(64) }]) }));
      const r = await route(peerToken(PEER), { fp });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.links.layers, [mine]);
      assert.deepEqual(r.body.links.served, [{ networkId: door.NET, fp: 'c'.repeat(64) }], 'a network the peer does not share is named in the served links');
      assert.ok(!JSON.stringify(r.body).includes(OTHER_NET), 'the answer names a network the peer is not in');
    });

    it('serves the two-layer row whole to a token that is no peer: it shares by reach', async () => {
      const { text, fp } = await snapshotNamed('two-layers-admin');
      const links = linksOf(fp, [{ networkId: door.NET, fp: 'a'.repeat(64) }, { networkId: lateral(), fp: 'b'.repeat(64) }]);
      await rowOf(snapshotRow({ fp, text, origin: 'own', links }));
      const r = await route(ADMIN_TOKEN, { fp });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.links, links);
    });
  });

  describe('GET /api/sync/meta asks the schema rung too', () => {
    const meta = (token) => callRoute(routers.meta, 'get', '/meta', { query: { spaceId: S, networkId: door.NET }, authToken: token });

    it('refuses a token that reaches the space with files only: 403 schema_rung, the answer the snapshot route gives', async () => {
      const r = await meta(peerHolding({ files: 'write' }));
      assert.equal(r.code, 403, `GET /meta answered ${r.code} ${JSON.stringify(r.body).slice(0, 120)}: it asked reach only, so a token with no schema right was handed the schema`);
      assert.equal(r.body.code, 'schema_rung');
    });

    it('serves a peer token minted by an invite or a join (it holds schema: write), a read-only one and an admin', async () => {
      assert.equal((await meta(peerHolding({ knowledge: 'write', files: 'write', schema: 'write' }))).code, 200);
      assert.equal((await meta(peerHolding({ schema: 'read' }))).code, 200);
      assert.equal((await meta(peerToken(PEER))).code, 200);
      assert.equal((await meta(ADMIN_TOKEN)).code, 200);
    });
  });
});
