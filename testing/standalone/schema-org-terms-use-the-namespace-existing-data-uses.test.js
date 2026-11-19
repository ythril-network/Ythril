/**
 * schema.org terms are written in the `http://schema.org/` namespace (Q-749, bundle-269 slice S; owner, 2026-11-19, standards review row 2).
 *
 * ## The defect this prevents
 *
 * Slice B declared `schema` as `https://schema.org/`. schema.org accepts both spellings, but its own JSON-LD context file maps `schema:` to
 * `http://schema.org/`, and most stores and published data use `http`: an export in `https` names terms nobody else's data joins to. A
 * namespace cannot change once data was exported, so the one place vocabularies are declared (`STANDARD_PREFIXES`) is pinned here, and every
 * term the mapper writes (`schema:keywords`, `schema:MediaObject`, ...) and the reserved predicates read from it.
 *
 * Run: node --test testing/standalone/schema-org-terms-use-the-namespace-existing-data-uses.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));
const mapper = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));

/** The namespace schema.org's own JSON-LD context gives `schema:`, which existing data uses. */
const SCHEMA_ORG = 'http://schema.org/';

describe('schema.org is http://schema.org/', () => {
  it('the one declaration of the vocabularies says so', () => {
    assert.equal(typeof vocab.STANDARD_PREFIXES, 'object', 'STANDARD_PREFIXES is exported by server/src/rdf/ythril-vocabulary.ts');
    assert.equal(vocab.STANDARD_PREFIXES.schema, SCHEMA_ORG, 'existing data and schema.org\'s own context use http');
  });
  it('the reserved predicates and a record\'s form use it, and no https schema.org address is written', () => {
    assert.ok(vocab.RDF_RESERVED_PREDICATES.includes(`${SCHEMA_ORG}keywords`), 'schema:keywords is reserved under http');
    assert.ok(!vocab.RDF_RESERVED_PREDICATES.some(p => p.startsWith('https://schema.org/')));
    const base = 'https://ythril.example.org/ld/s/';
    const meta = { rdf: { enabled: true, base, vocab: `${base}vocab/`, baseEpoch: 0 } };
    const { quads } = mapper.recordTriples(meta, 'file', { _id: 'a.pdf', path: 'a.pdf', tags: ['t'], description: 'd', sha256: 'ab'.repeat(32) }, { edgeDetails: 'rdf12' });
    const written = quads.flatMap(q => [q.subject, q.predicate, q.object]).filter(t => t.kind === 'iri').map(t => t.value);
    assert.ok(written.includes(`${SCHEMA_ORG}MediaObject`), 'a file is an http schema:MediaObject');
    assert.ok(!written.some(v => v.startsWith('https://schema.org/')), 'no https schema.org address is written');
  });
});
