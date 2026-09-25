/**
 * Every existing token shape maps to exactly what it grants today, and never more.
 *
 * ## Why this file is the one that matters
 *
 * The rest of the rights work can be wrong and fail loudly. This step cannot: a token that gains an area
 * nobody chose keeps working, reports success, and is indistinguishable from one configured that way on
 * purpose. There is no error, no log line and no counter — only access somebody has that nobody granted.
 *
 * So every shape a token can have is a case here, and the "never a superset" property is asserted twice: once
 * per shape against the expected mapping, and once as a PROPERTY across generated combinations, because a
 * fixture test can only speak about shapes somebody thought of.
 *
 * Run: node --test testing/standalone/rights-migration-never-widens.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let migrateToken, grantsMoreThan, AREAS, DATA;
before(async () => {
  ({ migrateToken, grantsMoreThan, AREAS } = await import('../../server/dist/auth/rights-migration.js'));
  // The legacy level maps onto the DATA areas. `networks` is its own rule (F-34): network routes were
  // instance-admin in the legacy model, so below `admin` a legacy token maps to `networks: none`.
  DATA = AREAS.filter(a => a !== 'networks');
});


describe('the shapes that exist today', () => {
  it('admin — every area at admin, as a FLOOR, plus the instance switch', () => {
    const r = migrateToken({ admin: true });
    assert.equal(r.instanceAdmin, true);
    assert.equal(r.createSpaces, true);
    assert.ok(r.floor, 'an admin token reaches spaces created tomorrow; only a floor preserves that');
    for (const a of AREAS) assert.equal(r.floor[a], 'admin');
    assert.deepEqual(r.perSpace, {});
  });

  it('read-only, unscoped — read everywhere, no instance switch', () => {
    const r = migrateToken({ readOnly: true });
    assert.equal(r.instanceAdmin, false);
    assert.equal(r.createSpaces, false, 'creating spaces was admin-only; a read-only token never had it');
    for (const a of DATA) assert.equal(r.floor[a], 'read');
    assert.equal(r.floor.networks, 'none', 'a legacy token below admin gains no network rights');
  });

  it('ordinary, unscoped — write everywhere', () => {
    const r = migrateToken({});
    assert.equal(r.instanceAdmin, false);
    // The migration derives TWO instance-level flags from the one `admin` boolean, and this is the half that
    // is easy to forget — in both directions.
    assert.equal(r.createSpaces, false, 'creating spaces was admin-only; an ordinary token never had it');
    for (const a of DATA) assert.equal(r.floor[a], 'write');
    assert.equal(r.floor.networks, 'none', 'a legacy token below admin gains no network rights');
  });

  it('space-scoped — rows, and NO floor', () => {
    const r = migrateToken({ spaces: ['qa', 'tasks'] });
    assert.equal(r.floor, null,
      'a scoped token could not reach spaces created later; a floor would hand it every future space');
    assert.deepEqual(Object.keys(r.perSpace).sort(), ['qa', 'tasks']);
    for (const a of DATA) assert.equal(r.perSpace['qa'][a], 'write');
    assert.equal(r.perSpace['qa'].networks, 'none', 'a legacy token below admin gains no network rights');
  });

  it('space-scoped AND read-only — rows at read', () => {
    const r = migrateToken({ readOnly: true, spaces: ['qa'] });
    assert.equal(r.floor, null);
    for (const a of DATA) assert.equal(r.perSpace['qa'][a], 'read');
    assert.equal(r.perSpace['qa'].networks, 'none', 'a legacy token below admin gains no network rights');
  });

  it('space-scoped AND admin — rows at admin, instance switch still on', () => {
    // Both halves are real: the token IS an instance admin, and its space reach was still a list.
    const r = migrateToken({ admin: true, spaces: ['qa'] });
    assert.equal(r.instanceAdmin, true);
    assert.equal(r.floor, null);
    for (const a of AREAS) assert.equal(r.perSpace['qa'][a], 'admin');
  });

  it('schemaLibrary — NOTHING, even though it carries readOnly', () => {
    // The trap. A schemaLibrary token is read-only and stores `spaces: []`. Reading `readOnly` first, or
    // treating an empty list as "unscoped", turns the narrowest token on the instance into the widest.
    const r = migrateToken({ schemaLibrary: true, readOnly: true, spaces: [] });
    assert.equal(r.floor, null, 'a schemaLibrary token would reach EVERY space on the instance');
    assert.deepEqual(r.perSpace, {});
    assert.equal(r.instanceAdmin, false);
  });

  it('an EMPTY spaces list is not the same as an absent one', () => {
    // `spaces: []` reaches nothing; `spaces` absent reaches everything. A length check collapses them.
    assert.equal(migrateToken({ spaces: [] }).floor, null);
    assert.deepEqual(migrateToken({ spaces: [] }).perSpace, {});
    assert.ok(migrateToken({}).floor, 'an absent list must still mean all spaces');
  });

  it('a peer token maps by its other fields, not by being a peer', () => {
    // `peerInstanceId` is a label on how the token is used, not a permission. It must not add or remove one.
    const withPeer = migrateToken({ peerInstanceId: 'i-1', spaces: ['fleet'] });
    const without = migrateToken({ spaces: ['fleet'] });
    assert.deepEqual(withPeer, without);
  });
});

describe('the property, across shapes nobody listed', () => {
  it('never grants more than the legacy token did', () => {
    // A fixture test can only speak about shapes somebody thought of. This walks the combinations.
    const bools = [undefined, true, false];
    const spaceSets = [undefined, [], ['a'], ['a', 'b']];
    let checked = 0;
    for (const admin of bools) {
      for (const readOnly of bools) {
        for (const schemaLibrary of bools) {
          for (const spaces of spaceSets) {
            const t = { admin, readOnly, schemaLibrary, spaces };
            const r = migrateToken(t);
            assert.equal(grantsMoreThan(t, r), false,
              `widened: ${JSON.stringify(t)} -> ${JSON.stringify(r)}`);
            checked++;
          }
        }
      }
    }
    // The count is asserted so a loop that silently stops iterating cannot pass as thoroughness.
    assert.equal(checked, 108, `expected 108 combinations, walked ${checked}`);
  });

  it('the widening detector actually detects widening', () => {
    // Mutation-check on the checker itself: a property test whose predicate always returns false proves
    // nothing, and would look identical to a clean run.
    const t = { spaces: ['a'] };
    assert.equal(grantsMoreThan(t, { instanceAdmin: true, createSpaces: false, floor: null, perSpace: {} }), true);
    assert.equal(grantsMoreThan(t, {
      instanceAdmin: false, createSpaces: false,
      floor: { knowledge: 'read', files: 'read', schema: 'read', dataQuality: 'read' }, perSpace: {},
    }), true, 'a floor where the token had a fixed list is a grant of every future space');
    assert.equal(grantsMoreThan(t, {
      instanceAdmin: false, createSpaces: false, floor: null,
      perSpace: { b: { knowledge: 'read', files: 'none', schema: 'none', dataQuality: 'none' } },
    }), true, 'a space the token never had');
    assert.equal(grantsMoreThan({ readOnly: true }, {
      instanceAdmin: false, createSpaces: false,
      floor: { knowledge: 'write', files: 'read', schema: 'read', dataQuality: 'read' }, perSpace: {},
    }), true, 'write from a read-only token');
  });
});
