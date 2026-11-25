/**
 * A POST body the body parser refuses is answered with a SPARQL code, whatever the refusal (bundle-271, Q-757, review m2; design r2 R3.5).
 *
 * ## The rule
 *
 * The route's parsers map every refusal by its `err.type`: a body past a limit or a form with too many parameters is `413
 * sparql_query_too_large`; a charset or a content encoding the parser does not read is `415 sparql_unsupported_media_type`; any other (a
 * broken gzip stream) is `400 sparql_no_query`. Each body is `{error, code}` like every other refusal of the endpoint; none is the app's
 * bare error answer with no code.
 *
 * ## Seen red
 *
 * On 3cfca318b only `entity.too.large` is mapped: the three other refusals are passed on (`next(err)`) and answered without a `code`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-body-the-parser-refuses-has-a-code-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spq-parser-codes';
const QUERY = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';
const FORM = 'application/x-www-form-urlencoded';
const QUERY_TYPE = 'application/sparql-query';

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;

describe('a body the SPARQL route\'s parser refuses has a code', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-parser-codes', spaces: [{ id: S }] });
    tok = await d.mint('spq-parser-codes', { [S]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a form with more parameters than the parser takes is 413 sparql_query_too_large', async () => {
    const form = new URLSearchParams({ query: QUERY });
    for (let i = 0; i < 1_200; i++) form.append('named-graph-uri', `https://example.org/g${i}`);
    const a = await d.sparqlRest(tok.key, 'POST', d.path(S), { body: form.toString(), headers: { 'Content-Type': FORM } });
    assert.equal(a.status, 413, fmt(a));
    assert.equal(a.body?.code, 'sparql_query_too_large', fmt(a));
  });

  it('a charset or a content encoding the parser does not read is 415 sparql_unsupported_media_type', async () => {
    const charset = await d.sparqlRest(tok.key, 'POST', d.path(S), { body: new URLSearchParams({ query: QUERY }).toString(), headers: { 'Content-Type': `${FORM}; charset=x-no-such-charset` } });
    assert.equal(charset.status, 415, `charset: ${fmt(charset)}`);
    assert.equal(charset.body?.code, 'sparql_unsupported_media_type', `charset: ${fmt(charset)}`);
    const encoding = await d.sparqlRest(tok.key, 'POST', d.path(S), { body: QUERY, headers: { 'Content-Type': QUERY_TYPE, 'Content-Encoding': 'x-no-such-encoding' } });
    assert.equal(encoding.status, 415, `encoding: ${fmt(encoding)}`);
    assert.equal(encoding.body?.code, 'sparql_unsupported_media_type', `encoding: ${fmt(encoding)}`);
  });

  it('any other refusal of a parser (a gzip body that is none) is 400 sparql_no_query', async () => {
    const a = await d.sparqlRest(tok.key, 'POST', d.path(S), { body: QUERY, headers: { 'Content-Type': QUERY_TYPE, 'Content-Encoding': 'gzip' } });
    assert.equal(a.status, 400, fmt(a));
    assert.equal(a.body?.code, 'sparql_no_query', fmt(a));
  });
});
