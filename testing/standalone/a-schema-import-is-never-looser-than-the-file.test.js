/**
 * A schema built from a file is exactly as strict as the file says: a required property, a one-only edge label and an allowed-values list come
 * back whole, a cardinality the schema cannot express is not taken, and a shape that targets a class the file does not declare is answered
 * (bundle-270, slice S8, Q-754).
 *
 * ## The defect this prevents
 *
 * A space built from an ontology is strict: it refuses a record that breaks its schema. A reader that rounds a statement to the nearest field
 * (`sh:minCount 2` to `required`, `sh:maxCount 2` to one-only, an enumeration with a member it cannot read to the enumeration of the others,
 * `xsd:integer` to `number`, a bare `sh:class` to an endpoint list that lets a fact through) builds a space that accepts what the file forbade
 * or refuses what it allowed, and nothing in the answer says so. Each statement either maps to a field that holds exactly what it says or is
 * named not taken.
 *
 * ## What it holds
 *
 * - **Required**: `sh:minCount 1` is `required`; `sh:minCount 0` states nothing; `sh:minCount 2` is not taken and the property stays optional.
 * - **One-only label**: `sh:maxCount 1` on the label's own property shape, and `owl:FunctionalProperty`, are `functional`; `sh:maxCount 2` is
 *   named and the label stays many.
 * - **Allowed values**: an `sh:in` list comes back as the same members in the same order (strings, numbers, booleans; the integer twin the
 *   export writes beside a whole decimal is one member); a list with a member that is no plain value is not taken at all, never a shorter list.
 * - **Endpoints**: the export's guarded form (classes, and an end that is no entity passes) is `endpoints`; a bare `sh:class` is named, because
 *   it would let a non-entity end through; a class the file does not name has no member name: the side is named, not guessed.
 * - **A shape that targets a class the file does not declare** is taken as a type when shapes are asked for, and the answer says the class is
 *   not declared in the file; a class the file declares says so too.
 * - **The kind of a type** is what its address or its target says (a vocabulary address of a chrono type, a shape under the space's base, the
 *   subjects of a property), else an entity: and a file's type is no type.
 *
 * Run: node --test testing/standalone/a-schema-import-is-never-looser-than-the-file.test.js (after the server and schema builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VOCAB, read, Q, N, I, LIT, LANG, LIST, INT, DEC, BOOL, ex, iriOf } from './_schema-from-rdf-doors.mjs';

const KNOWS = ex('knows');
/** An edge label's shape the way the export writes it: the node shape of its subjects and a property shape of the label. */
const label = (...onLabelShape) => [
  Q(ex('KnowsShape'), 'rdf:type', 'sh:NodeShape'), Q(ex('KnowsShape'), 'sh:targetSubjectsOf', KNOWS), Q(ex('KnowsShape'), 'sh:property', ex('KnowsLabel')),
  Q(ex('KnowsLabel'), 'rdf:type', 'sh:PropertyShape'), Q(ex('KnowsLabel'), 'sh:path', KNOWS), ...onLabelShape,
];
const onLabel = (predicate, object) => Q(ex('KnowsLabel'), predicate, object);

const PERSON = ex('Person');
const person = (...statements) => [
  Q(ex('PersonShape'), 'rdf:type', 'sh:NodeShape'), Q(ex('PersonShape'), 'sh:targetClass', PERSON), Q(ex('PersonShape'), 'sh:property', ex('PS')),
  Q(ex('PS'), 'rdf:type', 'sh:PropertyShape'), Q(ex('PS'), 'sh:path', ex('p')), ...statements,
];
const prop = (answer) => answer.typeSchemas.entity.Person.propertySchemas.p;

describe('a required property', () => {
  it('is required when the file counts one at least', () => {
    assert.equal(prop(read(person(Q(ex('PS'), 'sh:minCount', INT(1))))).required, true);
  });
  it('is optional when the file counts none at least, and when it counts two (which no field states)', () => {
    assert.equal(prop(read(person(Q(ex('PS'), 'sh:minCount', INT(0))))).required, undefined);
    assert.equal(prop(read(person(Q(ex('PS'), 'sh:minCount', INT(2))))).required, undefined);
  });
  it('is required only by a count of one, not by a minimum length alone', () => {
    assert.equal(prop(read(person(Q(ex('PS'), 'sh:minLength', INT(1))))).required, undefined);
  });
});

