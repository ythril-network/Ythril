/**
 * A converge that changes nothing writes nothing (bundle-270, fix round 4, finding R3; Q-753: "a re-import into the source space changes nothing").
 *
 * ## The defect
 *
 * A space's own export imported into it converged every record onto itself with every field as it was, and still rewrote each one: a new
 * position (`seq`), a new modified time, an embed job, and so sync traffic, for a file that stated nothing new.
 *
 * ## Where the rule lives, and why not in the planners
 *
 * The single-record doors write on an update that changes nothing, on purpose (`brain/fact.ts`: a retried create "is not a no-op: `updatedAt` and
 * `seq` move", and an idempotent resend is a visible `clean` write); the planners' converge is that rule, and the doors' tests hold it. So the
 * rule is the import's: its commit does not hand a converge to the commit when the stored record already says what the plan leaves
 * (`rdf/import-unchanged.ts`), and the report counts such a record in `unchanged` (per kind, a part of `converged`).
 *
 * ## What this spec holds
 *
 * - The own export of the space, in each of the four formats, imported into the space: every document of every collection (entities, facts,
 *   chrono entries, edges, link rows) is byte-for-byte what it was (position, modified time, stamp included), no embed job is queued, the report
 *   counts every record `converged` and `unchanged`, and inserts none.
 * - The records a file cannot state in full are not rewritten for a difference it never stated: a tag list whose stored order is not the sorted
 *   one, a property the export leaves out (its value does not fit its declared type), a number the export writes as a decimal (edited here to
 *   `36.0`, the same number).
 * - A dry run, and the MCP tool, count the same `unchanged` and write nothing.
 * - A file that changes ONE field of ONE record rewrites that record only: its position and modified time move, one embed job is queued for it,
 *   every other document is as it was, and the report counts every other record `unchanged`.
 *
 * Run: node --test testing/standalone/an-rdf-import-of-a-spaces-own-export-writes-nothing-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors } from './_rdf-import-doors.mjs';
import { sourceMeta, writeSource, snapshotOf, exportText, expected, NOT_A_NUMBER } from './_rdf-source-fixture.mjs';

const skip = await mongoSkipReason();
const SELF = 'rdfselfown';
const FORMATS = ['turtle', 'trig', 'nquads', 'jsonld'];
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
/** The kinds the report counts, each with the literal count the fixture wrote (a `warn` space with the extra entity). */
const RECORDS = { entity: 5, fact: 2, chrono: 2, edge: 2 };

