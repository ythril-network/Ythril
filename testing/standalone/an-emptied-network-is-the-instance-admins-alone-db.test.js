/**
 * A network that carries no space is read, reconfigured, added to and left by the instance admin alone (Q-603).
 *
 * ## The rule
 *
 * An act on a network needs a rung on EVERY space it carries. A network with none has no space for a rung to be held on, so below the
 * instance admin nobody holds one: `[].every(...)` is true, and the empty-means-everything shape answered "yes" to any token with a matrix.
 * `takeSpaceOutOfNetwork` leaves such a network in config when its last space goes, so it is a state normal operation reaches.
 *
 * To a token that is not the instance admin an emptied network does not exist: it is not listed, and every act on it answers 404 (never 403:
 * a refusal would confirm it exists), on the REST door and the MCP door alike. The instance admin keeps seeing it, changing it, and leaving it
 * (which is how an operator tidies one up), so a stored empty network does not strand: after an upgrade it is the admin's alone.
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server with real tokens for REST; `callTool` for MCP; the harness Mongo; networks
 * seeded straight into the config (how an upgrade finds one). Written red on d079607b3: a matrix token sees, patches, adds to and leaves it.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/an-emptied-network-is-the-instance-admins-alone-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
const SPACE = 'emptiedrung';
const OTHER = 'emptiedother';

const REAL = crypto.randomUUID();
const EMPTY_READ = crypto.randomUUID();
const EMPTY_LEAVE = crypto.randomUUID();

const area = (rung) => ({ knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin', networks: rung });
/** Not the instance admin; `networks: admin` on the one space the real network carries, and on no other. */
const NONADMIN = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: area('admin'), [OTHER]: area('admin') } };

const netRecord = (id, label, spaces, members) => ({
  id, label, type: 'closed', origin: 'created', spaces, spaceOrigins: {}, votes: [], votingDeadlineHours: 24, pendingRounds: [],
  ...(spaces.length === 0 ? { pendingSpaces: [{ networkId: 'pend', localId: 'pend', why: 'announced', from: 'peer', at: new Date().toISOString() }] } : {}),
  members,
});
const MEMBER = { instanceId: 'emptied-network-member', label: 'cm', url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'both' };

let door, loader, tokens, server, base, app, plain, admin;

