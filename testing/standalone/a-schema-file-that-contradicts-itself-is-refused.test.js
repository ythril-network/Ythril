/**
 * A schema file that contradicts itself is refused with both statements, in every mode; names that collide after shortening are refused with
 * both addresses (bundle-270, slice S8, Q-754).
 *
 * ## The defect this prevents
 *
 * A file that says a property is a string in one place and a boolean in another cannot be built into a schema without choosing, and a reader
 * that chooses (the first one, the stricter one) writes a schema the file's author never stated, and says nothing. A class that is both a
 * record type and an edge label, a property of two kinds, two names for one type, two enumerations that differ: each is a refusal answer
 * carrying the two statements (their subjects, constraints and values), so the author can see what to fix. And a type or property is named by
 * its label or the local part of its address: two addresses that shorten to one name (`http://a.org/x#Person` and `http://b.org/y/Person`)
 * would be one type with two sources, so they are refused with both addresses, never merged and never numbered.
 *
 * ## What it holds
 *
 * - **Each contradiction**, within the shapes, within the OWL axioms and between them: refused, with at least two statements named, and the
 *   stored schema back with no change.
 * - **In every mode**: the same file is refused in `generate`, `expand` and `update`.
 * - **Names that collide**: two types of one kind, two properties of one type, a label and a local part; with both addresses in the answer. The
 *   same name in two kinds is no collision.
 * - **A name that cannot be made** (an address with no local part and no label) is a statement named not taken, not a refusal.
 *
 * Run: node --test testing/standalone/a-schema-file-that-contradicts-itself-is-refused.test.js (after the server and schema builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read, Q, N, I, LIT, LIST, DEC, BOOL, ex } from './_schema-from-rdf-doors.mjs';

const T = ex('Thing');
const PS = ex('sizeShape');

/** A shape of `Thing` with a property shape for `size` and the statements `extra` add to the property shape. */
const shapeWith = (extra) => [
  Q(ex('ThingShape'), 'rdf:type', 'sh:NodeShape'), Q(ex('ThingShape'), 'sh:targetClass', T), Q(ex('ThingShape'), 'sh:property', PS),
  Q(PS, 'rdf:type', 'sh:PropertyShape'), Q(PS, 'sh:path', ex('size')), ...extra,
];
/** The OWL axioms of the class and a datatype property `size` of it, with the statements `extra` add to the property. */
const owlWith = (extra) => [
  Q(T, 'rdf:type', 'owl:Class'), Q(ex('size'), 'rdf:type', 'owl:DatatypeProperty'), Q(ex('size'), 'rdfs:domain', T), ...extra,
];

