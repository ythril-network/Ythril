/**
 * An import with no `sourceBase` reads the file's one data graph as its source, as the guide says (bundle-270, fix round 4, finding R2).
 *
 * ## The defect
 *
 * The guide (`06f-exports.md`, the parameters table) says `sourceBase` defaults, for TriG, N-Quads and JSON-LD, to the file's one data graph
 * (and `sourceVocab` to `<sourceBase>vocab/`). The act read an absent `sourceBase` as the target's own base, so the export of another space was
 * refused with every record, type and predicate unknown.
 *
 * ## The rule
 *
 * - TriG, N-Quads or JSON-LD, exactly one data graph, no `sourceBase`, no `graphBase`: that graph's address is the source base, its vocabulary
 *   the default of it. The default is made once, by the door, before the import is registered: the act and a dry run read the one options.
 *   The file is sorted by the addresses it is read by, so it is sorted again under the default (a chrono entry's time nodes belong to it).
 * - A file of several data graphs and no `sourceBase` keeps its reading (400, `rdf_import_several_graphs`). Turtle names no graph and keeps its
 *   reading: the file's addresses are foreign, and a strict space refuses its types.
 * - A graph that is the target's own base adds no source: the addresses are the space's own, as before (the self import of R3).
 *
 * ## What this spec holds
 *
 * Per format that names its graphs: a dry run with no address answers what it does with the address given; a real import lands the same records
 * (the same names, the same chrono entry with its time nodes, the same edges and link rows) as the twin target imported with the address; the MCP
 * tool answers the same dry run. Turtle, two data graphs, and a graph that is the target's own base keep today's reading.
 *
 * Run: node --test testing/standalone/an-rdf-import-reads-a-files-one-data-graph-as-its-source-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, baseOf } from './_rdf-import-doors.mjs';
import { sourceMeta, writeSource, snapshotOf, labelsOf, linkLabels, exportText, PAIRS, expected } from './_rdf-source-fixture.mjs';

const skip = await mongoSkipReason();
const SRC = 'rdfdgsrc';
const SRC2 = 'rdfdgsrc2';
const FORMATS = ['trig', 'nquads', 'jsonld'];
const WITHOUT = Object.fromEntries(FORMATS.map(f => [f, `rdfdgno${f}`]));
const WITH = Object.fromEntries(FORMATS.map(f => [f, `rdfdgwith${f}`]));
const TURTLE = 'rdfdgturtle';
const MANY = 'rdfdgmany';
const SPACES = [SRC, SRC2, TURTLE, MANY, ...Object.values(WITHOUT), ...Object.values(WITH)];
const KINDS = { entity: 4, fact: 2, chrono: 2, edge: 2 };

describe('an import with no sourceBase reads the file\'s one data graph as its source (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer;
  const insertedOf = (report) => Object.fromEntries(Object.entries(report.kinds).map(([k, v]) => [k, v.inserted]));
  /** What a target holds, as labels: each kind's names, the edges and the link rows by their ends' labels, the chrono entries' times. */
  async function shapeOf(space) {
    const snap = await snapshotOf(d, space);
    const m = labelsOf(snap);
    return {
      names: ['entity', 'fact', 'chrono'].flatMap(k => [...m.entries()].filter(([key]) => key.startsWith(`${k}:`)).map(([, v]) => v)).sort(),
      chrono: snap.chrono.map(c => [c.title, c.startsAt, c.endsAt, c.status, c.confidence, JSON.stringify(c.recurrence)]).sort(),
      edges: snap.edge.map(e => `${m.get(`${e.fromKind ?? 'entity'}:${e.from}`)} -${e.label}-> ${m.get(`${e.toKind ?? 'entity'}:${e.to}`)}`).sort(),
      links: PAIRS.map(p => linkLabels(snap, p.from, p.to)),
    };
  }

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_graph_default', spaces: SPACES.map(id => ({ id, meta: sourceMeta(id) })) });
    writer = await d.mint('rdf-import-graph-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    await writeSource(d, writer.key, SRC);
    await writeSource(d, writer.key, SRC2);
  });
  after(async () => { await d?.close(); });

  for (const format of FORMATS) {
    it(`${format}: a dry run with no address answers what it does with the address given`, async () => {
      const text = await exportText(d, writer.key, SRC, format);
      const bare = await d.importRest(writer.key, WITHOUT[format], text, { format, params: { dryRun: true } });
      assert.equal(bare.status, 200, bare.text.slice(0, 500));
      assert.equal(bare.body.status, 'dry-run');
      assert.equal(bare.body.reasonCount, 0, JSON.stringify(bare.body.reasons?.slice(0, 2)).slice(0, 400));
      assert.deepEqual(insertedOf(bare.body), KINDS, 'what would land');
      const given = await d.importRest(writer.key, WITH[format], text, { format, params: { dryRun: true, sourceBase: baseOf(SRC) } });
      assert.equal(given.status, 200, given.text.slice(0, 500));
      assert.deepEqual(insertedOf(bare.body), insertedOf(given.body), 'the same as with the address given');
      assert.deepEqual(bare.body.notTaken, given.body.notTaken);
      assert.deepEqual(await d.records(WITHOUT[format], 'entities'), [], 'a dry run writes nothing');
    });

    it(`${format}: a real import with no address lands what the twin imported with the address landed`, async () => {
      const text = await exportText(d, writer.key, SRC, format);
      const bare = await d.importRest(writer.key, WITHOUT[format], text, { format });
      assert.equal(bare.status, 200, bare.text.slice(0, 500));
      assert.equal(bare.body.status, 'completed');
      const given = await d.importRest(writer.key, WITH[format], text, { format, params: { sourceBase: baseOf(SRC) } });
      assert.equal(given.status, 200, given.text.slice(0, 500));
      assert.deepEqual(insertedOf(bare.body), KINDS);
      const [a, b] = [await shapeOf(WITHOUT[format]), await shapeOf(WITH[format])];
      assert.equal(a.names.length, 8, 'eight records by name');
      assert.equal(a.links.flat().length, expected().link, 'every link row');
      assert.deepEqual(a, b, 'the same records, chrono entries with their times, edges and link rows');
      assert.deepEqual(a.chrono.find(c => c[0] === 'Lecture').slice(1, 3), ['2026-06-01T09:00:00Z', '2026-06-01T10:30:00Z'], 'the time nodes belong to their chrono entry');
    });
  }

  it('the MCP tool answers the same dry run with no address', async () => {
    const text = await exportText(d, writer.key, SRC, 'nquads');
    const m = await d.importMcp(writer.key, { space: TURTLE, document: text, format: 'nquads', dryRun: true });
    assert.equal(m.isError, false, m.text.slice(0, 500));
    assert.equal(m.structured?.status, 'dry-run');
    assert.deepEqual(insertedOf(m.structured), KINDS);
    assert.equal(m.structured.reasonCount, 0);
  });

  it('Turtle names no graph and keeps its reading: the addresses are foreign and a strict space refuses their types', async () => {
    const text = await exportText(d, writer.key, SRC, 'turtle');
    const r = await d.importRest(writer.key, TURTLE, text, { format: 'turtle', params: { dryRun: true } });
    assert.equal(r.status, 409, r.text.slice(0, 500));
    assert.equal(r.body.code, 'rdf_import_refused');
    assert.ok(Object.keys(r.body.report.reasonsByCode).includes('class-without-term'), JSON.stringify(r.body.report.reasonsByCode));
    assert.deepEqual(await d.records(TURTLE, 'entities'), []);
  });

  it('a file of two data graphs and no sourceBase keeps its reading: refused, one graphBase per graph asked for', async () => {
    const both = (await exportText(d, writer.key, SRC, 'nquads')) + (await exportText(d, writer.key, SRC2, 'nquads'));
    const r = await d.importRest(writer.key, MANY, both, { format: 'nquads', params: { dryRun: true } });
    assert.equal(r.status, 400, r.text.slice(0, 500));
    assert.equal(r.body.code, 'rdf_import_several_graphs');
    const ok = await d.importRest(writer.key, MANY, both, { format: 'nquads', params: { dryRun: true, graphBase: [`${baseOf(SRC)} ${baseOf(SRC)}`, `${baseOf(SRC2)} ${baseOf(SRC2)}`] } });
    assert.equal(ok.status, 200, ok.text.slice(0, 500));
    assert.deepEqual(insertedOf(ok.body), { entity: 8, fact: 4, chrono: 4, edge: 4 }, 'with a base per graph both are read');
  });

  it('a graph that is the target\'s own base adds no source: the file\'s addresses are the space\'s own', async () => {
    const text = await exportText(d, writer.key, SRC, 'nquads');
    const r = await d.importRest(writer.key, SRC, text, { format: 'nquads', params: { dryRun: true } });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.deepEqual(insertedOf(r.body), { entity: 0, fact: 0, chrono: 0, edge: 0 }, 'nothing is new: every record is the space\'s own');
    assert.deepEqual(Object.fromEntries(Object.entries(r.body.kinds).map(([k, v]) => [k, v.converged])), KINDS);
  });
});