describe('a one-only edge label', () => {
  it('is functional when the label\'s shape allows one at most', () => {
    assert.equal(read(label(onLabel('sh:maxCount', INT(1)))).typeSchemas.edge.knows.functional, true);
  });
  it('is functional when the label is declared functional', () => {
    const answer = read([Q(KNOWS, 'rdf:type', 'owl:ObjectProperty'), Q(KNOWS, 'rdf:type', 'owl:FunctionalProperty')], { from: ['declared'] });
    assert.equal(answer.typeSchemas.edge.knows.functional, true);
  });
  it('stays many when the label\'s shape allows two, and the count is named', () => {
    const answer = read(label(onLabel('sh:maxCount', INT(2))));
    assert.equal(answer.typeSchemas.edge.knows.functional, undefined);
    assert.equal(answer.notTaken.filter(n => n.constraint === 'sh:maxCount').length, 1);
  });
  it('stays many when the file does not say one-only, however the shape is spelled', () => {
    assert.equal(read(label()).typeSchemas.edge.knows.functional, undefined);
  });
});

describe('an allowed-values list', () => {
  const values = (...members) => prop(read(person(Q(ex('PS'), 'sh:in', LIST(...members))))).enum;

  it('comes back as the same members in the same order', () => {
    assert.deepEqual(values(LIT('b'), LIT('a'), LIT('c')), ['b', 'a', 'c']);
    assert.deepEqual(values(INT(3), INT(1), INT(2)), [3, 1, 2]);
    assert.deepEqual(values(BOOL(true), BOOL(false)), [true, false]);
    assert.deepEqual(values(DEC('0.5'), INT(2)), [0.5, 2]);
  });

  it('reads the integer the export writes beside a whole decimal as the same member', () => {
    assert.deepEqual(values(DEC(1), INT(1), DEC(2), INT(2), DEC('2.5')), [1, 2, 2.5]);
  });

  it('is not taken when one member is no plain value, and is never a shorter list', () => {
    for (const bad of [LANG('b', 'en'), I(ex('iri')), LIT('x', ex('Money')), LIT('abc', iriOf('xsd:integer'))]) {
      const answer = read(person(Q(ex('PS'), 'sh:in', LIST(LIT('a'), bad))));
      assert.equal(prop(answer).enum, undefined);
      assert.equal(answer.notTaken.filter(n => n.constraint === 'sh:in' && n.why === 'unreadable-value').length, 1);
    }
  });

  it('is not taken when the list is no list', () => {
    const answer = read(person(Q(ex('PS'), 'sh:in', LIT('a'))));
    assert.equal(prop(answer).enum, undefined);
    assert.equal(answer.notTaken.filter(n => n.constraint === 'sh:in').length, 1);
  });

  it('is read from a list the parser writes as first and rest statements, and from the model\'s list term alike', () => {
    const chain = [
      Q(ex('PS'), 'sh:in', N('c1')),
      Q(N('c1'), 'rdf:first', LIT('a')), Q(N('c1'), 'rdf:rest', N('c2')), Q(N('c2'), 'rdf:first', LIT('b')), Q(N('c2'), 'rdf:rest', 'rdf:nil'),
    ];
    assert.deepEqual(prop(read(person(...chain))).enum, ['a', 'b']);
  });

  it('is not taken when the list has no end', () => {
    const loop = [Q(ex('PS'), 'sh:in', N('c1')), Q(N('c1'), 'rdf:first', LIT('a')), Q(N('c1'), 'rdf:rest', N('c1'))];
    const answer = read(person(...loop));
    assert.equal(prop(answer).enum, undefined);
    assert.equal(answer.notTaken.filter(n => n.constraint === 'sh:in').length, 1);
  });
});