/** Each is a file that contradicts itself, read from the kinds named, with the constraints its two statements are about. */
const CONTRADICTIONS = [
  { name: 'two datatypes on one property shape', from: ['shacl'], quads: shapeWith([Q(PS, 'sh:datatype', 'xsd:string'), Q(PS, 'sh:datatype', 'xsd:boolean')]), constraints: ['sh:datatype', 'sh:datatype'] },
  { name: 'two ranges of one datatype property', from: ['declared'], quads: owlWith([Q(ex('size'), 'rdfs:range', 'xsd:string'), Q(ex('size'), 'rdfs:range', 'xsd:boolean')]), constraints: ['rdfs:range', 'rdfs:range'] },
  { name: 'a range in the axioms and a datatype in the shapes that differ', from: ['declared', 'shacl'], quads: [...owlWith([Q(ex('size'), 'rdfs:range', 'xsd:string')]), ...shapeWith([Q(PS, 'sh:datatype', 'xsd:boolean')])], constraints: ['rdfs:range', 'sh:datatype'] },
  { name: 'an enumeration in the axioms and one in the shapes that differ', from: ['declared', 'shacl'],
    quads: [...owlWith([Q(ex('size'), 'rdfs:range', N('e')), Q(N('e'), 'rdf:type', 'rdfs:Datatype'), Q(N('e'), 'owl:oneOf', LIST(LIT('a'), LIT('b')))]), ...shapeWith([Q(PS, 'sh:in', LIST(LIT('a'), LIT('c')))])],
    constraints: ['rdfs:range', 'sh:in'] },
  { name: 'two minimums', from: ['shacl'], quads: shapeWith([Q(PS, 'sh:datatype', 'xsd:decimal'), Q(PS, 'sh:minInclusive', DEC(1)), Q(PS, 'sh:minInclusive', DEC(2))]), constraints: ['sh:minInclusive', 'sh:minInclusive'] },
  { name: 'two defaults', from: ['shacl'], quads: shapeWith([Q(PS, 'sh:defaultValue', LIT('a')), Q(PS, 'sh:defaultValue', LIT('b'))]), constraints: ['sh:defaultValue', 'sh:defaultValue'] },
  { name: 'a class that is also an edge label', from: ['declared'], quads: [Q(T, 'rdf:type', 'owl:Class'), Q(T, 'rdf:type', 'owl:ObjectProperty')], constraints: ['rdf:type', 'rdf:type'] },
  { name: 'a property that is a datatype property and an object property', from: ['declared'], quads: owlWith([Q(ex('size'), 'rdf:type', 'owl:ObjectProperty')]), constraints: ['rdf:type', 'rdf:type'] },
  { name: 'a shape that targets a class and the subjects of a property', from: ['shacl'], quads: [Q(ex('S'), 'rdf:type', 'sh:NodeShape'), Q(ex('S'), 'sh:targetClass', T), Q(ex('S'), 'sh:targetSubjectsOf', ex('knows'))], constraints: ['sh:targetClass', 'sh:targetSubjectsOf'] },
  { name: 'two names of one type', from: ['declared', 'shacl'], quads: [Q(T, 'rdf:type', 'owl:Class'), Q(T, 'rdfs:label', LIT('Thing')), Q(ex('S'), 'rdf:type', 'sh:NodeShape'), Q(ex('S'), 'sh:targetClass', T), Q(ex('S'), 'sh:name', LIT('Item'))], constraints: ['rdfs:label', 'sh:name'] },
  { name: 'two labels of one type', from: ['declared'], quads: [Q(T, 'rdf:type', 'owl:Class'), Q(T, 'rdfs:label', LIT('Thing')), Q(T, 'rdfs:label', LIT('Item'))], constraints: ['rdfs:label', 'rdfs:label'] },
  { name: 'a pattern in the annotation and a different one in the shape of the name', from: ['shacl'],
    quads: [Q(ex('S'), 'rdf:type', 'sh:NodeShape'), Q(ex('S'), 'sh:targetClass', T), Q(ex('S'), 'ythril:namingPattern', LIT('^A')), Q(ex('S'), 'sh:property', ex('L')), Q(ex('L'), 'sh:path', 'rdfs:label'), Q(ex('L'), 'sh:pattern', LIT('^B'))],
    constraints: ['ythril:namingPattern', 'sh:pattern'] },
];

