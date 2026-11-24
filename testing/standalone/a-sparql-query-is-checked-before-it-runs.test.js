/**
 * A SPARQL query is judged before the engine runs it: too long a text, a text that does not parse, an update, and a regular expression the
 * server cannot bound are each refused with their named code, and no refusal repeats the query's text (bundle-271, Q-756; design §1.3,
 * r2 R2.2, R2.5, R4.6).
 *
 * ## What it prevents
 *
 * - **A parser fed without a bound.** The text is measured in UTF-8 bytes before it is parsed: past 64 KiB, `413 sparql_query_too_large`.
 * - **A parse error that echoes the query.** `400 sparql_malformed` names the line and column the parser stopped at and nothing of the text,
 *   which may hold what the caller would not have logged.
 * - **A write through the read door.** Any update (`INSERT DATA`, `DELETE WHERE`, `CLEAR`, `DROP`, `CREATE`, `LOAD`) is
 *   `400 sparql_update_not_here`.
 * - **A pattern the server cannot bound.** `REGEX` and `REPLACE` run a caller's pattern on every row; one that is not a literal, has flags
 *   that are not a literal, is longer than `MAX_PATTERN_LENGTH` or fails `hasReDoSRisk` is `400 sparql_pattern_refused`.
 *
 * ## Seen red
 *
 * On 2bfffd806: `server/src/rdf/sparql-engine.ts` does not exist. Mutation (seen red once it exists): the REGEX check skipped for `REPLACE`.
 *
 * Run: node --test testing/standalone/a-sparql-query-is-checked-before-it-runs.test.js (a prior `npm run build:server`).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const SECRET = 'q756-secret-literal-7f3a';
let engine;

const check = async (text) => needModule(engine, ['checkSparqlAlgebra'], 'the SPARQL engine').checkSparqlAlgebra(text);
const codeOf = async (text) => {
  const r = await check(text);
  return 'refusal' in r ? r.refusal.code : 'accepted';
};

describe('a SPARQL query is checked before it runs', () => {
  before(async () => { engine = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url); });

  it('a text past 64 KiB in UTF-8 bytes is 413 sparql_query_too_large; one at the bound is parsed', async () => {
    const at = (bytes) => { const head = 'SELECT * WHERE { ?s ?p ?o } #'; return head + 'é'.repeat(Math.floor((bytes - head.length) / 2)) + (((bytes - head.length) % 2) ? 'x' : ''); };
    const over = await check(at(64 * 1024 + 1));
    assert.equal(over.refusal?.code, 'sparql_query_too_large');
    assert.equal(over.refusal.status, 413);
    assert.equal(await codeOf(at(64 * 1024)), 'accepted', 'a text of exactly 64 KiB was refused');
  });

  it('a text that does not parse is 400 sparql_malformed naming its line and column, and nothing of the text', async () => {
    const r = await check(`SELECT * WHERE {\n  ?s ?p "${SECRET}" .\n  FILTER( }`);
    assert.equal(r.refusal?.code, 'sparql_malformed');
    assert.equal(r.refusal.status, 400);
    assert.equal(r.refusal.line, 3);
    assert.ok(Number.isInteger(r.refusal.column) && r.refusal.column > 0, `column ${r.refusal.column}`);
    assert.ok(!r.refusal.error.includes(SECRET) && !r.refusal.error.includes('FILTER'), `the refusal echoes the query: ${r.refusal.error}`);
  });

  for (const [what, text] of [
    ['INSERT DATA', 'INSERT DATA { <urn:a> <urn:b> <urn:c> }'],
    ['DELETE WHERE', 'DELETE WHERE { ?s ?p ?o }'],
    ['CLEAR', 'CLEAR ALL'],
    ['DROP', 'DROP GRAPH <urn:g>'],
    ['CREATE', 'CREATE GRAPH <urn:g>'],
    ['LOAD', 'LOAD <urn:g>'],
  ]) {
    it(`${what} is 400 sparql_update_not_here`, async () => {
      const r = await check(text);
      assert.equal(r.refusal?.code, 'sparql_update_not_here');
      assert.equal(r.refusal.status, 400);
    });
  }

  for (const [what, text, want] of [
    ['a literal pattern', 'SELECT * WHERE { ?s ?p ?o FILTER regex(?o, "^Ada", "i") }', 'accepted'],
    ['a pattern from a variable', 'SELECT * WHERE { ?s ?p ?o FILTER regex(?o, ?p) }', 'sparql_pattern_refused'],
    ['flags from a variable', 'SELECT * WHERE { ?s ?p ?o FILTER regex(?o, "a", ?p) }', 'sparql_pattern_refused'],
    ['a nested quantifier', 'SELECT * WHERE { ?s ?p ?o FILTER regex(?o, "(a+)+$") }', 'sparql_pattern_refused'],
    ['a pattern past the length bound', `SELECT * WHERE { ?s ?p ?o FILTER regex(?o, "${'a'.repeat(501)}") }`, 'sparql_pattern_refused'],
    ['REPLACE with a nested quantifier', 'SELECT * WHERE { ?s ?p ?o BIND(REPLACE(?o, "(x*)*y", "z") AS ?r) }', 'sparql_pattern_refused'],
    ['REPLACE with a pattern from a variable', 'SELECT * WHERE { ?s ?p ?o BIND(REPLACE(?o, ?p, "z") AS ?r) }', 'sparql_pattern_refused'],
    ['REPLACE with a literal pattern', 'SELECT * WHERE { ?s ?p ?o BIND(REPLACE(?o, "a", "b") AS ?r) }', 'accepted'],
    ['a regex inside EXISTS', 'ASK { ?s ?p ?o FILTER EXISTS { ?s ?q ?r FILTER regex(?r, "(b+)+$") } }', 'sparql_pattern_refused'],
  ]) {
    it(`REGEX/REPLACE with ${what}: ${want}`, async () => {
      const r = await check(text);
      assert.equal('refusal' in r ? r.refusal.code : 'accepted', want);
      if (want !== 'accepted') assert.equal(r.refusal.status, 400);
    });
  }

  it('an accepted query hands back the algebra the engine will run, so it is parsed once', async () => {
    const r = await check('SELECT ?s WHERE { ?s ?p ?o }');
    assert.ok('algebra' in r, JSON.stringify(r));
    assert.equal(r.algebra.type, 'project');
  });
});
