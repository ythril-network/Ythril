/**
 * A SPARQL query the endpoint refuses after it ran is audited by its counts, with the refusal's code as its outcome (bundle-271, Q-757,
 * review m1; design r2 R5).
 *
 * ## The rule
 *
 * The audit row of `brain.sparql_query` carries form, length, member count, records read, rows and `outcome` on every path of the act, not
 * only the answered one: a query refused for too many rows or for reading too much records `outcome` = the refusal's code, `rows` 0 (no row
 * was answered) and the records read up to the refusal, on REST `GET`, REST `POST` and MCP. An answered query keeps `outcome: answered`.
 * The row never holds the query's text.
 *
 * ## Seen red
 *
 * On 3cfca318b the refused row has no counts at all (`changes` empty) and a refusal's outcome is absent. On d78b20280 (lens-3) a refusal of the
 * parameters and an engine failure still left `changes` empty: their rows now hold the counts they know and the code, or `engine_failed`, as
 * the outcome.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-refused-sparql-query-is-audited-by-its-counts-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { recordProcessFaults } from './_quad-source-faults.mjs';

const skip = await mongoSkipReason();
/** Every unhandled rejection and uncaught exception of the file's run: the server ends its process on either, so none may be raised. */
const faults = recordProcessFaults();
const S = 'spq-refused-audit';
const OP = 'brain.sparql_query';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ENTITY_LABELS = `?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/ythril/ns#Entity> ; <${RDFS_LABEL}> ?n`;
const LABELS = `SELECT ?s ?n WHERE { ${ENTITY_LABELS} }`;
/** Reads every record and answers none of them: the read bound ends it. */
const SCAN = 'SELECT * WHERE { ?s ?p ?o }';
const STAMP = '2026-03-04T05:06:07.000Z';
const ENTITIES = 1_500;

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const setLimits = (sparql) => d.loader.mutateConfig(cfg => { cfg.sparql = sparql; });
const fieldsOf = (row) => Object.fromEntries((row.changes ?? []).map(c => [c.field, c.to]));

/** The audit rows this step added, the three doors in order GET, POST, MCP. */
async function rowsOf(step) {
  const before_ = (await auditRowsOf(d.door.mongo, { operation: OP })).length;
  await step();
  return (await auditRowsOf(d.door.mongo, { operation: OP })).slice(before_);
}

