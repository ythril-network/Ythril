/**
 * A space's records exported through the REST door in each of the four formats are read back by independent parsers (n3; jsonld then n3),
 * say the same statements in every format, and say exactly what the record form says (Q-750, design r4 §5.2-§5.5, §8).
 *
 * ## What it holds
 *
 * - Turtle, TriG, N-Quads and JSON-LD of one seeded space (every record kind, three edges of one label from one entity, two links, a file)
 *   parse, and their statements outside the report graph are one set, equal to the union of the slice B record form of every record.
 * - Several edges of one label are that predicate stated several times; several links are `dcterms:references` stated several times.
 * - The RDF 1.2 edge form (the default for the text formats) is announced: `VERSION "1.2"` first and `; version=1.2` on the Content-Type;
 *   JSON-LD writes the classic form and announces nothing.
 * - Every answer carries its registered media type, `Vary: Accept` and `Content-Disposition: attachment` with the format's extension.
 * - The end of a page is always said: Turtle ends with the `# ythril-export:` comment; TriG, N-Quads and JSON-LD carry a
 *   `ythril:ExportReport` node in a graph of its own, with the page's record count and `ythril:complete true`.
 * - MCP `export_rdf` answers the same document (byte for byte) in its first text block, its summary as JSON in the second, and the summary
 *   alone in `structuredContent`.
 *
 * Run: node --test testing/standalone/an-rdf-export-is-read-by-an-independent-parser-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf, parseRdf, tripleSet, reportGraphs, recordFormSet } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfparse';
const BIG = 5_000_000;
const META = rdfMeta(SPACE, { typeSchemas: { entity: { Person: { propertySchemas: { age: { type: 'number' } } } }, edge: { knows: {} } } });

const RECORDS = {
  entity: [
    { _id: 'e1', name: 'Ada "the first" \\ Lovelace', type: 'Person', properties: { age: 36 }, tags: ['math', 'poetry'] },
    { _id: 'e2', name: 'Charles', type: 'Person' }, { _id: 'e3', name: 'Mary' }, { _id: 'e4', name: 'Über Ström' },
  ],
  fact: [{ _id: 'f1', fact: 'A fact\nwith a newline.', description: 'plain text' }],
  chrono: [{ _id: 'c1', title: 'Talk', type: 'event', status: 'upcoming', startsAt: '2026-04-05T10:00:00Z', endsAt: '2026-04-05T11:00:00Z' }],
  edge: [
    { _id: 'k1', from: 'e1', to: 'e2', label: 'knows', weight: 0.5 },
    { _id: 'k2', from: 'e1', to: 'e3', label: 'knows' },
    { _id: 'k3', from: 'e1', to: 'e4', label: 'knows' },
  ],
  link: [
    { _id: 'l1', from: 'f1', fromKind: 'fact', to: 'e1', toKind: 'entity' },
    { _id: 'l2', from: 'f1', fromKind: 'fact', to: 'e2', toKind: 'entity' },
  ],
  file: [{ _id: 'docs/readme.md', path: 'docs/readme.md', sizeBytes: 12, sha256: 'ab'.repeat(32), description: 'a file', createdAt: '2026-01-01T00:00:00.000Z' }],
};

describe('an RDF export is read by an independent parser', { skip }, () => {
  let d, admin, mapper, vocab;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_parse', spaces: [{ id: SPACE, meta: META }] });
    for (const [kind, docs] of Object.entries(RECORDS)) await d.seed(SPACE, kind, docs);
    admin = await d.mint('admin', {}, { admin: true });
    mapper = await import('../../server/dist/rdf/record-triples.js');
    vocab = await import('../../server/dist/rdf/ythril-vocabulary.js');
  });
  after(async () => { await d?.close(); });

  const expected = (edgeDetails) => {
    const meta = d.loader.getConfig().spaces.find(s => s.id === SPACE).meta;
    return [...new Set(Object.entries(RECORDS).flatMap(([kind, docs]) => docs.flatMap(doc => recordFormSet(mapper, meta, kind, doc, edgeDetails))))].sort();
  };

  it('each format parses and states exactly the record form, alike in all four', async () => {
    const sets = {};
    for (const format of ['turtle', 'trig', 'nquads', 'jsonld']) {
      const r = await d.exportRest(admin.key, SPACE, { format, edgeDetails: 'reification', maxChars: BIG });
      assert.equal(r.status, 200, `${format}: ${r.text.slice(0, 300)}`);
      const quads = await parseRdf(format, r.text);
      const reports = reportGraphs(quads, vocab.YTHRIL_NS);
      if (format !== 'turtle') assert.equal(reports.size, 1, `${format} carries one report graph`);
      sets[format] = tripleSet(quads, reports);
    }
    assert.deepEqual(sets.trig, sets.turtle, 'TriG states what Turtle states');
    assert.deepEqual(sets.nquads, sets.turtle, 'N-Quads states what Turtle states');
    assert.deepEqual(sets.jsonld, sets.turtle, 'JSON-LD states what Turtle states');
    assert.deepEqual(sets.turtle, expected('reification'), 'the export states the record form, no more and no less');
  });

  it('three edges of one label are the predicate three times; two links are dcterms:references twice', async () => {
    const r = await d.exportRest(admin.key, SPACE, { format: 'nquads', maxChars: BIG });
    const quads = await parseRdf('nquads', r.text);
    const knows = quads.filter(q => q.predicate.value === `${baseOf(SPACE)}vocab/edge/knows` && q.subject.value === `${baseOf(SPACE)}entity/e1`);
    assert.equal(knows.length, 3, r.text.slice(0, 500));
    const refs = quads.filter(q => q.predicate.value === 'http://purl.org/dc/terms/references');
    assert.equal(refs.length, 2);
  });

  it('the RDF 1.2 edge form is announced in the body and the Content-Type; JSON-LD is classic and announces nothing', async () => {
    const parsedRdf12 = expected('rdf12');
    for (const [format, type] of [['turtle', 'text/turtle'], ['trig', 'application/trig'], ['nquads', 'application/n-quads']]) {
      const r = await d.exportRest(admin.key, SPACE, { format, maxChars: BIG });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.headers['content-type'], `${type}; version=1.2`);
      assert.ok(r.text.startsWith('VERSION "1.2"\n'), r.text.slice(0, 80));
      const quads = await parseRdf(format, r.text);
      assert.deepEqual(tripleSet(quads, reportGraphs(quads, vocab.YTHRIL_NS)), parsedRdf12, `${format} in the RDF 1.2 form states the record form`);
    }
    const j = await d.exportRest(admin.key, SPACE, { format: 'jsonld', maxChars: BIG });
    assert.equal(j.headers['content-type'], 'application/ld+json');
    assert.doesNotMatch(j.text, /VERSION/);
  });

  it('every answer carries Vary: Accept and an attachment named for the space', async () => {
    for (const [format, ext] of [['turtle', 'ttl'], ['trig', 'trig'], ['nquads', 'nq'], ['jsonld', 'jsonld']]) {
      const r = await d.exportRest(admin.key, SPACE, { format });
      assert.match(String(r.headers['vary']), /Accept/i);
      assert.match(String(r.headers['content-disposition']), new RegExp(`^attachment; filename="${SPACE}\\.${ext}"`));
    }
  });

  it('the end of a page is said in every format', async () => {
    const t = await d.exportRest(admin.key, SPACE, { format: 'turtle', maxChars: BIG });
    assert.match(t.text, /\n# ythril-export: [^\n]*\n$/, 'Turtle ends with the closing comment');
    for (const format of ['trig', 'nquads', 'jsonld']) {
      const r = await d.exportRest(admin.key, SPACE, { format, maxChars: BIG });
      const quads = await parseRdf(format, r.text);
      const graph = [...reportGraphs(quads, vocab.YTHRIL_NS)][0];
      const report = quads.filter(q => q.graph.value === graph);
      const value = (name) => report.find(q => q.predicate.value === `${vocab.YTHRIL_NS}${name}`)?.object.value;
      assert.equal(value('recordCount'), String(Object.values(RECORDS).flat().length), `${format}: the page's records are counted`);
      assert.equal(value('complete'), 'true', `${format}: the last page says it is complete`);
    }
  });

  it('the description graph says what the file holds, in standard terms: the scope has the space graph, which names its shapes', async () => {
    const { schemaFingerprintOf } = await import('../../server/dist/spaces/schema-stamp.js');
    const fp = schemaFingerprintOf(d.loader.getConfig().spaces.find(s => s.id === SPACE));
    const graphIri = baseOf(SPACE);
    for (const format of ['trig', 'nquads', 'jsonld']) {
      const r = await d.exportRest(admin.key, SPACE, { format, maxChars: BIG });
      const quads = await parseRdf(format, r.text);
      const graph = [...reportGraphs(quads, vocab.YTHRIL_NS)][0];
      const described = quads.filter(q => q.graph.value === graph);
      const report = described.find(q => q.object.value === `${vocab.YTHRIL_NS}ExportReport`).subject.value;
      assert.ok(described.some(q => q.subject.value === report && q.predicate.value === 'http://purl.org/dc/terms/hasPart' && q.object.value === graphIri),
        `${format}: the export's scope dcterms:hasPart the space's record graph`);
      assert.ok(described.some(q => q.subject.value === graphIri && q.predicate.value === 'http://purl.org/dc/terms/isPartOf' && q.object.value === report),
        `${format}: the record graph dcterms:isPartOf the export's scope`);
      assert.ok(described.some(q => q.subject.value === graphIri && q.predicate.value === 'http://www.w3.org/ns/shacl#shapesGraph' && q.object.value === `${graphIri}schema/${fp}`),
        `${format}: the record graph names its shapes graph, the schema at the exported version (SHACL sh:shapesGraph)`);
      assert.ok(quads.some(q => q.graph.value === graphIri && q.subject.value === `${graphIri}entity/e1`), `${format}: the records sit in the space's graph`);
    }
    const t = await d.exportRest(admin.key, SPACE, { format: 'turtle', maxChars: BIG });
    assert.ok(t.text.trimEnd().split('\n').at(-1).includes(`${graphIri}schema/${fp}`), 'Turtle names the shapes in its closing comment');
  });

  it('MCP export_rdf answers the same document once, the summary beside it, and no document in structuredContent', async () => {
    const rest = await d.exportRest(admin.key, SPACE, { format: 'turtle', maxChars: 20_000 });
    const mcp = await d.exportMcp(admin.key, { space: SPACE, format: 'turtle', maxChars: 20_000 });
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    assert.equal(mcp.blocks.length, 2);
    assert.equal(mcp.document, rest.text, 'one document on both doors');
    assert.deepEqual(mcp.summary, mcp.structured, 'the second block is the summary as JSON');
    assert.equal(mcp.structured.format, 'turtle');
    assert.equal(mcp.structured.records, Object.values(RECORDS).flat().length);
    assert.equal(mcp.structured.complete, true);
    assert.ok(!JSON.stringify(mcp.structured).includes('@prefix'), 'structuredContent carries no document');
  });
});
