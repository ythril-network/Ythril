/**
 * Every door answers the time of its phases: a `Server-Timing` header on REST, the same figures in an MCP tool result's `_meta`
 * (bundle-378, Q-976, S1, contract rows 1 and 2).
 *
 * ## The rule
 *
 * One per-request phase timer, set up in the shared middleware above every route, that each door adds its phases to:
 *
 *  1. every route the server mounts (derived from the source by `mountedRoutes`, never a hand list) answers a `Server-Timing` header naming
 *     `total`, whatever it answers: a refusal before any guard (`401`) carries it as an answer does, and a `401` names `auth`;
 *  2. a SPARQL query names at least `auth`, `rate`, `door`, `parse`, `members`, `plan`, `run` and `render`, each with a duration;
 *  3. every door family read here (SPARQL and its Update, RDF export, Linked Data, a record write, filter, traverse) names `auth`, `rate`
 *     and `door`;
 *  4. MCP `sparql_query` carries the same phases in its result's `_meta` (`ythril/server-timing`), since a streamed MCP answer sends its
 *     HTTP headers before the tool has run;
 *  5. an answer the body parsers refuse (a JSON body `{` is a 400, one past the limit a 413) carries the header too: the timer is mounted
 *     above the parsers, which answer before any route (bundle-378 fix round A, R4; on f91569511 both answered with no `Server-Timing`).
 *
 * ## Seen red
 *
 * On 42c51f330 no answer carries a `Server-Timing` header and no tool result a `_meta`.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/every-door-answers-its-phase-times-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { mountedRoutes } from './_routes.mjs';
import { serverTimingOf, mcpTimingOf, mcpCallResult } from './_server-timing.mjs';

const skip = await mongoSkipReason();
const PUBLIC = 'https://rdf.example.org';
const previousPublic = process.env['PUBLIC_BASE_URL'];
const A = 'q976-phases';
const STAMP = '2026-03-04T05:06:07.000Z';
const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';
const SPARQL_PHASES = ['auth', 'rate', 'door', 'parse', 'members', 'plan', 'run', 'render'];
const DOOR_PHASES = ['auth', 'rate', 'door'];
const JSON_TYPE = { 'Content-Type': 'application/json' };
/** The body size the JSON parser refuses past (`config/body-limits.ts`), read from the build. */
let JSON_LIMIT;

let d, reader, writer;

