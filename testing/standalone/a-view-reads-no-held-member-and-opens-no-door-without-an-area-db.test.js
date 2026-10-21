/**
 * A view never reads a member held for the caller's peer, and a door that has no rights area refuses a view (Q-531, bundle-100, plan
 * rev 3.2 security vet S2 and S3).
 *
 * ## The rules
 *
 * 1. **The held-peer refusal applies per member.** `viewReadMembers` asks, for each member, what a direct read of that member asks:
 *    a member held for the PEER a token is bound to (an act owed on it, design v5 section 3.3) is not read through a view either.
 *    Here a peer-bound token owns a view of two members and one is held: the direct read of the held member answers 423
 *    `space_held` (control), and the read through the view returns the other member's marker, not the held member's, with
 *    `viewMembers` naming only the member read - on the REST path, the tool door and MCP. A view must not be a way round the hold.
 * 2. **A door with no area fails closed.** Every mounted route whose path names a space (`:spaceId`, or `:id` under `/api/spaces`)
 *    and that has no `ROUTE_RIGHTS` row (derived from the mounted routes, floor; today the `NOT_AREA_SCOPED` space routes: activity,
 *    token access, rename, delete, export, import, wipe) refuses the owner's own view id, and the owner here is an instance admin, so
 *    a refusal cannot come from a missing right: a view resolves to members PER AREA, so a door that names no area has no members to
 *    give it.
 *
 * ## Seen red at 18e8d598
 *
 * 1: the view is unknown, so the read through it answers `Space '@guarded' not found` and the readable member's marker is missing.
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

  it('a member held for the caller\'s peer is not read through the view, on any door', async () => {
    const peer = await d.mint('vh-peer', { [QA]: d.row({ knowledge: 'read' }), [HELD]: d.row({ knowledge: 'read' }) }, { peerInstanceId: PEER });
    // A peer-bound token cannot create a view; one can still own one (a copy given to it, a config written by hand).
    d.loader.mutateConfig(cfg => {
      cfg.views = [...(cfg.views ?? []), { id: '@guarded', name: 'guarded', ownerId: `token:${peer.id}`, members: [QA, HELD], createdAt: new Date().toISOString() }];
      cfg.pendingSpaceActs = [{ id: 'vh-act', kind: 'wipe', localId: HELD, rounds: [], postSteps: {}, registeredAt: new Date().toISOString(), state: 'registered', attempts: 0 }];
    });
    try {
      const direct = await d.rest(peer.key, 'GET', `/api/brain/spaces/${HELD}/stats`);
      assert.equal(direct.status, 423, `control: the direct read of the held member: ${fmt(direct)}`);
      const doors = {
        toolDoor: () => d.rest(peer.key, 'POST', '/api/filter', { space: '@guarded', collection: 'entities', filter: {} }),
        mcp: () => d.mcp(peer.key, 'filter', { space: '@guarded', collection: 'entities', filter: {} }),
      };
      for (const [name, call] of Object.entries(doors)) {
        const a = await call();
        const ids = rowsOf(a).map(r => r._id);
        assert.ok(!ids.includes(markers[HELD]), `${name}: the held member's record was read through the view`);
        assert.ok(ids.includes(markers[QA]), `${name}: the readable member's record was not read through the view: ${fmt(a)}`);
        assert.deepEqual(viewMembersOf(a), [QA], `${name}: viewMembers names other than the member read`);
      }
      const p = await d.rest(peer.key, 'GET', '/api/brain/spaces/%40guarded/stats');
      assert.equal(p.status, 200, `path: ${fmt(p)}`);
      assert.deepEqual(viewMembersOf(p), [QA], 'path: viewMembers names other than the member read');
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
