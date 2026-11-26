/**
 * A SPARQL view answers the same refusal for the same cause on every door that reads it, and never answers a wrong reason (bundle-273,
 * Q-762, review S5 findings K1, K2 and K6, and the unproven points W1, W2 and W6).
 *
 * ## The rules
 *
 * 1. **One cause, one code (K1).** A CONSTRUCT whose members hold more records than `sparql.maxRecordsRead` is `413 sparql_too_much_read` on
 *    the RDF export (REST and MCP), the SPARQL query endpoint (REST and MCP) and the view's Linked Data address. Only the cap of statements
 *    is `view_construct_too_large`; no other bound is answered as it.
 * 2. **A budget is not a cap (K2).** A page of a SPARQL view's export whose document passes the caller's budget is `413
 *    rdf_export_budget_exceeded`, on MCP `export_rdf` (default budget) and on REST with `maxChars`: never `view_construct_too_large`, which
 *    says the CONSTRUCT is too large, and which raising the budget would not fix.
 * 3. **A stored query is judged by the same rules as a saved one (K6).** A hand-edited `config.json` view whose `sparql.query` is empty or
 *    past 16 384 bytes is refused when the config loads; one that is a SELECT (a text the shape cannot judge) is answered
 *    `409 view_sparql_not_construct` on every door, never `sparql_malformed` nor `view_construct_too_large`.
 * 4. **A CONSTRUCT that makes a literal subject (W1)** (`CONSTRUCT { ?o ?p ?s } WHERE { ?s ?p ?o }`) is answered by every door alike and by
 *    none as a 500.
 * 5. **A statement made twice is one statement (W2).** The cap counts the statements of the graph, not the solutions that made them.
 * 6. **No graph in the template (W6).** A `GRAPH` block in a CONSTRUCT template is refused at save with `400 view_sparql_invalid`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-view-refusal-is-one-answer-on-every-door-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { fiveDoors } from './_sparql-view-doors.mjs';

const skip = await mongoSkipReason();
const WIDE = 'q762c-wide';
const DUP = 'q762c-dup';
const SMALL = 'q762c-small';
const STAMP = '2026-03-04T05:06:07.000Z';
const ENTITY = 'https://w3id.org/ythril/ns#Entity';
const KEEP_ENTITIES = `CONSTRUCT { ?s ?p ?o } WHERE { ?s a <${ENTITY}> ; ?p ?o }`;
const entities = (n, prefix) => Array.from({ length: n }, (_, i) => ({ _id: `${prefix}-${i}`, name: `Entity ${prefix} ${i}`, type: 'Thing', createdAt: STAMP, updatedAt: STAMP }));

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const setLimits = (sparql) => d.loader.mutateConfig(cfg => { cfg.sparql = sparql; });
async function view(name, members, query) {
  const r = await d.rest(tok.key, 'POST', '/api/views', { name, members, sparql: { query } });
  assert.equal(r.status, 201, `create ${name}: ${fmt(r)}`);
  return `@${name}`;
}
/** The doors' answers without the headers, for comparing. */
const plain = (answers) => Object.fromEntries(Object.entries(answers).map(([door, a]) => [door, a.code === undefined ? { status: a.status, ...(a.triples ? { triples: a.triples } : {}), ...(a.rows ? { rows: a.rows } : {}) } : { status: a.status, code: a.code }]));

