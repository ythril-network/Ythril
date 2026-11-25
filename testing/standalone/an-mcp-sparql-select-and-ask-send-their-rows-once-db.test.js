/**
 * The MCP answer to a SELECT or ASK holds its rows once, and the tool's output schema declares the answer's keys (bundle-271, Q-757, review
 * unproven 2; design r2 R3.6).
 *
 * ## The rule
 *
 * The first text block is the SPARQL results JSON (`{head, results}` or `{head, boolean}`), the second the summary, and `structuredContent`
 * is the summary alone: the rows are not in it again, so an agent pays for them once. The output schema `sparql_query` lists declares
 * `head`, `results` and `boolean` beside the summary's keys, so a client that validates an answer against it knows every key of the answer.
 *
 * ## Seen red
 *
 * On 3cfca318b `structuredContent` is the results body merged with the summary: each row is in the answer twice, and `head`, `results` and
 * `boolean` are not in the output schema.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/an-mcp-sparql-select-and-ask-send-their-rows-once-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spq-rows-once';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ENTITY_LABELS = `?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/ythril/ns#Entity> ; <${RDFS_LABEL}> ?n`;
const SELECT = `SELECT ?s ?n WHERE { ${ENTITY_LABELS} } ORDER BY ?n`;
const ASK = `ASK { ?s <${RDFS_LABEL}> "Rowonce" }`;
const STAMP = '2026-03-04T05:06:07.000Z';

let d, tok;

/** The occurrences of `needle` in the whole of an answer: its blocks and its structured half. */
const occurrences = (m, needle) => (JSON.stringify([m.blocks, m.structured]).match(new RegExp(needle, 'g')) ?? []).length;

describe('an MCP SPARQL SELECT or ASK sends its rows once', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-rows-once', spaces: [{ id: S }] });
    await d.seed(S, 'entity', ['Rowonce', 'Other'].map((n, i) => ({ _id: `e-${i}`, name: n, type: 'Person', createdAt: STAMP, updatedAt: STAMP })));
    tok = await d.mint('spq-rows-once', { [S]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a SELECT\'s rows are in the first block and not again in structuredContent', async () => {
    const m = await d.sparqlMcp(tok.key, { space: S, query: SELECT });
    assert.ok(!m.isError, m.text.slice(0, 300));
    assert.equal(m.body?.results?.bindings?.length, 2, 'the rows are in the first block');
    assert.equal(occurrences(m, 'Rowonce'), 1, 'a row is in the answer more than once');
    assert.equal(m.structured?.results, undefined, 'structuredContent holds the results');
    assert.equal(m.structured?.head, undefined, 'structuredContent holds the head');
    assert.equal(m.structured?.rows, 2, 'structuredContent is the summary');
  });

  it('an ASK\'s boolean is in the first block and not again in structuredContent', async () => {
    const m = await d.sparqlMcp(tok.key, { space: S, query: ASK });
    assert.ok(!m.isError, m.text.slice(0, 300));
    assert.deepEqual(m.body, { head: {}, boolean: true });
    assert.equal(m.structured?.boolean, undefined, 'structuredContent holds the boolean');
    assert.equal(m.structured?.form, 'ask');
  });

  it('the output schema of sparql_query declares head, results and boolean', async () => {
    const r = await fetch(`${d.server.url}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${tok.key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const raw = await r.text();
    const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
    const tool = (JSON.parse(data).result?.tools ?? []).find(t => t.name === 'sparql_query');
    assert.ok(tool, 'tools/list holds no sparql_query');
    for (const key of ['head', 'results', 'boolean']) {
      assert.ok(key in (tool.outputSchema?.properties ?? {}), `the output schema does not declare \`${key}\``);
    }
  });
});