/** The status and headers of one request, without waiting for a body (a stream answers its headers and then holds the connection). */
function headersOf(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${d.server.url}${path}`, { method, agent: false, headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
      res.destroy();
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
    req.setTimeout(60_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end();
  });
}

/** The served path of a mounted route, each parameter filled; `null` for a pattern no literal path matches. */
function pathOf(route) {
  if (/[*()?]/.test(route.path)) return null;
  return route.path.replace(/:spaceId\b/g, A).replace(/:(\w+)/g, 'q976x');
}

describe('every door answers the time of its phases', { skip }, () => {
  before(async () => {
    // Linked Data answers an address under the public base only (`/ld/<space>/...` of `https://rdf.example.org/ld/<space>/`).
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
    d = await openSparqlDoors({ suite: 'q976-phases', spaces: [{ id: A }] });
    ({ JSON_BODY_MAX_BYTES: JSON_LIMIT } = await import('../../server/dist/config/body-limits.js'));
    await d.seed(A, 'entity', [{ _id: 'ea', name: 'Ada', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    reader = await d.mint('q976-phases-reader', { [A]: d.row({ knowledge: 'read', files: 'read' }) });
    writer = await d.mint('q976-phases-writer', { [A]: d.row({ knowledge: 'write', files: 'read' }) });
  });
  after(async () => {
    await d?.close();
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
  });

  it('every mounted route answers a Server-Timing header naming total; a 401 names auth', async () => {
    const routes = mountedRoutes();
    const missing = [];
    let asked = 0;
    for (const route of routes) {
      const path = pathOf(route);
      const method = String(route.method).toUpperCase();
      if (!path || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
      // No credential: every answer is a refusal or a public read, so the sweep changes nothing it reaches.
      const r = await headersOf(method, path);
      asked++;
      const timing = serverTimingOf(r.headers['server-timing']);
      if (!timing?.has('total')) missing.push(`${method} ${route.path} (${r.status}): no total in ${JSON.stringify(r.headers['server-timing'] ?? null)}`);
      else if (r.status === 401 && !timing.has('auth')) missing.push(`${method} ${route.path} (401): no auth phase`);
    }
    assert.ok(asked > 100, `the sweep asked ${asked} routes`);
    assert.deepEqual(missing, [], `routes answering without their phase times:\n${missing.slice(0, 20).join('\n')}`);
  });

  it('a SPARQL query names auth, rate, door, parse, members, plan, run and render, each with a duration', async () => {
    const r = await d.sparqlGet(reader.key, A, ALL);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const timing = serverTimingOf(r.headers['server-timing']);
    assert.ok(timing, 'the SPARQL answer carries no Server-Timing header');
    for (const phase of SPARQL_PHASES) {
      assert.ok(timing.has(phase), `the SPARQL answer names no ${phase} phase: ${r.headers['server-timing']}`);
      assert.ok(Number.isFinite(timing.get(phase).dur) && timing.get(phase).dur >= 0, `${phase} has no duration`);
    }
    assert.ok(timing.get('total').dur >= timing.get('door').dur, 'the door took longer than the whole request');
  });

  it('every door family read here names auth, rate and door', async () => {
    const asks = {
      'sparql': () => d.sparqlGet(reader.key, A, ALL),
      'sparql update': () => d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/sparql/update`,
        { body: 'DELETE { ?s <urn:q976:none> ?o } WHERE { ?s <urn:q976:none> ?o }', headers: { 'Content-Type': 'application/sparql-update' } }),
      'rdf export': () => d.sparqlRest(reader.key, 'GET', `/api/brain/spaces/${A}/export/rdf?format=nquads`),
      'linked data': () => d.sparqlRest(reader.key, 'GET', `/ld/${A}/entity/ea`, { headers: { Accept: 'application/n-quads' } }),
      'record save': () => d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${A}/facts`, { body: JSON.stringify({ fact: 'timed', tags: [] }), headers: JSON_TYPE }),
      'filter (a record read)': () => d.sparqlRest(reader.key, 'POST', '/api/filter',
        { body: JSON.stringify({ space: A, collection: 'entities', filter: {} }), headers: JSON_TYPE }),
      'traverse': () => d.sparqlRest(reader.key, 'POST', `/api/brain/spaces/${A}/traverse`, { body: JSON.stringify({ startId: 'ea', maxDepth: 1 }), headers: JSON_TYPE }),
    };
    const missing = [];
    for (const [family, ask] of Object.entries(asks)) {
      const r = await ask();
      const timing = serverTimingOf(r.headers['server-timing']);
      for (const phase of DOOR_PHASES) if (!timing?.has(phase)) missing.push(`${family} (${r.status}): no ${phase} in ${JSON.stringify(r.headers['server-timing'] ?? null)}`);
    }
    assert.deepEqual(missing, []);
  });

  it('an answer the body parser refuses carries the timing header: a 400 for a body that is not JSON, a 413 for one past the limit', async () => {
    // The parsers sit above every route, so these answers are written before any route or guard runs: the timer must sit above them (R4).
    const notJson = await d.sparqlRest(null, 'POST', '/api/brain/recall', { body: '{', headers: JSON_TYPE });
    assert.equal(notJson.status, 400, notJson.text.slice(0, 300));
    // A body really past the limit: the parser reads the whole request off the wire before it refuses, so a short body under a long Content-Length hangs.
    const pastLimit = await d.sparqlRest(null, 'POST', '/api/brain/recall', { body: `{"query":"${'x'.repeat(JSON_LIMIT)}"}`, headers: JSON_TYPE });
    assert.equal(pastLimit.status, 413, pastLimit.text.slice(0, 300));
    for (const [what, answer] of [['400', notJson], ['413', pastLimit]]) {
      const timing = serverTimingOf(answer.headers['server-timing']);
      assert.ok(timing?.has('total'), `the ${what} the body parser refused carries no total: ${JSON.stringify(answer.headers['server-timing'] ?? null)}`);
    }
  });

  it('MCP sparql_query carries the same phases in its result\'s _meta', async () => {
    const result = await mcpCallResult(d.server.url, reader.key, 'sparql_query', { space: A, query: ALL });
    assert.ok(result && !result.isError && !result.error, `the tool call failed: ${JSON.stringify(result).slice(0, 300)}`);
    const timing = mcpTimingOf(result);
    assert.ok(timing, `the tool result carries no ythril/server-timing in _meta: ${JSON.stringify(result._meta ?? null)}`);
    for (const phase of SPARQL_PHASES) assert.ok(timing.has(phase), `the MCP result names no ${phase} phase: ${JSON.stringify(result._meta)}`);
  });
});
