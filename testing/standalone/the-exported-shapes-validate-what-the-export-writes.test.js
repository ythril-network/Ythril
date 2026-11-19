/**
 * The shapes the schema export writes accept the records the record export writes, and refuse the ones the server refuses (Q-751, design r4 §6
 * "faithfulness", §8; the pure half of `a-conforming-space-conforms-to-its-own-shapes-db.test.js`).
 *
 * ## The defect this prevents
 *
 * A shape can read fine and still say something the record form does not do: a `sh:minCount` on a property the mapper leaves out when it is
 * empty, a `sh:datatype xsd:decimal` where the mapper writes an integer, a `sh:in` whose members are typed differently from the values, a
 * range check that also refuses the strings a property without a declared type may hold, a pattern that reads a number's digits. Such a shape
 * would make an exporting space fail its own validation, or let a record through the server refuses. Reading the shapes proves nothing; this
 * file RUNS them: slice B's mapper writes the records of a small space, this module's shapes are built for the space's schema, and an
 * independent validator (`rdf-validate-shacl`, a dev dependency, offline) checks one against the other.
 *
 * ## What it holds
 *
 * - **Conforming records conform**: every record kind the space holds, with the values at the edges of every rule (the bounds themselves, a
 *   date written as a date, a date-time with a zone, a date that is only text, a number where a pattern is declared, a string where a range is
 *   declared on a property of no type, an edge to a record outside the exported set, an edge from a record that is no entity).
 * - **One failing record per kind of constraint, reported for the right shape**, with the right focus node and component: a missing required
 *   value, an empty one (the server counts `''` as missing), a wrong datatype, a value below and above its range, a pattern that does not
 *   match, a value outside its enumeration (strings and numbers), a second value for one property, a date written as a number, a naming
 *   pattern, an edge that ends at the wrong class (on the object side and the subject side, an untyped subject), a functional label with two
 *   objects, and the plain properties of an edge (range and empty-required).
 * - **A shape never refuses what the server accepts**: the guards (a range on a text, a pattern on a number) are exercised, not just written.
 *
 * Run: node --test testing/standalone/the-exported-shapes-validate-what-the-export-writes.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataFactory } from 'n3';
import datasetFactory from '@rdfjs/dataset';
import SHACLValidator from 'rdf-validate-shacl';
import { META, FP, BASE, NS, iriOf, shapeAt, termAt } from './_schema-export-fixture.mjs';

const schemaMod = await import('../../server/dist/rdf/schema-owl-shacl.js').catch(() => ({}));
const mapperMod = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));

const { namedNode, literal, blankNode, quad } = DataFactory;
const RDF_FIRST = iriOf('rdf:first');
const RDF_REST = iriOf('rdf:rest');
const RDF_NIL = iriOf('rdf:nil');
const XSD = NS.xsd;

/** The quads of the model as RDF/JS quads; a list is written as the chain of its nodes. */
function rdfjs(quads) {
  const out = [];
  let lists = 0;
  const term = (t) => {
    switch (t.kind) {
      case 'iri': return namedNode(t.value);
      case 'blank': return blankNode(`m${t.id}`);
      case 'literal': return t.datatype === undefined ? literal(t.value) : literal(t.value, namedNode(t.datatype));
      case 'list': {
        if (t.items.length === 0) return namedNode(RDF_NIL);
        const nodes = t.items.map(() => blankNode(`list${lists++}`));
        t.items.forEach((item, i) => {
          out.push(quad(nodes[i], namedNode(RDF_FIRST), term(item)));
          out.push(quad(nodes[i], namedNode(RDF_REST), i + 1 < nodes.length ? nodes[i + 1] : namedNode(RDF_NIL)));
        });
        return nodes[0];
      }
      default: throw new Error(`a ${t.kind} is not in these graphs`);
    }
  };
  for (const q of quads) out.push(quad(term(q.subject), term(q.predicate), term(q.object)));
  return out;
}