describe('endpoints', () => {
  const from = (...classes) => [
    Q(ex('KnowsShape'), 'sh:or', LIST(...classes.map((_, i) => N(`m${i}`)), N('esc'))),
    ...classes.map((c, i) => Q(N(`m${i}`), 'sh:class', c)),
    Q(N('esc'), 'sh:not', N('inner')), Q(N('inner'), 'sh:class', 'ythril:Entity'),
  ];
  const declared = [Q(PERSON, 'rdf:type', 'owl:Class'), Q(ex('Org'), 'rdf:type', 'owl:Class')];

  it('are the classes of the guarded form the export writes, in the order written', () => {
    const answer = read([...label(), ...from(ex('Org'), PERSON), ...declared, Q(ex('OrgShape'), 'sh:targetClass', ex('Org'))], { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.typeSchemas.edge.knows.endpoints, { from: ['Org', 'Person'] });
  });

  it('read the untyped bucket as UNTYPED', () => {
    const answer = read([...label(), ...from(iriOf('ythril:Untyped'))]);
    assert.deepEqual(answer.typeSchemas.edge.knows.endpoints, { from: ['UNTYPED'] });
  });

  it('are not taken from a bare sh:class, which would let an end that is no entity through', () => {
    const answer = read(label(onLabel('sh:class', PERSON)));
    assert.equal(answer.typeSchemas.edge.knows.endpoints, undefined);
    const entry = answer.notTaken.find(n => n.constraint === 'sh:class');
    assert.equal(entry?.why, 'looser-field');
  });

  it('are not taken when a class the file does not name has no member name: the side is named, not guessed', () => {
    const answer = read([...label(), ...from(ex('Stranger'))], { from: ['shacl'] });
    assert.equal(answer.typeSchemas.edge.knows.endpoints, undefined);
    const entry = answer.notTaken.find(n => n.constraint === 'sh:or' && n.subject === ex('KnowsShape'));
    assert.equal(entry?.why, 'unreadable-value');
  });
});

describe('a shape that targets a class the file does not declare', () => {
  const shape = [Q(ex('S'), 'rdf:type', 'sh:NodeShape'), Q(ex('S'), 'sh:targetClass', PERSON)];

  it('is a type when shapes are asked for, and the answer says the class is not declared in the file', () => {
    const answer = read(shape, { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.typeSchemas.entity, { Person: { iri: PERSON } });
    const entry = answer.taken.find(t => t.constraint === 'sh:targetClass');
    assert.equal(entry.declared, false);
  });

  it('says the class is declared when it is', () => {
    const answer = read([...shape, Q(PERSON, 'rdf:type', 'owl:Class')], { from: ['declared', 'shacl'] });
    assert.equal(answer.taken.find(t => t.constraint === 'sh:targetClass').declared, true);
  });

  it('is not read at all when only declarations are asked for, and the file\'s statements are outside', () => {
    const answer = read(shape, { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity, {});
    assert.deepEqual(answer.counts, { statements: 2, taken: 0, notTaken: 0, outside: 2 });
  });
});

describe('the kind of a type', () => {
  const target = (address) => [Q(ex('S'), 'rdf:type', 'sh:NodeShape'), Q(ex('S'), 'sh:targetClass', address)];

  it('is read from the vocabulary address of the space (a chrono type, a fact type)', () => {
    const answer = read([...target(`${VOCAB}chrono/meeting`), Q(ex('S2'), 'sh:targetClass', `${VOCAB}fact/note`)], { from: ['shacl'] });
    assert.deepEqual(answer.typeSchemas.chrono, { meeting: {} });
    assert.deepEqual(answer.typeSchemas.fact, { note: {} });
  });

  it('is an entity for a class the space\'s names do not read', () => {
    assert.deepEqual(read(target(ex('Person')), { from: ['shacl'] }).typeSchemas.entity, { Person: { iri: ex('Person') } });
  });

  it('is no type for a file, and the statement is named', () => {
    const answer = read(target(`${VOCAB}file`), { from: ['shacl'] });
    assert.deepEqual(answer.typeSchemas, { entity: {}, fact: {}, chrono: {}, edge: {} });
    assert.ok(answer.notTaken.some(n => n.constraint === 'sh:targetClass'));
  });

  it('a name the vocabulary address gives wins over a label that differs, and the label is named', () => {
    const answer = read([...target(`${VOCAB}entity/person`), Q(ex('S'), 'sh:name', LIT('Human'))], { from: ['shacl'] });
    assert.deepEqual(answer.typeSchemas.entity, { person: {} });
    assert.ok(answer.notTaken.some(n => n.constraint === 'sh:name'));
  });

  it('is not an explicit address when the address is the vocabulary\'s own derived name', () => {
    assert.equal(read(target(`${VOCAB}entity/person`), { from: ['shacl'] }).typeSchemas.entity.person.iri, undefined);
  });

  it('a type address of the vocabulary that is not a spelling the export writes is named, and is no type', () => {
    const answer = read(target(`${VOCAB}entity/a%2fb/`), { from: ['shacl'] });
    assert.deepEqual(answer.typeSchemas.entity, {});
    assert.equal(answer.notTaken.find(n => n.constraint === 'sh:targetClass')?.why, 'unreadable-value');
  });
});
