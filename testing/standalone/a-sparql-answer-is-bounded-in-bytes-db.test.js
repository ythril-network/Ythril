/**
 * A SPARQL answer and a Linked Data answer are bounded in bytes as well as in rows (bundle-271, Q-756, Q-757, Q-758, lens-2 P1).
 *
 * ## The rule
 *
 * `sparql.maxResults` bounds the rows, and a record may be up to 10 MB: 10 000 rows of long literals reach gigabytes in the server's memory
 * before the first byte is sent. `sparql.maxResultBytes` (default 64 MiB, validated from 1 MiB to 1 GiB) bounds the bytes of every term value
 * an answer holds: the read is ended and the answer is `413 sparql_answer_too_large` with no row of it, on REST and MCP, for SELECT and
 * CONSTRUCT alike. `/ld/` answers the same code for a record whose own statements pass it. An answer under the bound is unchanged.
 *
 * ## Seen red
 *
 * On d78b20280 the key is unknown (the config is refused at load) and every answer under the row bound is a 200, however many bytes.
 * Mutation: the byte count left out of the collect step (the answer is a 200).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then node --test testing/standalone/a-sparql-answer-is-bounded-in-bytes-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spq-bytes';
const PUBLIC = 'https://rdf.example.org';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const LABELS = `SELECT ?s ?n WHERE { ?s <${RDFS_LABEL}> ?n }`;
/** The four long names alone (not the 2 MiB one, which is the /ld/ case). */
const LONG_ROWS = `SELECT ?s ?n WHERE { ?s <${RDFS_LABEL}> ?n . FILTER(STRLEN(?n) > 100 && STRLEN(?n) < 500000) }`;
const CONSTRUCT = `CONSTRUCT { ?s <${RDFS_LABEL}> ?n } WHERE { ?s <${RDFS_LABEL}> ?n . FILTER(STRLEN(?n) > 100 && STRLEN(?n) < 500000) }`;
const ONE_MIB = 1_048_576;
/** Four records of 400 000 bytes of name each: 1.6 MB of answer in four rows, far under any row bound. */
const LONG = 400_000;
const STAMP = '2026-03-04T05:06:07.000Z';

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const setLimits = (sparql) => d.loader.mutateConfig(cfg => { cfg.sparql = sparql; });
const previousPublic = process.env['PUBLIC_BASE_URL'];

describe('a SPARQL answer is bounded in bytes', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'lens2-bytes', spaces: [{ id: S }] });
    await d.seed(S, 'entity', [
      ...Array.from({ length: 4 }, (_, i) => ({ _id: `long-${i}`, name: `${i}${'x'.repeat(LONG)}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP })),
      { _id: 'short', name: 'Short', type: 'Person', createdAt: STAMP, updatedAt: STAMP },
      { _id: 'huge', name: 'y'.repeat(2 * ONE_MIB), type: 'Person', createdAt: STAMP, updatedAt: STAMP },
    ]);
    tok = await d.mint('spq-bytes', { [S]: d.row({ knowledge: 'read' }) });
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await setLimits(undefined);
    await d?.close();
  });

  it('an answer under the byte bound is whole: the default holds 64 MiB', async () => {
    const a = await d.sparqlGet(tok.key, S, LABELS);
    assert.equal(a.status, 200, fmt(a));
    assert.ok(a.body.results.bindings.length >= 4);
  });

  it('a SELECT whose rows pass sparql.maxResultBytes is 413 sparql_answer_too_large with no row of it, on REST and MCP; one under it is whole', async () => {
    await setLimits({ maxResultBytes: ONE_MIB, maxResults: 100 });
    try {
      const over = await d.sparqlGet(tok.key, S, LONG_ROWS);
      assert.equal(over.status, 413, fmt(over));
      assert.equal(over.body?.code, 'sparql_answer_too_large');
      assert.equal(over.body?.results, undefined, 'a refusal carries rows');
      const m = await d.sparqlMcp(tok.key, { space: S, query: LONG_ROWS });
      assert.ok(m.isError && m.text.includes('sparql_answer_too_large'), `MCP: ${m.text.slice(0, 300)}`);
      const fits = await d.sparqlGet(tok.key, S, `${LONG_ROWS} LIMIT 2`);
      assert.equal(fits.status, 200, `two rows of 400 000 bytes: ${fmt(fits)}`);
      assert.equal(fits.body.results.bindings.length, 2);
    } finally { await setLimits(undefined); }
  });

  it('a CONSTRUCT whose statements pass the bound is the same 413', async () => {
    await setLimits({ maxResultBytes: ONE_MIB, maxResults: 100 });
    try {
      const over = await d.sparqlGet(tok.key, S, CONSTRUCT, {}, { Accept: 'application/n-quads' });
      assert.equal(over.status, 413, fmt(over));
      assert.equal(over.body?.code, 'sparql_answer_too_large');
    } finally { await setLimits(undefined); }
  });

  it('a record whose own statements pass the bound is 413 sparql_answer_too_large at /ld/, and one under it is answered', async () => {
    await setLimits({ maxResultBytes: ONE_MIB });
    try {
      const huge = await d.sparqlRest(tok.key, 'GET', `/ld/${S}/entity/huge`, { headers: { Accept: 'application/n-quads' } });
      assert.equal(huge.status, 413, fmt(huge));
      assert.equal(huge.body?.code, 'sparql_answer_too_large');
      const short = await d.sparqlRest(tok.key, 'GET', `/ld/${S}/entity/short`, { headers: { Accept: 'application/n-quads' } });
      assert.equal(short.status, 200, fmt(short));
    } finally { await setLimits(undefined); }
  });
});
