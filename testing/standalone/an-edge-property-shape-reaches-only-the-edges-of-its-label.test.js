/**
 * The shape of an edge's own property checks the reifiers of that edge label, and only them (Q-749, Q-751, bundle-269 slice S; standards
 * review row 13, decided by the parent).
 *
 * ## The defect this prevents
 *
 * An edge's own properties sit on its reifier (`recordIri(edge, id)`). Slice C aimed their shapes with `sh:targetSubjectsOf <property>`,
 * which reaches every subject of that property: when two labels share a property address (an explicit `iri` both map to), the range of one
 * label's property is checked on the other label's edges, which the server never does. So the record form gives every reifier a class per
 * edge label, the label's own document in the space vocab (`<vocab>edge/<seg(label)>`, whose fragments are the label's properties: the Direct
 * Mapping's table and columns), and an edge property's shape targets that class with `sh:targetClass`.
 *
 * Holds: the reifier carries the class in both edge forms; a violation of one label's property is reported once, for that label's shape; the
 * same value on an edge of another label that maps the property to the same address is not reached; a required edge property is now a count.
 *
 * Run: node --test testing/standalone/an-edge-property-shape-reaches-only-the-edges-of-its-label.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataFactory } from 'n3';
import datasetFactory from '@rdfjs/dataset';
import SHACLValidator from 'rdf-validate-shacl';
import { BASE, VOCAB, FP, iriOf, shapeAt } from './_schema-export-fixture.mjs';

const schemaMod = await import('../../server/dist/rdf/schema-owl-shacl.js').catch(() => ({}));
const mapperMod = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));
const { namedNode, literal, blankNode, quad } = DataFactory;

const SHARED_SINCE = 'https://example.org/terms/strength';
const META = {
  rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 },
  typeSchemas: {
    entity: { person: {} },
    edge: {
      knows: { propertySchemas: { strength: { type: 'number', minimum: 0, maximum: 1, iri: SHARED_SINCE }, note: { type: 'string', required: true } } },
      rates: { propertySchemas: { strength: { type: 'number', iri: SHARED_SINCE } } },
    },
  },
};
const STAMPS = { createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00Z' };
const edge = (id, label, properties) => ({ _id: id, from: 'a', to: 'b', label, properties, ...STAMPS });

function rdfjs(quads) {
  const out = [];
  let lists = 0;
  const term = (t) => {
    if (t.kind === 'iri') return namedNode(t.value);
    if (t.kind === 'blank') return blankNode(`m${t.id}`);
    if (t.kind === 'literal') return t.datatype === undefined ? literal(t.value) : literal(t.value, namedNode(t.datatype));
    if (t.kind === 'list') {
      if (t.items.length === 0) return namedNode(iriOf('rdf:nil'));
      const nodes = t.items.map(() => blankNode(`list${lists++}`));
      t.items.forEach((item, i) => {
        out.push(quad(nodes[i], namedNode(iriOf('rdf:first')), term(item)));
        out.push(quad(nodes[i], namedNode(iriOf('rdf:rest')), i + 1 < nodes.length ? nodes[i + 1] : namedNode(iriOf('rdf:nil'))));
      });
      return nodes[0];
    }
    throw new Error(`a ${t.kind} is not in these graphs`);
  };
  for (const q of quads) out.push(quad(term(q.subject), term(q.predicate), term(q.object)));
  return out;
}

const recordsOf = (docs, edgeDetails) => docs.flatMap(d => mapperMod.recordTriples(META, 'edge', d, { edgeDetails }).quads);
async function validate(docs) {
  assert.equal(typeof schemaMod.schemaGraph, 'function', 'schemaGraph is not exported by server/src/rdf/schema-owl-shacl.ts');
  const validator = new SHACLValidator(datasetFactory.dataset(rdfjs(schemaMod.schemaGraph(META, FP).quads)));
  const report = await validator.validate(datasetFactory.dataset(rdfjs(recordsOf(docs, 'reification'))));
  return report.results.map(r => ({ focus: r.focusNode.value.replace(BASE, ''), shape: r.sourceShape.value, component: r.sourceConstraintComponent.value.replace(iriOf('sh:'), 'sh:') }));
}

describe('an edge property\'s shape reaches only the edges of its label', () => {
  it('the reifier carries its label\'s class in both edge forms', () => {
    for (const edgeDetails of ['rdf12', 'reification']) {
      const quads = recordsOf([edge('k1', 'knows', { strength: 0.5, note: 'n' })], edgeDetails);
      const types = quads.filter(q => q.subject.value === `${BASE}edge/k1` && q.predicate.value === iriOf('rdf:type')).map(q => q.object.value);
      assert.ok(types.includes(`${VOCAB}edge/knows`), `${edgeDetails}: the reifier is of its label's class (${JSON.stringify(types)})`);
    }
  });
  it('the edge property shape targets that class, not the subjects of the property', () => {
    const quads = schemaMod.schemaGraph(META, FP).quads;
    const of = (p) => quads.filter(q => q.subject.value === shapeAt('edge', 'knows', 'strength') && q.predicate.value === iriOf(p)).map(q => q.object.value);
    assert.deepEqual(of('sh:targetClass'), [`${VOCAB}edge/knows`]);
    assert.deepEqual(of('sh:targetSubjectsOf'), []);
  });
  it('conforming edges of both labels conform', async () => {
    assert.deepEqual(await validate([edge('k1', 'knows', { strength: 0.5, note: 'n' }), edge('r1', 'rates', { strength: 7 })]), []);
  });
  it('a violation is reported once, for its label\'s shape; a like-named property on the other label is not reached', async () => {
    const report = await validate([edge('k1', 'knows', { strength: 2, note: 'n' }), edge('r1', 'rates', { strength: 7 })]);
    assert.deepEqual(report, [{ focus: 'edge/k1', shape: shapeAt('edge', 'knows', 'strength'), component: 'sh:OrConstraintComponent' }]);
  });
  it('a required edge property that is missing is reported, now that its shape has a target', async () => {
    const report = await validate([edge('k1', 'knows', { strength: 0.5 })]);
    assert.deepEqual(report, [{ focus: 'edge/k1', shape: shapeAt('edge', 'knows', 'note'), component: 'sh:MinCountConstraintComponent' }]);
  });
});