describe('a space\'s own export imported into it writes nothing (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, ids;
  const jobs = () => d.col(d.spaceCollection(SELF, 'embedJobs'));
  const countsOf = (report, key) => Object.fromEntries(Object.keys(RECORDS).map(k => [k, key === 'unchanged' ? report.unchanged?.[k] : report.kinds?.[k]?.[key]]));
  const nothingLanded = (report) => assert.deepEqual(countsOf(report, 'inserted'), { entity: 0, fact: 0, chrono: 0, edge: 0 }, 'nothing is inserted into the space the file came from');

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_self', spaces: [{ id: SELF, meta: sourceMeta(SELF, { validationMode: 'warn' }) }] });
    writer = await d.mint('rdf-import-self-writer', { [SELF]: d.row({ knowledge: 'write', schema: 'admin' }) });
    ids = await writeSource(d, writer.key, SELF, { weird: true });
    // The writes queued their own embed jobs: what the import adds is what is counted.
    await jobs().deleteMany({});
  });
  after(async () => { await d?.close(); });

  it('the fixture holds the three sorts of record a file cannot state in full', async () => {
    const snap = await snapshotOf(d, SELF);
    assert.deepEqual(Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.length])), expected(true));
    assert.deepEqual(snap.entity.find(e => e._id === ids.zed).tags, ['zeta', 'alpha'], 'a tag list in an order that is not the sorted one');
    assert.equal(snap.entity.find(e => e._id === ids.nan).properties.age, NOT_A_NUMBER, 'a property whose value does not fit its declared type');
    const text = await exportText(d, writer.key, SELF, 'nquads');
    assert.ok(!text.includes(NOT_A_NUMBER), 'the export leaves that property out');
    assert.ok(text.includes(`"36"^^<${XSD_DECIMAL}>`), 'the export writes the stored number 36 as a decimal');
  });

  for (const format of FORMATS) {
    it(`${format}: every record converges onto itself and nothing is written: no position, no modified time, no embed job`, async () => {
      const was = await snapshotOf(d, SELF);
      const text = await exportText(d, writer.key, SELF, format);
      const r = await d.importRest(writer.key, SELF, text, { format });
      assert.equal(r.status, 200, r.text.slice(0, 500));
      assert.equal(r.body.status, 'completed');
      assert.equal(r.body.reasonCount, 0, JSON.stringify(r.body.reasons).slice(0, 400));
      nothingLanded(r.body);
      assert.deepEqual(countsOf(r.body, 'converged'), RECORDS, 'every record is counted converged');
      assert.deepEqual(countsOf(r.body, 'unchanged'), RECORDS, 'and every one of them unchanged');
      const now = await snapshotOf(d, SELF);
      assert.deepEqual(now, was, 'every document of every collection is as it was, position and modified time included');
      assert.equal(await jobs().countDocuments({}), 0, 'no embed job was queued');
    });
  }

  it('a number written as 36.0 is the number 36: the record is not rewritten', async () => {
    const was = await snapshotOf(d, SELF);
    const text = await exportText(d, writer.key, SELF, 'nquads');
    const edited = text.replace(`"36"^^<${XSD_DECIMAL}>`, `"36.0"^^<${XSD_DECIMAL}>`);
    assert.notEqual(edited, text, 'the file was edited');
    const r = await d.importRest(writer.key, SELF, edited, { format: 'nquads' });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.deepEqual(countsOf(r.body, 'unchanged'), RECORDS);
    assert.deepEqual(await snapshotOf(d, SELF), was);
    assert.equal(await jobs().countDocuments({}), 0);
  });

  it('a dry run counts the same unchanged records and writes nothing', async () => {
    const was = await snapshotOf(d, SELF);
    const text = await exportText(d, writer.key, SELF, 'trig');
    const r = await d.importRest(writer.key, SELF, text, { format: 'trig', params: { dryRun: true } });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.equal(r.body.status, 'dry-run');
    assert.deepEqual(countsOf(r.body, 'converged'), RECORDS);
    assert.deepEqual(countsOf(r.body, 'unchanged'), RECORDS);
    assert.deepEqual(await snapshotOf(d, SELF), was);
  });

  it('the MCP tool counts the same and writes nothing', async () => {
    const was = await snapshotOf(d, SELF);
    const text = await exportText(d, writer.key, SELF, 'nquads');
    const m = await d.importMcp(writer.key, { space: SELF, document: text, format: 'nquads' });
    assert.equal(m.isError, false, m.text.slice(0, 400));
    assert.equal(m.structured?.status, 'completed', m.text.slice(0, 400));
    assert.deepEqual(countsOf(m.structured, 'converged'), RECORDS);
    assert.deepEqual(countsOf(m.structured, 'unchanged'), RECORDS);
    assert.deepEqual(await snapshotOf(d, SELF), was);
    assert.equal(await jobs().countDocuments({}), 0);
  });

  it('a file that changes one field of one record rewrites that record only', async () => {
    const was = await snapshotOf(d, SELF);
    const text = await exportText(d, writer.key, SELF, 'nquads');
    assert.equal(text.split('"Charles Babbage"').length, 2, 'the name is stated once');
    const edited = text.replace('"Charles Babbage"', '"Charles Babbage Esq"');
    const r = await d.importRest(writer.key, SELF, edited, { format: 'nquads' });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.equal(r.body.status, 'completed');
    assert.deepEqual(countsOf(r.body, 'converged'), RECORDS);
    assert.deepEqual(countsOf(r.body, 'unchanged'), { ...RECORDS, entity: RECORDS.entity - 1 }, 'every record but the edited one is unchanged');
    const now = await snapshotOf(d, SELF);
    const was1 = was.entity.find(e => e._id === ids.charles);
    const now1 = now.entity.find(e => e._id === ids.charles);
    assert.equal(now1.name, 'Charles Babbage Esq');
    assert.ok(now1.seq > was1.seq, `its position moved (${was1.seq} to ${now1.seq})`);
    assert.ok(Date.parse(now1.updatedAt) > Date.parse(was1.updatedAt), 'its modified time moved');
    for (const kind of Object.keys(was)) {
      const others = (snap) => snap[kind].filter(x => x._id !== ids.charles);
      assert.deepEqual(others(now), others(was), `every ${kind} but the edited one is as it was`);
    }
    const queued = await jobs().find({}).toArray();
    assert.deepEqual(queued.map(j => j.recordId), [ids.charles], 'one embed job, for the record that changed');
  });
});
