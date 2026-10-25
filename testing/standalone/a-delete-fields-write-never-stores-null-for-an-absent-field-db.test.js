/**
 * A write that carries `deleteFields` never stores `null` for a field the record does not have (Q-624 design §12, test 15).
 *
 * ## What it prevents
 *
 * The four update writers (`updateEntityById`, `updateEdgeById`, `updateChrono`, `updateFact`) run `deleteFields` through
 * `setUnlessDeleted`, and call it with `requested = updates.x !== undefined || !!deleteFieldsPaths` for each of `description`,
 * `tags`, `properties` (and `weight` on an edge). A request that deletes `properties.region` and says nothing of `description` therefore
 * sets `description` to the record's current value, which for a record with no description is `undefined`, and the driver stores that
 * as `null`.
 *
 * The record then fails its own `Incoming*` schema (`description` is a string or absent, never null), so a peer refuses it on push and
 * keeps the older version, and since Q-624 the body hash of such a row is the raw one: it forks against an equal copy that holds no null.
 * The fix sits inside `brain/delete-fields.ts`: a requested value that is `undefined` is not set, so no caller can bring the null back.
 *
 * ## The rule, over the whole set it governs
 *
 * For every forking kind, a record with none of the optional fields is edited through its own writer with a `deleteFields` that names
 * something else. Afterwards:
 *
 *  1. no top-level key of the stored row holds `null`;
 *  2. the row, stripped of its local-only fields, passes its family's `Incoming*` schema, so it is pushable;
 *  3. pushed back to its own space it is `skipped`, not forked against itself.
 *
 * The kinds are derived from the replication registry, minus the two with no `deleteFields` writer (links, files), with a floor.
 *
 * Run: node --test testing/standalone/a-delete-fields-write-never-stores-null-for-an-absent-field-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { incomingSchemas } from '../_shared/incoming-sync-schemas.mjs';

const skip = await mongoSkipReason();
const S = 'q624nulls';

/**
 * Per kind: the writer's module and name, how to call it with a `deleteFields`, and the Incoming schema's name.
 * A fixture table of HOW to drive each writer; which kinds there are is derived below and checked against it.
 */
const WRITERS = {
  facts:    { module: 'brain/fact.js',     call: (m, id) => m.updateFact(S, id, {}, ['properties.nothing']),            schema: 'IncomingFactDoc' },
  entities: { module: 'brain/entities.js', call: (m, id) => m.updateEntityById(S, id, {}, ['properties.nothing']),       schema: 'IncomingEntityDoc' },
  edges:    { module: 'brain/edges.js',    call: (m, id) => m.updateEdgeById(S, id, {}, ['properties.nothing']),         schema: 'IncomingEdgeDoc' },
  chrono:   { module: 'brain/chrono.js',   call: (m, id) => m.updateChrono(S, id, {}, ['properties.nothing']),           schema: 'IncomingChronoDoc' },
};

describe('a deleteFields write never stores null for an absent field', { skip }, () => {
  let door; let families; let schemas; let stripLocalOnly;

  before(async () => {
    door = await openPushDoor({ suite: 'q624t3_nulls', spaces: [{ id: S, label: 'Nulls', folders: [], meta: {} }] });
    ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
    ({ stripLocalOnly } = await import('../../server/dist/sync/local-only-fields.js'));
    schemas = new Map(incomingSchemas(await import('../../server/dist/api/sync/_shared.js')));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the set is derived: every replicated family but links and files has a writer here, and the floor holds', () => {
    const kinds = families.map(f => f.payloadKey).filter(k => k !== 'links' && k !== 'filemeta');
    assert.ok(kinds.length >= 4, `only ${kinds.length} kind(s) derived from REPLICATED_FAMILIES: ${kinds}`);
    for (const k of kinds) assert.ok(WRITERS[k], `the family '${k}' has a deleteFields writer this test does not drive: add it`);
  });

  for (const [family, w] of Object.entries(WRITERS)) {
    it(`${family}: the stored row holds no null, is pushable, and is skipped when pushed back`, async () => {
      const row = { facts: build.fact, entities: build.entity, edges: build.edge, chrono: build.chrono }[family](S, 'r1', 5);
      // The smallest row: none of the optional fields the writers set from "the record's current value".
      for (const f of ['description', 'weight']) delete row[f];
      await door.coll(S, family).insertOne(row);

      const written = await w.call(await import(`../../server/dist/${w.module}`), 'r1');
      assert.ok(written, `${family}: the writer answered nothing for a stored record`);

      const stored = await door.coll(S, family).findOne({ _id: 'r1' });
      const nulls = Object.entries(stored).filter(([, v]) => v === null).map(([k]) => k);
      assert.deepEqual(nulls, [],
        `${family}: a write that deletes ${'properties.nothing'} stored null for ${nulls.join(', ')}, which the record never had: `
        + 'the row now fails its Incoming schema, so a peer refuses it on push');

      const schema = schemas.get(w.schema);
      assert.ok(schema, `no ${w.schema} found`);
      const arriving = stripLocalOnly({ ...stored });
      const parsed = schema.safeParse(arriving);
      assert.ok(parsed.success, `${family}: the stored row fails ${w.schema}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`))}`);

      const back = await door.push('/batch-upsert', { [family]: [arriving] }, { spaceId: S });
      assert.equal(back.code, 200, JSON.stringify(back.body));
      const forks = await door.coll(S, family).countDocuments({ forkOf: 'r1' });
      assert.equal(forks, 0, `${family}: the row forked against itself when pushed back to its own space`);
    });
  }
});
