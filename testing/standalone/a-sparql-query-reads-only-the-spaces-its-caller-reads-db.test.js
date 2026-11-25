/**
 * A SPARQL query reads only the spaces its caller reads, on every door, and a graph the dataset names outside them holds nothing (bundle-271,
 * Q-757, review m4; design r2 R1.1).
 *
 * ## The rules
 *
 * 1. **A space the caller cannot read** is refused on `GET`, `POST` `application/sparql-query`, `POST` urlencoded and MCP alike, and the
 *    refusal is the one an unknown space gets: the answer does not say which spaces exist, and no row of it is in the body.
 * 2. **A dataset outside the members.** `named-graph-uri`, `default-graph-uri`, `FROM` and `FROM NAMED` naming a space the caller does not
 *    read answer no row of it (an empty result, not a refusal), on the REST doors and MCP; the same names for a space it reads answer
 *    that space's rows, so the empty answers are not an empty space.
 *
 * ## Seen red
 *
 * Mutations: the act reading every configured space (`members` of `createQuadSource` widened to the config's spaces): rule 2's rows of the
 * outside space; the route without `requireSpaceAuth`: rule 1's 200.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-query-reads-only-the-spaces-its-caller-reads-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, baseOf } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spq-door-own';
const OUTSIDE = 'spq-door-outside';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const STAMP = '2026-03-04T05:06:07.000Z';
/** The label text of the outside space's one entity: found in any answer, it was read from where the caller may not read. */
const SECRET = 'OutsideSecret';
const ENTITY_LABELS = `?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/ythril/ns#Entity> ; <${RDFS_LABEL}> ?n`;
const LABELS = `SELECT ?n WHERE { ${ENTITY_LABELS} }`;
const GRAPHS = `SELECT ?g ?n WHERE { GRAPH ?g { ${ENTITY_LABELS} } }`;

let d, tok;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const labelsOf = (body) => (body?.results?.bindings ?? []).map(b => b.n?.value);

describe('a SPARQL query reads only the spaces its caller reads', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-door-rights', spaces: [{ id: S }, { id: OUTSIDE }] });
    await d.seed(S, 'entity', [{ _id: 'own-1', name: 'OwnName', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(OUTSIDE, 'entity', [{ _id: 'out-1', name: SECRET, type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    tok = await d.mint('spq-door-own', { [S]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('a space the caller cannot read is refused like an unknown space on GET, both POST forms and MCP, with no row of it', async () => {
    const unknown = await d.sparqlGet(tok.key, 'spq-door-no-such-space', LABELS);
    assert.ok(unknown.status >= 400, `an unknown space: ${fmt(unknown)}`);
    const doors = {
      GET: await d.sparqlGet(tok.key, OUTSIDE, LABELS),
      'POST sparql-query': await d.sparqlPost(tok.key, OUTSIDE, LABELS),
      'POST form': await d.sparqlPost(tok.key, OUTSIDE, LABELS, { as: 'form' }),
    };
    for (const [door, a] of Object.entries(doors)) {
      assert.equal(a.status, unknown.status, `${door}: status ${fmt(a)} against an unknown space's ${unknown.status}`);
      assert.ok(!a.text.includes(SECRET), `${door}: the refusal holds the outside space's data`);
      assert.equal(a.body?.results, undefined, `${door}: a refusal carries rows`);
    }
    const m = await d.sparqlMcp(tok.key, { space: OUTSIDE, query: LABELS });
    assert.ok(m.isError, `MCP: ${m.text.slice(0, 300)}`);
    assert.ok(!m.text.includes(SECRET), 'MCP: the refusal holds the outside space\'s data');
  });

  it('named-graph-uri, default-graph-uri, FROM and FROM NAMED naming a space the caller does not read answer no row of it, on every door', async () => {
    const outside = baseOf(OUTSIDE);
    const own = baseOf(S);
    const cases = [
      ['named-graph-uri', GRAPHS, { 'named-graph-uri': outside }, { 'named-graph-uri': own }],
      ['default-graph-uri', LABELS, { 'default-graph-uri': outside }, { 'default-graph-uri': own }],
      ['FROM', `SELECT ?n FROM <${outside}> WHERE { ${ENTITY_LABELS} }`, {}, {}, `SELECT ?n FROM <${own}> WHERE { ${ENTITY_LABELS} }`],
      ['FROM NAMED', `SELECT ?g ?n FROM NAMED <${outside}> WHERE { GRAPH ?g { ${ENTITY_LABELS} } }`, {}, {}, `SELECT ?g ?n FROM NAMED <${own}> WHERE { GRAPH ?g { ${ENTITY_LABELS} } }`],
    ];
    for (const [what, query, params, ownParams, ownQuery = query] of cases) {
      const ownGet = await d.sparqlGet(tok.key, S, ownQuery, ownParams);
      assert.equal(ownGet.status, 200, `${what}, own graph: ${fmt(ownGet)}`);
      assert.deepEqual(labelsOf(ownGet.body), ['OwnName'], `${what}: the caller's own graph answers its rows`);
      const answers = {
        GET: await d.sparqlGet(tok.key, S, query, params),
        'POST sparql-query': await d.sparqlPost(tok.key, S, query, { params }),
        'POST form': await d.sparqlPost(tok.key, S, query, { as: 'form', params }),
      };
      for (const [door, a] of Object.entries(answers)) {
        assert.equal(a.status, 200, `${what} on ${door}: ${fmt(a)}`);
        assert.deepEqual(labelsOf(a.body), [], `${what} on ${door}: rows of a space the caller does not read`);
        assert.ok(!a.text.includes(SECRET), `${what} on ${door}: the outside space's data is in the answer`);
      }
      const m = await d.sparqlMcp(tok.key, { space: S, query, ...params });
      assert.ok(!m.isError, `${what} on MCP: ${m.text.slice(0, 300)}`);
      assert.deepEqual(labelsOf(m.body), [], `${what} on MCP: rows of a space the caller does not read`);
      assert.ok(!m.text.includes(SECRET), `${what} on MCP: the outside space's data is in the answer`);
    }
  });
});