describe('a file that contradicts itself', () => {
  for (const row of CONTRADICTIONS) {
    it(`${row.name} is refused with both statements`, () => {
      const answer = read(row.quads, { from: row.from });
      assert.equal(answer.refusals.length, 1, `refusals: ${JSON.stringify(answer.refusals.map(r => r.code))}`);
      const [refusal] = answer.refusals;
      assert.equal(refusal.code, 'contradiction');
      assert.ok(refusal.statements.length >= 2, 'a refusal names fewer than two statements');
      for (const s of refusal.statements) {
        assert.equal(typeof s.subject, 'string');
        assert.equal(typeof s.constraint, 'string');
        assert.equal(typeof s.object, 'string');
      }
      assert.deepEqual([...refusal.statements.map(s => s.constraint)].sort(), [...row.constraints].sort());
      assert.equal(new Set(refusal.statements.map(s => `${s.subject} ${s.constraint} ${s.object}`)).size, refusal.statements.length, 'a statement is named twice');
      assert.deepEqual(answer.typeSchemas, { entity: {}, fact: {}, chrono: {}, edge: {} }, 'a refused file still answers a schema');
      assert.deepEqual(answer.changes, []);
    });
  }

  it('is refused in every mode, with the stored schema back', () => {
    const was = { entity: { keep: { description: 'mine' } }, fact: {}, chrono: {}, edge: {} };
    for (const mode of ['generate', 'expand', 'update']) {
      const answer = read(CONTRADICTIONS[0].quads, { from: ['shacl'], mode, stored: structuredClone(was) });
      assert.equal(answer.refusals[0]?.code, 'contradiction', `${mode} did not refuse the contradiction`);
      assert.deepEqual(answer.typeSchemas, was);
      assert.deepEqual(answer.changes, []);
    }
  });

  it('is refused whatever order its quads come in', () => {
    const a = read(CONTRADICTIONS[2].quads, { from: ['declared', 'shacl'] });
    const b = read([...CONTRADICTIONS[2].quads].reverse(), { from: ['declared', 'shacl'] });
    assert.deepEqual(a.refusals.map(r => [r.code, r.statements.map(s => s.constraint).sort()]), b.refusals.map(r => [r.code, r.statements.map(s => s.constraint).sort()]));
    assert.equal(b.refusals.length, 1);
  });

  it('is not refused when two statements agree (the same datatype twice, in the axioms and the shapes)', () => {
    const answer = read([...owlWith([Q(ex('size'), 'rdfs:range', 'xsd:string')]), ...shapeWith([Q(PS, 'sh:datatype', 'xsd:string')])], { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(answer.typeSchemas.entity.Thing.propertySchemas.size, { type: 'string', iri: ex('size') });
  });
});

describe('names that collide after shortening', () => {
  const A = 'http://a.example.org/x#Person';
  const B = 'http://b.example.org/y/Person';

  it('two classes of one local part are refused with both addresses', () => {
    const answer = read([Q(A, 'rdf:type', 'owl:Class'), Q(B, 'rdf:type', 'owl:Class')], { from: ['declared'] });
    assert.equal(answer.refusals.length, 1);
    assert.equal(answer.refusals[0].code, 'name-collision');
    assert.deepEqual(answer.refusals[0].statements.map(s => s.subject).sort(), [A, B]);
    assert.ok(answer.refusals[0].message.includes(A) && answer.refusals[0].message.includes(B), 'the message does not name both addresses');
    assert.deepEqual(answer.typeSchemas.entity, {});
  });

  it('a label that is another class\'s local part collides with it', () => {
    const answer = read([Q(A, 'rdf:type', 'owl:Class'), Q(B, 'rdf:type', 'owl:Class'), Q(A, 'rdfs:label', LIT('Human'))], { from: ['declared'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(Object.keys(answer.typeSchemas.entity).sort(), ['Human', 'Person']);
    const collide = read([Q(A, 'rdf:type', 'owl:Class'), Q(B, 'rdf:type', 'owl:Class'), Q(A, 'rdfs:label', LIT('Person')), Q(B, 'rdfs:label', LIT('Person'))], { from: ['declared'] });
    assert.equal(collide.refusals[0]?.code, 'name-collision');
  });

  it('two properties of one type that shorten alike are refused with both addresses', () => {
    const p1 = 'http://a.example.org/p#name';
    const p2 = 'http://b.example.org/p/name';
    const answer = read([Q(T, 'rdf:type', 'owl:Class'), Q(p1, 'rdf:type', 'owl:DatatypeProperty'), Q(p1, 'rdfs:domain', T), Q(p2, 'rdf:type', 'owl:DatatypeProperty'), Q(p2, 'rdfs:domain', T)], { from: ['declared'] });
    assert.equal(answer.refusals.length, 1);
    assert.equal(answer.refusals[0].code, 'name-collision');
    assert.deepEqual(answer.refusals[0].statements.map(s => s.subject).sort(), [p1, p2]);
  });

  it('the same name in two kinds is no collision', () => {
    const answer = read([
      Q(ex('S1'), 'rdf:type', 'sh:NodeShape'), Q(ex('S1'), 'sh:targetClass', A),
      Q(ex('S2'), 'rdf:type', 'sh:NodeShape'), Q(ex('S2'), 'sh:targetSubjectsOf', B),
    ], { from: ['shacl'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(Object.keys(answer.typeSchemas.entity), ['Person']);
    assert.deepEqual(Object.keys(answer.typeSchemas.edge), ['Person']);
  });

  it('two types read from one class in the file and the target\'s stored names are no collision when the names differ', () => {
    const answer = read([Q(A, 'rdf:type', 'owl:Class'), Q(`${A}2`, 'rdf:type', 'owl:Class')], { from: ['declared'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(Object.keys(answer.typeSchemas.entity).sort(), ['Person', 'Person2']);
  });
});

describe('a name that cannot be made', () => {
  it('an address with no local part and no label is named, and is no type', () => {
    const answer = read([Q('http://a.example.org/', 'rdf:type', 'owl:Class'), Q(ex('Ok'), 'rdf:type', 'owl:Class')], { from: ['declared'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(Object.keys(answer.typeSchemas.entity), ['Ok']);
    const entry = answer.notTaken.find(n => n.subject === 'http://a.example.org/');
    assert.equal(entry?.why, 'unreadable-value');
  });

  it('a name that would reach an object\'s internals is named, and is no type', () => {
    const answer = read([Q(ex('x'), 'rdf:type', 'owl:Class'), Q(ex('x'), 'rdfs:label', LIT('__proto__'))], { from: ['declared'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(Object.keys(answer.typeSchemas.entity), []);
    assert.equal(Object.getPrototypeOf(answer.typeSchemas.entity), Object.prototype);
    assert.ok(answer.notTaken.some(n => n.subject === ex('x') && n.why === 'unreadable-value'));
  });

  it('a boolean literal and an iri in a place that wants text are named', () => {
    const answer = read([Q(ex('x'), 'rdf:type', 'owl:Class'), Q(ex('x'), 'rdfs:comment', BOOL(true)), Q(ex('x'), 'rdfs:label', I(ex('lbl')))], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity, { x: { iri: ex('x') } });
    assert.equal(answer.notTaken.filter(n => n.why === 'unreadable-value').length, 2);
  });
});
