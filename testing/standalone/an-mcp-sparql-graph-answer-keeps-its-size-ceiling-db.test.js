/**
 * The MCP answer to a CONSTRUCT or DESCRIBE is the N-Quads lines its budget admitted, measured as it is returned (bundle-271, Q-757,
 * review m3; design r2 R3.6).
 *
 * ## The rule
 *
 * The first block of `sparql_query` for a graph form is the admitted statements as N-Quads, one per line, and its `mediaType` is
 * `application/n-quads`. `charsReturned` and `bytesReturned` are the length and the bytes of exactly that text, which stays under the
 * caller's `maxChars` and `maxBytes` (past the first statement, which is admitted whole); the statements it cut are spilled. A Turtle answer
 * carries a prefix block of its own, so it broke a ceiling that the lines were measured against.
 *
 * ## Seen red
 *
 * On 3cfca318b the block is Turtle (`mediaType: text/turtle`) with a prefix block of hundreds of characters, past the ceiling, and
 * `charsReturned` measures lines the caller never received.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/an-mcp-sparql-graph-answer-keeps-its-size-ceiling-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spq-graph-ceiling';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ENTITY = 'https://w3id.org/ythril/ns#Entity';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CONSTRUCT = `CONSTRUCT { ?s <${RDFS_LABEL}> ?n } WHERE { ?s <${RDF_TYPE}> <${ENTITY}> ; <${RDFS_LABEL}> ?n }`;
const STAMP = '2026-03-04T05:06:07.000Z';
const ENTITIES = 30;

let d, tok;

describe('an MCP SPARQL graph answer keeps the size ceiling it is measured against', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-graph-ceiling', spaces: [{ id: S }] });
    await d.seed(S, 'entity', Array.from({ length: ENTITIES }, (_, i) => ({
      _id: `e-${String(i).padStart(2, '0')}`, name: `Name ${String(i).padStart(2, '0')}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP,
    })));
    tok = await d.mint('spq-graph-ceiling', { [S]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a CONSTRUCT is the admitted N-Quads lines, under maxChars and maxBytes, counted as returned, the rest spilled', async () => {
    for (const ceiling of [{ maxChars: 1_000 }, { maxBytes: 1_200 }]) {
      const m = await d.sparqlMcp(tok.key, { space: S, query: CONSTRUCT, ...ceiling });
      assert.ok(!m.isError, `${JSON.stringify(ceiling)}: ${m.text.slice(0, 300)}`);
      assert.equal(m.summary?.mediaType, 'application/n-quads', `${JSON.stringify(ceiling)}: mediaType`);
      const lines = m.document.split('\n').filter(l => l !== '');
      assert.ok(lines.length > 0 && lines.length < ENTITIES, `${JSON.stringify(ceiling)}: ${lines.length} statements returned`);
      assert.equal(new Parser({ format: 'application/n-quads' }).parse(m.document).length, lines.length, `${JSON.stringify(ceiling)}: the block is N-Quads`);
      assert.equal(m.summary.returned, lines.length, `${JSON.stringify(ceiling)}: returned`);
      assert.equal(m.summary.truncated, true);
      assert.equal(m.summary.charsReturned, m.document.length, `${JSON.stringify(ceiling)}: charsReturned measures the block`);
      assert.equal(m.summary.bytesReturned, Buffer.byteLength(m.document), `${JSON.stringify(ceiling)}: bytesReturned measures the block`);
      if (ceiling.maxChars) assert.ok(m.document.length <= ceiling.maxChars, `the block is ${m.document.length} chars over maxChars ${ceiling.maxChars}`);
      if (ceiling.maxBytes) assert.ok(Buffer.byteLength(m.document) <= ceiling.maxBytes, `the block is ${Buffer.byteLength(m.document)} bytes over maxBytes ${ceiling.maxBytes}`);
      assert.ok(m.summary.remainder?.spillId, `${JSON.stringify(ceiling)}: the cut statements are not spilled: ${JSON.stringify(m.summary).slice(0, 300)}`);
    }
  });

  it('an answer under the ceiling is every statement, untruncated, as N-Quads', async () => {
    const m = await d.sparqlMcp(tok.key, { space: S, query: CONSTRUCT });
    assert.ok(!m.isError, m.text.slice(0, 300));
    assert.equal(m.summary?.mediaType, 'application/n-quads');
    assert.equal(m.summary.truncated, false);
    assert.equal(new Parser({ format: 'application/n-quads' }).parse(m.document).length, ENTITIES);
    assert.equal(m.summary.charsReturned, m.document.length);
    assert.equal(m.summary.bytesReturned, Buffer.byteLength(m.document));
  });
});
