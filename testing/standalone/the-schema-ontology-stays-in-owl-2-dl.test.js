/**
 * The OWL half of a space's schema export uses only datatypes OWL 2 DL knows, so a DL reasoner can load it (Q-751, bundle-269 slice S;
 * standards review row 6, decided by the parent).
 *
 * ## The defect this prevents
 *
 * Slice C gave a date property the OWL range `[ a rdfs:Datatype; owl:unionOf (xsd:dateTimeStamp xsd:dateTime xsd:date xsd:string) ]`.
 * `xsd:date` is not in the OWL 2 datatype map (OWL 2 Structural Specification §4, "Datatype Maps"), so the ontology fell out of OWL 2 DL and a
 * DL tool refuses or ignores it. The rule now: a date property's OWL range is `rdfs:Literal`; the four-member `sh:or` stays in its SHACL
 * shape, where it checks what the record form writes.
 *
 * The test walks every datatype the OWL part names (each `rdfs:range`, read through `owl:unionOf`, `owl:intersectionOf`, `owl:onDatatype`,
 * `owl:oneOf` and their members' datatypes) and holds each to {@link OWL2_DATATYPE_MAP}.
 *
 * Run: node --test testing/standalone/the-schema-ontology-stays-in-owl-2-dl.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FP, META, iriOf, treeAt, termAt, shapeAt } from './_schema-export-fixture.mjs';

const mod = await import('../../server/dist/rdf/schema-owl-shacl.js').catch(() => ({}));
const graph = (meta = META) => {
  assert.equal(typeof mod.schemaGraph, 'function', 'schemaGraph is not exported by server/src/rdf/schema-owl-shacl.ts');
  return mod.schemaGraph(meta, FP);
};

/**
 * The OWL 2 datatype map: the datatypes OWL 2 DL supports, as listed in OWL 2 Web Ontology Language Structural Specification and
 * Functional-Style Syntax (Second Edition), §4 "Datatype Maps" (§4.1 to §4.7), plus `rdfs:Literal`, the top datatype (§4.6). `xsd:date`,
 * `xsd:time`, `xsd:gYear` and the other XSD date parts are not in it.
 */
const OWL2_DATATYPE_MAP = new Set([
  'owl:real', 'owl:rational', 'xsd:decimal', 'xsd:integer', 'xsd:nonNegativeInteger', 'xsd:nonPositiveInteger', 'xsd:positiveInteger',
  'xsd:negativeInteger', 'xsd:long', 'xsd:int', 'xsd:short', 'xsd:byte', 'xsd:unsignedLong', 'xsd:unsignedInt', 'xsd:unsignedShort',
  'xsd:unsignedByte', 'xsd:double', 'xsd:float', 'xsd:string', 'xsd:normalizedString', 'xsd:token', 'xsd:language', 'xsd:Name',
  'xsd:NCName', 'xsd:NMTOKEN', 'xsd:boolean', 'xsd:hexBinary', 'xsd:base64Binary', 'xsd:anyURI', 'xsd:dateTime', 'xsd:dateTimeStamp',
  'rdf:PlainLiteral', 'rdf:XMLLiteral', 'rdfs:Literal',
].map(iriOf));

const RDFS_RANGE = iriOf('rdfs:range');
/** The predicates of an OWL datatype expression whose objects are datatypes or hold them. */
const DATATYPE_EXPRESSION = new Set(['owl:unionOf', 'owl:intersectionOf', 'owl:onDatatype', 'owl:oneOf', 'owl:datatypeComplementOf'].map(iriOf));

/** Every datatype the term `t` (an `rdfs:range` object) names, read through the expressions above; a literal member gives its datatype. */
function datatypesOf(quads, t, out = []) {
  if (t.kind === 'iri') { out.push(t.value); return out; }
  if (t.kind === 'literal') { out.push(t.datatype ?? iriOf('xsd:string')); return out; }
  if (t.kind === 'list') { for (const item of t.items) datatypesOf(quads, item, out); return out; }
  for (const q of quads) {
    if (q.subject.kind === 'blank' && q.subject.id === t.id && DATATYPE_EXPRESSION.has(q.predicate.value)) datatypesOf(quads, q.object, out);
  }
  return out;
}

describe('the ontology names only OWL 2 datatypes', () => {
  it('every datatype of every rdfs:range is in the OWL 2 datatype map', () => {
    const { quads } = graph();
    const ranges = quads.filter(q => q.predicate.value === RDFS_RANGE);
    assert.ok(ranges.length > 5, 'the fixture states ranges');
    const outside = ranges.flatMap(q => datatypesOf(quads, q.object).filter(d => !OWL2_DATATYPE_MAP.has(d)).map(d => `${q.subject.value} -> ${d}`));
    assert.deepEqual(outside, [], 'a datatype outside the OWL 2 datatype map takes the ontology out of OWL 2 DL');
  });
  it('a date property\'s OWL range is rdfs:Literal, an entity\'s and an edge\'s alike', () => {
    const { quads } = graph();
    assert.deepEqual(treeAt(quads, termAt('entity', 'person', 'born'))['rdfs:range'], [`<rdfs:Literal>`]);
    assert.deepEqual(treeAt(quads, termAt('edge', 'knows', 'since'))['rdfs:range'], [`<rdfs:Literal>`]);
  });
  it('the four-member sh:or stays in the SHACL shape, where it checks what the record form writes', () => {
    const { quads } = graph();
    const or = treeAt(quads, shapeAt('entity', 'person', 'born'))['sh:or'];
    assert.deepEqual(or, [{ list: ['xsd:dateTimeStamp', 'xsd:dateTime', 'xsd:date', 'xsd:string'].map(d => ({ 'sh:datatype': [`<${d}>`] })) }]);
  });
});
