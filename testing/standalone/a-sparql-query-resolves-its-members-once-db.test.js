/**
 * A SPARQL query, and an Update, resolve their RDF members once per request (bundle-378, Q-976, S1, contract row 3).
 *
 * ## The rule
 *
 * `rdfMembers` (which spaces of a read are members, under which names and rights) ran twice for every query: once while the query was
 * prepared, and again when its quad source was made, each run paying the schema checks (a probe at BSBM 1 000 measured about 22 ms each).
 * The quad source now reuses what the preparation resolved, so the request's phase timer counts ONE `members` phase:
 *
 *  - a SPARQL query by GET, by POST and by MCP `sparql_query` (its `_meta`) names `members` once;
 *  - a SPARQL Update names `members` once (it resolved its one space, then made its source over the same space).
 *
 * The count is read where an operator reads it: the `Server-Timing` entry's `desc="n=<count>"` (absent for one), and the MCP result's
 * `_meta` `ythril/server-timing` `count`.
 *
 * ## Seen red
 *
 * On 42c51f330 no answer names a `members` phase (no `Server-Timing` at all); with the phase timer and without the reuse, the count is 2.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-sparql-query-resolves-its-members-once-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { serverTimingOf, mcpTimingOf, mcpCallResult } from './_server-timing.mjs';

const skip = await mongoSkipReason();
const A = 'q976-once-a';
const B = 'q976-once-b';
const STAMP = '2026-03-04T05:06:07.000Z';
const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';
const NO_OP = 'DELETE { ?s <urn:q976:none> ?o } WHERE { ?s <urn:q976:none> ?o }';

let d, reader, writer;

/** The member resolutions a `Server-Timing` header counts, with the header for the message. */
function membersCounted(r) {
  const timing = serverTimingOf(r.headers['server-timing']);
  assert.ok(timing?.has('members'), `the answer (${r.status}) names no members phase: ${JSON.stringify(r.headers['server-timing'] ?? null)}`);
  return timing.get('members').count;
}

describe('a SPARQL query resolves its members once', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q976-once', spaces: [{ id: A }, { id: B }] });
    await d.seed(A, 'entity', [{ _id: 'ea', name: 'Ada', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(B, 'entity', [{ _id: 'eb', name: 'Bea', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    reader = await d.mint('q976-once-reader', { [A]: d.row({ knowledge: 'read' }), [B]: d.row({ knowledge: 'read' }) });
    writer = await d.mint('q976-once-writer', { [A]: d.row({ knowledge: 'write' }) });
  });
  after(async () => { await d?.close(); });

  it('a query by GET and by POST counts one member resolution', async () => {
    const get = await d.sparqlGet(reader.key, A, ALL);
    assert.equal(get.status, 200, get.text.slice(0, 300));
    assert.equal(membersCounted(get), 1, `GET resolved its members more than once: ${get.headers['server-timing']}`);
    const post = await d.sparqlPost(reader.key, A, ALL);
    assert.equal(post.status, 200, post.text.slice(0, 300));
    assert.equal(membersCounted(post), 1, `POST resolved its members more than once: ${post.headers['server-timing']}`);
  });

  it('MCP sparql_query counts one member resolution in its _meta', async () => {
    const result = await mcpCallResult(d.server.url, reader.key, 'sparql_query', { space: A, query: ALL });
    assert.ok(result && !result.isError && !result.error, `the tool call failed: ${JSON.stringify(result).slice(0, 300)}`);
    const timing = mcpTimingOf(result);
    assert.ok(timing?.has('members'), `the tool result names no members phase: ${JSON.stringify(result._meta ?? null)}`);
    assert.equal(timing.get('members').count, 1, `sparql_query resolved its members more than once: ${JSON.stringify(result._meta)}`);
  });

  it('an Update counts one member resolution', async () => {
    const r = await d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/sparql/update`, { body: NO_OP, headers: { 'Content-Type': 'application/sparql-update' } });
    assert.ok(r.status < 300, `${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(membersCounted(r), 1, `the Update resolved its members more than once: ${r.headers['server-timing']}`);
  });
});
