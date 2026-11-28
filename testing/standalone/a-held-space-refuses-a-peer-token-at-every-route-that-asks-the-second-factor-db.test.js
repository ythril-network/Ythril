/**
 * A space held for a peer is refused to that peer's token on every route behind the second-factor guard, not only reindex and reembed
 * (Q-181, bundle-41, round-1 finding F8).
 *
 * ## What the change reached
 *
 * Q-181 gave `requireSpaceAuthMfaScoped` the hold: after the area rung it asks `refuseHeldPeer`, as `requireSpaceAuthScoped` does. That guard
 * stands in front of every route that asks the second factor of a space's own rung (reindex, reembed, rebuild-indexes, PUT schema, PATCH space,
 * the type-schema routes, validate-schema, network-precedence, schema-convert, the schema and data RDF imports), so the refusal reaches all of
 * them, and no test drove it. The routes are derived here from the route table (the ones whose chain names the guard), never listed.
 *
 * ## What holds now (bundle-47, Q-244; the real application over a socket, real MongoDB; a wipe round applied here whose peer has not concluded it holds the space)
 *
 * Q-244 confines a peer-bound token to the sync doors: token resolution answers it `403 { code: 'peer_door' }` on every route but `/api/sync/*`,
 * `GET`/`POST /api/files/:spaceId` and `POST /api/notify`. None of the routes behind the second-factor guard is one of those, so a peer token no
 * longer reaches the hold there: the refusal comes first, and it is the same on a held space and on a free one. The routes driven are the same
 * (DRIVEN, derived from the route table), and the file holds:
 *
 * 1. A peer-bound token with the rung on the held space is answered `403 peer_door` on reindex, reembed and validate-schema, never `423 space_held`,
 *    each of which is asserted to stand behind the guard in the route table.
 * 2. Controls: the same token on a space nothing holds is answered the same words (the refusal is about the token kind, not the hold); an
 *    instance-admin token on the held space is neither held nor refused as a peer.
 * 3. A peer-bound token WITHOUT the rung is answered `403 peer_door` on the held space and on a free one alike: it never learns the space is held.
 *
 * Seen red at the bundle-47 server: the rows as Q-181 wrote them (`423` on the held space, a hold-free answer on the free one) fail with the `peer_door`
 * refusal. The hold's own guard on these routes was seen red on f3cd49548 by mutation (`refuseHeldPeer` dropped from `requireSpaceAuthMfaScoped`).
 *
 * Run: node --test testing/standalone/a-held-space-refuses-a-peer-token-at-every-route-that-asks-the-second-factor-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';
import { MFA_GUARDED_ROUTES_DRIVEN as DRIVEN } from './_mfa-guarded-routes-driven.mjs';
import { isPeerDoorRefusal } from './_peer-door.mjs';

const skip = await mongoSkipReason();
const HELD = 'mfaheld';
const FREE = 'mfafree';
const PEER = 'mfa-held-peer';
const NET = 'mfa-held-net';
const HOUR = 3_600_000;

// The routes driven (DRIVEN) are shared with the pure test that holds them to the route table:
// the-routes-the-held-space-test-drives-stand-behind-the-second-factor-guard.test.js.
const url = (path, space) => path.replace(/:\w+/, space);
const isHeld = (r) => r.status === 423 && r.body?.code === 'space_held';
const isPeerDoor = isPeerDoorRefusal;
const fmt = (r) => `${r.status} ${r.text.slice(0, 160)}`;

/** An applied wipe round of the held space with no evidence that the peer concluded it: the space is held for that peer. */
const wipeRound = (selfId) => {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  return {
    roundId: 'mfa-w', type: 'space_wipe', spaceId: HELD, subjectInstanceId: selfId, subjectLabel: 'x', subjectUrl: '',
    openedAt: iso(-HOUR), deadline: iso(23 * HOUR), votes: [{ instanceId: selfId, vote: 'yes', castAt: iso(-HOUR) }],
    concluded: true, passed: true, appliedHere: true, proposedHere: true,
  };
};

describe('a held space is refused to a peer token on every route that asks the second factor', { skip }, () => {
  let d; const keys = {};
  before(async () => {
    d = await openRdfExportDoors({ suite: 'mfa_held', spaces: [{ id: HELD, meta: rdfMeta(HELD) }, { id: FREE, meta: rdfMeta(FREE) }] });
    const admin = d.row({}, 'admin');
    const none = d.row({}, 'none');
    const peer = async (name, perSpace) => (await d.mint(name, perSpace, { peerInstanceId: PEER })).key;
    keys.peer = await peer('mfa-held-peer', { [HELD]: admin, [FREE]: admin });
    keys.peerNoRung = await peer('mfa-held-peer-norung', { [HELD]: none, [FREE]: none });
    keys.admin = (await d.mint('mfa-held-admin', {}, { admin: true })).key;
    d.loader.mutateConfig((cfg) => {
      cfg.networks.push({
        id: NET, label: 'Held network', type: 'club', origin: 'joined', spaces: [HELD, FREE], votes: [], votingDeadlineHours: 24,
        members: [{ instanceId: PEER, label: 'Peer', url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'both' }],
        pendingRounds: [wipeRound(cfg.instanceId)],
      });
    });
  });
  after(async () => { await d?.close(); });

  const drive = (route, key, space) => d.rest(key, route.method, url(route.path, space), route.body);

  it('a peer token with the rung is answered 403 peer_door on each route driven, never 423 space_held', async () => {
    const notRefused = [];
    for (const route of DRIVEN) { const r = await drive(route, keys.peer, HELD); if (!isPeerDoor(r)) notRefused.push(`${route.method} ${route.path} -> ${fmt(r)}`); }
    assert.deepEqual(notRefused, [], `a peer token was not refused as a peer on a route that is no peer door:\n  ${notRefused.join('\n  ')}`);
  });

  it('controls: the same token on a free space is refused the same words, and an instance-admin token on the held one is neither held nor refused as a peer', async () => {
    for (const route of DRIVEN) {
      const free = await drive(route, keys.peer, FREE);
      assert.ok(isPeerDoor(free), `${route.method} ${route.path} on a space nothing holds: ${fmt(free)}`);
      const held = await drive(route, keys.peer, HELD);
      assert.equal(held.text, free.text, `${route.method} ${route.path}: the peer's answer on the held space differs from the one on a free space`);
      const admin = await drive(route, keys.admin, HELD);
      assert.ok(!isHeld(admin), `${route.method} ${route.path}: an instance-admin token was held as if it were the exchange: ${fmt(admin)}`);
      assert.ok(!isPeerDoor(admin), `${route.method} ${route.path}: an instance-admin token was refused as a peer: ${fmt(admin)}`);
    }
  });

  it('a peer token without the rung is refused 403 peer_door on the held space and the free one alike, and told nothing of the hold', async () => {
    for (const route of DRIVEN) {
      const held = await drive(route, keys.peerNoRung, HELD);
      const free = await drive(route, keys.peerNoRung, FREE);
      assert.ok(isPeerDoor(held), `${route.method} ${route.path}: ${fmt(held)}`);
      assert.ok(!isHeld(held), `${route.method} ${route.path} told a token without the rung that the space is held`);
      assert.equal(held.text.split(HELD).join('S'), free.text.split(FREE).join('S'), `${route.method} ${route.path}: the answer on the held space differs from the one on a free space`);
    }
  });
});
