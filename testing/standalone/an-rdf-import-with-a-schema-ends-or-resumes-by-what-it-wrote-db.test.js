/**
 * An RDF import with a schema ends or resumes by what its act has written, never by a file or a state it no longer needs (bundle-270, Q-955 fix
 * round: findings F1, F2, F3, S1 and S3).
 *
 * ## What it holds
 *
 * - F1: an import of a file whose classes the space already holds writes no schema; a space that took the same `rdf.base` before the act's
 *   first read ends the act `409 rdf_base_shared` with no act standing (not retried for ever as one that "already wrote its schema").
 * - F2: an act resumed in `committing` with its schema step's file gone finishes (the schema was written, the step is not used again): `ok`,
 *   both records.
 * - F3: `ex:alice a owl:NamedIndividual, ex:Person` is a record of an import with `schema`, as it is of one without.
 * - S1: the networked refusal of the act's write carries the proposal's own mode, sources and counts, not the defaults.
 * - S3: a stored schema that is not the one the write was judged by, seen after an applied write, leaves the act owed (the schema is written;
 *   ending it would leave the schema with no data), never ended for good.
 *
 * Run: node --test testing/standalone/an-rdf-import-with-a-schema-ends-or-resumes-by-what-it-wrote-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith, baseOf, fileOf, schemaFile, BUILT_PERSON } from './_rdf-import-schema-doors.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const SHARED = 'rdfisfshared';
const OTHER = 'rdfisfother';
const GONE = 'rdfisfgone';
const INDIVIDUAL = 'rdfisfindiv';
const NETTED = 'rdfisfnetted';
const MISMATCH = 'rdfisfmismatch';
const IDS = [SHARED, OTHER, GONE, INDIVIDUAL, NETTED, MISMATCH];
const STORED = { entity: { Person: BUILT_PERSON } };

/** A file of classes only (nothing a shape states), and one person of the class: what `from: [declared]` reads whole. */
const DECLARED_ONLY = [
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .', '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .', '@prefix ex: <http://shapes.example/> .',
  'ex:onto a owl:Ontology .', 'ex:Person a owl:Class .', '<http://people.example/bob> a ex:Person ; rdfs:label "Bob" .', '',
].join('\n');

/** The schema, the data and a named individual of the data's class. */
const withIndividual = () => `${fileOf()}\n<http://people.example/carol> a owl:NamedIndividual, ex:Person ; rdfs:label "Carol" .\n`;

describe('an RDF import with a schema ends or resumes by what its act has written (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner;
  before(async () => {
    d = await openRdfImportSchemaDoors({
      suite: 'rdf_import_schema_ends',
      spaces: [
        spaceWith(SHARED, STORED, STRICT), spaceWith(OTHER, undefined, STRICT), spaceWith(GONE, undefined, STRICT),
        spaceWith(INDIVIDUAL, undefined), spaceWith(NETTED, undefined), spaceWith(MISMATCH, undefined, STRICT),
      ],
    });
    writer = await d.mint('rdf-import-schema-ends-writer', Object.fromEntries(IDS.map(id => [id, d.row({ knowledge: 'write', schema: 'write' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  async function withKnobs(k, fn) {
    act.setRdfImportKnobsForTest(k);
    try { return await fn(); } finally { act.setRdfImportKnobsForTest(null); }
  }
  const bumpMeta = (id, change) => d.loader.mutateConfig(cfg => {
    const s = cfg.spaces.find(x => x.id === id);
    s.meta = change(structuredClone(s.meta));
  });

  it('F1: a no-change schema import whose space meets a shared base ends 409 rdf_base_shared with no act standing', async () => {
    const v = d.versionOf(SHARED);
    const r = await withKnobs({ hooks: { afterRegister: () => bumpMeta(OTHER, m => ({ ...m, rdf: { ...m.rdf, base: baseOf(SHARED), vocab: `${baseOf(SHARED)}vocab/` } })) } },
      () => d.importRestOne(writer.key, SHARED, schemaFile(), { schema: 'expand' }));
    assert.equal(r.status, 409, r.text.slice(0, 400));
    assert.equal(r.code, 'rdf_base_shared', r.text.slice(0, 400));
    assert.deepEqual(d.actsOf(SHARED), [], 'the act still holds the space');
    assert.equal(d.versionOf(SHARED), v, 'a no-change import wrote a schema');
  });

  it('F2: an act resumed in committing with its schema step file gone finishes and writes both records', async () => {
    let failures = 0;
    await withKnobs({ window: 1, hooks: { afterCommitWindow: () => { if (failures === 0) { failures += 1; throw new Error('planted: the first window\'s end fails'); } } } },
      () => d.importRestOne(writer.key, GONE, fileOf(), { schema: 'expand' }));
    assert.equal(failures, 1);
    const [entry] = d.actsOf(GONE);
    assert.ok(entry, 'the act is owed');
    const step = path.join(d.loader.getDataRoot(), act.RDF_IMPORT_DIR ?? 'rdf-import', entry.spoolId, 'schema.spool');
    assert.ok(fs.existsSync(step), `the premise: the act keeps its schema step in ${step}`);
    fs.rmSync(step);
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the resumed act completes: ${settled.error}`);
    assert.deepEqual((await d.records(GONE, 'entities')).map(p => p.name).sort(), ['Alice', 'Bob']);
  });

  it('F3: a subject typed owl:NamedIndividual and the data class is a record of an import with schema', async () => {
    const r = await d.importRestOne(writer.key, INDIVIDUAL, withIndividual(), { schema: 'expand' });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.deepEqual((await d.records(INDIVIDUAL, 'entities')).map(p => p.name).sort(), ['Alice', 'Bob', 'Carol']);
  });

  it('S1: the networked refusal of the act\'s write carries the proposal\'s mode, sources and counts', async () => {
    const r = await withKnobs({ hooks: { beforeSchemaWrite: () => d.joinNetwork('rdfisfnet', NETTED) } },
      () => d.importRestOne(writer.key, NETTED, DECLARED_ONLY, { schema: 'generate', from: ['declared'] }));
    assert.equal(r.status, 409, r.text.slice(0, 400));
    assert.equal(r.code, 'schema_rdf_networked', r.text.slice(0, 400));
    const proposed = r.body?.proposed;
    assert.ok(proposed, `the refusal carries the proposal: ${r.text.slice(0, 400)}`);
    assert.equal(proposed.mode, 'generate', 'the proposal\'s mode');
    assert.deepEqual(proposed.from, ['declared'], 'the proposal\'s sources');
    assert.ok(proposed.counts?.statements > 0, `the proposal's statements are counted: ${JSON.stringify(proposed.counts)}`);
    assert.ok(proposed.counts?.changes >= 1, `the proposal's changes are counted: ${JSON.stringify(proposed.counts)}`);
  });

  it('S3: a stored schema other than the one the write was judged by, after an applied write, leaves the act owed', async () => {
    let moved = 0;
    await withKnobs({ hooks: { afterSchemaWrite: () => {
      if (moved === 0) { moved += 1; bumpMeta(MISMATCH, m => ({ ...m, version: (m.version ?? 0) + 1, typeSchemas: { ...m.typeSchemas, entity: { ...m.typeSchemas?.entity, other: {} } } })); }
    } } }, () => d.importRestOne(writer.key, MISMATCH, fileOf(), { schema: 'expand' }));
    assert.equal(moved, 1, 'the stored schema moved after the write');
    const [entry] = d.actsOf(MISMATCH);
    assert.ok(entry, 'the act is owed: the schema is written, so ending it would leave the schema with no data');
    await runner.runSpaceAct(entry.id).catch(() => undefined);
  });
});
