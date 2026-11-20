/**
 * An import that stops after a window landed, before the window's state was written, counts and names what it left out once (bundle-270, fix
 * round 4, finding R5).
 *
 * ## The question
 *
 * A window whose records include one the store no longer lets be written (a stored record gone under the hold, `stored_record_gone`) lands, and
 * the process stops before `commitPass` writes the act's state (`committed`, the report). The resumed act plans that window again, leaves the
 * same record out again, and counts again. Are the report's counts and its reasons then what one uninterrupted run gives, each once and not
 * twice? Read: `commitPass` (the report is the state's own object, written at a window's end only; a stopped run's in-memory changes are never
 * written, and the resumed run reads the file), `commitWindow` (a record that landed is planned again as a converge onto its minted id).
 *
 * ## What this spec holds
 *
 * Two twin spaces, each with a stored record that expires after the dry plan: one imported without interruption, one stopped by the seam
 * between the window's commit and its state write (`hooks.afterCommitWindow` throwing, as a crash does) and run again. Both end `completed` with
 * the same counts per kind, the same reasons (a converge onto the gone record, an edge to it), the same records, each reason once. The expected
 * figures are written out below, so two reports that are equally wrong fail too.
 *
 * Run: node --test testing/standalone/an-rdf-import-stopped-after-a-window-with-left-out-records-counts-them-once-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const UNBROKEN = 'rdfcrashu';
const BROKEN = 'rdfcrashb';
const ALICE = '55555555-5555-4555-8555-555555555555';
const LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';

describe('an import stopped between a window\'s commit and its state write counts what it left out once (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner, reference;
  const fileFor = (space) => {
    const person = `${baseOf(space)}vocab/entity/person`;
    const knows = `${baseOf(space)}vocab/edge/knows`;
    return [
      `<${baseOf(space)}entity/${ALICE}> a <${person}> ; ${LABEL} "Alice" .`,
      `<http://people.example/bob> a <${person}> ; ${LABEL} "Bob" .`,
      `<http://people.example/carol> a <${person}> ; ${LABEL} "Carol" .`,
      `<http://people.example/bob> <${knows}> <${baseOf(space)}entity/${ALICE}> .`,
      `<http://people.example/bob> <${knows}> <http://people.example/carol> .`,
      '',
    ].join('\n');
  };
  const shapeOf = (report) => ({
    kinds: report.kinds,
    byCode: report.reasonsByCode,
    reasons: report.reasons.map(r => `${r.code}/${r.outcome}/${r.kind}`).sort(),
    status: report.status,
  });
  /** Seed the stored Alice and run the import with her expiring after the dry plan; `stopAfter`: the committed count after which the process stops once. */
  async function run(space, stopAfter) {
    await d.seed(space, 'entity', [{ _id: ALICE, spaceId: space, name: 'Alice', type: 'person', seq: 1 }]);
    let stops = 0;
    act.setRdfImportKnobsForTest({
      window: 1,
      hooks: {
        beforeCommit: async () => { await d.col(d.spaceCollection(space, 'entities')).deleteOne({ _id: ALICE }); },
        afterCommitWindow: (committed) => { if (stopAfter !== undefined && committed === stopAfter && stops === 0) { stops += 1; throw new Error('planted: the process stops after this window'); } },
      },
    });
    try {
      const r = await d.importRest(writer.key, space, fileFor(space), { params: { sourceBase: baseOf(space) } });
      if (stopAfter === undefined) return { r, stops };
      assert.equal(r.status, 202, `the stopped attempt stays owed: ${r.status} ${r.text.slice(0, 300)}`);
      assert.equal(stops, 1, 'the process was stopped once');
      const [entry] = d.actsOf(space);
      assert.ok(entry, 'the act is owed');
      const settled = await runner.runSpaceAct(entry.id);
      assert.equal(settled.ok, true, settled.error);
      let status;
      await waitFor(async () => { status = await d.statusRest(writer.key, space, r.body.importId); return status.body?.status === 'completed'; }, 30_000, 50, undefined, { what: 'the resumed import to complete' });
      return { r: status, stops };
    } finally { act.setRdfImportKnobsForTest(null); }
  }

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_crash', spaces: [UNBROKEN, BROKEN].map(id => ({ id, meta: personMeta(id, 'warn') })) });
    writer = await d.mint('rdf-import-crash-writer', Object.fromEntries([UNBROKEN, BROKEN].map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  it('one uninterrupted run: the converge onto the gone record and the edge to it are left out, once each', async () => {
    const { r } = await run(UNBROKEN, undefined);
    assert.equal(r.status, 200, r.text.slice(0, 400));
    const s = shapeOf(r.body);
    assert.equal(s.status, 'completed');
    assert.deepEqual(s.byCode, { stored_record_gone: 2 });
    assert.deepEqual(s.reasons, ['stored_record_gone/recorded/edge', 'stored_record_gone/recorded/entity']);
    assert.deepEqual(s.kinds.entity, { inserted: 2, converged: 0 });
    assert.deepEqual(s.kinds.edge, { inserted: 1, converged: 0 });
    reference = s;
    assert.deepEqual((await d.records(UNBROKEN, 'entities')).map(e => e.name).sort(), ['Bob', 'Carol']);
    assert.equal((await d.records(UNBROKEN, 'edges')).length, 1);
  });

  it('the same import stopped after the window that left a record out, and run again, reports what that run reports', async () => {
    assert.ok(reference, 'the uninterrupted run answered first');
    // The entity windows are Bob, Carol, then Alice (the one left out): the process stops after the third window landed.
    const { r } = await run(BROKEN, 3);
    assert.equal(r.status, 200, r.text.slice(0, 400));
    const s = shapeOf(r.body);
    assert.equal(s.status, 'completed');
    assert.deepEqual(s.byCode, { stored_record_gone: 2 }, 'each left-out record is named once, not twice');
    assert.deepEqual(s.reasons, ['stored_record_gone/recorded/edge', 'stored_record_gone/recorded/entity']);
    assert.deepEqual(s.kinds.entity, { inserted: 2, converged: 0 }, 'the counts are of what landed');
    assert.deepEqual(s.kinds.edge, { inserted: 1, converged: 0 });
    assert.deepEqual(s, reference, 'the counts and the reasons are what the uninterrupted run gave');
    assert.deepEqual((await d.records(BROKEN, 'entities')).map(e => e.name).sort(), ['Bob', 'Carol'], 'every record once');
    assert.equal((await d.records(BROKEN, 'edges')).length, 1);
    assert.deepEqual(d.actsOf(BROKEN), []);
  });
});
