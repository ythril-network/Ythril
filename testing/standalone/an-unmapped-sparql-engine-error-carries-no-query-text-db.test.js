/**
 * An engine error the act does not map is rethrown as a fixed text naming only its class, so no query text reaches a log line, an error
 * body or an audit row (bundle-271, Q-757, review unproven 1; design r2 R5).
 *
 * ## The rule
 *
 * A query whose FILTER calls an extension function the engine does not know, by an IRI holding a marker string, ends in an engine error
 * whose own message may name that IRI. `answerSparql` catches it and throws `SparqlEngineFailure`: a fixed sentence and the error's class
 * name, the cause dropped. The marker is then in no log line (the failure is reported through `sendCaughtFailure`, which logs the error),
 * no response body and no audit row, on REST `GET`, REST `POST` and MCP; the answer is a `500` with the app's generic body (or a refusal
 * of its own that holds no text of the query).
 *
 * ## Seen red
 *
 * On 3cfca318b the engine's message, with the marker, is rethrown as it is and reaches the log line of `sendCaughtFailure`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/an-unmapped-sparql-engine-error-carries-no-query-text-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spq-engine-error';
const OP = 'brain.sparql_query';
/** A marker no sentence of the server holds: found anywhere, it came from the query's text. */
const MARK = 'zq7enginemarker';
const STAMP = '2026-03-04T05:06:07.000Z';
const UNKNOWN_FUNCTION = `SELECT ?s WHERE { ?s ?p ?o FILTER(<https://example.org/${MARK}/fn>(?o)) }`;

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;

describe('an unmapped SPARQL engine error carries no query text', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-engine-error', spaces: [{ id: S }] });
    await d.seed(S, 'entity', [{ _id: 'e-1', name: 'One', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    tok = await d.mint('spq-engine-error', { [S]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('an unknown extension function named by an IRI with a marker leaves the marker in no log line, body or audit row, on every door', async () => {
    const before_ = (await auditRowsOf(d.door.mongo, { operation: OP })).length;
    const { lines, result } = await logLinesDuring(async () => ({
      get: await d.sparqlGet(tok.key, S, UNKNOWN_FUNCTION),
      post: await d.sparqlPost(tok.key, S, UNKNOWN_FUNCTION),
      mcp: await d.sparqlMcp(tok.key, { space: S, query: UNKNOWN_FUNCTION }),
    }));
    for (const [door, a] of [['GET', result.get], ['POST', result.post]]) {
      assert.ok(!a.text.includes(MARK), `${door}: the body repeats the query: ${fmt(a)}`);
    }
    assert.ok(!result.mcp.text.includes(MARK), `MCP: the answer repeats the query: ${result.mcp.text.slice(0, 300)}`);
    assert.deepEqual(lines.filter(l => l.includes(MARK)), [], 'a log line repeats the query');
    const rows = (await auditRowsOf(d.door.mongo, { operation: OP })).slice(before_);
    assert.equal(rows.length, 3, `rows: ${rows.map(r => `${r.method} ${r.status}`).join(', ')}`);
    assert.deepEqual(rows.filter(r => JSON.stringify(r).includes(MARK)).map(r => r.method), [], 'an audit row holds the query\'s text');
    // The error took the unmapped path: a fault, named by its class only (a mapped refusal would hold a code of its own).
    for (const [door, a] of [['GET', result.get], ['POST', result.post]]) {
      assert.equal(a.status, 500, `${door}: the unknown function is no engine fault: ${fmt(a)}`);
    }
  });
});
