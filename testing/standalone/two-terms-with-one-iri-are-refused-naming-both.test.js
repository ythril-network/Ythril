/**
 * Two terms of one space that would share an address are named, both of them (Q-748, slice A, design r4 §4.1 rule 5).
 *
 * `termClashes(meta)` in `server/src/rdf/term-iri.ts` lists, each with a `message` naming both owners and the address:
 *
 * - two types (of any kinds) with one IRI;
 * - a type and a property with one IRI (one would be a class and a property at once);
 * - two properties with one IRI and differing declared types (sharing one with agreeing types is allowed: `schema:email` on two types);
 * - an explicit `iri` under the space's own vocab (the derived terms live there, so it could collide with one later);
 * - an explicit `iri` equal to a predicate the mapper itself writes (`RDF_RESERVED_PREDICATES`: `rdfs:label`, `dcterms:created`, ...).
 *
 * A meta write that leaves a clash on an RDF-enabled space is refused 422 `rdf_term_clash` with the same words (the door's test is
 * `an-rdf-base-is-kept-through-every-door-db`).
 *
 * Run: node --test testing/standalone/two-terms-with-one-iri-are-refused-naming-both.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const termIri = await import('../../server/dist/rdf/term-iri.js').catch(() => ({}));
const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));
const clashes = (meta) => {
  assert.equal(typeof termIri.termClashes, 'function', 'termClashes is not exported by server/src/rdf/term-iri.ts');
  return termIri.termClashes(meta);
};

const BASE = 'https://ythril.example.org/ld/s/';
const withTypes = (typeSchemas) => ({ rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 }, typeSchemas });
const PERSON = 'http://schema.org/Person';

const named = (list, ...words) => list.some(c => words.every(w => c.message.includes(w)));

describe('a clash is named with both owners', () => {
  it('two types with one IRI, across kinds too', () => {
    const list = clashes(withTypes({ entity: { person: { iri: PERSON }, human: { iri: PERSON } }, fact: { who: { iri: PERSON } } }));
    assert.ok(list.length >= 2, JSON.stringify(list));
    assert.ok(named(list, 'person', 'human', PERSON), JSON.stringify(list));
    assert.ok(named(list, 'who', PERSON), JSON.stringify(list));
  });
  it('a type and a property with one IRI', () => {
    const list = clashes(withTypes({ entity: { person: { iri: PERSON }, card: { propertySchemas: { owner: { type: 'string', iri: PERSON } } } } }));
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.ok(named(list, 'person', 'owner', PERSON));
  });
  it('two properties with one IRI and differing types; agreeing types share it', () => {
    const EMAIL = 'http://schema.org/email';
    const differ = clashes(withTypes({ entity: {
      a: { propertySchemas: { mail: { type: 'string', iri: EMAIL } } },
      b: { propertySchemas: { contact: { type: 'number', iri: EMAIL } } },
    } }));
    assert.equal(differ.length, 1, JSON.stringify(differ));
    assert.ok(named(differ, 'mail', 'contact', EMAIL));
    const agree = clashes(withTypes({ entity: {
      a: { propertySchemas: { mail: { type: 'string', iri: EMAIL } } },
      b: { propertySchemas: { contact: { type: 'string', iri: EMAIL } } },
    } }));
    assert.deepEqual(agree, []);
  });
  it('an explicit iri under the space vocab', () => {
    const list = clashes(withTypes({ entity: { person: { iri: `${BASE}vocab/entity/human` } } }));
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.ok(named(list, 'person', `${BASE}vocab/`));
    // The Direct Mapping shape (slice S): a property's derived address is a fragment of its type's document; taking one by hand is refused too.
    const taken = clashes(withTypes({ entity: { card: { propertySchemas: { owner: { type: 'string', iri: `${BASE}vocab/entity/person#name` } } } } }));
    assert.equal(taken.length, 1, JSON.stringify(taken));
    assert.equal(taken[0].reason, 'under-vocab');
    assert.ok(named(taken, 'owner', `${BASE}vocab/entity/person#name`), JSON.stringify(taken));
  });
  // Review finding 11 (slice A-fix): an iri under the base but outside the vocab could equal a record's address (`<base>entity/<id>`).
  it('an explicit iri under the space base, outside its vocab, is refused under-base, naming the value', () => {
    for (const iri of [`${BASE}entity/Person`, `${BASE}agent/x`, `${BASE}schema`, `${BASE}anything`]) {
      const list = clashes(withTypes({ entity: { person: { iri } } }));
      assert.equal(list.length, 1, `${iri} could name a record and went unrefused: ${JSON.stringify(list)}`);
      assert.equal(list[0].reason, 'under-base');
      assert.ok(named(list, 'person', iri), JSON.stringify(list));
    }
    const vocabOutside = { rdf: { enabled: true, base: BASE, vocab: 'https://v.example/terms/', baseEpoch: 0 }, typeSchemas: { entity: { p: { propertySchemas: { q: { type: 'string', iri: `${BASE}fact/q` } } } } } };
    assert.equal(clashes(vocabOutside)[0]?.reason, 'under-base', 'a property iri under the base is refused when the vocab lies elsewhere');
  });
  it('an explicit iri equal to a predicate the mapper writes', () => {
    assert.ok(Array.isArray(vocabulary.RDF_RESERVED_PREDICATES), 'RDF_RESERVED_PREDICATES is exported by server/src/rdf/ythril-vocabulary.ts');
    const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
    const CREATED = 'http://purl.org/dc/terms/created';
    for (const reserved of [LABEL, CREATED]) assert.ok(vocabulary.RDF_RESERVED_PREDICATES.includes(reserved), reserved);
    const list = clashes(withTypes({ entity: { person: { propertySchemas: { name: { type: 'string', iri: LABEL } } } } }));
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.ok(named(list, 'name', LABEL));
  });
  it('a schema with derived names only never clashes, whatever its names hold', () => {
    assert.deepEqual(clashes(withTypes({
      entity: { 'a/b': { propertySchemas: { 'c d': { type: 'string' } } }, 'a': { propertySchemas: { 'b/c d': { type: 'number' }, b: { type: 'boolean' } } } },
      edge: { 'a/b': {} },
    })), []);
    // The collision pairs of the Direct Mapping shape: a type `a.b` or `a#b` is never the property `b` of type `a`.
    assert.deepEqual(clashes(withTypes({
      entity: { 'a.b': {}, 'a#b': { propertySchemas: { c: { type: 'string' } } }, a: { propertySchemas: { b: { type: 'number' }, 'b#c': { type: 'boolean' } } } },
    })), []);
  });
});
