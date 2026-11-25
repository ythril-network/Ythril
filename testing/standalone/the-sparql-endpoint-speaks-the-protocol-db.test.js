/**
 * The SPARQL endpoint answers on every door of the SPARQL 1.1 Protocol, and refuses with a named code where it does not (bundle-271, Q-757;
 * design §2, r2 R2.2, R3.2, R3.5).
 *
 * ## The rules
 *
 * 1. **One answer on every door.** `GET ?query=`, `POST` `application/sparql-query` and `POST` urlencoded `query=` answer the same SPARQL
 *    results JSON for one SELECT, and MCP `sparql_query` answers the same body; `HEAD` answers the `GET`'s status and Content-Type with no
 *    body.
 * 2. **Formats by Accept.** A SELECT answers CSV and TSV; an ASK answers JSON `{head, boolean}` and, in CSV and TSV, `true` or `false` under a
 *    header row; a CONSTRUCT answers Turtle by default and N-Quads by Accept. An Accept naming nothing the answer has is `406`, a POST of any
 *    other media type `415`.
 * 3. **Named refusals.** A body over the text cap is `413 sparql_query_too_large`; an update, by `update=` or `application/sparql-update`,
 *    is `400 sparql_update_not_here`; a `default-graph-uri` outside the caller's members answers an empty result, never a refusal that would
 *    say which graphs exist.
 * 4. **A graph answer is written by the export's writer.** A CONSTRUCT whose `IRI(CONCAT(...))` builds an IRI holding `>` is refused or
 *    escaped by the writer's IRIREF guard: no statement the query did not construct is ever in the document.
 *
 * ## Seen red
 *
 * On db66e206d no route answers `/api/brain/spaces/:spaceId/sparql` (404) and no tool `sparql_query` exists. Mutation: the route-level
 * text parser taking another media type (rule 1: the `application/sparql-query` door answers `400 sparql_no_query`).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then node --test testing/standalone/the-sparql-endpoint-speaks-the-protocol-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, baseOf, rowTexts, RESULTS_JSON } from './_sparql-doors.mjs';
import { recordProcessFaults } from './_quad-source-faults.mjs';

const skip = await mongoSkipReason();
/** Every unhandled rejection and uncaught exception of the file's run: the server ends its process on either, so none may be raised. */
const faults = recordProcessFaults();
const S = 'spq-protocol';
const OTHER = 'spq-protocol-other';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
/** An entity's class: the records' writer (an agent) has a label too, and the queries here ask for the entities alone. */
const ENTITY = 'https://w3id.org/ythril/ns#Entity';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SELECT = `SELECT ?s ?n WHERE { ?s <${RDF_TYPE}> <${ENTITY}> ; <${RDFS_LABEL}> ?n } ORDER BY ?n`;
const ASK = `ASK { ?s <${RDFS_LABEL}> "Ada" }`;
const CONSTRUCT = `CONSTRUCT { ?s <${RDFS_LABEL}> ?n } WHERE { ?s <${RDF_TYPE}> <${ENTITY}> ; <${RDFS_LABEL}> ?n }`;
const STAMP = '2026-03-04T05:06:07.000Z';

let d, reader;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;

