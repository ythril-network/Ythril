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
 * ## What it holds (the real application over a socket, real MongoDB; a wipe round applied here whose peer has not concluded it holds the space)
 *
 * 1. A peer-bound token with the rung on the held space is answered `423 space_held` on reindex, reembed and validate-schema, each of which is
 *    asserted to stand behind the guard in the route table.
 * 2. The same token on a space nothing holds, and an instance-admin token on the held one, are not refused for the hold.
 * 3. A peer-bound token WITHOUT the rung is answered `403` first, and its answer on the held space is the answer it gets on a free one: it never
 *    learns the space is held.
 *
 * Seen red on f3cd49548 by mutation: `refuseHeldPeer` dropped from `requireSpaceAuthMfaScoped`: rows 1 answer 202 or 200.
 *
 * Run: node --test testing/standalone/a-held-space-refuses-a-peer-token-at-every-route-that-asks-the-second-factor-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';
import { mountedRoutes } from './_routes.mjs';

const skip = await mongoSkipReason();
const HELD = 'mfaheld';
const FREE = 'mfafree';
const PEER = 'mfa-held-peer';
const NET = 'mfa-held-net';
const HOUR = 3_600_000;

/** The routes driven: one of each guard's families, as the route table spells them (`:id` the space). */
const DRIVEN = [
  { method: 'POST', path: '/api/brain/spaces/:spaceId/reindex', body: {} },
  { method: 'POST', path: '/api/spaces/:id/reembed', body: {} },
  { method: 'POST', path: '/api/spaces/:id/validate-schema', body: {} },
];
const url = (path, space) => path.replace(/:\w+/, space);
const isHeld = (r) => r.status === 423 && r.body?.code === 'space_held';
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

  it('the routes driven stand behind requireSpaceAuthMfaScoped in the route table, and so do at least as many more', () => {
    const behind = mountedRoutes().filter(r => /\brequireSpaceAuthMfa(?:Scoped)?\b/.test(r.chain));
    const named = new Set(behind.map(r => `${r.method} ${r.path}`));
    const missing = DRIVEN.filter(r => !named.has(`${r.method} ${r.path}`)).map(r => `${r.method} ${r.path}`);
    assert.deepEqual(missing, [], 'a route driven here no longer stands behind the second-factor guard: this case would hold nothing');
    assert.ok(behind.length > DRIVEN.length, `only ${behind.length} route(s) stand behind the guard: the scan stopped seeing them`);
  });

  it('a peer token with the rung is answered 423 space_held on each route driven', async () => {
    const notHeld = [];
    for (const route of DRIVEN) { const r = await drive(route, keys.peer, HELD); if (!isHeld(r)) notHeld.push(`${route.method} ${route.path} -> ${fmt(r)}`); }
    assert.deepEqual(notHeld, [], `a peer token acted on a space whose wipe only this side has applied:\n  ${notHeld.join('\n  ')}`);
  });

  it('controls: the same token on a free space and an instance-admin token on the held one are not held', async () => {
    for (const route of DRIVEN) {
      const free = await drive(route, keys.peer, FREE);
      assert.ok(!isHeld(free), `${route.method} ${route.path} on a space nothing holds: ${fmt(free)}`);
      const admin = await drive(route, keys.admin, HELD);
      assert.ok(!isHeld(admin), `${route.method} ${route.path}: an instance-admin token was held as if it were the exchange: ${fmt(admin)}`);
    }
  });

  it('a peer token without the rung is refused 403 first and told nothing of the hold', async () => {
    for (const route of DRIVEN) {
      const held = await drive(route, keys.peerNoRung, HELD);
      const free = await drive(route, keys.peerNoRung, FREE);
      assert.equal(held.status, 403, `${route.method} ${route.path}: ${fmt(held)}`);
      assert.ok(!isHeld(held), `${route.method} ${route.path} told a token without the rung that the space is held`);
      assert.equal(held.text.split(HELD).join('S'), free.text.split(FREE).join('S'), `${route.method} ${route.path}: the answer on the held space differs from the one on a free space`);
    }
  });
});
