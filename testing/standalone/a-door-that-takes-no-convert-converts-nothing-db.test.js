/**
 * A schema door that takes no `convertRecords` starts no conversion, and restarts a run that is unfinished toward the schema it leaves
 * (`Q-746`, bundle-284 design r5 sections 2.1 and 5.2, finding B2).
 *
 * ## What it prevents
 *
 * - **A conversion nobody asked for.** Only `PATCH /api/spaces/:id` and `schema_update` take `convertRecords`; every other door that writes a
 *   schema (the full `PUT`, the single-type `PUT` and `DELETE`, the library's group apply and an edit of a library entry a space references)
 *   "converts nothing until Convert" (O5). A run started by one of them would rewrite or stamp records nobody chose to touch.
 * - **A run stranded on a schema the space no longer has.** Such a door still moves the space's fingerprint. A run that is unfinished at that
 *   moment is restarted in place toward the new fingerprint (`restartSchemaConvertRun`), or the types it had not finished are converted toward
 *   a schema that is gone.
 *
 * ## What holds
 *
 * For each of the five doors, on a space in no network:
 * - with no run, the door answers and no run document exists afterwards;
 * - with an unfinished run (held by a sweeper's lease, so nothing else touches it), the run is rewritten in place toward the fingerprint the door
 *   left: its `toFp` is the new one and its generation moved by one.
 *
 * Run: node --test testing/standalone/a-door-that-takes-no-convert-converts-nothing-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const dir = tempInstanceDir('ythril-no-convert-doors-');
const skip = await mongoSkipReason();
const SPACE = 'people';
const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const string = { type: 'string' };
const AT = '2026-01-01T00:00:00.000Z';

const ENTRY = Object.freeze({
  name: 'person-shape', knowledgeType: 'entity', typeName: 'Crew', schemaGroup: 'crew',
  schema: { propertySchemas: { email: string } }, createdAt: AT, updatedAt: AT,
});
const META = Object.freeze({
  typeSchemas: { entity: { Person: { propertySchemas: { fullName: string } }, Member: { $ref: 'library:person-shape' } } },
});

describe('a door that takes no convertRecords converts nothing, and restarts an unfinished run', { skip }, () => {
  let inst, mongo, run, stamp, spaceCollection;
  let doors;
  before(async () => {
    mongo = await openTestMongo('no_convert_doors');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: SPACE, label: 'People', folders: [], meta: structuredClone(META) },
        { id: 'general', label: 'General', builtIn: true, folders: [] },
      ],
      library: [ENTRY],
    });
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    const { schemaLibraryRouter } = await import('../../server/dist/api/schema-library.js');
    run = await import('../../server/dist/spaces/schema-convert-run.js');
    stamp = await import('../../server/dist/spaces/schema-stamp.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    const route = (router, method, path, params, body) => callRoute(router, method, path, { params, body, authToken: AUTH });
    doors = {
      'PUT /api/spaces/:id/schema': () => route(spacesRouter, 'put', '/:id/schema', { id: SPACE },
        { typeSchemas: { ...META.typeSchemas, entity: { ...META.typeSchemas.entity, Person: { propertySchemas: { fullName: string, age: { type: 'number' } } } } } }),
      'PUT /api/spaces/:id/meta/typeSchemas/:kt/:name': () => route(spacesRouter, 'put', '/:id/meta/typeSchemas/:knowledgeType/:typeName',
        { id: SPACE, knowledgeType: 'entity', typeName: 'Person' }, { propertySchemas: { fullName: string, nick: string } }),
      'DELETE /api/spaces/:id/meta/typeSchemas/:kt/:name': () => route(spacesRouter, 'delete', '/:id/meta/typeSchemas/:knowledgeType/:typeName',
        { id: SPACE, knowledgeType: 'entity', typeName: 'Person' }, {}),
      'POST /api/schema-library/groups/:group/apply': () => route(schemaLibraryRouter, 'post', '/groups/:group/apply', { group: 'crew' }, { spaceId: SPACE }),
      'PATCH /api/schema-library/:name (an entry the space references)': () => route(schemaLibraryRouter, 'patch', '/:name', { name: ENTRY.name },
        { schema: { propertySchemas: { email: string, phone: string } } }),
    };
  });
  after(async () => { run?.stopSchemaConvertWatcher(); inst?.close(); await closeTestMongo(); });

  const runs = () => mongo.getDb().collection(spaceCollection(SPACE, 'schemaConvertRun'));
  const runDoc = () => runs().findOne({ _id: 'run' });
  const fp = () => stamp.readMetaForWrite(SPACE).stamp.fp;

  /** An unfinished run toward the fingerprint now, held by a live sweeper's lease far ahead, so no pass and no tick takes it here. */
  async function seedUnfinishedRun() {
    const doc = {
      _id: 'run', toFp: fp(), types: [{ kind: 'entity', type: 'Person', done: false }], steps: [], splitDeclared: {}, stepsRefused: [],
      sources: [{ kind: 'act', at: AT }], owed: false, syncedFirst: { asked: 0, answered: 0 }, startedAt: AT, cursor: null,
      counts: { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 }, state: 'running', failures: 0,
      sweepLeaseAt: Date.now() + 3_600_000, generation: 1,
    };
    await runs().insertOne(doc);
    return doc;
  }

  beforeEach(async () => {
    run.stopSchemaConvertWatcher();
    inst.reset();
    await runs().drop().catch(() => {});
  });

  for (const name of [
    'PUT /api/spaces/:id/schema',
    'PUT /api/spaces/:id/meta/typeSchemas/:kt/:name',
    'DELETE /api/spaces/:id/meta/typeSchemas/:kt/:name',
    'POST /api/schema-library/groups/:group/apply',
    'PATCH /api/schema-library/:name (an entry the space references)',
  ]) {
    it(`${name} starts no run`, async () => {
      const before = fp();
      const a = await doors[name]();
      assert.ok(a.code < 300, `the door refused the edit: ${a.code} ${JSON.stringify(a.body)}`);
      assert.notEqual(fp(), before, 'precondition: the door moved the fingerprint');
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await runDoc(), null, `${name} started a conversion run`);
    });

    it(`${name} restarts an unfinished run toward the schema it leaves`, async () => {
      const seeded = await seedUnfinishedRun();
      const a = await doors[name]();
      assert.ok(a.code < 300, `the door refused the edit: ${a.code} ${JSON.stringify(a.body)}`);
      const after = fp();
      assert.notEqual(after, seeded.toFp, 'precondition: the door moved the fingerprint');
      const doc = await waitForValue(async () => { const d = await runDoc(); return d && d.generation !== seeded.generation ? d : null; },
        3_000, 50, async () => `the run was left as it was: ${JSON.stringify(await runDoc())}`, { what: 'the unfinished run to be restarted' });
      assert.equal(doc.toFp, after, 'the run was restarted toward a fingerprint other than the one the door left');
      assert.equal(doc.generation, seeded.generation + 1);
      assert.equal(doc.state, 'running');
      assert.deepEqual(doc.types.map(t => `${t.kind}:${t.type}:${t.done}`), ['entity:Person:false']);
      assert.deepEqual(doc.sources.map(s => s.kind), ['act'], 'a door that takes no convert joined a source to the run');
    });
  }
});
