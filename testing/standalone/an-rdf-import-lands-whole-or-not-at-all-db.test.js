/**
 * An RDF import lands whole or not at all, through two doors that answer alike (bundle-270 slice S6, Q-753; plan amendments A6, A10, A11):
 * `POST /api/brain/spaces/:spaceId/import/rdf` and MCP `import_rdf`, with `GET /api/brain/spaces/:spaceId/import/rdf/:importId` and MCP
 * `import_rdf_status` for the report.
 *
 * ## What it holds
 *
 * - In a strict space one statement the space cannot hold refuses the whole file: nothing lands, every reason is answered with its statement,
 *   the act ends so the space takes writes again, and the status door answers the refusal. No answer repeats a literal value of the file.
 * - The same file in a warn space lands, and the reasons are answered as recorded.
 * - A dry run writes nothing and registers no act, and answers what the import would insert.
 * - A second import of the space's own export converges onto the stored records and inserts nothing.
 * - A token without `knowledge: write` is refused on both doors, for a dry run too; a view id and an unknown id answer as a missing space.
 * - The door answers a malformed file (400 with its place) and a file over a bound (413 naming the bound) itself, registering nothing.
 * - The schema flag is the next slice's: a request carrying it is refused, naming it as not available yet.
 * - Both doors answer the same reasons and counts for the same file.
 * - One `rdf.import` audit row per import, with counts and no value of the file.
 *
 * Run: node --test testing/standalone/an-rdf-import-lands-whole-or-not-at-all-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { openRdfImportDoors, personMeta, goodTurtle, badTurtle, reasonCodes, SECRET } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const STRICT = 'rdfimpstrict';
const WARN = 'rdfimpwarn';
const DRY = 'rdfimpdry';
const BOUND = 'rdfimpbound';

describe('an RDF import lands whole or not at all (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, reader, act;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_whole', spaces: [
      { id: STRICT, meta: personMeta(STRICT) }, { id: WARN, meta: personMeta(WARN, 'warn') },
      { id: DRY, meta: personMeta(DRY) }, { id: BOUND, meta: personMeta(BOUND) },
    ] });
    const rights = (level) => Object.fromEntries([STRICT, WARN, DRY, BOUND].map(s => [s, d.row({ knowledge: level, schema: 'read' })]));
    writer = await d.mint('rdf-import-writer', rights('write'));
    reader = await d.mint('rdf-import-reader', rights('read'));
    act = await import('../../server/dist/spaces/rdf-import-act.js').catch(() => ({}));
  });
  after(async () => { act.setRdfImportKnobsForTest?.(null); await d?.close(); });

  it('strict: one bad statement lands nothing, answers every reason with its statement, and releases the space', async () => {
    const r = await d.importRest(writer.key, STRICT, badTurtle(STRICT));
    assert.equal(r.status, 409, r.text.slice(0, 400));
    assert.equal(r.body?.code, 'rdf_import_refused');
    assert.deepEqual(reasonCodes(r.body?.report), ['language-tagged-literal', 'predicate-without-term']);
    for (const reason of r.body.report.reasons) {
      assert.equal(reason.outcome, 'refused');
      assert.ok(reason.statements.length > 0 && reason.statements.every(s => s.subject === 'http://people.example/carol'), JSON.stringify(reason));
    }
    assert.ok(!r.text.includes(SECRET), 'a refusal repeats no literal value of the file');
    assert.deepEqual(await d.records(STRICT, 'entities'), [], 'nothing landed');
    assert.deepEqual(await d.records(STRICT, 'edges'), []);
    assert.deepEqual(d.actsOf(STRICT), [], 'the act ended, so the space is released');
    const status = await d.statusRest(writer.key, STRICT, r.body.report.importId);
    assert.equal(status.status, 200, status.text.slice(0, 300));
    assert.equal(status.body?.status, 'refused');
    assert.ok(!status.text.includes(SECRET));
    const save = await d.rest(writer.key, 'POST', `/api/brain/spaces/${STRICT}/entities`, { name: 'After', type: 'person' });
    assert.ok(save.status < 300, `the space takes writes again: ${save.text?.slice(0, 200)}`);
  });

  it('both doors answer the same reasons for the same file', async () => {
    const rest = await d.importRest(writer.key, STRICT, badTurtle(STRICT), { params: { dryRun: true } });
    const mcp = await d.importMcp(writer.key, { space: STRICT, document: badTurtle(STRICT), format: 'turtle', dryRun: true });
    const again = await d.importRest(writer.key, STRICT, badTurtle(STRICT), { params: { dryRun: true } });
    assert.equal(rest.status, 409, rest.text.slice(0, 300));
    assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
    assert.match(mcp.text, /rdf_import_refused/);
    const mcpReport = mcp.structured?.report;
    assert.deepEqual(reasonCodes(mcpReport), reasonCodes(rest.body.report));
    assert.deepEqual(reasonCodes(again.body.report), reasonCodes(rest.body.report));
    assert.equal(mcpReport.reasonCount, rest.body.report.reasonCount);
    assert.ok(!mcp.text.includes(SECRET));
  });

  it('warn: the same file lands, its reasons recorded', async () => {
    const r = await d.importRest(writer.key, WARN, badTurtle(WARN));
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.equal(r.body?.status, 'completed');
    assert.deepEqual(reasonCodes(r.body), ['language-tagged-literal', 'predicate-without-term']);
    assert.ok(r.body.reasons.every(x => x.outcome === 'recorded'));
    const names = (await d.records(WARN, 'entities')).map(e => e.name).sort();
    assert.deepEqual(names, ['Alice', 'Bob', 'Carol']);
    assert.equal((await d.records(WARN, 'edges')).length, 1);
    assert.equal(r.body.kinds.entity.inserted, 3);
    assert.equal(r.body.kinds.edge.inserted, 1);
    assert.ok(!r.text.includes(SECRET));
  });

  it('a second import of the space\'s own export converges and inserts nothing', async () => {
    const exported = await d.exportRest(writer.key, WARN, { format: 'trig' });
    assert.equal(exported.status, 200, exported.text.slice(0, 300));
    const before = (await d.records(WARN, 'entities')).length;
    const r = await d.importRest(writer.key, WARN, exported.text, { format: 'trig' });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.equal(r.body.kinds.entity.inserted, 0);
    assert.equal(r.body.kinds.entity.converged, before);
    assert.equal((await d.records(WARN, 'entities')).length, before);
    assert.equal((await d.records(WARN, 'edges')).length, 1);
  });

  it('a dry run writes nothing, registers no act, and answers what would land; both doors alike', async () => {
    const r = await d.importRest(writer.key, DRY, goodTurtle(DRY), { params: { dryRun: true } });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.equal(r.body.status, 'dry-run');
    assert.equal(r.body.kinds.entity.inserted, 2);
    assert.equal(r.body.kinds.edge.inserted, 1);
    const m = await d.importMcp(writer.key, { space: DRY, document: goodTurtle(DRY), format: 'turtle', dryRun: true });
    assert.equal(m.isError, false, m.text.slice(0, 300));
    assert.deepEqual(m.structured?.kinds, r.body.kinds);
    assert.deepEqual(await d.records(DRY, 'entities'), []);
    assert.deepEqual(d.actsOf(DRY), []);
  });

  it('a token without knowledge: write is refused on both doors, for a dry run too', async () => {
    for (const params of [{}, { dryRun: true }]) {
      const r = await d.importRest(reader.key, DRY, goodTurtle(DRY), { params });
      assert.equal(r.status, 403, r.text.slice(0, 200));
      const m = await d.importMcp(reader.key, { space: DRY, document: goodTurtle(DRY), format: 'turtle', ...params });
      assert.equal(m.isError, true, m.text.slice(0, 200));
    }
    assert.deepEqual(await d.records(DRY, 'entities'), []);
  });

  it('a view id answers as a missing space on both doors', async () => {
    const v = await d.rest(writer.key, 'POST', '/api/views', { name: 'imp', members: [DRY] });
    assert.ok(v.status < 300, v.text.slice(0, 200));
    // An id the token cannot reach at all is the route guard's 403, as on every write door; a view the token owns is the one id that reaches
    // the import and must be answered as a missing space, never written through.
    for (const id of ['@imp']) {
      const r = await d.importRest(writer.key, id, goodTurtle(DRY));
      assert.equal(r.status, 404, `${id}: ${r.text.slice(0, 200)}`);
      assert.ok(r.text.includes(id.replace(/^@/, '')), `the answer is the missing-space answer naming ${id}: ${r.text.slice(0, 200)}`);
      const m = await d.importMcp(writer.key, { space: id, document: goodTurtle(DRY), format: 'turtle' });
      assert.equal(m.isError, true, m.text.slice(0, 200));
      assert.ok(m.text.includes(id.replace(/^@/, '')), `the tool answers the missing space ${id}: ${m.text.slice(0, 200)}`);
      assert.doesNotMatch(m.text, /unknown tool/i);
    }
  });

  it('the door answers a malformed file and a file over a bound itself, registering nothing', async () => {
    const bad = await d.importRest(writer.key, BOUND, '<http://a.example/s> <http://a.example/p> "unterminated .\n');
    assert.equal(bad.status, 400, bad.text.slice(0, 300));
    assert.equal(bad.body?.code, 'rdf_malformed');
    assert.equal(typeof bad.body?.place?.line, 'number');
    assert.equal(typeof act.setRdfImportKnobsForTest, 'function', 'the act module exports its test knobs');
    act.setRdfImportKnobsForTest({ bounds: { maxQuads: 3 } });
    try {
      const r = await d.importRest(writer.key, BOUND, goodTurtle(BOUND));
      assert.equal(r.status, 413, r.text.slice(0, 300));
      assert.equal(r.body?.code, 'rdf_bound_exceeded');
      assert.equal(r.body?.bound, 'RDF_IMPORT_MAX_QUADS');
      const m = await d.importMcp(writer.key, { space: BOUND, document: goodTurtle(BOUND), format: 'turtle' });
      assert.equal(m.isError, true);
      assert.match(m.text, /RDF_IMPORT_MAX_QUADS/);
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.deepEqual(d.actsOf(BOUND), []);
    assert.deepEqual(await d.records(BOUND, 'entities'), []);
  });

  it('a bound only the act meets (records past the index, a bare edge among them) ends the act, releases the space and answers 413', async () => {
    // Two subjects pass the door's pass; the bare edge is minted while the file is translated, as the third record of a bound of two.
    act.setRdfImportKnobsForTest({ maxRecords: 2 });
    try {
      const r = await d.importRest(writer.key, BOUND, goodTurtle(BOUND));
      assert.equal(r.status, 413, r.text.slice(0, 300));
      assert.equal(r.body?.bound, 'RDF_IMPORT_MAX_RECORDS');
      const dry = await d.importRest(writer.key, BOUND, goodTurtle(BOUND), { params: { dryRun: true } });
      assert.equal(dry.status, 413, dry.text.slice(0, 300));
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.deepEqual(d.actsOf(BOUND), [], 'the act ended: the space is not held for ever');
    assert.deepEqual(await d.records(BOUND, 'entities'), []);
  });

  it('a file of two data graphs is refused unless each has its source base, naming the one without', async () => {
    const v = `https://rdf.example.org/ld/${BOUND}/vocab/`;
    const quad = (g) => `<http://people.example/x> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${v}entity/person> <${g}> .`;
    const r = await d.importRest(writer.key, BOUND, `${quad('http://graphs.example/a/')}\n${quad('http://graphs.example/b/')}\n`, {
      format: 'nquads', params: { dryRun: true, graphBase: 'http://graphs.example/b/ https://elsewhere.example/ld/b/' },
    });
    assert.equal(r.status, 400, r.text.slice(0, 300));
    assert.equal(r.body?.code, 'rdf_import_several_graphs');
    assert.deepEqual(r.body?.graphsWithoutBase, ['http://graphs.example/a/']);
  });

  it('the schema flag is refused as not available yet', async () => {
    const r = await d.importRest(writer.key, BOUND, goodTurtle(BOUND), { params: { schema: 'generate' } });
    assert.equal(r.status, 400, r.text.slice(0, 300));
    assert.equal(r.body?.code, 'rdf_import_schema_not_available');
    assert.deepEqual(d.actsOf(BOUND), []);
  });

  it('one rdf.import audit row per import, with counts and no value of the file', async () => {
    await untilAuditWritesLanded();
    const rows = await d.col('audit_log').find({ tokenId: writer.id, operation: 'rdf.import' }).toArray();
    assert.ok(rows.length >= 3, `rows: ${rows.length}`);
    const warnRow = rows.find(row => row.spaceId === WARN && (row.changes ?? []).some(c => c.field === 'inserted'));
    assert.ok(warnRow, JSON.stringify(rows.map(x => x.changes)));
    const fields = warnRow.changes.map(c => c.field);
    for (const f of ['quads', 'inserted', 'converged', 'reasons', 'notTaken']) assert.ok(fields.includes(f), `field ${f} in ${fields}`);
    assert.ok(!JSON.stringify(rows).includes(SECRET));
  });
});
