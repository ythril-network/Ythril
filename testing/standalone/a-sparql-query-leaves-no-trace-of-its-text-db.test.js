/**
 * A SPARQL query is recorded as an act, by its counts and never by its text, and what a budget cut from its MCP answer is kept as a spill
 * that goes with its space (bundle-271, Q-757; design r2 R3.7, R5).
 *
 * ## The rules
 *
 * 1. **Audit like the export.** Every query is one row of operation `brain.sparql_query`, written whatever `audit.logReads` says (the
 *    `rdf.export` rule), on REST `GET`, REST `POST` and MCP; a successful one records its form, length, member count, records read, rows and
 *    outcome.
 * 2. **No text anywhere.** No substring of the query is in an audit row, a log line or the body of an error (a parse error names its line
 *    and column only), on any door.
 * 3. **Spill.** A budget-cut MCP answer spills the rows it cut, each `{spaceId, members, row}`, readable through `read_spill`, and deleting
 *    the space drops the spill.
 *
 * ## Seen red
 *
 * On db66e206d no route answers `/api/brain/spaces/:spaceId/sparql` (404) and no tool `sparql_query` exists. Mutations: a parse refusal's words
 * followed by the query's text (rule 2: the marker is in the error body); spilling rows without `spaceId` (rule 3: no spill).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-query-leaves-no-trace-of-its-text-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spq-trace';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
/** A marker no answer, code or sentence of the server holds: found anywhere, it came from the query's text. */
const MARK = 'zq7marker';
/** The entities' labels (the records' writer, an agent, has one too, and is left out by the class). */
const ENTITY_LABELS = `?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/ythril/ns#Entity> ; <${RDFS_LABEL}> ?n`;
const GOOD = `SELECT ?s ?n WHERE { ${ENTITY_LABELS} FILTER(?n != "${MARK}") }`;
const BROKEN = `SELECT ?s WHERE { ?s ?p "${MARK}" .. }`;
const STAMP = '2026-03-04T05:06:07.000Z';
const OP = 'brain.sparql_query';

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;

describe('a SPARQL query leaves no trace of its text', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-trace', spaces: [{ id: S }] });
    await d.seed(S, 'entity', Array.from({ length: 40 }, (_, i) => ({
      _id: `e-${String(i).padStart(2, '0')}`, name: `Name ${String(i).padStart(2, '0')} ${'w'.repeat(60)}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP,
    })));
    tok = await d.mint('spq-trace', { [S]: d.row({ knowledge: 'read' }) });
    await d.loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: false }; });
  });
  after(async () => { await d?.close(); });

  it('every query is a brain.sparql_query row on every door with reads off, its counts recorded and its text nowhere', async () => {
    const before_ = (await auditRowsOf(d.door.mongo, { operation: OP })).length;
    const { lines, result } = await logLinesDuring(async () => {
      const get = await d.sparqlGet(tok.key, S, GOOD);
      const post = await d.sparqlPost(tok.key, S, GOOD, { as: 'form' });
      const mcp = await d.sparqlMcp(tok.key, { space: S, query: GOOD });
      const badGet = await d.sparqlGet(tok.key, S, BROKEN);
      const badPost = await d.sparqlPost(tok.key, S, BROKEN);
      const badMcp = await d.sparqlMcp(tok.key, { space: S, query: BROKEN });
      return { get, post, mcp, badGet, badPost, badMcp };
    });
    assert.equal(result.get.status, 200, fmt(result.get));
    assert.equal(result.post.status, 200, fmt(result.post));
    assert.ok(!result.mcp.isError, result.mcp.text.slice(0, 300));
    for (const [door, a] of [['GET', result.badGet], ['POST', result.badPost]]) {
      assert.equal(a.status, 400, `${door}: ${fmt(a)}`);
      assert.equal(a.body?.code, 'sparql_malformed', `${door}: ${fmt(a)}`);
      assert.equal(typeof a.body?.line, 'number', `${door}: the parse error names no line`);
      assert.ok(!a.text.includes(MARK), `${door}: the error body repeats the query: ${a.text.slice(0, 300)}`);
    }
    assert.ok(result.badMcp.isError && result.badMcp.text.includes('sparql_malformed'), result.badMcp.text.slice(0, 300));
    assert.ok(!result.badMcp.text.includes(MARK), `MCP: the error repeats the query: ${result.badMcp.text.slice(0, 300)}`);
    assert.deepEqual(lines.filter(l => l.includes(MARK)), [], 'a log line repeats the query');

    const rows = (await auditRowsOf(d.door.mongo, { operation: OP })).slice(before_);
    assert.equal(rows.length, 6, `rows of ${OP}: ${rows.map(r => `${r.method} ${r.status}`).join(', ')}`);
    assert.deepEqual(rows.map(r => r.method).sort(), ['GET', 'GET', 'MCP', 'MCP', 'POST', 'POST']);
    assert.deepEqual(rows.filter(r => JSON.stringify(r).includes(MARK)).map(r => r.method), [], 'an audit row holds the query\'s text');
    for (const r of rows.filter(x => x.status === 200)) {
      const fields = Object.fromEntries((r.changes ?? []).map(c => [c.field, c.to]));
      assert.equal(fields.form, 'select', `${r.method}: form`);
      assert.equal(fields.length, Buffer.byteLength(GOOD), `${r.method}: length`);
      assert.equal(fields.members, 1, `${r.method}: members`);
      assert.equal(fields.rows, 40, `${r.method}: rows`);
      assert.equal(fields.outcome, 'answered', `${r.method}: outcome`);
      assert.ok(fields.recordsRead >= 40, `${r.method}: recordsRead ${fields.recordsRead}`);
      assert.equal(r.spaceId, S, `${r.method}: spaceId`);
    }
  });

  it('a budget-cut MCP answer spills its cut rows, readable by read_spill, and the spill goes with its space', async () => {
    const m = await d.sparqlMcp(tok.key, { space: S, query: `SELECT ?s ?n WHERE { ${ENTITY_LABELS} } ORDER BY ?n`, maxChars: 2_000 });
    assert.ok(!m.isError, m.text.slice(0, 300));
    assert.equal(m.summary?.truncated, true, `the answer was not cut: ${m.blocks[1]?.slice(0, 300)}`);
    const returned = m.body.results.bindings.length;
    assert.ok(returned > 0 && returned < 40, `${returned} rows returned`);
    const spillId = m.summary?.remainder?.spillId;
    assert.ok(spillId, `no spill: ${JSON.stringify(m.summary).slice(0, 400)}`);
    const read = await d.toolCall(tok.key, 'read_spill', { id: spillId });
    assert.ok(!read.isError, read.text.slice(0, 300));
    const items = read.structured?.items ?? JSON.parse(read.blocks[0] ?? '{}').items ?? [];
    assert.equal(items.length, 40 - returned, 'the spill holds the rows the budget cut, no more, no less');
    assert.deepEqual(Object.keys(items[0] ?? {}).sort(), ['members', 'row', 'spaceId']);
    assert.equal(items[0].spaceId, S);
    assert.deepEqual(items[0].members, [S]);
    const headers = () => d.door.mongo.getDb().collection('_read_spills').find({ _id: spillId }).toArray();
    assert.equal((await headers()).length, 1, 'the spill header is not stored');
    const { dropSpillsForSpace } = await import('../../server/dist/brain/read-spill-store.js');
    await dropSpillsForSpace(S);
    assert.deepEqual(await headers(), [], 'the spill outlived its space');
  });
});