/** The stored networks as an upgrade would find them: a real one, an emptied one with a member, an emptied one with none. */
function seed() {
  loader.mutateConfig((cfg) => {
    cfg.networks = [netRecord(REAL, 'Real', [SPACE], [MEMBER]), netRecord(EMPTY_READ, 'Emptied A', [], [MEMBER]), netRecord(EMPTY_LEAVE, 'Emptied B', [], [])];
  });
}
const stored = (id) => loader.getConfig().networks.find(n => n.id === id);
const rest = (bearer, method, path, body) => fetch(`${base}${path}`, {
  method, headers: { Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
});

describe('a network with no space is the instance admin\'s alone (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    door = await openToolDoor({ suite: 'emptiednet', spaces: [{ id: SPACE, label: 'Rung', folders: [] }, { id: OTHER, label: 'Other', folders: [] }] });
    loader = await import('../../server/dist/config/loader.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    plain = await tokens.createToken({ name: 'emptied-nonadmin', rights: NONADMIN });
    admin = await tokens.createToken({ name: 'emptied-admin', admin: true });
    app = await appRouter();
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await door?.close();
  });

  describe('REST: a token with networks admin on a space', () => {
    it('sees the real network and not the emptied ones (the control is not vacuous)', async () => {
      seed();
      const r = await rest(plain.plaintext, 'GET', '/api/networks');
      assert.equal(r.status, 200, await r.clone().text());
      const ids = JSON.stringify(await r.json());
      assert.ok(ids.includes(REAL), 'the token does not see the network that carries its space: the fixture is wrong');
      assert.ok(!ids.includes(EMPTY_READ) && !ids.includes(EMPTY_LEAVE), 'an emptied network was listed to a token that is not the instance admin');
      assert.ok(!ids.includes('Emptied'), 'an emptied network\'s label was listed');
    });

    it('GET /api/networks/:id is a 404', async () => {
      seed();
      const r = await rest(plain.plaintext, 'GET', `/api/networks/${EMPTY_READ}`);
      assert.equal(r.status, 404, `an emptied network was read: ${r.status} ${(await r.text()).slice(0, 200)}`);
    });

    it('PATCH /api/networks/:id (settings) is a 404 and changes nothing', async () => {
      seed();
      const r = await rest(plain.plaintext, 'PATCH', `/api/networks/${EMPTY_READ}`, { label: 'taken over' });
      assert.equal(r.status, 404, `an emptied network was reconfigured: ${r.status}`);
      assert.equal(stored(EMPTY_READ)?.label, 'Emptied A', 'the label changed');
    });

    it('POST /api/networks/:id/spaces (add a space) is a 404 and attaches nothing', async () => {
      seed();
      const r = await rest(plain.plaintext, 'POST', `/api/networks/${EMPTY_READ}/spaces`, { spaceId: OTHER });
      assert.equal(r.status, 404, `a space was added to an emptied network: ${r.status} ${(await r.text()).slice(0, 200)}`);
      assert.deepEqual(stored(EMPTY_READ)?.spaces, [], 'a space was attached');
    });

    it('POST /api/networks/:id/pending-spaces (dismiss) is a 404 and records nothing', async () => {
      seed();
      const r = await rest(plain.plaintext, 'POST', `/api/networks/${EMPTY_READ}/pending-spaces`, { spaceId: 'pend', action: 'dismiss' });
      assert.equal(r.status, 404, `a pending space of an emptied network was resolved: ${r.status}`);
      assert.deepEqual(stored(EMPTY_READ)?.dismissedSpaces ?? [], [], 'a dismissal was recorded');
    });

    it('DELETE /api/networks/:id (leave) is a 404 and the network stays', async () => {
      seed();
      const r = await rest(plain.plaintext, 'DELETE', `/api/networks/${EMPTY_LEAVE}`);
      assert.equal(r.status, 404, `an emptied network was left: ${r.status} ${(await r.text()).slice(0, 200)}`);
      assert.ok(stored(EMPTY_LEAVE), 'the network record was removed');
    });
  });

  describe('MCP: the same token', () => {
    const call = (name, args) => door.call(name, args, { rights: NONADMIN });

    it('network_get is not found', async () => {
      seed();
      const out = await call('network_get', { id: EMPTY_READ });
      assert.equal(out.status, 404, `an emptied network was read: ${out.status} ${out.text.slice(0, 200)}`);
    });

    it('network_peers does not list it', async () => {
      seed();
      const out = await call('network_peers', {});
      assert.ok(!out.text.includes(EMPTY_READ) && !out.text.includes(EMPTY_LEAVE), 'an emptied network was listed');
      assert.ok(out.text.includes(REAL) || out.status < 400, `fixture check: network_peers failed: ${out.status} ${out.text.slice(0, 200)}`);
    });

    it('network_update is not found and changes nothing', async () => {
      seed();
      const out = await call('network_update', { id: EMPTY_READ, label: 'taken over' });
      assert.equal(out.status, 404, `an emptied network was reconfigured: ${out.status} ${out.text.slice(0, 200)}`);
      assert.equal(stored(EMPTY_READ)?.label, 'Emptied A');
    });

    it('network_add_space is not found and attaches nothing', async () => {
      seed();
      const out = await call('network_add_space', { id: EMPTY_READ, spaceId: OTHER });
      assert.equal(out.status, 404, `a space was added to an emptied network: ${out.status} ${out.text.slice(0, 200)}`);
      assert.deepEqual(stored(EMPTY_READ)?.spaces, []);
    });

    it('network_pending_space (dismiss) is not found and records nothing', async () => {
      seed();
      const out = await call('network_pending_space', { id: EMPTY_READ, spaceId: 'pend', action: 'dismiss' });
      assert.equal(out.status, 404, `a pending space of an emptied network was resolved: ${out.status} ${out.text.slice(0, 200)}`);
      assert.deepEqual(stored(EMPTY_READ)?.dismissedSpaces ?? [], []);
    });

    it('network_leave is not found and the network stays', async () => {
      seed();
      const out = await call('network_leave', { id: EMPTY_LEAVE });
      assert.equal(out.status, 404, `an emptied network was left: ${out.status} ${out.text.slice(0, 200)}`);
      assert.ok(stored(EMPTY_LEAVE), 'the network record was removed');
    });
  });

  describe('the instance admin (the upgrade path: a stored empty network is still reachable)', () => {
    it('sees an emptied network on the list and by id', async () => {
      seed();
      const list = JSON.stringify(await (await rest(admin.plaintext, 'GET', '/api/networks')).json());
      assert.ok(list.includes(EMPTY_READ) && list.includes(EMPTY_LEAVE), 'the admin does not see an emptied network');
      assert.equal((await rest(admin.plaintext, 'GET', `/api/networks/${EMPTY_READ}`)).status, 200);
    });

    it('changes its settings', async () => {
      seed();
      const r = await rest(admin.plaintext, 'PATCH', `/api/networks/${EMPTY_READ}`, { label: 'tidied' });
      assert.equal(r.status, 200, `${r.status} ${(await r.text()).slice(0, 200)}`);
      assert.equal(stored(EMPTY_READ)?.label, 'tidied');
    });

    it('leaves it (deletes it)', async () => {
      seed();
      const r = await rest(admin.plaintext, 'DELETE', `/api/networks/${EMPTY_LEAVE}`);
      assert.ok(r.status === 200 || r.status === 204, `${r.status} ${(await r.text()).slice(0, 200)}`);
      assert.equal(stored(EMPTY_LEAVE), undefined, 'the network record stayed');
    });

    it('the same over MCP', async () => {
      seed();
      const got = await door.call('network_get', { id: EMPTY_READ });
      assert.equal(got.status, 200, `${got.status} ${got.text.slice(0, 200)}`);
    });
  });
});
