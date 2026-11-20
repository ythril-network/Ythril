/**
 * Every link the file states lands, or the report names it (bundle-270, fix round 4, finding R1; Q-753 last line).
 *
 * ## The defect
 *
 * A space's export states each link row as `<from> dcterms:references <to>`. The import landed only the rows that start at a chrono entry: the
 * rows from a fact to an entity were lost, in every format, with the import completed and no reason named.
 *
 * ## The cause, found by reading
 *
 * The import wrote its windows kind by kind in `IMPORT_OP_ORDER`, which copied the planners' `COMMIT_ORDER`: facts, then entities. A fact's link
 * rows are reconciled straight after its stage (`commit.ts`, `afterStage`), and `takeBackLinksToGoneEntities` removes a row whose entity is not
 * stored: the entity of the same file had not been written yet. The outcome carried `linksTakenBack`, which `commitWindow` never read.
 * A chrono entry comes after both kinds, so its rows survived.
 *
 * ## What this spec holds
 *
 * - For every kind pair the store links (a fact to entities, a chrono entry to entities, a chrono entry to facts: the literal `PAIRS`), the rows
 *   the source holds come back, by the labels of their ends, in every format.
 * - A row the commit takes back (its entity went under the hold, after the window that wrote it was planned) is NAMED: a recorded reason
 *   `links_not_written` on the record that carried it. A link the file states never lands without a word, and is never lost without one.
 *
 * Run: node --test testing/standalone/an-rdf-import-lands-or-names-every-link-the-file-states-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, baseOf as importBaseOf } from './_rdf-import-doors.mjs';
import { sourceMeta, writeSource, snapshotOf, linkLabels, exportText, PAIRS, expected } from './_rdf-source-fixture.mjs';

const skip = await mongoSkipReason();
const SRC = 'rdflinksrc';
const FORMATS = ['turtle', 'trig', 'nquads', 'jsonld'];
const TARGETS = Object.fromEntries(FORMATS.map(f => [f, `rdflinkto${f}`]));
const GONE = 'rdflinkgone';
const SPACES = [SRC, ...Object.values(TARGETS), GONE];

describe('every link row the file states lands, or the report names it (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, source;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_links', spaces: SPACES.map(id => ({ id, meta: sourceMeta(id) })) });
    writer = await d.mint('rdf-import-links-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    await writeSource(d, writer.key, SRC);
    source = await snapshotOf(d, SRC);
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  it('the source holds the link rows of every kind pair the store links, as written', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v.length])), expected());
    for (const p of PAIRS) assert.equal(linkLabels(source, p.from, p.to).length, p.n, `${p.from} to ${p.to}: the rows the fixture wrote`);
  });

  for (const format of FORMATS) {
    it(`${format}: every link row of every kind pair comes back, and the report names no link as lost`, async () => {
      const target = TARGETS[format];
      const text = await exportText(d, writer.key, SRC, format);
      const r = await d.importRest(writer.key, target, text, { format, params: { sourceBase: importBaseOf(SRC) } });
      assert.equal(r.status, 200, r.text.slice(0, 500));
      assert.equal(r.body.status, 'completed');
      assert.equal(r.body.reasonCount, 0, JSON.stringify(r.body.reasons).slice(0, 400));
      const landed = await snapshotOf(d, target);
      for (const p of PAIRS) {
        const stated = linkLabels(source, p.from, p.to);
        const got = linkLabels(landed, p.from, p.to);
        const named = (r.body.reasonsByCode.links_not_written ?? 0);
        assert.equal(stated.length, p.n);
        assert.deepEqual(got, stated, `${format}, ${p.from} to ${p.to}: the rows that landed are the rows the file states (named in the report: ${named})`);
      }
    });
  }

  it('a row the commit takes back is named: the entity went under the hold after the window that wrote the link was planned', async () => {
    const v = `${importBaseOf(GONE)}vocab/`;
    const file = [
      `<http://people.example/eve> a <${v}entity/Person> ; <http://www.w3.org/2000/01/rdf-schema#label> "Eve" .`,
      `<http://people.example/note> a <${v}fact/note> ; <http://schema.org/text> "a fact that links Eve" ; <http://purl.org/dc/terms/references> <http://people.example/eve> .`,
      '',
    ].join('\n');
    let calls = 0;
    let removed = 0;
    act.setRdfImportKnobsForTest({
      window: 1,
      hooks: {
        // Window 1 writes the entity, window 2 the fact: the entity goes after the fact's window was planned, as the database's expiry removes a record.
        beforeCommitPlans: async () => {
          calls += 1;
          if (calls === 2) removed += (await d.col(d.spaceCollection(GONE, 'entities')).deleteOne({ name: 'Eve' })).deletedCount;
        },
      },
    });
    let r;
    try { r = await d.importRest(writer.key, GONE, file); } finally { act.setRdfImportKnobsForTest(null); }
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.equal(r.body.status, 'completed');
    assert.equal(calls, 2, 'two windows were committed');
    assert.equal(removed, 1, 'the entity was stored by the first window and went before the second landed');
    assert.equal((await d.records(GONE, 'facts')).length, 1, 'the fact landed');
    assert.deepEqual(await d.records(GONE, 'links'), [], 'its link row was taken back with the entity');
    assert.deepEqual(r.body.reasonsByCode, { links_not_written: 1 }, 'and the report says so');
    assert.equal(r.body.reasons[0].outcome, 'recorded');
    assert.equal(r.body.reasons[0].kind, 'fact');
  });
});