describe('the SPARQL endpoint speaks the protocol', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-protocol', spaces: [{ id: S }, { id: OTHER }] });
    await d.seed(S, 'entity', ['Ada', 'Bea', 'Cy'].map(n => ({ _id: `e-${n.toLowerCase()}`, name: n, type: 'Person', createdAt: STAMP, updatedAt: STAMP })));
    await d.seed(OTHER, 'entity', [{ _id: 'o-1', name: 'Outside', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    reader = await d.mint('spq-reader', { [S]: d.row({ knowledge: 'read', files: 'read' }) });
  });
  after(async () => { faults.stop(); await d?.close(); });

  it('GET, POST sparql-query, POST form and MCP answer one SELECT with the same results JSON', async () => {
    const get = await d.sparqlGet(reader.key, S, SELECT);
    assert.equal(get.status, 200, `GET: ${fmt(get)}`);
    assert.match(get.headers['content-type'] ?? '', /^application\/sparql-results\+json/, 'GET Content-Type');
    assert.deepEqual(get.body?.head?.vars, ['s', 'n'], 'GET head.vars');
    assert.deepEqual(get.body.results.bindings.map(b => b.n.value), ['Ada', 'Bea', 'Cy'], 'GET rows');
    assert.equal(get.body.results.bindings[0].s.value, `${baseOf(S)}entity/e-ada`, 'GET subject address');
    const post = await d.sparqlPost(reader.key, S, SELECT);
    assert.equal(post.status, 200, `POST sparql-query: ${fmt(post)}`);
    const form = await d.sparqlPost(reader.key, S, SELECT, { as: 'form' });
    assert.equal(form.status, 200, `POST form: ${fmt(form)}`);
    const mcp = await d.sparqlMcp(reader.key, { space: S, query: SELECT });
    assert.ok(!mcp.isError, `MCP: ${mcp.text.slice(0, 300)}`);
    for (const [door, body] of [['POST sparql-query', post.body], ['POST form', form.body], ['MCP', mcp.body]]) {
      assert.deepEqual(body?.head, get.body.head, `${door} head`);
      assert.deepEqual(rowTexts(body), rowTexts(get.body), `${door} rows`);
    }
    assert.equal(Object.keys(get.body).sort().join(','), 'head,results', 'a standard results body carries no key of its own');
    assert.ok(mcp.structured && typeof mcp.structured === 'object', 'MCP answers a structured half');
  });

  it('HEAD answers the GET\'s status and Content-Type with no body', async () => {
    const head = await d.sparqlRest(reader.key, 'HEAD', d.path(S, { query: SELECT }));
    assert.equal(head.status, 200, `HEAD: ${fmt(head)}`);
    assert.match(head.headers['content-type'] ?? '', /^application\/sparql-results\+json/);
    assert.equal(head.text, '', 'HEAD carries no body');
    assert.match(head.headers['vary'] ?? '', /Accept/i, 'Vary: Accept');
  });

  it('a SELECT answers CSV and TSV by Accept', async () => {
    const csv = await d.sparqlGet(reader.key, S, SELECT, {}, { Accept: 'text/csv' });
    assert.equal(csv.status, 200, `CSV: ${fmt(csv)}`);
    assert.match(csv.headers['content-type'] ?? '', /^text\/csv/);
    assert.deepEqual(csv.text.trim().split(/\r?\n/), ['s,n', `${baseOf(S)}entity/e-ada,Ada`, `${baseOf(S)}entity/e-bea,Bea`, `${baseOf(S)}entity/e-cy,Cy`]);
    const tsv = await d.sparqlGet(reader.key, S, SELECT, {}, { Accept: 'text/tab-separated-values' });
    assert.equal(tsv.status, 200, `TSV: ${fmt(tsv)}`);
    assert.match(tsv.headers['content-type'] ?? '', /^text\/tab-separated-values/);
    assert.deepEqual(tsv.text.trim().split(/\r?\n/)[0], '?s\t?n');
    assert.deepEqual(tsv.text.trim().split(/\r?\n/)[1], `<${baseOf(S)}entity/e-ada>\t"Ada"`);
  });

  it('an ASK answers JSON, and in CSV and TSV true or false under a header row', async () => {
    const json = await d.sparqlGet(reader.key, S, ASK);
    assert.equal(json.status, 200, fmt(json));
    assert.deepEqual(json.body, { head: {}, boolean: true });
    const no = await d.sparqlGet(reader.key, S, `ASK { ?s <${RDFS_LABEL}> "Nobody" }`);
    assert.deepEqual(no.body, { head: {}, boolean: false });
    for (const accept of ['text/csv', 'text/tab-separated-values']) {
      const a = await d.sparqlGet(reader.key, S, ASK, {}, { Accept: accept });
      assert.equal(a.status, 200, `${accept}: ${fmt(a)}`);
      assert.deepEqual(a.text.trim().split(/\r?\n/), ['_askResult', 'true'], `${accept} ASK`);
    }
  });

  it('a CONSTRUCT answers Turtle by default and N-Quads by Accept, read back by an independent parser', async () => {
    const ttl = await d.sparqlGet(reader.key, S, CONSTRUCT);
    assert.equal(ttl.status, 200, fmt(ttl));
    assert.match(ttl.headers['content-type'] ?? '', /^text\/turtle/);
    const quads = new Parser({ format: 'text/turtle' }).parse(ttl.text);
    assert.deepEqual(quads.map(q => q.object.value).sort(), ['Ada', 'Bea', 'Cy']);
    const nq = await d.sparqlGet(reader.key, S, CONSTRUCT, {}, { Accept: 'application/n-quads' });
    assert.equal(nq.status, 200, fmt(nq));
    assert.match(nq.headers['content-type'] ?? '', /^application\/n-quads/);
    assert.equal(new Parser({ format: 'application/n-quads' }).parse(nq.text).length, 3);
  });

  it('an Accept naming nothing the answer has is 406, a POST of another media type 415', async () => {
    const select = await d.sparqlGet(reader.key, S, SELECT, {}, { Accept: 'image/png' });
    assert.equal(select.status, 406, fmt(select));
    assert.equal(select.body?.code, 'sparql_not_acceptable');
    const graph = await d.sparqlGet(reader.key, S, CONSTRUCT, {}, { Accept: 'application/sparql-results+json' });
    assert.equal(graph.status, 406, fmt(graph));
    assert.equal(graph.body?.code, 'rdf_format_not_acceptable');
    const other = await d.sparqlRest(reader.key, 'POST', d.path(S), { body: JSON.stringify({ query: SELECT }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(other.status, 415, fmt(other));
    assert.equal(other.body?.code, 'sparql_unsupported_media_type');
  });

  it('a body over the text cap is 413 sparql_query_too_large, on both POST forms', async () => {
    const big = `SELECT * WHERE { ?s ?p ?o } # ${'x'.repeat(70 * 1024)}`;
    for (const as of ['query', 'form']) {
      const a = await d.sparqlPost(reader.key, S, big, { as });
      assert.equal(a.status, 413, `${as}: ${fmt(a)}`);
      assert.equal(a.body?.code, 'sparql_query_too_large', `${as}: ${fmt(a)}`);
    }
  });

  it('an update is 400 sparql_update_not_here, by update= and by application/sparql-update', async () => {
    const update = `INSERT DATA { <${baseOf(S)}entity/x> <${RDFS_LABEL}> "X" }`;
    const form = await d.sparqlRest(reader.key, 'POST', d.path(S), { body: new URLSearchParams({ update }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 400, fmt(form));
    assert.equal(form.body?.code, 'sparql_update_not_here');
    const typed = await d.sparqlRest(reader.key, 'POST', d.path(S), { body: update, headers: { 'Content-Type': 'application/sparql-update' } });
    assert.equal(typed.status, 400, fmt(typed));
    assert.equal(typed.body?.code, 'sparql_update_not_here');
    const asQuery = await d.sparqlGet(reader.key, S, update);
    assert.equal(asQuery.body?.code, 'sparql_update_not_here', `an update sent as query=: ${fmt(asQuery)}`);
  });

  it('a default-graph-uri outside the caller\'s members answers empty, alike for an existing and an unknown graph', async () => {
    const own = await d.sparqlGet(reader.key, S, SELECT, { 'default-graph-uri': baseOf(S) });
    assert.equal(own.status, 200, fmt(own));
    assert.equal(own.body.results.bindings.length, 3, 'the caller\'s own member graph as the default graph');
    const outside = await d.sparqlGet(reader.key, S, SELECT, { 'default-graph-uri': baseOf(OTHER) });
    const unknown = await d.sparqlGet(reader.key, S, SELECT, { 'default-graph-uri': 'https://nowhere.example.org/g' });
    for (const [what, a] of [['a space the caller does not read', outside], ['an unknown graph', unknown]]) {
      assert.equal(a.status, 200, `${what}: ${fmt(a)}`);
      assert.deepEqual(a.body.results.bindings, [], `${what} answers rows`);
    }
  });

  it('a CONSTRUCT that builds an IRI holding ">" is refused or escaped by the writer, never a statement of its own', async () => {
    const q = `CONSTRUCT { ?s <${RDFS_LABEL}> ?x } WHERE { ?s <${RDFS_LABEL}> "Ada" . BIND(IRI(CONCAT("https://evil.example.org/a> <https://evil.example.org/p> <https://evil.example.org/o", "")) AS ?x) }`;
    for (const accept of ['text/turtle', 'application/n-quads']) {
      const a = await d.sparqlGet(reader.key, S, q, {}, { Accept: accept });
      assert.ok(a.status === 200 || a.status === 409, `${accept}: ${fmt(a)}`);
      if (a.status === 409) {
        assert.equal(a.body?.code, 'rdf_unwritable', `${accept}: ${fmt(a)}`);
        assert.ok(!a.text.includes('evil.example.org'), `${accept}: the refusal repeats the query's text`);
        continue;
      }
      const quads = new Parser({ format: accept }).parse(a.text);
      assert.ok(!quads.some(x => x.predicate.value === 'https://evil.example.org/p'), `${accept}: an injected statement is in the document`);
    }
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
