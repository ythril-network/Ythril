/**
 * A property value that is a list or an object (only a direct database write can leave one; decision record 23) is left out of the export,
 * the rest of its record is exported, and the answer names it on every channel (Q-750, design r4 §5.2, §8; standards review row 10).
 *
 * ## What it holds
 *
 * - One entity's property is `["a","b"]`, another's `{x:1}`, planted by a direct collection write. The REST export in all four formats and
 *   MCP `export_rdf` succeed; both records are present with every other statement; the two values are absent.
 * - REST: the trailers `Ythril-Skipped-Values: 2` and `Ythril-Skipped-Records` (both ids), declared up front in `Trailer:`; the closing
 *   comment of the text formats names each record, key and reason in words ("not a plain value"); TriG, N-Quads and JSON-LD carry the
 *   count and each value in the `ythril:ExportReport` node.
 * - MCP: `structuredContent.skippedValues` with the count and each `{ recordId, key, reason }`.
 * - The `rdf.export` audit row of each door names the count and the records.
 * - Over 100 planted values: 100 named, the rest counted.
 *
 * Run: node --test testing/standalone/a-record-with-a-planted-list-value-is-exported-without-it-and-named-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf, parseRdf, reportGraphs } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfplanted';
const MANY = 'rdfplantedmany';
const BIG = 5_000_000;

describe('a planted list value is exported without it and named', { skip }, () => {
  let d, admin, vocab;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_planted', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }, { id: MANY, meta: rdfMeta(MANY) }] });
    await d.seed(SPACE, 'entity', [
      { _id: 'listy', name: 'Listy', properties: { colours: ['a', 'b'], height: 3 } },
      { _id: 'objy', name: 'Objy', properties: { shape: { x: 1 }, note: 'kept' } },
      { _id: 'plain', name: 'Plain', properties: { colour: 'red' } },
    ]);
    await d.seed(MANY, 'entity', Array.from({ length: 105 }, (_, i) => ({ _id: `m${String(i).padStart(3, '0')}`, name: `M${i}`, properties: { bad: [i] } })));
    admin = await d.mint('admin', {}, { admin: true });
    vocab = await import('../../server/dist/rdf/ythril-vocabulary.js');
  });
  after(async () => { await d?.close(); });

  const E = (id) => `${baseOf(SPACE)}entity/${id}`;
  const P = (prop) => `${baseOf(SPACE)}vocab/entity#${prop}`;

  for (const format of ['turtle', 'trig', 'nquads', 'jsonld']) {
    it(`${format}: the values are left out, the records kept, and the answer names them`, async () => {
      const r = await d.exportRest(admin.key, SPACE, { format, maxChars: BIG });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const quads = await parseRdf(format, r.text);
      const has = (s, p) => quads.some(q => q.subject.value === s && q.predicate.value === p);
      assert.ok(has(E('listy'), P('height')) && has(E('objy'), P('note')) && has(E('plain'), P('colour')), 'the rest of each record is exported');
      assert.ok(!has(E('listy'), P('colours')) && !has(E('objy'), P('shape')), 'the list and the object give no statement');
      assert.match(String(r.headers['trailer']), /Ythril-Skipped-Values/i);
      assert.equal(r.trailers['ythril-skipped-values'], '2');
      assert.match(r.trailers['ythril-skipped-records'] ?? '', /listy/);
      assert.match(r.trailers['ythril-skipped-records'] ?? '', /objy/);
      if (format !== 'jsonld') {
        const last = r.text.trimEnd().split('\n').at(-1);
        assert.match(last, /^# ythril-export: /);
        assert.match(last, /listy \(colours: not a plain value\)/);
        assert.match(last, /objy \(shape: not a plain value\)/);
      }
      if (format !== 'turtle') {
        const graph = [...reportGraphs(quads, vocab.YTHRIL_NS)][0];
        const report = quads.filter(q => q.graph.value === graph);
        assert.equal(report.find(q => q.predicate.value === `${vocab.YTHRIL_NS}leftOutCount`)?.object.value, '2');
        const keys = report.filter(q => q.predicate.value === `${vocab.YTHRIL_NS}leftOutKey`).map(q => q.object.value).sort();
        assert.deepEqual(keys, ['colours', 'shape']);
        const records = report.filter(q => q.predicate.value === `${vocab.YTHRIL_NS}leftOutRecord`).map(q => q.object.value).sort();
        assert.deepEqual(records, [E('listy'), E('objy')]);
        assert.ok(report.some(q => q.predicate.value === `${vocab.YTHRIL_NS}leftOutReason` && q.object.value === 'not a plain value'));
      }
    });
  }

  it('MCP names them in structuredContent.skippedValues', async () => {
    const r = await d.exportMcp(admin.key, { space: SPACE, maxChars: BIG });
    assert.equal(r.isError, false, r.text.slice(0, 300));
    assert.equal(r.structured.skippedValues.count, 2);
    assert.deepEqual(r.structured.skippedValues.named.map(v => [v.recordId, v.key, v.reason]).sort(),
      [['listy', 'colours', 'not-a-plain-value'], ['objy', 'shape', 'not-a-plain-value']]);
    assert.equal(r.structured.skippedValues.unnamed, 0);
  });

  it('the rdf.export audit row of each door names the count and the records', async () => {
    const { col } = d;
    await col('audit_log').deleteMany({ operation: 'rdf.export' });
    await d.exportRest(admin.key, SPACE, { format: 'nquads', maxChars: BIG });
    await d.exportMcp(admin.key, { space: SPACE, maxChars: BIG });
    // The REST entry is written when the response finishes: give it a moment.
    let rows = [];
    for (let i = 0; i < 50 && rows.length < 2; i++) {
      rows = await col('audit_log').find({ operation: 'rdf.export' }).toArray();
      if (rows.length < 2) await new Promise(res => setTimeout(res, 100));
    }
    assert.equal(rows.length, 2, JSON.stringify(rows.map(r => r.operation)));
    for (const row of rows) {
      const changes = Object.fromEntries((row.changes ?? []).map(c => [c.field, c.to]));
      assert.equal(changes.skippedValues, 2, JSON.stringify(row.changes));
      assert.match(String(changes.skippedNamed), /listy/);
      assert.match(String(changes.skippedNamed), /objy/);
      assert.equal(row.spaceId, SPACE);
    }
  });

  it('over 100 planted values: 100 named, the rest counted', async () => {
    const r = await d.exportMcp(admin.key, { space: MANY, maxChars: BIG });
    assert.equal(r.isError, false, r.text.slice(0, 300));
    assert.equal(r.structured.skippedValues.count, 105);
    assert.equal(r.structured.skippedValues.named.length, 100);
    assert.equal(r.structured.skippedValues.unnamed, 5);
    const rest = await d.exportRest(admin.key, MANY, { format: 'turtle', maxChars: BIG });
    assert.equal(rest.trailers['ythril-skipped-values'], '105');
    assert.match(rest.text.trimEnd().split('\n').at(-1), /and 5 more/);
  });
});
