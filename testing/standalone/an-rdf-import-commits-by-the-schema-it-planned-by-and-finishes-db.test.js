/**
 * The RDF import commits against the schema it was planned by, and once its first window landed nothing ends it but finishing (bundle-270, second
 * review F2 and F4, and the cases the review found missing: a commit that fails in the middle of a window, and every end of the act).
 *
 * ## What it holds
 *
 * - F2: the space's schema gains a required property after the dry plan and before the second window commits (a network's layer is stored
 *   while an import stands). The act, run again after its first window's end failed, completes: every record carries the stamp of the schema it
 *   was planned by, and a normal write afterwards is judged by the schema stored now.
 * - F4: after the first window landed, the act is run again while the space's RDF state would refuse (RDF switched off meanwhile): it finishes.
 * - A commit that fails inside a window (one plan of it does not land, the others do), run again, leaves every record once: none twice, none
 *   missing.
 * - Every end of the act, of whatever kind (completed, planner refusal, a translation's refusal, the space no longer able to hold the import),
 *   leaves the space taking local writes and its folder gone.
 *
 * Run: node --test testing/standalone/an-rdf-import-commits-by-the-schema-it-planned-by-and-finishes-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, goodTurtle, badTurtle, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const until = (what, fn, ms = 30_000) => waitFor(fn, ms, 50, undefined, { what });
const SCHEMA = 'rdfimpf2';
const OFF = 'rdfimpf4';
const MIDDLE = 'rdfimpmid';
const ENDS = ['rdfimpend1', 'rdfimpend2', 'rdfimpend3', 'rdfimpend4'];
const SPACES = [SCHEMA, OFF, MIDDLE, ...ENDS];

describe('the RDF import commits by the schema it planned by and finishes (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner, stamp;
  const replaceMeta = (space, change) => d.loader.mutateConfig(cfg => {
    const s = cfg.spaces.find(x => x.id === space);
    s.meta = change(structuredClone(s.meta));
  });
  const spaceOf = (space) => d.loader.getConfig().spaces.find(s => s.id === space);
  const folderOf = (entry) => path.join(d.loader.getDataRoot(), act.RDF_IMPORT_DIR, entry.spoolId);

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_finish', spaces: SPACES.map(id => ({ id, meta: personMeta(id, id === OFF || id === MIDDLE ? 'warn' : 'strict') })) });
    writer = await d.mint('rdf-import-finish-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    stamp = await import('../../server/dist/spaces/schema-stamp.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); runner?.setSpaceActKnobsForTest?.(null); await d?.close(); });

  /** Run the import with its first window's end failing once (`atFailure` runs first), and the owed act run again. */
  async function failOnceThenRerun(space, atFailure) {
    let failures = 0;
    act.setRdfImportKnobsForTest({
      window: 1,
      hooks: { afterCommitWindow: () => { if (failures === 0) { failures += 1; atFailure(); throw new Error('planted: the first window\'s end fails'); } } },
    });
    try {
      await d.importRest(writer.key, space, goodTurtle(space));
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(failures, 1, 'the first window\'s end failed once');
    const [entry] = d.actsOf(space);
    assert.ok(entry, 'the act is owed');
    const landed = await d.records(space, 'entities');
    assert.ok(landed.length >= 1, 'the first window landed before the failure');
    return { entry, settled: await runner.runSpaceAct(entry.id), landed };
  }

  it('F2: a schema stored while the import stands does not break it; the records carry the schema they were planned by', async () => {
    let plannedBy;
    const { entry, settled, landed } = await failOnceThenRerun(SCHEMA, () => {
      plannedBy = stamp.schemaFingerprintOf(spaceOf(SCHEMA));
      // What a network layer's arrival does to the space's effective schema: a required property no record of the file states.
      replaceMeta(SCHEMA, meta => {
        meta.typeSchemas.entity.person.propertySchemas.nick = { type: 'string', required: true };
        return meta;
      });
    });
    assert.equal(settled.ok, true, `the act completes: ${settled.error}`);
    assert.notEqual(stamp.schemaFingerprintOf(spaceOf(SCHEMA)), plannedBy, 'the stored schema changed under the act');
    const people = await d.records(SCHEMA, 'entities');
    assert.deepEqual(people.map(p => p.name).sort(), ['Alice', 'Bob']);
    for (const p of people) assert.equal(p[stamp.SCHEMA_FINGERPRINT_FIELD], plannedBy, `${p.name} carries the stamp of the schema it was planned by`);
    for (const first of landed) assert.ok(people.some(p => p._id === first._id), 'a record of the first window keeps its id');
    assert.equal((await d.records(SCHEMA, 'edges')).length, 1);
    assert.deepEqual(d.actsOf(SCHEMA), []);
    const folder = folderOf(entry);
    await until('its folder to be removed', () => !fs.existsSync(folder), 10_000);
    const write = await d.rest(writer.key, 'POST', `/api/brain/spaces/${SCHEMA}/entities`, { name: 'Carol', type: 'person' });
    assert.ok(write.status >= 400 && write.status < 500, `a normal write is judged by the schema stored now: ${write.status} ${write.text?.slice(0, 200)}`);
  });

  it('F4: the act, run again after its first window landed, finishes though the space\'s RDF state would now refuse', async () => {
    const { entry, settled } = await failOnceThenRerun(OFF, () => {
      replaceMeta(OFF, meta => { meta.rdf.enabled = false; return meta; });
    });
    assert.equal(settled.ok, true, `the act finishes whatever the RDF state: ${settled.error}`);
    assert.deepEqual((await d.records(OFF, 'entities')).map(p => p.name).sort(), ['Alice', 'Bob'], 'the whole import landed, not half');
    assert.equal((await d.records(OFF, 'edges')).length, 1);
    assert.deepEqual(d.actsOf(OFF), []);
    await until('its folder to be removed', () => !fs.existsSync(folderOf(entry)), 10_000);
  });

  it('a commit that fails in the middle of a window, run again, stores every record once', async () => {
    // Stored: Alice converges (the file names her under this space's address). The plan of the others is built; then Alice's row moves, so her
    // plan does not land while the plans around her do (the window is committed plan by plan).
    const at = (id) => `${baseOf(MIDDLE)}entity/${id}`;
    const ALICE = '33333333-3333-4333-8333-333333333333';
    await d.seed(MIDDLE, 'entity', [{ _id: ALICE, spaceId: MIDDLE, name: 'Alice', type: 'person', seq: 1 }]);
    const v = `${baseOf(MIDDLE)}vocab/`;
    const label = '<http://www.w3.org/2000/01/rdf-schema#label>';
    const file = [
      // The file states a new name for Alice: a converge that changed nothing writes nothing (fix round 4, R3), so it would have no plan to fail.
      `<${at(ALICE)}> a <${v}entity/person> ; ${label} "Alice Liddell" .`,
      `<http://people.example/bob> a <${v}entity/person> ; ${label} "Bob" .`,
      `<http://people.example/carol> a <${v}entity/person> ; ${label} "Carol" .`,
      '',
    ].join('\n');
    let failures = 0;
    act.setRdfImportKnobsForTest({
      hooks: {
        beforeCommitPlans: async () => {
          if (failures > 0) return;
          failures += 1;
          await d.col(d.spaceCollection(MIDDLE, 'entities')).updateOne({ _id: ALICE }, { $inc: { seq: 5 } });
        },
      },
    });
    try {
      await d.importRest(writer.key, MIDDLE, file, { params: { sourceBase: baseOf(MIDDLE) } });
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(failures, 1, 'a plan of the window failed to land');
    const [entry] = d.actsOf(MIDDLE);
    assert.ok(entry, 'the act is owed');
    const settled = await runner.runSpaceAct(entry.id);
    assert.equal(settled.ok, true, settled.error);
    const names = (await d.records(MIDDLE, 'entities')).map(p => p.name).sort();
    assert.deepEqual(names, ['Alice Liddell', 'Bob', 'Carol'], 'every record once: none twice, none missing');
    assert.deepEqual(d.actsOf(MIDDLE), []);
  });

  it('every end of the act releases the space and removes its folder', async () => {
    const [completed, refusedByPlan, refusedByTranslation, spaceLost] = ENDS;
    const root = path.join(d.loader.getDataRoot(), act.RDF_IMPORT_DIR);
    const takesWrites = async (space) => {
      const save = await d.rest(writer.key, 'POST', `/api/brain/spaces/${space}/entities`, { name: `After ${space}`, type: 'person', properties: { age: 1 } });
      assert.ok(save.status < 300, `${space} takes writes again: ${save.status} ${save.text?.slice(0, 200)}`);
    };
    const folders = () => (fs.existsSync(root) ? fs.readdirSync(root) : []);
    await d.importRest(writer.key, completed, goodTurtle(completed));
    // A planner refuses a record the translation took (strict: a literal the schema refuses).
    const refusedPlan = await d.importRest(writer.key, refusedByPlan, badTurtle(refusedByPlan));
    assert.equal(refusedPlan.status, 409, refusedPlan.text.slice(0, 300));
    // A translation refuses (a subject that is a blank node, with blank nodes refused).
    const blank = `_:b <${baseOf(refusedByTranslation)}vocab/entity/person#age> "1" .\n`;
    const refusedTranslation = await d.importRest(writer.key, refusedByTranslation, blank);
    assert.ok(refusedTranslation.status === 409 || refusedTranslation.status === 200, refusedTranslation.text.slice(0, 300));
    // The space can no longer hold the import when the act starts.
    act.setRdfImportKnobsForTest({ hooks: { beforeRegister: () => { replaceMeta(spaceLost, meta => { meta.rdf.enabled = false; return meta; }); } } });
    try { await d.importRest(writer.key, spaceLost, goodTurtle(spaceLost)); } finally { act.setRdfImportKnobsForTest(null); }
    for (const space of ENDS) await until(`the act of ${space} to end`, () => d.actsOf(space).length === 0);
    await until(`every import folder to be removed (left: ${folders().join(' ')})`, () => folders().length === 0, 10_000);
    for (const space of [completed, refusedByPlan, refusedByTranslation]) await takesWrites(space);
    const lost = await d.rest(writer.key, 'POST', `/api/brain/spaces/${spaceLost}/entities`, { name: 'After the lost one', type: 'person', properties: { age: 1 } });
    assert.ok(lost.status < 300, `the space whose RDF state ended the import takes writes again: ${lost.status} ${lost.text?.slice(0, 200)}`);
  });
});
