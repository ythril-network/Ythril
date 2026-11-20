/**
 * The RDF import reads the store only while it holds the space, and answers its caller before it has read any of it (bundle-270, second
 * review F1 and F7).
 *
 * ## What it holds
 *
 * - F1: a record changed, and another deleted, by a caller while the file is being translated (the translation copies a converged record's stored
 *   fields) is never lost to the import's older copy, and the deleted record is never brought back under a new id. Whatever the doors accepted
 *   stands after the import; whatever they refused stays as it was. Asserted for a change made while the translation reads the store, and for
 *   one made after the door has the file and before its act exists (where the translation, now the act's, sees it).
 * - F7: the door answers 202 with the `importId` while the act is held at its translation: the sort is the door's, nothing of the store is read
 *   before the answer. (The act is held by a seam, and the answer is awaited: no timer decides the assertion.)
 *
 * Run: node --test testing/standalone/an-rdf-import-reads-the-store-only-under-its-hold-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, baseOf } from './_rdf-import-doors.mjs';

const until = (what, fn, ms = 30_000) => waitFor(fn, ms, 50, undefined, { what });

const skip = await mongoSkipReason();
const MID = 'rdfimpf1mid';
const GAP = 'rdfimpf1gap';
const HOLD = 'rdfimpf7';
const SPACES = [MID, GAP, HOLD];
const RDFS_LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';
const KEPT = '11111111-1111-4111-8111-111111111111';
const LOST = '22222222-2222-4222-8222-222222222222';

describe('the RDF import reads the store only under its hold (real routes, real MongoDB)', { skip, timeout: 240_000 }, () => {
  let d, writer, act, runner;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_hold', spaces: SPACES.map(id => ({ id, meta: personMeta(id, 'warn') })) });
    writer = await d.mint('rdf-import-hold-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); runner?.setSpaceActKnobsForTest?.(null); await d?.close(); });

  const seed = async (space) => {
    // A space whose links are converted records (the boot conversion has run for it): a delete reads its connections.
    d.loader.mutateConfig(cfg => { cfg.spaces.find(s => s.id === space).completeLinkage = true; });
    await d.seed(space, 'entity', [
      { _id: KEPT, spaceId: space, seq: 1, name: 'Stored one', type: 'person', description: 'the first description', properties: { age: 1 } },
      { _id: LOST, spaceId: space, seq: 1, name: 'Stored two', type: 'person', description: 'the second description' },
    ]);
    const at = (id) => `${baseOf(space)}entity/${id}`;
    return [
      `<${at(KEPT)}> a <${baseOf(space)}vocab/entity/person> ; ${RDFS_LABEL} "Stored one" .`,
      `<${at(LOST)}> a <${baseOf(space)}vocab/entity/person> ; ${RDFS_LABEL} "Stored two" .`,
      '',
    ].join('\n');
  };

  /** A caller changes the first record and deletes the second, as a person would at the doors: the answers are kept. */
  const callerChanges = async (space) => {
    const patch = await d.rest(writer.key, 'PATCH', `/api/brain/spaces/${space}/entities/${KEPT}`, { description: 'changed by a caller' });
    const del = await d.rest(writer.key, 'DELETE', `/api/brain/spaces/${space}/entities/${LOST}`);
    return { patch: patch.status, del: del.status, said: `${patch.text?.slice(0, 160)} | ${del.text?.slice(0, 160)}` };
  };

  /** Whatever a door accepted stands, whatever it refused stays: no lost update, no record brought back. */
  async function assertNothingLostOrRevived(space, said) {
    const people = await d.records(space, 'entities');
    const kept = people.find(p => p._id === KEPT);
    assert.ok(kept, 'the first record is still there');
    assert.equal(kept.description, said.patch < 300 ? 'changed by a caller' : 'the first description',
      `the first record's description after the caller's PATCH (answered ${said.patch})`);
    if (said.del < 300) {
      // The file still states the record under this space's address: with the record gone it is a new record, as the file says it, with the
      // id the instance mints (never the old one, which only addresses) and none of the deleted record's content, which the file does not state.
      const again = people.filter(p => p.name === 'Stored two');
      assert.ok(again.length <= 1, `the deleted record is back at most once as the file's own: ${again.length}`);
      for (const p of again) {
        assert.notEqual(p._id, LOST, 'a supplied address never becomes the new record\'s identity');
        assert.equal(p.description, undefined, `the content of the record the caller deleted (answered ${said.del}) is not brought back from an older copy`);
      }
    } else {
      assert.ok(people.some(p => p._id === LOST), 'a delete the door refused left the record');
    }
  }

  it('F1: a change made while the file is translated is not lost, and a delete is not undone', async () => {
    const file = await seed(MID);
    let reads = 0;
    let said;
    act.setRdfImportKnobsForTest({
      window: 1,
      hooks: { duringTranslation: async () => { reads += 1; if (reads === 2) said = await callerChanges(MID); } },
    });
    try {
      const r = await d.importRest(writer.key, MID, file, { params: { sourceBase: baseOf(MID) } });
      assert.ok(r.status === 200 || r.status === 202, r.text.slice(0, 400));
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.ok(said, 'the seam ran after the translation read the store');
    await until('the import to end', () => d.actsOf(MID).length === 0);
    await assertNothingLostOrRevived(MID, said);
  });

  it('F1: a change made after the door has the file and before the act exists is the one the import converges onto', async () => {
    const file = await seed(GAP);
    let said;
    act.setRdfImportKnobsForTest({ hooks: { beforeRegister: async () => { said = await callerChanges(GAP); } } });
    try {
      const r = await d.importRest(writer.key, GAP, file, { params: { sourceBase: baseOf(GAP) } });
      assert.ok(r.status === 200 || r.status === 202, r.text.slice(0, 400));
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.ok(said, 'the seam ran between the door\'s sort and the act');
    assert.ok(said.patch < 300 && said.del < 300, `the space is not held yet, so the callers' writes are taken: ${JSON.stringify(said)}`.replace(/\\"/g, ''));
    await until('the import to end', () => d.actsOf(GAP).length === 0);
    await assertNothingLostOrRevived(GAP, said);
  });

  it('F7: the door answers 202 with the importId while the act is held at its translation', async () => {
    const file = await seed(HOLD);
    runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 300 });
    let release;
    const gate = new Promise(r => { release = r; });
    let releasedBySafety = false;
    const safety = setTimeout(() => { releasedBySafety = true; release(); }, 10_000);
    act.setRdfImportKnobsForTest({ hooks: { duringTranslation: () => gate } });
    try {
      const r = await d.importRest(writer.key, HOLD, file, { params: { sourceBase: baseOf(HOLD) } });
      assert.equal(releasedBySafety, false, 'the door answered before the act\'s translation was let go: it did not wait for it');
      assert.equal(r.status, 202, r.text.slice(0, 300));
      assert.ok(r.body?.importId, 'the answer carries the importId');
      const status = await d.statusRest(writer.key, HOLD, r.body.importId);
      assert.equal(status.body?.status, 'running', status.text.slice(0, 300));
    } finally {
      clearTimeout(safety);
      release();
      act.setRdfImportKnobsForTest(null);
      runner.setSpaceActKnobsForTest(null);
    }
    await until('the import to end', () => d.actsOf(HOLD).length === 0);
  });
});
