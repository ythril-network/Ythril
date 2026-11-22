/**
 * An RDF import that infers its schema from its data resumes exactly as it began: the act's schema step file carries what the door inferred,
 * and a resumed act recomputes none of it (bundle-270, Q-755, tests 10, 19, 29 and 32 of its plan).
 *
 * ## What it holds
 *
 * - 10: an act that failed during its translation and is resumed skips the same label groups and leaves out the same predicates as a dry run
 *   of the same file: the same records, the same `notTaken` counts.
 * - 19: the resumed act infers nothing again: it leaves out what its step file says, so a pair added to the step file's left-out pairs between
 *   the failure and the resume is left out too, which no new inference of the file would do.
 * - F1 (Q-755 fix round): a class the inference did not take, and the label group of it, are left out by the resumed act as by the dry run.
 * - 29: the step file holds no statement the file does not hold (no declaration the inference stands for).
 * - 32: the resumed act's report keeps `inferred` and the `source` of each change.
 *
 * Run: node --test testing/standalone/an-rdf-import-inferring-a-schema-resumes-as-it-began-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith } from './_rdf-import-schema-doors.mjs';
import { ttl, people, EX } from './_rdf-import-infer.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const DRY = 'rdfinfrdry';
const RESUMED = 'rdfinfrres';
const STEPPED = 'rdfinfrstep';
const LONELY_DRY = 'rdfinfrlonedry';
const LONELY_RESUMED = 'rdfinfrloneres';
const IDS = [DRY, RESUMED, STEPPED, LONELY_DRY, LONELY_RESUMED];
/** Two people of a class, and a class one subject has, with its label group. */
const LONELY_FILE = ttl(people(2), 'ex:Lonely rdfs:label "Rare" .', people(1, { cls: 'ex:Lonely', prefix: 'l' }));

/** A labelled class, a column of numbers, and a multi-valued predicate the inference leaves out. */
const FILE = ttl(
  'ex:P1 rdfs:label "Human" .',
  people(3, { cls: 'ex:P1', extra: (i) => (i === 0 ? `ex:age "${i}"^^xsd:decimal ; ex:nick "a", "b"` : `ex:age "${i}"^^xsd:decimal ; ex:nick "n${i}"`) }),
);
const DATA = { schema: 'generate', from: ['data'] };

