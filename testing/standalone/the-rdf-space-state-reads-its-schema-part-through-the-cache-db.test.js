/**
 * Every door that resolves a space's RDF state reads its schema part (its term clashes, the first address no document can carry) through
 * the schema verdict cache, and the read is counted (bundle-378, Q-976, S1; fix round A: R5, L2.2).
 *
 * ## The rule
 *
 * Every module that resolves a space's RDF state calls `rdfSpaceState` (the member helper for the SPARQL query, Update and CONSTRUCT view,
 * the RDF export and Linked Data; and the schema export, the imports and the triple index's follower beside them). The cache sits inside
 * that one function, so no caller can skip it. The first version of this spec read the source of `rdfSpaceState` for the call and passed
 * whatever the call did; this one drives the doors:
 *
 *  1. a SPARQL query, an RDF export, a Linked Data read and a schema export each cause at least one counted lookup of the cache
 *     (`ythril_cache_lookups_total{cache="schema_verdict"}`), whichever result, so a door that computes the verdict inline is the one that
 *     counts nothing;
 *  2. a second request of the same door, with the schema unchanged, is served from the cache (a hit) and computes nothing (no miss);
 *  3. the entries held are a gauge, `ythril_cache_entries{cache="schema_verdict"}`, and it reports at least the spaces asked;
 *  4. every caller of `rdfSpaceState` is a tracked server source (derived with `git ls-files`, never a hand list), and none checks the
 *     stored addresses around it, so the doors driven above are the count of callers the cache serves that this scan finds.
 *
 * ## Seen red
 *
 * On f91569511 the schema verdict cache counts nothing in the registry: no series of `ythril_cache_lookups_total` exists, so case 1 finds
 * none for any door. Under a mutation that computes `termClashes` inline in `rdfSpaceState`, every door counts nothing and case 1 fails the
 * same way (the source-reading version of this spec stayed green under a mutation that left the call in place).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-rdf-space-state-reads-its-schema-part-through-the-cache-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { trackedSources, SERVER_SOURCE_ROOT, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();
const STATE = 'server/src/rdf/rdf-space-state.ts';
const PUBLIC = 'https://rdf.example.org';
const previousPublic = process.env['PUBLIC_BASE_URL'];
const A = 'rsc-state';
const STAMP = '2026-03-04T05:06:07.000Z';
const ALL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';

let d, reader, register;

/** The counted lookups of the schema verdict cache by result, as the registry says now (`null` when no series exists). */
async function lookups() {
  const text = await register.metrics();
  const out = { hit: null, miss: null };
  for (const line of text.split('\n')) {
    const m = /^ythril_cache_lookups_total\{[^}]*cache="schema_verdict"[^}]*\}\s+(\S+)/.exec(line);
    if (!m) continue;
    const result = /result="(hit|miss)"/.exec(line)?.[1];
    if (result) out[result] = Number(m[1]);
  }
  return out;
}

describe('every door reads the RDF schema part through the cache', { skip }, () => {
  before(async () => {
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
    d = await openSparqlDoors({ suite: 'rsc-state', spaces: [{ id: A }] });
    await d.seed(A, 'entity', [{ _id: 'ea', name: 'Ada', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
    reader = await d.mint('rsc-state-reader', { [A]: d.row({ knowledge: 'read', files: 'read', schema: 'read' }) });
    ({ register } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => {
    await d?.close();
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
  });

  const doors = () => ({
    'sparql query': () => d.sparqlGet(reader.key, A, ALL),
    'rdf export': () => d.sparqlRest(reader.key, 'GET', `/api/brain/spaces/${A}/export/rdf?format=nquads`),
    'linked data': () => d.sparqlRest(reader.key, 'GET', `/ld/${A}/entity/ea`, { headers: { Accept: 'application/n-quads' } }),
    'schema export': () => d.sparqlRest(reader.key, 'GET', `/api/spaces/${A}/schema-rdf?format=turtle`),
  });

  it('each door causes a counted lookup of the cache, and a second request of it is a hit that computes nothing', async () => {
    const wrong = [];
    for (const [door, ask] of Object.entries(doors())) {
      const first = await ask();
      if (first.status !== 200) { wrong.push(`${door}: ${first.status} ${first.text.slice(0, 120)}`); continue; }
      const before = await lookups();
      if (before.hit === null && before.miss === null) { wrong.push(`${door}: no ythril_cache_lookups_total{cache="schema_verdict"} series at all`); continue; }
      const again = await ask();
      if (again.status !== 200) { wrong.push(`${door} again: ${again.status}`); continue; }
      const after = await lookups();
      if ((after.hit ?? 0) <= (before.hit ?? 0)) wrong.push(`${door}: its second request counted no hit`);
      if ((after.miss ?? 0) !== (before.miss ?? 0)) wrong.push(`${door}: its second request computed the verdict again`);
    }
    assert.deepEqual(wrong, []);
  });

  it('the entries held are a gauge that reports the space asked', async () => {
    await d.sparqlGet(reader.key, A, ALL);
    const text = await register.metrics();
    const line = text.split('\n').find(l => /^ythril_cache_entries\{[^}]*cache="schema_verdict"/.test(l));
    assert.ok(line, 'ythril_cache_entries{cache="schema_verdict"} is not declared');
    assert.ok(Number(line.slice(line.lastIndexOf(' ') + 1)) >= 1, `the gauge reports ${line}: the space asked is not counted`);
  });

  it('every caller of rdfSpaceState is a tracked server source, and none checks the addresses around it', () => {
    const callers = [];
    const around = [];
    for (const file of trackedSources([SERVER_SOURCE_ROOT], { untracked: true, floor: 100 })) {
      const text = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      if (/\brdfSpaceState\s*\(/.test(text.replace(/export function rdfSpaceState\s*\(/g, ''))) callers.push(file);
      if (file !== STATE && /\bfirstUnwritableAddress\s*\(/.test(text)) around.push(file);
    }
    assert.ok(callers.length > 0, 'no module calls rdfSpaceState: the scan stopped matching');
    assert.deepEqual(around, [], 'a module checks the stored addresses around rdfSpaceState and its cache');
  });
});
