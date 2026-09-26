/**
 * An instance admin holds space admin on the FLOOR — stored on the token, covering every space including ones
 * created later — and a space admin holds every rung on the spaces it administers. Together: an instance admin
 * holds every right on the whole instance.
 *
 * Owner, 2026-09-26: *"instance admin inherits each and every right on the whole instance automatically"*,
 * *"instance admin does not IMPLY, it grants, it sets the rung"*, and *"as a floor so it covers new spaces as
 * well"*. That was the behaviour and had stopped holding (S-11). The grant is STORED: the one statement of it is
 * `withInstanceAdminGrants`, applied by every write of a token's rights, and a boot migration repairs instance
 * admins stored without it.
 *
 * Seen live on ythril-home: an instance-admin token with rows for one space got 403 on three spaces a network
 * had just created there, and could not widen itself because it read as a "space-restricted administrator".
 *
 * Run: node --test testing/standalone/instance-admin-holds-space-admin-floor.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let withInstanceAdminGrants, migrateInstanceAdminFloor, reachesSpace, effectiveRung, capRights, AREAS, SPACE_ADMIN_AREAS;
before(async () => {
  ({ withInstanceAdminGrants } = await import('../../server/dist/auth/instance-admin-grants.js'));
  ({ migrateInstanceAdminFloor } = await import('../../server/dist/config/migrate-instance-admin-floor.js'));
  ({ reachesSpace } = await import('../../server/dist/auth/space-reach.js'));
  ({ AREAS } = await import('../../server/dist/auth/rights-migration.js'));
  ({ effectiveRung, capRights } = await import('../../server/dist/auth/mint-cap.js'));
  ({ SPACE_ADMIN_AREAS } = await import('../../server/dist/config/rights-shape.js'));
});

const rows = (rung) => Object.fromEntries(AREAS.map(a => [a, rung]));
const instanceAdminWithOneRow = () => ({ instanceAdmin: true, createSpaces: false, floor: null, perSpace: { 'y-flows': rows('admin') } });

describe('granting instance admin sets the space-admin floor', () => {
  it('an instance admin comes back with spaceAdmin.floor true, and keeps its named spaces', () => {
    const r = withInstanceAdminGrants({ ...instanceAdminWithOneRow(), spaceAdmin: { floor: false, spaces: ['flows'] } });
    assert.equal(r.spaceAdmin?.floor, true, 'the floor is what covers spaces created after the grant');
    assert.deepEqual(r.spaceAdmin.spaces, ['flows']);
  });

  it('a token that is not an instance admin is left exactly as it was', () => {
    const before = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { qa: rows('read') } };
    assert.deepEqual(withInstanceAdminGrants(structuredClone(before)), before);
  });

  it('holds every rung on a space that did not exist when it was granted', () => {
    const r = withInstanceAdminGrants(instanceAdminWithOneRow());
    for (const a of AREAS.filter(x => x !== 'networks')) {
      assert.equal(effectiveRung(r, 'created-tomorrow', a), 'admin', `${a} on a new space`);
    }
    assert.equal(reachesSpace(r, 'created-tomorrow'), true);
  });
});

describe('instance admins stored without the floor are repaired on boot', () => {
  it('writes the floor onto every instance admin that lacks it and names each one', () => {
    const tokens = [
      { id: 'a', name: 'project-ythril', rights: instanceAdminWithOneRow() },
      { id: 'b', name: 'reader', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { qa: rows('read') } } },
    ];
    const out = migrateInstanceAdminFloor(tokens);
    assert.deepEqual(out.granted, ['a']);
    assert.equal(tokens[0].rights.spaceAdmin?.floor, true);
    assert.equal(tokens[1].rights.spaceAdmin, undefined, 'a non-admin token gains nothing');
  });

  it('is idempotent: a second run changes nothing', () => {
    const tokens = [{ id: 'a', name: 'x', rights: instanceAdminWithOneRow() }];
    migrateInstanceAdminFloor(tokens);
    assert.deepEqual(migrateInstanceAdminFloor(tokens).granted, []);
  });

  it('runs on boot', () => {
    const src = stripComments(readFileSync('server/src/index.ts', 'utf8'));
    assert.match(src, /migrate-instance-admin-floor\.js/, 'the migration exists but nothing calls it');
  });
});

describe('a space admin reaches the spaces it administers', () => {
  // reachesSpace read only perSpace and floor, so a space admin with no area rows reached nothing, and every
  // check built on it (listings, MCP spaces, sync, proxies) refused its own space.
  it('by the floor, with no rows at all', () => {
    const r = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: true, spaces: [] } };
    assert.equal(reachesSpace(r, 'any-space'), true);
  });

  it('by name, with no row for it — and not beyond it', () => {
    const r = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces: ['qa'] } };
    assert.equal(reachesSpace(r, 'qa'), true);
    assert.equal(reachesSpace(r, 'other'), false);
  });
});

describe('a space-admin floor can delegate the floor rungs it resolves to', () => {
  // Seen on ythril-home after the owner set the floor: the token could not grant an area FLOOR — "floor.knowledge:
  // asked admin, you hold none" — because minting read the area floor alone and never the space-admin floor, while
  // enforcement already resolved that floor to admin in every space. Enforcement grants it, minting refused it.
  const floorAdmin = () => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: true, spaces: [] } });

  it('grants an admin floor in every area space admin covers', () => {
    const want = { instanceAdmin: false, createSpaces: false, floor: Object.fromEntries(SPACE_ADMIN_AREAS.map(a => [a, 'admin'])), perSpace: {} };
    assert.deepEqual(capRights(floorAdmin(), want), []);
  });

  it('and still not in an area space admin does not cover', () => {
    const outside = AREAS.filter(a => !SPACE_ADMIN_AREAS.includes(a));
    assert.ok(outside.length > 0, 'no area outside space admin to check — the rule below would assert nothing');
    const want = { instanceAdmin: false, createSpaces: false, floor: Object.fromEntries(AREAS.map(a => [a, outside.includes(a) ? 'read' : 'none'])), perSpace: {} };
    assert.deepEqual(capRights(floorAdmin(), want).map(e => e.area).sort(), [...outside].sort());
  });

  it('a space admin by NAME still cannot grant a floor', () => {
    const named = { ...floorAdmin(), spaceAdmin: { floor: false, spaces: ['qa'] } };
    const want = { instanceAdmin: false, createSpaces: false, floor: { ...rows('none'), knowledge: 'read' }, perSpace: {} };
    assert.equal(capRights(named, want).length, 1, 'one space administered is not every space');
  });
});