describe('an RDF import inferring a schema resumes as it began (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner, files, spool, leaveOutKey;
  before(async () => {
    d = await openRdfImportSchemaDoors({ suite: 'rdf_import_infer_resume', spaces: IDS.map(s => spaceWith(s, undefined, STRICT)) });
    writer = await d.mint('rdf-import-infer-resume-writer', Object.fromEntries(IDS.map(s => [s, d.row({ knowledge: 'write', schema: 'write' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    files = await import('../../server/dist/spaces/rdf-import-files.js');
    spool = await import('../../server/dist/rdf/import-spool.js');
    ({ leaveOutKey } = await import('../../server/dist/rdf/quads-to-ops.js'));
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  it('10, 19, 29, 32: an act failed in its translation resumes with the door\'s inference, and its report keeps it', async () => {
    const dry = await d.importRestOne(writer.key, DRY, FILE, { ...DATA, dryRun: true });
    assert.equal(dry.status, 200, dry.text.slice(0, 400));
    const dryReport = dry.body;

    let failures = 0;
    act.setRdfImportKnobsForTest({ hooks: { duringTranslation: () => { if (failures === 0) { failures += 1; throw new Error('planted: the translation fails once'); } } } });
    try { await d.importRestOne(writer.key, RESUMED, FILE, DATA); } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(failures, 1, 'the premise: the translation failed once');
    const [entry] = d.actsOf(RESUMED);
    assert.ok(entry, 'the act is owed');

    // 29: the step file holds the inference and no declaration the file never held.
    const folder = await spool.openImportFolder(path.join(d.loader.getDataRoot(), files.RDF_IMPORT_DIR, entry.spoolId));
    const step = await files.readSchemaStep(folder);
    const text = JSON.stringify(step);
    assert.ok(step.inferred, `the step file carries the inference: ${text.slice(0, 300)}`);
    assert.ok(!/shacl#|owl#Class|owl#DatatypeProperty|rdf-schema#domain/.test(text), 'no synthetic statement is kept');

    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the resumed act completes: ${settled.error}`);

    // 10: the same records and the same statements left out as the dry run's.
    assert.equal((await d.records(RESUMED, 'entities')).length, 3);
    const status = await d.statusRest(writer.key, RESUMED, entry.spoolId);
    const report = status.body?.report ?? status.body;
    assert.deepEqual(report.notTaken, dryReport.notTaken, `the resumed act leaves out what the door planned: ${JSON.stringify(report.notTaken)}`);
    assert.equal(report.notTaken?.['not-inferred'], 4, JSON.stringify(report.notTaken));
    assert.deepEqual(Object.keys(d.heldTypes(RESUMED).entity?.Human?.propertySchemas ?? {}), ['age']);

    // 32: the report keeps the inference and each change's source.
    assert.ok((report.schema?.inferred?.types ?? []).some(t => t.iri === `${EX}P1`), JSON.stringify(report.schema));
    assert.ok((report.schema?.changes ?? []).length > 0 && report.schema.changes.every(c => c.source === 'data'), JSON.stringify(report.schema?.changes));
  });

  /** An import into `space` whose translation fails once: the act it leaves owed, and the folder of its step file. */
  async function failedOnce(space, file) {
    let failures = 0;
    act.setRdfImportKnobsForTest({ hooks: { duringTranslation: () => { if (failures === 0) { failures += 1; throw new Error('planted: the translation fails once'); } } } });
    try { await d.importRestOne(writer.key, space, file, DATA); } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(failures, 1, 'the premise: the translation failed once');
    const [entry] = d.actsOf(space);
    assert.ok(entry, 'the act is owed');
    const folder = await spool.openImportFolder(path.join(d.loader.getDataRoot(), files.RDF_IMPORT_DIR, entry.spoolId));
    return { entry, folder };
  }

  it('19: a resumed act leaves out what its step file says, so it infers nothing anew', async () => {
    const { entry, folder } = await failedOnce(STEPPED, FILE);
    const step = await files.readSchemaStep(folder);
    const age = leaveOutKey('entity', 'Human', `${EX}age`);
    assert.ok(!step.leaveOut.includes(age), 'the premise: the inference takes age');
    await files.writeSchemaStep(folder, { ...step, leaveOut: [...step.leaveOut, age] });
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the resumed act completes: ${settled.error}`);
    const status = await d.statusRest(writer.key, STEPPED, entry.spoolId);
    const report = status.body?.report ?? status.body;
    assert.equal(report.notTaken?.['not-inferred'], 7, `the four nick statements and the three ages: ${JSON.stringify(report.notTaken)}`);
  });

  it('F1: a class the inference did not take and its label group are left out by the resumed act as by the dry run', async () => {
    const dry = await d.importRestOne(writer.key, LONELY_DRY, LONELY_FILE, { ...DATA, dryRun: true });
    assert.equal(dry.status, 200, dry.text.slice(0, 400));
    const { entry, folder } = await failedOnce(LONELY_RESUMED, LONELY_FILE);
    const step = await files.readSchemaStep(folder);
    assert.ok(step.leaveOut.some(k => k.includes(`${EX}Lonely`)), `the step file keeps the class it left out: ${JSON.stringify(step.leaveOut)}`);
    assert.ok(step.skip.length > 0, `the step file keeps the label group it skips: ${JSON.stringify(step.skip)}`);
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, `the resumed act completes: ${settled.error}`);
    const status = await d.statusRest(writer.key, LONELY_RESUMED, entry.spoolId);
    const report = status.body?.report ?? status.body;
    assert.deepEqual(report.notTaken, dry.body.notTaken, `the resumed act leaves out what the door planned: ${JSON.stringify(report.notTaken)}`);
    assert.deepEqual((await d.records(LONELY_RESUMED, 'entities')).map(r => r.name).sort(), ['person 0', 'person 1']);
  });
});
