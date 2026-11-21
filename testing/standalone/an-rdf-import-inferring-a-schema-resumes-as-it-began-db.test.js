/**
 * An RDF import that infers its schema from its data resumes exactly as it began: the act's schema step file carries what the door inferred,
 * and a resumed act recomputes none of it (bundle-270, Q-755, tests 10, 19, 29 and 32 of its plan).
 *
 * ## What it holds
 *
 * - 10: an act that failed during its translation and is resumed skips the same label groups and leaves out the same predicates as a dry run
 *   of the same file: the same records, the same `notTaken` counts.
 * - 19: the resumed act infers nothing again: with the inference's predicate bound lowered under the file's width, it still completes as the
 *   door planned it.
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
const IDS = [DRY, RESUMED];

/** A labelled class, a column of numbers, and a multi-valued predicate the inference leaves out. */
const FILE = ttl(
  'ex:P1 rdfs:label "Human" .',
  people(3, { cls: 'ex:P1', extra: (i) => (i === 0 ? `ex:age "${i}"^^xsd:decimal ; ex:nick "a", "b"` : `ex:age "${i}"^^xsd:decimal ; ex:nick "n${i}"`) }),
);
const DATA = { schema: 'generate', from: ['data'] };

describe('an RDF import inferring a schema resumes as it began (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner, files, spool;
  before(async () => {
    d = await openRdfImportSchemaDoors({ suite: 'rdf_import_infer_resume', spaces: IDS.map(s => spaceWith(s, undefined, STRICT)) });
    writer = await d.mint('rdf-import-infer-resume-writer', Object.fromEntries(IDS.map(s => [s, d.row({ knowledge: 'write', schema: 'write' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    files = await import('../../server/dist/spaces/rdf-import-files.js');
    spool = await import('../../server/dist/rdf/import-spool.js');
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

    // 19: the act infers nothing again: a bound under the file's width would refuse a recomputation.
    act.setRdfImportKnobsForTest({ schemaInferMaxPredicates: 1 });
    let settled;
    try { settled = await runner.runSpaceAct(entry.id); } finally { act.setRdfImportKnobsForTest(null); }
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
});