const shapes = () => {
  assert.equal(typeof schemaMod.schemaGraph, 'function', 'schemaGraph is not exported by server/src/rdf/schema-owl-shacl.ts: the schema has no shapes to validate with');
  return datasetFactory.dataset(rdfjs(schemaMod.schemaGraph(META, FP).quads));
};
const records = (kind, doc) => {
  assert.equal(typeof mapperMod.recordTriples, 'function', 'recordTriples is not exported by server/src/rdf/record-triples.ts');
  const out = mapperMod.recordTriples(META, kind, doc, { edgeDetails: 'reification' });
  assert.deepEqual(out.counts.skippedValues, [], `the record ${doc._id} is wholly exported`);
  return out.quads;
};

// -- a small space ----------------------------------------------------------------------------------------------------------------------
const AUTHOR = { instanceId: 'inst-1', instanceLabel: 'Home' };
const STAMPS = { author: AUTHOR, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00Z', schemaFingerprint: FP };
const entity = (id, name, type, properties) => ({ _id: id, name, type, properties, ...STAMPS });
const edge = (id, from, to, label, properties, ends = {}) => ({ _id: id, from, to, label, properties, ...ends, ...STAMPS });

const SPACE = {
  entities: [
    entity('alice', 'Alice Smith', 'person', { name: 'Alice Smith', age: 30, status: 'active', level: 2, born: '2026-04-05', active: true, score: 4, email: 'a@example.org', loose: 'abc', code: 5 }),
    entity('bob', 'Bob Jones', 'person', { name: 'Bob Jones', age: 0, born: '2026-04-05T10:00:00Z', loose: 7, code: 'Axe' }),
    entity('carol', 'Carol', 'person', { name: 'Carol', age: 150, born: 'next tuesday', level: 3 }),
    entity('dave', 'Dave', 'person', { name: 'Dave', born: '2026-02-30' }),
    entity('nobody', 'Nobody', undefined, {}),
    entity('robby', 'Robby', 'robot', {}),
    entity('card', 'Card', 'contact', {}),
  ],
  facts: [{ _id: 'n1', fact: 'a note', type: 'note', properties: { weight: 2.5 }, ...STAMPS }],
  chronos: [{ _id: 'm1', title: 'Weekly', type: 'meeting', startsAt: '2026-05-01T09:00:00Z', properties: { room: 'A1' }, ...STAMPS }],
  edges: [
    edge('e1', 'alice', 'bob', 'knows', { since: '2026-01-01', strength: 0.5 }),
    edge('e2', 'alice', 'carol', 'knows', { since: 'last spring', strength: 0 }),
    edge('e3', 'alice', 'nobody', 'knows', { strength: 1 }),
    edge('e4', 'n1', 'alice', 'knows', { strength: 0.2 }, { fromKind: 'fact' }),
    edge('e5', 'alice', 'outside-the-set', 'knows', { strength: 0.2 }),
    edge('e6', 'alice', 'bob', 'reports_to', {}),
    edge('e7', 'carol', 'bob', 'reports_to', {}),
  ],
};
const DATA = () => [
  ...SPACE.entities.flatMap(d => records('entity', d)),
  ...SPACE.facts.flatMap(d => records('fact', d)),
  ...SPACE.chronos.flatMap(d => records('chrono', d)),
  ...SPACE.edges.flatMap(d => records('edge', d)),
];

/** The validation of `quads` (the model's) against the shapes: what is reported, each as { focus, shape, component, path }. */
async function validate(quads) {
  const validator = new SHACLValidator(shapes());
  const report = await validator.validate(datasetFactory.dataset(rdfjs(quads)));
  const short = (t) => (t === null ? null : t.termType === 'BlankNode' ? 'blank' : t.value.replace(NS.sh, 'sh:').replace(NS.base, '').replace(NS.rdfs, 'rdfs:').replace(BASE, ''));
  return report.results.map(r => ({ focus: short(r.focusNode), shape: short(r.sourceShape), component: short(r.sourceConstraintComponent), path: short(r.path) }));
}

const comp = (name) => `sh:${name}ConstraintComponent`;
const at = (kind, type, prop) => shapeAt(kind, type, prop).replace(BASE, '');
const PERSON_NAME = at('entity', 'person', 'name');
const entityIri = (id) => `entity/${id}`;

/** The property triple `subject predicate object` of a record, as quads, for a mutation. */
const iri = (value) => ({ kind: 'iri', value });
const lit = (value, datatype) => (datatype === undefined ? { kind: 'literal', value } : { kind: 'literal', value, datatype: `${XSD}${datatype}` });
const prop = (kind, id, type, name) => ({ subject: iri(`${BASE}${kind}/${id}`), predicate: iri(termAt(kind, type, name)) });
const without = (quads, subject, predicate) => quads.filter(q => !(q.subject.value === subject.value && q.predicate.value === predicate.value));
const withValue = (quads, p, object) => [...without(quads, p.subject, p.predicate), { ...p, object }];
const addValue = (quads, p, object) => [...quads, { ...p, object }];

describe('the schema export is run against the records the record export writes', () => {
  it('the space is wholly exported and reaches the validator', async () => {
    const data = DATA();
    assert.ok(data.length > 100, 'the small space has many statements');
    const report = await validate(data);
    assert.deepEqual(report, [], 'every record of the space conforms to the shapes of its schema');
  });

  it('the validator is not vacuous: it reports a record that does not conform', async () => {
    const data = without(DATA(), iri(`${BASE}entity/alice`), iri(termAt('entity', 'person', 'name')));
    assert.ok((await validate(data)).length > 0);
  });
});

describe('one failing record per kind of constraint, reported for the right shape', () => {
  const alice = (name) => prop('entity', 'alice', 'person', name);
  const cases = [
    ['a missing required value', (d) => without(d, alice('name').subject, alice('name').predicate), [{ focus: entityIri('alice'), shape: PERSON_NAME, component: comp('MinCount') }]],
    ['an empty required value (the server counts "" as missing)', (d) => withValue(d, alice('name'), lit('')), [
      { focus: entityIri('alice'), shape: PERSON_NAME, component: comp('MinLength') },
      { focus: entityIri('alice'), shape: PERSON_NAME, component: comp('Or') }, // the pattern, which "" does not match either
    ]],
    ['a wrong datatype (a text where the property is a number)', (d) => withValue(d, alice('age'), lit('thirty')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'age'), component: comp('Datatype') }]],
    ['a number below its minimum', (d) => withValue(d, alice('age'), lit('-1', 'decimal')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'age'), component: comp('Or') }]],
    ['a number above its maximum', (d) => withValue(d, alice('age'), lit('151', 'decimal')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'age'), component: comp('Or') }]],
    ['a string that does not match its pattern', (d) => withValue(d, alice('name'), lit('Alice 2')), [{ focus: entityIri('alice'), shape: PERSON_NAME, component: comp('Or') }]],
    ['a string outside its enumeration', (d) => withValue(d, alice('status'), lit('gone')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'status'), component: comp('In') }]],
    ['a number outside its enumeration', (d) => withValue(d, alice('level'), lit('4', 'decimal')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'level'), component: comp('In') }]],
    ['a second value for one property', (d) => addValue(d, alice('age'), lit('31', 'decimal')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'age'), component: comp('MaxCount') }]],
    ['a date written as a number', (d) => withValue(d, alice('born'), lit('5', 'decimal')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'born'), component: comp('Or') }]],
    ['a boolean written as a text', (d) => withValue(d, alice('active'), lit('yes')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'active'), component: comp('Datatype') }]],
    ['a number below the minimum of a property of no type', (d) => withValue(d, alice('loose'), lit('3', 'decimal')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'loose'), component: comp('Or') }]],
    ['a text that does not match the pattern of a property of no type', (d) => withValue(d, alice('code'), lit('Bxe')), [{ focus: entityIri('alice'), shape: at('entity', 'person', 'code'), component: comp('Or') }]],
    ['a name that does not match the naming pattern', (d) => withValue(d, { subject: iri(`${BASE}entity/alice`), predicate: iri(iriOf('rdfs:label')) }, lit('alice smith')), [{ focus: entityIri('alice'), shape: 'blank', component: comp('Pattern') }]],
    ['a required property of a chrono entry, missing', (d) => without(d, iri(`${BASE}chrono/m1`), iri(termAt('chrono', 'meeting', 'room'))), [{ focus: 'chrono/m1', shape: at('chrono', 'meeting', 'room'), component: comp('MinCount') }]],
    ['an edge that ends at the wrong class', (d) => [...d, { subject: iri(`${BASE}entity/alice`), predicate: iri(termAt('edge', 'knows')), object: iri(`${BASE}entity/robby`) }],
      [{ focus: entityIri('alice'), shape: 'blank', component: comp('Or') }]],
    ['an edge that starts at the wrong class', (d) => [...d, { subject: iri(`${BASE}entity/robby`), predicate: iri(termAt('edge', 'knows')), object: iri(`${BASE}entity/bob`) }],
      [{ focus: entityIri('robby'), shape: at('edge', 'knows'), component: comp('Or') }]],
    ['an edge that starts at an untyped entity', (d) => [...d, { subject: iri(`${BASE}entity/nobody`), predicate: iri(termAt('edge', 'knows')), object: iri(`${BASE}entity/bob`) }],
      [{ focus: entityIri('nobody'), shape: at('edge', 'knows'), component: comp('Or') }]],
    ['a functional label with two objects', (d) => [...d, { subject: iri(`${BASE}entity/alice`), predicate: iri(termAt('edge', 'reports_to')), object: iri(`${BASE}entity/carol`) }],
      [{ focus: entityIri('alice'), shape: 'blank', component: comp('MaxCount') }]],
    ['a plain property of an edge above its maximum', (d) => withValue(d, { subject: iri(`${BASE}edge/e1`), predicate: iri(termAt('edge', 'knows', 'strength')) }, lit('2', 'decimal')),
      [{ focus: 'edge/e1', shape: at('edge', 'knows', 'strength'), component: comp('Or') }]],
    ['a required property of an edge, empty', (d) => withValue(d, { subject: iri(`${BASE}edge/e1`), predicate: iri(termAt('edge', 'knows', 'strength')) }, lit('')),
      [{ focus: 'edge/e1', shape: at('edge', 'knows', 'strength'), component: comp('MinLength') }, { focus: 'edge/e1', shape: at('edge', 'knows', 'strength'), component: comp('Datatype') }]],
  ];
  const key = (r) => `${r.focus} ${r.shape} ${r.component}`;
  for (const [what, mutate, expected] of cases) {
    it(what, async () => {
      const report = await validate(mutate(DATA()));
      assert.deepEqual(report.map(key).sort(), expected.map(key).sort(), JSON.stringify(report));
    });
  }

  it('every kind of constraint the export writes is shown failing above', async () => {
    const seen = new Set();
    for (const [, mutate] of cases) for (const r of await validate(mutate(DATA()))) seen.add(r.component);
    for (const c of ['MinCount', 'MinLength', 'Datatype', 'Or', 'In', 'MaxCount', 'Pattern']) assert.ok(seen.has(comp(c)), `${c} is reported by a failing record`);
  });
});

describe('a shape never refuses what the server accepts', () => {
  it('a range is not read on a text, a pattern is not read on a number, a date may be only text, an edge may end outside the set', async () => {
    assert.deepEqual(await validate(DATA()), []);
    const data = DATA();
    for (const needle of [lit('abc'), lit('7', 'decimal'), lit('5', 'decimal'), lit('Axe'), lit('next tuesday'), lit('2026-02-30')]) {
      assert.ok(data.some(q => q.object.kind === 'literal' && q.object.value === needle.value && q.object.datatype === needle.datatype), `the fixture writes ${needle.value}`);
    }
  });
});
