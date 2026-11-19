/**
 * Two properties of one type never resolve to one address, and an own property address shared across types is one definition
 * (bundle-269 review, finding 6). The schema export writes `owl:FunctionalProperty` and `sh:maxCount 1` on every property: two keys of one
 * type on one path let a record the server accepts (two different values) break both, and two types sharing an own property under a library
 * namespace got two `rdfs:domain` statements, which OWL reads as an intersection.
 *
 * ## What it holds
 *
 * - `termClashes` names a same-type pair with the same declared type (`email` and `workEmail`, both `schema:email`), naming both keys;
 *   the save doors answer it as every clash, `rdf_term_clash`.
 * - Two types sharing an own property address under a group namespace clash when their definitions differ, and share it when they are the
 *   same: then the schema graph writes no `rdfs:domain` for it (one property, used by both).
 * - Two types sharing an OUTSIDE address with the same declared type stay allowed (each type's shape targets its own class).
 *
 * Run: node --test testing/standalone/two-properties-of-one-type-never-share-an-address.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { termClashes } = await import('../../server/dist/rdf/term-iri.js');
const { schemaGraph } = await import('../../server/dist/rdf/schema-owl-shacl.js');

const BASE = 'https://rdf.example.org/ld/clash/';
const NS = 'https://acme.example.org/ns/';
const rdf = { enabled: true, base: BASE, vocab: `${BASE}vocab/` };
const FP = 'ab12'.repeat(16);

describe('two properties of one type never share an address', () => {
  it('a same-type pair with the same declared type is a clash naming both keys', () => {
    const clashes = termClashes({ rdf, typeSchemas: { entity: { Person: { propertySchemas: {
      email: { type: 'string', iri: 'http://schema.org/email' }, workEmail: { type: 'string', iri: 'http://schema.org/email' },
    } } } } });
    assert.equal(clashes.length, 1, JSON.stringify(clashes));
    assert.match(clashes[0].message, /email/);
    assert.match(clashes[0].message, /workEmail/);
  });

  it('an outside address shared across types with the same type is no clash', () => {
    const clashes = termClashes({ rdf, typeSchemas: { entity: {
      Person: { propertySchemas: { email: { type: 'string', iri: 'http://schema.org/email' } } },
      Org: { propertySchemas: { email: { type: 'string', iri: 'http://schema.org/email' } } },
    } } });
    assert.deepEqual(clashes, []);
  });

  it('an own address shared across types clashes when the definitions differ, and is one property without a domain when they agree', () => {
    const differ = { rdf, typeSchemas: { entity: {
      Person: { propertySchemas: { code: { type: 'string', iri: `${NS}code`, pattern: '^[A-Z]+$' } } },
      Org: { propertySchemas: { code: { type: 'string', iri: `${NS}code` } } },
    } } };
    assert.equal(termClashes(differ, [{ prefix: 'acme', iri: NS }]).length, 1, 'differing definitions of one own property clash');
    const same = { rdf, typeSchemas: { entity: {
      Person: { propertySchemas: { code: { type: 'string', iri: `${NS}code` } } },
      Org: { propertySchemas: { code: { type: 'string', iri: `${NS}code` } } },
    } } };
    assert.deepEqual(termClashes(same, [{ prefix: 'acme', iri: NS }]), []);
    const graph = schemaGraph(same, FP, { namespaces: [{ prefix: 'acme', iri: NS }] });
    const domains = graph.quads.filter(q => q.subject.value === `${NS}code` && q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#domain');
    assert.equal(domains.length, 0, 'a property two types share states no domain');
  });
});