describe('a refused SPARQL query is audited by its counts', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-refused-audit', spaces: [{ id: S }] });
    await d.seed(S, 'entity', Array.from({ length: ENTITIES }, (_, i) => ({ _id: `e-${i}`, name: `N${i}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP })));
    tok = await d.mint('spq-refused-audit', { [S]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { faults.stop(); await d?.close(); });

  for (const [what, sparql, query, code, rows] of [
    ['an answer over maxResults', { maxResults: 5 }, LABELS, 'sparql_too_many_results', 0],
    ['a read past maxRecordsRead', { maxRecordsRead: 1_000 }, SCAN, 'sparql_too_much_read', 0],
  ]) {
    it(`${what} is a row with its form, length, members, records read, rows 0 and the refusal's code, on GET, POST and MCP`, async () => {
      await setLimits(sparql);
      try {
        const rows_ = await rowsOf(async () => {
          const get = await d.sparqlGet(tok.key, S, query);
          assert.equal(get.status, 413, `GET: ${fmt(get)}`);
          assert.equal(get.body?.code, code, `GET: ${fmt(get)}`);
          const post = await d.sparqlPost(tok.key, S, query);
          assert.equal(post.status, 413, `POST: ${fmt(post)}`);
          const mcp = await d.sparqlMcp(tok.key, { space: S, query });
          assert.ok(mcp.isError && mcp.text.includes(code), `MCP: ${mcp.text.slice(0, 300)}`);
        });
        assert.equal(rows_.length, 3, `rows: ${rows_.map(r => `${r.method} ${r.status}`).join(', ')}`);
        for (const r of rows_) {
          const f = fieldsOf(r);
          assert.equal(f.form, 'select', `${r.method}: form (${JSON.stringify(r.changes)})`);
          assert.equal(f.length, Buffer.byteLength(query), `${r.method}: length`);
          assert.equal(f.members, 1, `${r.method}: members`);
          assert.equal(f.rows, rows, `${r.method}: rows`);
          assert.ok(f.recordsRead > 0, `${r.method}: recordsRead ${f.recordsRead}`);
          assert.equal(f.outcome, code, `${r.method}: outcome`);
          assert.ok(!JSON.stringify(r).includes('?s'), `${r.method}: the row holds the query's text`);
        }
      } finally { await setLimits(undefined); }
    });
  }

  for (const [what, query, params, status, code] of [
    ['a text that does not parse (a refusal of the parameters)', 'SELEC ?s WHERE { ?s ?p ?o }', {}, 400, 'sparql_malformed'],
    ['a limit that is no whole number (a refusal of the parameters)', LABELS, { limit: 'many' }, 400, 'sparql_bad_limit'],
  ]) {
    it(`${what} is a row with its length, members, nothing read and its code as the outcome, on GET and POST (lens-3 audit counts)`, async () => {
      const rows_ = await rowsOf(async () => {
        const get = await d.sparqlGet(tok.key, S, query, params);
        assert.equal(get.status, status, `GET: ${fmt(get)}`);
        assert.equal(get.body?.code, code, `GET: ${fmt(get)}`);
        const post = await d.sparqlPost(tok.key, S, query, { params });
        assert.equal(post.status, status, `POST: ${fmt(post)}`);
      });
      assert.equal(rows_.length, 2, `rows: ${rows_.map(r => `${r.method} ${r.status}`).join(', ')}`);
      for (const r of rows_) {
        const f = fieldsOf(r);
        assert.equal(f.outcome, code, `${r.method}: outcome (${JSON.stringify(r.changes)})`);
        assert.equal(f.length, Buffer.byteLength(query), `${r.method}: length`);
        assert.equal(f.members, 1, `${r.method}: members`);
        assert.equal(f.rows, 0, `${r.method}: rows`);
        assert.equal(f.recordsRead, 0, `${r.method}: recordsRead`);
      }
    });
  }

  it('an engine failure is a row with its counts and the outcome engine_failed, on GET, POST and MCP, and holds no text of the query (lens-3 audit counts)', async () => {
    const query = 'SELECT ?s WHERE { ?s ?p ?o FILTER(<https://example.org/zq7auditmarker/fn>(?o)) }';
    const rows_ = await rowsOf(async () => {
      assert.equal((await d.sparqlGet(tok.key, S, query)).status, 500);
      assert.equal((await d.sparqlPost(tok.key, S, query)).status, 500);
      assert.equal((await d.sparqlMcp(tok.key, { space: S, query })).isError, true);
    });
    assert.equal(rows_.length, 3, `rows: ${rows_.map(r => `${r.method} ${r.status}`).join(', ')}`);
    for (const r of rows_) {
      const f = fieldsOf(r);
      assert.equal(f.outcome, 'engine_failed', `${r.method}: outcome (${JSON.stringify(r.changes)})`);
      assert.equal(f.form, 'select', `${r.method}: form`);
      assert.equal(f.length, Buffer.byteLength(query), `${r.method}: length`);
      assert.ok(!JSON.stringify(r).includes('zq7auditmarker'), `${r.method}: the row holds the query's text`);
    }
  });

  it('an answered query keeps outcome answered beside it', async () => {
    const rows_ = await rowsOf(async () => {
      const get = await d.sparqlGet(tok.key, S, `${LABELS} LIMIT 3`);
      assert.equal(get.status, 200, fmt(get));
    });
    assert.equal(rows_.length, 1);
    assert.equal(fieldsOf(rows_[0]).outcome, 'answered');
    assert.equal(fieldsOf(rows_[0]).rows, 3);
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
