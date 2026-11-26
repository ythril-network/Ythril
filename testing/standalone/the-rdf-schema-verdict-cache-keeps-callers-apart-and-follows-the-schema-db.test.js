/**
 * The RDF member resolution caches only what the space's schema decides, never what the caller's rights decide, follows every schema change,
 * and is bounded (bundle-378, Q-976, S1, contract row 4).
 *
 * ## The rule
 *
 * `rdfMembers` asks, per space, two kinds of question. What the schema alone decides (its term clashes, an address no document can carry:
 * a probe at BSBM 1 000 measured about 44 ms of them per query) is cached per space, keyed by a hash of its resolved type schemas, the space's RDF names
 * and the instance's library namespaces. What the caller decides (may it read the space, its files, which networks a refusal may name) is
 * asked on every call. So:
 *
 *  1. two callers with different rights over the same spaces get their own member sets, the second served from the cache (a hit, no miss);
 *  2. a schema change drops the space's cached part, and the next resolution sees the new clash (`409 rdf_term_clash`); the entry is
 *     replaced, not added beside the old one;
 *  3. a change of the space's RDF names alone (its vocab), which the schema fingerprint does not cover, is seen too;
 *  4. the cache holds at most `RDF_SCHEMA_VERDICT_CAP` spaces: past the cap the least recently asked is dropped and asked again.
 *
 * ## Seen red
 *
 * On 42c51f330 there is no cache: `server/dist/rdf/rdf-schema-verdict.js` does not exist, so no hit is ever counted.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/the-rdf-schema-verdict-cache-keeps-callers-apart-and-follows-the-schema-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const A = 'q976-cache-a';
const B = 'q976-cache-b';
const TERMS = 'https://terms.example.org/q976/';
/** Person carries an explicit address under TERMS: harmless until the vocab is moved onto TERMS. */
const SCHEMA = { entity: { Person: { iri: `${TERMS}Person`, propertySchemas: { age: { type: 'number' } } }, Org: {} } };
/** Two properties on one address with different declared types: a term clash. */
const CLASHING = {
  entity: {
    Person: { iri: `${TERMS}Person`, propertySchemas: { nick: { type: 'string', iri: `${TERMS}nick` } } },
    Org: { propertySchemas: { nick: { type: 'number', iri: `${TERMS}nick` } } },
  },
};

let d, members, cache, both, onlyA;

/** The member resolution of `spaces` for `caller`, as a comparable shape. */
const resolve = (spaces, caller) => {
  const got = members.rdfMembers(spaces, caller);
  return { members: got.members.map(m => `${m.space}:files=${m.files}`), leftOut: got.leftOut.map(l => `${l.space}:${l.code}`) };
};

/** Change `space`'s stored meta as a meta write does: a new object, stored and read again. */
const setMeta = (space, change) => d.loader.mutateConfig((cfg) => {
  const s = cfg.spaces.find(x => x.id === space);
  s.meta = change(s.meta);
});

describe('the RDF schema verdict cache keeps callers apart and follows the schema', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q976-cache', spaces: [{ id: A, meta: rdfMeta(A, { typeSchemas: SCHEMA }) }, { id: B }] });
    members = await import('../../server/dist/rdf/rdf-members.js');
    cache = await import('../../server/dist/rdf/rdf-schema-verdict.js').catch(() => null);
    both = (await d.mint('q976-cache-both', { [A]: d.row({ knowledge: 'read', files: 'read' }), [B]: d.row({ knowledge: 'read', files: 'read' }) })).record;
    onlyA = (await d.mint('q976-cache-only-a', { [A]: d.row({ knowledge: 'read' }) })).record;
  });
  after(async () => { await d?.close(); });

  it('two callers with different rights over the same spaces get their own member sets, the second from the cache', () => {
    assert.ok(cache?.rdfSchemaVerdictStats, 'there is no schema verdict cache (server/dist/rdf/rdf-schema-verdict.js, rdfSchemaVerdictStats)');
    assert.deepEqual(resolve([A, B], both), { members: [`${A}:files=true`, `${B}:files=true`], leftOut: [] });
    const warm = cache.rdfSchemaVerdictStats();
    assert.deepEqual(resolve([A, B], onlyA), { members: [`${A}:files=false`], leftOut: [] }, 'the second caller was given the first caller\'s members');
    const after1 = cache.rdfSchemaVerdictStats();
    assert.equal(after1.misses, warm.misses, 'the second caller recomputed the schema part');
    assert.ok(after1.hits > warm.hits, 'the second caller was not served from the cache');
    assert.deepEqual(resolve([A, B], both), { members: [`${A}:files=true`, `${B}:files=true`], leftOut: [] }, 'the first caller lost a member after the second asked');
  });

  it('a schema change drops the cached part, and the next resolution sees the new clash', () => {
    assert.ok(cache?.rdfSchemaVerdictStats, 'there is no schema verdict cache');
    assert.deepEqual(resolve([A], both).leftOut, []);
    const before1 = cache.rdfSchemaVerdictStats();
    setMeta(A, meta => ({ ...meta, typeSchemas: CLASHING }));
    assert.deepEqual(resolve([A], both), { members: [], leftOut: [`${A}:rdf_term_clash`] }, 'the changed schema was answered from the old verdict');
    const after1 = cache.rdfSchemaVerdictStats();
    assert.equal(after1.misses, before1.misses + 1, 'the changed schema was not computed again');
    assert.equal(after1.size, before1.size, 'the old schema\'s entry was kept beside the new one');
    setMeta(A, meta => ({ ...meta, typeSchemas: SCHEMA }));
    assert.deepEqual(resolve([A], both).leftOut, [], 'the restored schema was answered from the clashing verdict');
  });

  it('a change of the RDF names alone, which the fingerprint does not cover, is seen too', () => {
    assert.ok(cache?.rdfSchemaVerdictStats, 'there is no schema verdict cache');
    assert.deepEqual(resolve([A], both).leftOut, []);
    setMeta(A, meta => ({ ...meta, rdf: { ...meta.rdf, vocab: TERMS } }));
    assert.deepEqual(resolve([A], both), { members: [], leftOut: [`${A}:rdf_term_clash`] }, 'a vocab that now holds an explicit address was answered from the old verdict');
    setMeta(A, meta => ({ ...meta, rdf: { ...meta.rdf, vocab: `${meta.rdf.base}vocab/` } }));
    assert.deepEqual(resolve([A], both).leftOut, []);
  });

  it('the cache holds at most its cap of spaces, dropping the least recently asked', () => {
    assert.ok(cache?.cachedSchemaVerdict, 'there is no schema verdict cache (cachedSchemaVerdict)');
    const cap = cache.RDF_SCHEMA_VERDICT_CAP;
    let computed = 0;
    const compute = () => { computed++; return { clashes: [], unwritable: null }; };
    const meta = rdfMeta('q976-bound');
    for (let i = 0; i < cap + 10; i++) cache.cachedSchemaVerdict(`q976-bound-${i}`, meta, [], compute);
    assert.equal(computed, cap + 10, 'a space never asked before was answered without being computed');
    assert.ok(cache.rdfSchemaVerdictStats().size <= cap, `the cache holds ${cache.rdfSchemaVerdictStats().size} spaces, past its cap of ${cap}`);
    cache.cachedSchemaVerdict(`q976-bound-${cap + 9}`, meta, [], compute);
    assert.equal(computed, cap + 10, 'the most recently asked space was dropped');
    cache.cachedSchemaVerdict('q976-bound-0', meta, [], compute);
    assert.equal(computed, cap + 11, 'the least recently asked space was kept past the cap');
  });
});
