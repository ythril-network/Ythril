/**
 * A view never reads a member held for the caller's peer, and a door that has no rights area refuses a view (Q-531, bundle-100, plan
 * rev 3.2 security vet S2 and S3).
 *
 * ## The rules
 *
 * 1. **A view is no way round the hold for a peer-bound token (bundle-47, Q-244).** `viewReadMembers` asks, for each member, what a direct read of
 *    that member asks: a member held for the PEER a token is bound to (an act owed on it, design v5 section 3.3) is not read through a view either.
 *    Q-244 confines a peer-bound token to the sync doors (`/api/sync/*`, `GET`/`POST /api/files/:spaceId`, `POST /api/notify`): token resolution answers
 *    it `403 { code: 'peer_door' }` everywhere else, `/mcp` included (an HTTP `403`, not a tool result), so a peer token reaches neither the direct read
 *    nor the view read, and the per-member hold is not asked of it on these doors. Here a peer-bound token owns a view of two members and one is held:
 *    the direct read of the held member, the read through the view on the REST path, the tool door and MCP, are each answered `403 peer_door` and read no
 *    record. Control: a token not bound to a peer, which owns a view of the same two members, reads through it (the refusal is about the token kind).
 * 2. **A door with no area fails closed.** Every mounted route whose path names a space (`:spaceId`, or `:id` under `/api/spaces`)
 *    and that has no `ROUTE_RIGHTS` row (derived from the mounted routes, floor; today the `NOT_AREA_SCOPED` space routes: activity,
 *    token access, rename, delete, export, import, wipe) refuses the owner's own view id, and the owner here is an instance admin, so
 *    a refusal cannot come from a missing right: a view resolves to members PER AREA, so a door that names no area has no members to
 *    give it.
 *
 * ## Seen red at 18e8d598
 *
 * 1: the view is unknown, so the read through it answers `Space '@guarded' not found` and the readable member's marker is missing. At the bundle-47
 *    server the rows as Q-531 wrote them (`423` on the direct read, the readable member's marker through the view) fail with the `peer_door` refusal.
 * 2: `POST /api/views` answers 404, so the case fails at its create.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-view-reads-no-held-member-and-opens-no-door-without-an-area-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { mountedRoutes } from './_routes.mjs';
import { openViewDoors, viewOf, rowsOf, viewMembersOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const QA = 'vh-qa';
const HELD = 'vh-held';
const PEER = 'vh-peer-instance';

let d, admin, markers;
const fmt = (a) => `${a.status ?? ''} ${(a.text ?? '').slice(0, 200)}`;

describe('a view and the doors that must not open for it (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q531-view-held', spaces: [QA, HELD] });
    admin = await d.mint('vh-admin', {}, { admin: true });
    markers = {};
    for (const s of [QA, HELD]) {
      const a = await d.rest(admin.key, 'POST', `/api/brain/spaces/${s}/entities`, { name: `vh-marker-${s}`, type: 'thing' });
      assert.equal(a.status, 201, `seeding ${s}: ${fmt(a)}`);
      markers[s] = a.body._id;
    }
  });
  after(async () => { await d?.close(); });

  it('a peer-bound token that owns a view is refused 403 peer_door on the direct read and on every door that reads the view, and reads no member', async () => {
    const rungs = d.row({ knowledge: 'read' });
    const peer = await d.mint('vh-peer', { [QA]: rungs, [HELD]: rungs }, { peerInstanceId: PEER });
    const local = await d.mint('vh-local', { [QA]: rungs, [HELD]: rungs });
    // A peer-bound token cannot create a view; one can still own one (a copy given to it, a config written by hand).
    d.loader.mutateConfig(cfg => {
      cfg.views = [...(cfg.views ?? []),
        { id: '@guarded', name: 'guarded', ownerId: `token:${peer.id}`, members: [QA, HELD], createdAt: new Date().toISOString() },
        { id: '@unguarded', name: 'unguarded', ownerId: `token:${local.id}`, members: [QA, HELD], createdAt: new Date().toISOString() }];
      cfg.pendingSpaceActs = [{ id: 'vh-act', kind: 'wipe', localId: HELD, rounds: [], postSteps: {}, registeredAt: new Date().toISOString(), state: 'registered', attempts: 0 }];
    });
    const refusedAsPeer = (a) => a.status === 403 && a.body?.code === 'peer_door';
    try {
      const direct = await d.rest(peer.key, 'GET', `/api/brain/spaces/${HELD}/stats`);
      assert.ok(refusedAsPeer(direct), `the direct read of the held member by a peer-bound token: ${fmt(direct)}`);
      const filter = { space: '@guarded', collection: 'entities', filter: {} };
      const toolDoor = await d.rest(peer.key, 'POST', '/api/filter', filter);
      assert.ok(refusedAsPeer(toolDoor), `toolDoor: a peer-bound token was not refused as a peer: ${fmt(toolDoor)}`);
      assert.deepEqual(rowsOf(toolDoor), [], 'toolDoor: a record was read through the view');
      const mcp = await d.rpc(peer.key, 'tools/call', { name: 'filter', arguments: filter });
      assert.ok(mcp.status === 403 && mcp.messages[0]?.code === 'peer_door', `mcp: a peer-bound token was not refused as a peer: ${mcp.status} ${JSON.stringify(mcp.messages[0] ?? {}).slice(0, 200)}`);
      const p = await d.rest(peer.key, 'GET', '/api/brain/spaces/%40guarded/stats');
      assert.ok(refusedAsPeer(p), `path: a peer-bound token was not refused as a peer: ${fmt(p)}`);
      assert.equal(viewMembersOf(p), undefined, 'path: the view named members for a peer-bound token');
      // Control: a token not bound to a peer reads through a view of the same two members, so the refusal above is about the token kind.
      const control = await d.rest(local.key, 'POST', '/api/filter', { ...filter, space: '@unguarded' });
      assert.equal(control.status, 200, `control: a local token's read through its own view: ${fmt(control)}`);
      assert.ok(rowsOf(control).map(r => r._id).includes(markers[QA]), `control: the readable member's record was not read through the view: ${fmt(control)}`);
    } finally {
      d.loader.mutateConfig(cfg => { delete cfg.pendingSpaceActs; });
    }
  });

  it('every route that names a space and has no ROUTE_RIGHTS row refuses its owner\'s view, even an instance admin\'s', async () => {
    const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
    const priced = new Set(ROUTE_RIGHTS.map(r => `${r.method} ${r.route}`));
    const routes = mountedRoutes().filter(r => (/:spaceId\b/.test(r.path) || /^\/api\/spaces\/:id\b/.test(r.path)) && !priced.has(`${r.method} ${r.path}`));
    assert.ok(routes.length >= 8, `derived ${routes.length} route(s) naming a space with no rights row: the derivation is broken`);
    const owner = admin;
    const created = await d.rest(owner.key, 'POST', '/api/views', { name: 'arealess', members: [QA] });
    assert.equal(created.status, 201, `POST /api/views answered ${fmt(created)}`);
    assert.equal(viewOf(created)?.id, '@arealess');
    const opened = [];
    for (const r of routes) {
      const url = r.path.replace(/:spaceId\b|^(\/api\/spaces\/):id\b/, (m, pre) => `${pre ?? ''}${encodeURIComponent('@arealess')}`).replace(/:\w+/g, 'x');
      const a = await d.rest(owner.key, r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      if (a.status < 300) opened.push(`${r.method} ${r.path}: ${fmt(a)}`);
    }
    assert.deepEqual(opened, [], 'doors with no rights area that served a view');
  });
});