describe('a SPARQL view answers one refusal for one cause on every door', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q762c-refusal', spaces: [{ id: WIDE }, { id: DUP }, { id: SMALL }] });
    await d.seed(WIDE, 'entity', entities(1_100, 'w'));
    await d.seed(DUP, 'entity', entities(260, 'd'));
    await d.seed(SMALL, 'entity', entities(3, 's'));
    tok = await d.mint('q762c-refusal', { [WIDE]: d.row({ knowledge: 'read' }), [DUP]: d.row({ knowledge: 'read' }), [SMALL]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a CONSTRUCT over more records than sparql.maxRecordsRead is 413 sparql_too_much_read on all five doors (K1)', async () => {
    const id = await view('q762c-read-cap', [WIDE], KEEP_ENTITIES);
    await setLimits({ maxRecordsRead: 1_000 });
    try {
      const answers = plain(await fiveDoors(d, tok.key, id));
      assert.deepEqual(answers, {
        export: { status: 413, code: 'sparql_too_much_read' }, exportMcp: { status: 'refused', code: 'sparql_too_much_read' },
        sparql: { status: 413, code: 'sparql_too_much_read' }, sparqlMcp: { status: 'refused', code: 'sparql_too_much_read' },
        ld: { status: 413, code: 'sparql_too_much_read' },
      });
    } finally { await setLimits(undefined); }
  });

  it('a page of the export past the caller\'s budget is 413 rdf_export_budget_exceeded, not the cap\'s code (K2)', async () => {
    const id = await view('q762c-budget', [WIDE], KEEP_ENTITIES);
    // The default budget of an MCP call (25 000 characters) is smaller than the document of 1 100 entities.
    const viaMcp = await d.toolCall(tok.key, 'export_rdf', { space: id, format: 'nquads' });
    assert.ok(viaMcp.isError, 'MCP: the page past the default budget was answered');
    assert.equal(viaMcp.structured?.code, 'rdf_export_budget_exceeded', `MCP: ${viaMcp.text.slice(0, 300)}`);
    const viaRest = await d.sparqlRest(tok.key, 'GET', `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf?format=nquads&maxChars=1000`);
    assert.equal(viaRest.status, 413, fmt(viaRest));
    assert.equal(viaRest.body?.code, 'rdf_export_budget_exceeded');
    const whole = await d.sparqlRest(tok.key, 'GET', `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf?format=nquads`);
    assert.equal(whole.status, 200, `the whole export has no budget: ${fmt(whole)}`);
  });

  it('a hand-edited view with an empty query or one past 16 384 bytes is refused at load; exactly 16 384 bytes is accepted (K6)', async () => {
    const { validateViews } = await import('../../server/dist/config/view-shape.js');
    const base = { id: '@q762c-edit', name: 'q762c-edit', ownerId: 'token:t1', members: [SMALL], createdAt: STAMP };
    const withQuery = (query) => [{ ...base, sparql: { query } }];
    const header = `${KEEP_ENTITIES}\n# `;
    const padded = (bytes) => `${header}${'x'.repeat(bytes - Buffer.byteLength(header, 'utf8'))}`;
    assert.equal(Buffer.byteLength(padded(16 * 1024), 'utf8'), 16 * 1024);
    assert.doesNotThrow(() => validateViews(withQuery(padded(16 * 1024))), '16 384 bytes is accepted');
    assert.throws(() => validateViews(withQuery(padded(16 * 1024 + 1))), /sparql/, '16 385 bytes is refused');
    assert.throws(() => validateViews(withQuery('')), /sparql/, 'an empty query is refused');
    assert.throws(() => validateViews(withQuery('  \n ')), /sparql/, 'a blank query is refused');
  });

  it('a stored view that is no CONSTRUCT is 409 view_sparql_not_construct on all five doors (K6)', async () => {
    d.loader.mutateConfig(cfg => {
      cfg.views = [...(cfg.views ?? []), {
        id: '@q762c-select', name: 'q762c-select', ownerId: `token:${tok.id}`, members: [SMALL], createdAt: STAMP, sparql: { query: 'SELECT ?s WHERE { ?s ?p ?o }' },
      }];
    });
    const answers = plain(await fiveDoors(d, tok.key, '@q762c-select'));
    assert.deepEqual(answers, {
      export: { status: 409, code: 'view_sparql_not_construct' }, exportMcp: { status: 'refused', code: 'view_sparql_not_construct' },
      sparql: { status: 409, code: 'view_sparql_not_construct' }, sparqlMcp: { status: 'refused', code: 'view_sparql_not_construct' },
      ld: { status: 409, code: 'view_sparql_not_construct' },
    });
  });

  it('a CONSTRUCT that makes a literal subject is answered alike by every door and by none as a 500 (W1)', async () => {
    const id = await view('q762c-swapped', [SMALL], 'CONSTRUCT { ?o ?p ?s } WHERE { ?s ?p ?o }');
    const answers = await fiveDoors(d, tok.key, id);
    for (const [door, a] of Object.entries(answers)) assert.notEqual(a.status, 500, `${door}: answered 500`);
    const classes = Object.entries(plain(answers)).map(([door, a]) => [door, a.code !== undefined ? `refused ${a.code}` : `answered ${(a.triples ?? a.rows).length}`]);
    // The CONSTRUCT's graph is what is left of it once the statements no RDF graph holds are dropped; every door says that, with one count.
    assert.equal(new Set(classes.map(([, c]) => c)).size, 1, `the doors differ: ${JSON.stringify(classes)}`);
  });

  it('a statement the CONSTRUCT makes 67 600 times is one statement and no refusal (W2)', async () => {
    const id = await view('q762c-dups', [DUP], `CONSTRUCT { <urn:q762c:a> <urn:q762c:p> <urn:q762c:c> } WHERE { ?a a <${ENTITY}> . ?b a <${ENTITY}> }`);
    const answers = await fiveDoors(d, tok.key, id);
    for (const [door, a] of Object.entries(answers)) {
      assert.equal(a.status, 200, `${door}: ${JSON.stringify({ status: a.status, code: a.code })}`);
      assert.equal((a.triples ?? a.rows).length, 1, `${door}: the one statement`);
    }
  });

  it('a GRAPH block in the CONSTRUCT template is refused at save with 400 view_sparql_invalid (W6)', async () => {
    const r = await d.rest(tok.key, 'POST', '/api/views', { name: 'q762c-graph', members: [SMALL], sparql: { query: 'CONSTRUCT { GRAPH <urn:q762c:g> { ?s ?p ?o } } WHERE { ?s ?p ?o }' } });
    assert.equal(r.status, 400, fmt(r));
    assert.equal(r.body?.code, 'view_sparql_invalid');
  });
});
