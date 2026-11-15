/**
 * A definition's origin is read where the definition began, not at the oldest version a record carries (bundle-268, Q-744 verify drive).
 *
 * ## The failure it pins
 *
 * A definition's members are only the versions records carry. A type declared, then another type changed in a later schema write, then a
 * record of the first type written: the record carries the later stamp, so the definition's oldest member is a version where only the
 * OTHER type changed. Comparing it with the own version just before it said the type did not differ (`edited: false`), and the dialog showed
 * no origin line under a definition whose help says "Under each date: where the definition came from".
 *
 * ## The rule
 *
 * From the oldest member X and the own version Y kept just before it, while Y exists, both own texts are held, the type does not differ
 * between Y and X, and no network layer changed the type between them, the origin is read one own version earlier. A text not held stops the
 * walk and answers `null` (never "Edited here" blind); a change of the type, or of a layer, at X itself stops it where it stands.
 *
 * ## Fixtures (one space each; entity A is the type asked about; keeping order by `at`)
 *
 * - MAIN: v1 A{p} (Jan), v2 A{p} + B{b1} (Feb), v3 A{p} + B{b2} (Mar), records of A at v3 only, current A{q} (records too).
 *   v3's definition began at v1: edited true (it was declared there). The current one: true.
 * - GONE: g1 (own text of its stamp is gone), g2 A{p} + B{b1}, g3 A{p} + B{b2}; records of A at g3. The walk steps g3 -> g2 and meets
 *   g1, whose text is gone: null, never true or false.
 * - LAYER: l1 A{p} + B{b1} over layer N at L1, l2 A{p} + B{b2} over N at L2, A differs between L1 and L2; records of A at l2. The walk
 *   must not pass l2: edited false (own texts alike for A), networks [N].
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-type-history-origin-is-read-where-the-definition-began-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { snapshotOf, snapshotRow, snapshotsOf, linksOf } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion } from './_schema-version-fixtures.mjs';
import { typeDoors, allPages } from './_type-history.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const MAIN = 'thbmain';
const GONE_SPACE = 'thbgone';
const LAYER = 'thblayer';
const NET = 'net-origin-walk';
const META = { suppressEmbeddings: true };
const GONE = 'e'.repeat(64);
const prop = (p) => ({ propertySchemas: { [p]: { type: 'string' } } });
const types = (a, b) => ({ entity: { A: prop(a), ...(b ? { B: prop(b) } : {}) } });

let d, doors, owner;
const fx = {};

/** Rows for `versions` (each `{ v, at, links? }`), then the current version saved the way a door does, then a record of A at each of `stamped` and at current. */
async function seed(space, versions, curTypes, stamped, extraRows = []) {
  await snapshotsOf(d.door.mongo, space).insertMany([
    ...extraRows,
    ...versions.map(({ v, at, links }) => snapshotRow({ fp: v.fp, text: v.text, origin: 'own', links: links ?? linksOf(v.fp), at })),
  ]);
  const cur = await saveVersion(space, { ...META, typeSchemas: curTypes });
  let i = 0;
  await d.door.coll(space, 'entities').insertMany([...stamped, cur].map(v => recordOf('entities', space, ++i, { type: 'A', fp: v.fp })));
  const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
  assert.deepEqual((await ensureTtlIndexes(space)).failed, [], 'the stamp index did not build');
  return cur;
}

describe('a definition\'s origin is read where it began (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'thbegan', spaces: [MAIN, GONE_SPACE, LAYER] });
    doors = typeDoors(d);
    owner = await d.mint('thb-owner', {
      [MAIN]: d.row({ schema: 'read', knowledge: 'read' }),
      [GONE_SPACE]: d.row({ schema: 'read', knowledge: 'read' }),
      [LAYER]: d.row({ schema: 'read', knowledge: 'read' }),
    });
    const of = (a, b) => snapshotOf({ typeSchemas: types(a, b) });

    const [v1, v2, v3] = [await of('p'), await of('p', 'b1'), await of('p', 'b2')];
    fx.main = { v3, cur: await seed(MAIN, [
      { v: v1, at: '2026-01-01T00:00:00.000Z' }, { v: v2, at: '2026-02-01T00:00:00.000Z' }, { v: v3, at: '2026-03-01T00:00:00.000Z' },
    ], types('q', 'b2'), [v3]) };

    const [g1, g2, g3] = [await of('p'), await of('p', 'b1'), await of('p', 'b2')];
    fx.gone = { g3, cur: await seed(GONE_SPACE, [
      { v: g1, at: '2026-01-01T00:00:00.000Z', links: linksOf(GONE) }, { v: g2, at: '2026-02-01T00:00:00.000Z' }, { v: g3, at: '2026-03-01T00:00:00.000Z' },
    ], types('q', 'b2'), [g3]) };

    const [l1, l2] = [await of('p', 'b1'), await of('p', 'b2')];
    const [L1, L2] = [await snapshotOf({ typeSchemas: types('x') }), await snapshotOf({ typeSchemas: types('y') })];
    fx.layer = { l2, cur: await seed(LAYER, [
      { v: l1, at: '2026-01-01T00:00:00.000Z', links: linksOf(l1.fp, [{ networkId: NET, fp: L1.fp }]) },
      { v: l2, at: '2026-02-01T00:00:00.000Z', links: linksOf(l2.fp, [{ networkId: NET, fp: L2.fp }]) },
    ], types('q', 'b2'), [l2], [
      snapshotRow({ fp: L1.fp, text: L1.text, origin: 'layer', networkId: NET, at: '2026-01-01T00:00:00.000Z' }),
      snapshotRow({ fp: L2.fp, text: L2.text, origin: 'layer', networkId: NET, at: '2026-02-01T00:00:00.000Z' }),
    ]) };
  });
  after(async () => { await d?.close(); });

  const definitions = async (door, space) => {
    const { rows } = await allPages(doors[door], owner.key, space, { kind: 'entity', type: 'A' }, 'definitions');
    return new Map(rows.map(r => [r.rep, r]));
  };

  for (const door of ['REST', 'MCP']) {
    it(`${door}: a definition whose records carry a stamp that only another type changed answers where the type began (edited here)`, async () => {
      const by = await definitions(door, MAIN);
      assert.equal(by.size, 2, 'the older definition and the current one are listed');
      assert.equal(by.get(fx.main.v3.fp).origin.edited, true, 'the older definition shows no origin: it was read at the version where only B changed');
      assert.deepEqual(by.get(fx.main.v3.fp).origin.networks, []);
      assert.equal(by.get(fx.main.cur.fp).origin.edited, true);
    });

    it(`${door}: the walk meets an own text that is gone and answers null, never edited here or not`, async () => {
      const by = await definitions(door, GONE_SPACE);
      assert.equal(by.get(fx.gone.g3.fp).origin.edited, null);
    });

    it(`${door}: the walk stops where a network layer changed the type`, async () => {
      const by = await definitions(door, LAYER);
      const o = by.get(fx.layer.l2.fp).origin;
      assert.equal(o.edited, false, 'the walk passed the version where the layer changed the type');
      assert.deepEqual(o.networks, [NET]);
    });
  }
});
