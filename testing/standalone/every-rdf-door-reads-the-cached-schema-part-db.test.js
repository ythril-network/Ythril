/**
 * Every RDF door reads a space's schema part from the cache once one door has computed it (bundle-378, Q-976, S1, contract row 5).
 *
 * ## The rule
 *
 * The schema part of the RDF member resolution (term clashes, an address no document can carry) is computed once per schema version and
 * read from the cache by every door that resolves members: the SPARQL query and its Update, the RDF export, Linked Data, and a SPARQL view's
 * CONSTRUCT (read by the export and the query). A door that recomputes it names a `schema` phase in its `Server-Timing` header; one that
 * reads it from the cache names `members` and no `schema`.
 *
 *  1. after a schema change, the first door's answer names `schema` (it computed the new part), and every later door's answer names
 *     `members` and no `schema`, and the cache counts no further miss.
 *
 * That no caller of `rdfSpaceState` can go around the cache is held by the source, in
 * `the-rdf-space-state-reads-its-schema-part-through-the-cache.test.js`.
 *
 * ## Seen red
 *
 * On 42c51f330 no answer carries a `Server-Timing` header and there is no cache module.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/every-rdf-door-reads-the-cached-schema-part-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { serverTimingOf } from './_server-timing.mjs';

const skip = await mongoSkipReason();
const PUBLIC = 'https://rdf.example.org';
const previousPublic = process.env['PUBLIC_BASE_URL'];
const A = 'q976-doors';
const STAMP = '2026-03-04T05:06:07.000Z';
const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';
const KEEP = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
const NO_OP = 'DELETE { ?s <urn:q976:none> ?o } WHERE { ?s <urn:q976:none> ?o }';
const SCHEMA = { entity: { Person: { propertySchemas: { age: { type: 'number' } } } } };

let d, cache, reader, writer, viewId;

describe('every RDF door reads the cached schema part', { skip }, () => {
  before(async () => {
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
    d = await openSparqlDoors({ suite: 'q976-doors', spaces: [{ id: A, meta: rdfMeta(A, { typeSchemas: SCHEMA }) }] });
    await d.seed(A, 'entity', [{ _id: 'ea', name: 'Ada', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    cache = await import('../../server/dist/rdf/rdf-schema-verdict.js').catch(() => null);
    reader = await d.mint('q976-doors-reader', { [A]: d.row({ knowledge: 'read' }) });
    writer = await d.mint('q976-doors-writer', { [A]: d.row({ knowledge: 'write' }) });
    const v = await d.rest(reader.key, 'POST', '/api/views', { name: 'q976-doors-view', members: [A], sparql: { query: KEEP } });
    assert.equal(v.status, 201, `create the view: ${v.status} ${v.text.slice(0, 300)}`);
    viewId = '@q976-doors-view';
  });
  after(async () => {
    await d?.close();
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
  });

  it('after a schema change the first door computes the schema part and every other door reads it from the cache', async () => {
    assert.ok(cache?.rdfSchemaVerdictStats, 'there is no schema verdict cache (server/dist/rdf/rdf-schema-verdict.js)');
    // A new schema version: no door has computed its part yet.
    d.loader.mutateConfig((cfg) => {
      const s = cfg.spaces.find(x => x.id === A);
      s.meta = { ...s.meta, typeSchemas: { entity: { ...SCHEMA.entity, Org: {} } } };
    });
    const doors = {
      'sparql query': () => d.sparqlGet(reader.key, A, ALL),
      'sparql update': () => d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/sparql/update`, { body: NO_OP, headers: { 'Content-Type': 'application/sparql-update' } }),
      'rdf export': () => d.sparqlRest(reader.key, 'GET', `/api/brain/spaces/${A}/export/rdf?format=nquads`),
      'linked data': () => d.sparqlRest(reader.key, 'GET', `/ld/${A}/entity/ea`, { headers: { Accept: 'application/n-quads' } }),
      'view construct export': () => d.sparqlRest(reader.key, 'GET', `/api/brain/spaces/${encodeURIComponent(viewId)}/export/rdf?format=nquads`),
      'view construct query': () => d.sparqlGet(reader.key, viewId, ALL),
    };
    const first = await d.sparqlGet(reader.key, A, ALL);
    assert.equal(first.status, 200, first.text.slice(0, 300));
    assert.ok(serverTimingOf(first.headers['server-timing'])?.has('schema'), `the first door after the change computed no schema part: ${first.headers['server-timing']}`);
    const warm = cache.rdfSchemaVerdictStats();
    const wrong = [];
    for (const [door, ask] of Object.entries(doors)) {
      const r = await ask();
      const timing = serverTimingOf(r.headers['server-timing']);
      if (r.status >= 300) wrong.push(`${door}: ${r.status} ${r.text.slice(0, 200)}`);
      else if (!timing?.has('members')) wrong.push(`${door}: no members phase in ${JSON.stringify(r.headers['server-timing'] ?? null)}`);
      else if (timing.has('schema')) wrong.push(`${door}: computed the schema part again (${r.headers['server-timing']})`);
    }
    assert.deepEqual(wrong, []);
    assert.equal(cache.rdfSchemaVerdictStats().misses, warm.misses, 'a door missed the cache');
  });
});
