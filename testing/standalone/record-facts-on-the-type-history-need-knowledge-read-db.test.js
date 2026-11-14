/**
 * The record facts of a type's history (the older mark and the record-only names) need `knowledge: read` on the space or an
 * administrator; the definitions need only `schema: read` (Q-744, bundle-268 design r4 §4.1, §6 and §10 T13).
 *
 * ## The contract (written before the code)
 *
 * - `mayReadRecordFacts(rights, spaceId)` = instance administrator, or `knowledge: read` on the space (spaces/type-history.js).
 * - A `schema: read` caller without it gets `recordFacts: 'withheld'` on the `kind` and `kind` + `type` answers, no `older` on any row
 *   and no `declared: 'none'` row; layer rows stay, and the definitions, spans and origins are answered in full.
 * - With it (or as an administrator) the same reads carry `older` on every own row and the record-only names, and no `recordFacts`.
 *
 * ## Fixture
 *
 * Space RF: v1 declares A and Gone; v2 (current) changes A and drops Gone. Records A@v1, A@v2, Gone@v1: Gone is a record-only name.
 *
 * ## Seen red at 327b105e
 *
 * The `kind` form does not exist: REST answers the version list (no `types`), MCP refuses `kind`.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/record-facts-on-the-type-history-need-knowledge-read-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { recordOf, saveVersion } from './_schema-version-fixtures.mjs';
import { typeDoors, rowsByType } from './_type-history.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const RF = 'thfacts';
const META = { suppressEmbeddings: true };
const str = (p) => ({ propertySchemas: { [p]: { type: 'string' } } });

let d, doors, schemaOnly, both, admin, v1, v2;

describe('record facts on the type history need knowledge: read (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'thfacts', spaces: [RF] });
    doors = typeDoors(d);
    schemaOnly = await d.mint('thf-schema', { [RF]: d.row({ schema: 'read' }) });
    both = await d.mint('thf-both', { [RF]: d.row({ schema: 'read', knowledge: 'read' }) });
    admin = await d.mint('thf-admin', {}, { admin: true });
    v1 = await saveVersion(RF, { ...META, typeSchemas: { entity: { A: str('p'), Gone: str('g') } } });
    v2 = await saveVersion(RF, { ...META, typeSchemas: { entity: { A: str('q') } } });
    let i = 0;
    await d.door.coll(RF, 'entities').insertMany([
      recordOf('entities', RF, ++i, { type: 'A', fp: v1.fp }), recordOf('entities', RF, ++i, { type: 'A', fp: v2.fp }),
      recordOf('entities', RF, ++i, { type: 'Gone', fp: v1.fp }),
    ]);
    const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
    assert.deepEqual((await ensureTtlIndexes(RF)).failed, []);
  });
  after(async () => { await d?.close(); });

  for (const door of ['REST', 'MCP']) {
    describe(door, () => {
      it('schema: read alone: recordFacts withheld, no older, no record-only row', async () => {
        const r = await doors[door](schemaOnly.key, RF, { kind: 'entity' });
        assert.ok(!r.refused, r.text.slice(0, 300));
        assert.ok(Array.isArray(r.body.types), `no types: ${r.text.slice(0, 300)}`);
        assert.equal(r.body.recordFacts, 'withheld');
        const rows = rowsByType(r.body.types);
        assert.equal(rows.get('A')?.declared, 'own', 'the own type is not listed to a schema reader');
        assert.ok(r.body.types.every(t => !('older' in t)), 'a mark is answered without knowledge: read');
        assert.ok(r.body.types.every(t => t.declared !== 'none'), 'a record-only name is answered without knowledge: read');
      });

      it('schema: read alone still gets the definitions, spans and origins', async () => {
        const r = await doors[door](schemaOnly.key, RF, { kind: 'entity', type: 'A' });
        assert.ok(!r.refused, r.text.slice(0, 300));
        assert.equal(r.body.recordFacts, 'withheld');
        assert.deepEqual((r.body.definitions ?? []).map(x => x.rep).sort(), [v1.fp, v2.fp].sort(), 'the definitions are withheld too');
        assert.ok(r.body.definitions.every(x => x.origin && typeof x.origin.fetched === 'boolean'), 'origins are withheld');
      });

      for (const [who, key] of [['knowledge: read', () => both.key], ['an administrator', () => admin.key]]) {
        it(`${who}: older on every own row, the record-only name listed, nothing withheld`, async () => {
          const r = await doors[door](key(), RF, { kind: 'entity' });
          assert.ok(!r.refused, r.text.slice(0, 300));
          assert.equal(r.body.recordFacts, undefined, `record facts withheld from ${who}`);
          const rows = rowsByType(r.body.types ?? []);
          assert.equal(rows.get('A')?.older, true, 'A, carried at v1, is not marked');
          assert.equal(rows.get('Gone')?.declared, 'none', 'the record-only name Gone is not listed');
          assert.equal(rows.get('Gone')?.older, undefined, 'a record-only row carries a mark');
        });
      }
    });
  }
});
