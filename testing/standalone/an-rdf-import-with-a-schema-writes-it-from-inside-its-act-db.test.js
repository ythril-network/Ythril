/**
 * An RDF data import that asks for a schema writes it from inside its own act, once, and only when the data passed (bundle-270, Q-955, tests 6,
 * 7, 8, 11, 19 and 21 of its plan).
 *
 * ## What it holds
 *
 * - The import's own schema write passes the hold its act keeps, while a PATCH of the space during the act is refused 409 (6).
 * - A schema changed between the door and the act ends the act `rdf_import_space_changed` and writes neither the schema nor the data (7).
 * - An act resumed after its schema write, before `planned` was kept, or in `committing`, does not write the schema again (8, 21).
 * - A refused schema write mid-act (the space joined a network, a 412) ends the act with its code and writes no data (11).
 * - A token narrowed or revoked between the door and the write ends the act 403 and writes neither (19).
 * - A state written before the change (no schema step) resumes as today (21, pinning).
 *
 * Run: node --test testing/standalone/an-rdf-import-with-a-schema-writes-it-from-inside-its-act-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith, fileOf, dataFile } from './_rdf-import-schema-doors.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const HOLD = 'rdfisahold';
const MOVED = 'rdfisamoved';
const RESUME = 'rdfisaresume';
const COMMITTING = 'rdfisacommit';
const OLD = 'rdfisaold';
const JOINED = 'rdfisajoined';
const PRECOND = 'rdfisaprecond';
const NARROW = 'rdfisanarrow';
const REVOKED = 'rdfisarevoked';
const IDS = [HOLD, MOVED, RESUME, COMMITTING, OLD, JOINED, PRECOND, NARROW, REVOKED];

describe('an RDF import with a schema writes it from inside its act (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner, stamp;
  before(async () => {
    d = await openRdfImportSchemaDoors({ suite: 'rdf_import_schema_act', spaces: IDS.map(id => spaceWith(id, undefined, STRICT)) });
    writer = await d.mint('rdf-import-schema-act-writer', Object.fromEntries(IDS.map(id => [id, d.row({ knowledge: 'write', schema: 'write' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    stamp = await import('../../server/dist/spaces/schema-stamp.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  const spaceOf = (id) => d.loader.getConfig().spaces.find(s => s.id === id);
  const bumpMeta = (id, change) => d.loader.mutateConfig(cfg => {
    const s = cfg.spaces.find(x => x.id === id);
    s.meta = change(structuredClone(s.meta));
  });
  /** Run `fn` with the act's knobs set to `k`, then clear them. */
  async function withKnobs(k, fn) {
    act.setRdfImportKnobsForTest(k);
    try { return await fn(); } finally { act.setRdfImportKnobsForTest(null); }
  }
  /** The act ended with `status` and `code`, and neither the schema nor a record of the file was written. */
  async function endedWithNothing(r, id, status, code, what) {
    assert.equal(r.status, status, `${what}: ${r.text.slice(0, 400)}`);
    assert.equal(r.code, code, `${what}: ${r.text.slice(0, 400)}`);
    assert.equal(d.heldTypes(id).entity?.Person, undefined, `${what}: the schema was written`);
    assert.deepEqual(await d.records(id, 'entities'), [], `${what}: a record was written`);
    assert.deepEqual(d.actsOf(id), [], `${what}: the act still holds the space`);
  }

  it('6: the import\'s own schema write passes the hold while a PATCH during the act is refused 409', async () => {
    let patched;
    const r = await withKnobs({ hooks: { beforeSchemaWrite: async () => {
      patched = await d.rest(writer.key, 'PATCH', `/api/spaces/${HOLD}`, { meta: { typeSchemas: { entity: { other: {} } } }, typeSchemasMode: 'merge' });
    } } }, () => d.importRestOne(writer.key, HOLD, fileOf(), { schema: 'expand' }));
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.ok(patched, 'the hook ran inside the act');
    assert.equal(patched.status, 409, patched.text.slice(0, 300));
    assert.equal(patched.body?.code, 'space_being_rdf_imported');
    assert.ok(d.heldTypes(HOLD).entity?.Person, 'the import wrote its schema');
    assert.equal(d.heldTypes(HOLD).entity?.other, undefined, 'the PATCH wrote');
  });

  it('7: a schema changed between the door and the act ends the act rdf_import_space_changed and writes neither', async () => {
    const r = await withKnobs({ hooks: { afterRegister: () => bumpMeta(MOVED, m => ({ ...m, version: (m.version ?? 0) + 1, typeSchemas: { entity: { other: {} } } })) } },
      () => d.importRestOne(writer.key, MOVED, fileOf(), { schema: 'expand' }));
    await endedWithNothing(r, MOVED, 409, 'rdf_import_space_changed', 'a schema moved under the act');
  });

  it('8: an act resumed after its schema write, before planned was kept, does not write the schema again', async () => {
    let failures = 0;
    const v = d.versionOf(RESUME);
    await withKnobs({ hooks: { afterSchemaWrite: () => { if (failures === 0) { failures += 1; throw new Error('planted: the act fails after its schema write'); } } } },
      () => d.importRestOne(writer.key, RESUME, fileOf(), { schema: 'expand' }));
    assert.equal(failures, 1, 'the planted failure ran after the schema write');
    assert.equal(d.versionOf(RESUME), v + 1, 'the schema was written once');
    const [entry] = d.actsOf(RESUME);
    assert.ok(entry, 'the act is owed');
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the resumed act completes: ${settled.error}`);
    assert.equal(d.versionOf(RESUME), v + 1, 'the resumed act wrote the schema again');
    const fp = stamp.schemaFingerprintOf(spaceOf(RESUME));
    const people = await d.records(RESUME, 'entities');
    assert.deepEqual(people.map(p => p.name).sort(), ['Alice', 'Bob']);
    for (const p of people) assert.equal(p[stamp.SCHEMA_FINGERPRINT_FIELD], fp);
  });

  it('21: an act resumed in committing does not write the schema again', async () => {
    let failures = 0;
    const v = d.versionOf(COMMITTING);
    await withKnobs({ window: 1, hooks: { afterCommitWindow: () => { if (failures === 0) { failures += 1; throw new Error('planted: the first window\'s end fails'); } } } },
      () => d.importRestOne(writer.key, COMMITTING, fileOf(), { schema: 'expand' }));
    assert.equal(failures, 1);
    assert.equal(d.versionOf(COMMITTING), v + 1, 'the schema was written before the first window');
    const [entry] = d.actsOf(COMMITTING);
    assert.ok(entry, 'the act is owed');
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the resumed act completes: ${settled.error}`);
    assert.equal(d.versionOf(COMMITTING), v + 1, 'the resumed act wrote the schema again');
    assert.deepEqual((await d.records(COMMITTING, 'entities')).map(p => p.name).sort(), ['Alice', 'Bob']);
  });

  it('21: an import without schema (a state with no schema step) resumes as today (pinning)', async () => {
    bumpMeta(OLD, m => ({ ...m, typeSchemas: { entity: { Person: { iri: 'http://shapes.example/Person', propertySchemas: { age: { iri: 'http://shapes.example/age', type: 'number' } } } } } }));
    const v = d.versionOf(OLD);
    let failures = 0;
    await withKnobs({ window: 1, hooks: { afterCommitWindow: () => { if (failures === 0) { failures += 1; throw new Error('planted: the first window\'s end fails'); } } } },
      () => d.importRestOne(writer.key, OLD, dataFile()));
    assert.equal(failures, 1);
    const [entry] = d.actsOf(OLD);
    assert.ok(entry, 'the act is owed');
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the resumed act completes: ${settled.error}`);
    assert.equal(d.versionOf(OLD), v, 'an import without schema writes no schema');
    assert.ok((await d.records(OLD, 'entities')).some(p => p.name === 'Alice'));
  });

  it('11: the space joined to a network before the schema write ends the act schema_rdf_networked and writes no data', async () => {
    const r = await withKnobs({ hooks: { beforeSchemaWrite: () => d.joinNetwork('rdfisajoinednet', JOINED) } },
      () => d.importRestOne(writer.key, JOINED, fileOf(), { schema: 'expand' }));
    await endedWithNothing(r, JOINED, 409, 'schema_rdf_networked', 'joined mid-act');
    assert.equal(d.roundsOf('rdfisajoinednet'), 0, 'no round opened');
  });

  it('11: a schema version moved before the write (412) ends the act schema_rdf_changed and writes no data', async () => {
    const r = await withKnobs({ hooks: { beforeSchemaWrite: () => bumpMeta(PRECOND, m => ({ ...m, version: (m.version ?? 0) + 1 })) } },
      () => d.importRestOne(writer.key, PRECOND, fileOf(), { schema: 'expand' }));
    await endedWithNothing(r, PRECOND, 412, 'schema_rdf_changed', 'a version moved mid-act');
  });

  it('19: a token narrowed or revoked between the door and the write ends the act 403 and writes neither', async () => {
    const narrowed = await d.mint('rdf-import-schema-act-narrowed', { [NARROW]: d.row({ knowledge: 'write', schema: 'write' }) });
    const r = await withKnobs({ hooks: { beforeSchemaWrite: () => d.setRights(narrowed.id, rights => { rights.perSpace[NARROW] = d.row({ knowledge: 'write', schema: 'read' }); }) } },
      () => d.importRestOne(narrowed.key, NARROW, fileOf(), { schema: 'expand' }));
    await endedWithNothing(r, NARROW, 403, 'schema_rdf_rung', 'a narrowed token');
    const revoked = await d.mint('rdf-import-schema-act-revoked', { [REVOKED]: d.row({ knowledge: 'write', schema: 'write' }) });
    const r2 = await withKnobs({ hooks: { beforeSchemaWrite: () => d.tokens.revokeToken(revoked.id) } },
      () => d.importRestOne(revoked.key, REVOKED, fileOf(), { schema: 'expand' }));
    await endedWithNothing(r2, REVOKED, 403, 'schema_rdf_rung', 'a revoked token');
  });
});
