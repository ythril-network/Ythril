/**
 * What a schema file does to the schema a space already has depends on its mode, and the answer says what it would change (bundle-270, slice
 * S8, Q-754; plan section 3 (g), Modes).
 *
 * ## The defect this prevents
 *
 * An import that builds over a stored schema either clobbers a type the owner edited by hand (a write that loses work) or adds nothing and says
 * nothing (a file that looks imported and is not). The three modes are one rule each, given the stored type schemas as an argument: `generate`
 * builds a whole schema and only into a space with no type; `expand` adds the types and properties that are absent and leaves what is stored
 * alone, naming each stored value the file states differently; `update` changes the stored values the file states, adds what is absent, and
 * deletes nothing. The answer lists every change as a row (what, from, to), so a dry run shows exactly what a write would do, and the stored
 * argument is never touched.
 *
 * ## What it holds
 *
 * - **generate** into an empty schema builds the whole; into a schema with a type it is refused (`schema-not-empty`), the stored schema comes
 *   back unchanged and no change is listed.
 * - **expand** adds absent types and absent properties of stored types; a stored field is kept, and a field the file states differently is named
 *   `kept-as-stored`; a stored type that is a library reference is kept whole.
 * - **update** replaces the stored fields the file states (naming each change from and to), adds what is absent, keeps every stored type and
 *   property the file does not name, and keeps a field the file does not state (an absence is no statement).
 * - **A file that equals the stored schema** changes nothing in any mode but `generate`.
 * - **A refusal** (a contradiction in the file) is the answer in every mode, with the stored schema back and no change.
 * - **A bad request** (a mode that is none, no `from`) throws.
 *
 * Run: node --test testing/standalone/a-schema-import-meets-the-stored-schema-by-its-mode.test.js (after the server and schema builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, read, exported, reader, namesOf, Q, ex } from './_schema-from-rdf-doors.mjs';

const clone = (x) => structuredClone(x);
const deepFreeze = (x) => { if (x && typeof x === 'object') { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; };
const FILE = exported(META);

/** A stored schema that overlaps the file's: `person` with fewer properties and other values, a type the file lacks, a library reference. */
const stored = () => ({
  entity: {
    person: { description: 'Our own words', propertySchemas: { age: { type: 'number', minimum: 10 }, extra: { type: 'string' } } },
    legacy: { description: 'A type the file does not know' },
    contact: { $ref: 'library:contact' },
  },
  fact: {},
  chrono: {},
  edge: { knows: { description: 'One person knows another', functional: false } },
});

describe('generate', () => {
  it('builds the whole schema into a space with no type, and lists each type and property as an addition', () => {
    const answer = read(FILE, { mode: 'generate', stored: { entity: {}, fact: {}, chrono: {}, edge: {} } });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(answer.typeSchemas, META.typeSchemas);
    const types = answer.changes.filter(c => c.change === 'add-type').map(c => `${c.kind}:${c.type}`).sort();
    assert.deepEqual(types, ['chrono:meeting', 'edge:knows', 'edge:reports_to', 'entity:contact', 'entity:person', 'entity:robot', 'fact:note']);
    assert.ok(answer.changes.some(c => c.change === 'add-property' && c.kind === 'entity' && c.type === 'person' && c.prop === 'age'));
  });

  it('is the same with no stored schema handed in (a space with no type)', () => {
    assert.deepEqual(read(FILE, { mode: 'generate' }).typeSchemas, META.typeSchemas);
  });

  it('is refused into a space that has a type, naming one, and the stored schema comes back unchanged', () => {
    const was = stored();
    const answer = read(FILE, { mode: 'generate', stored: deepFreeze(clone(was)) });
    assert.equal(answer.refusals.length, 1);
    assert.equal(answer.refusals[0].code, 'schema-not-empty');
    assert.match(answer.refusals[0].message, /person|legacy|contact|knows/);
    assert.deepEqual(answer.typeSchemas, was);
    assert.deepEqual(answer.changes, []);
  });
});

describe('expand', () => {
  it('adds the types and properties that are absent and keeps every stored value', () => {
    const was = stored();
    const answer = read(FILE, { mode: 'expand', stored: deepFreeze(clone(was)) });
    assert.deepEqual(answer.refusals, []);
    const t = answer.typeSchemas;
    assert.equal(t.entity.person.description, 'Our own words');
    assert.deepEqual(t.entity.person.propertySchemas.age, { type: 'number', minimum: 10 });
    assert.deepEqual(t.entity.person.propertySchemas.extra, { type: 'string' });
    assert.deepEqual(t.entity.person.propertySchemas.name, META.typeSchemas.entity.person.propertySchemas.name);
    assert.deepEqual(t.entity.robot, META.typeSchemas.entity.robot);
    assert.deepEqual(t.entity.legacy, was.entity.legacy);
    assert.deepEqual(t.entity.contact, { $ref: 'library:contact' });
    assert.deepEqual(t.fact, META.typeSchemas.fact);
    assert.deepEqual(t.edge.reports_to, META.typeSchemas.edge.reports_to);
    assert.equal(t.edge.knows.description, was.edge.knows.description);
    assert.equal(t.edge.knows.functional, false);
    assert.equal(t.edge.knows.endpoints, undefined, 'expand added a field to a stored type');
    assert.deepEqual(t.edge.knows.propertySchemas, META.typeSchemas.edge.knows.propertySchemas, 'the properties of a stored type the file adds are not added');
  });

  it('names each stored value the file states differently, with the place, and changes none of them', () => {
    const answer = read(FILE, { mode: 'expand', stored: stored() });
    const kept = answer.notTaken.filter(n => n.why === 'kept-as-stored');
    const places = kept.map(n => `${n.where.kind}:${n.where.type}${n.where.prop ? `.${n.where.prop}` : ''} ${n.constraint}`);
    assert.ok(places.includes('entity:person sh:description'), 'the type description the file states differently is not named');
    assert.ok(places.includes('entity:person.age sh:or'), 'a field the file states (the guarded maximum) and the stored property lacks is not added in expand, and not named either');
    assert.ok(places.includes('edge:knows sh:or'), 'the endpoints the file states and the stored label lacks are not named');
    assert.ok(kept.some(n => n.where.prop === 'age'), 'the stored age differs from the file\'s and is not named');
    assert.ok(kept.some(n => n.where.type === 'contact'), 'the library reference the file states fields of is not named');
    assert.ok(answer.changes.every(c => c.change === 'add-type' || c.change === 'add-property'), 'expand changed a stored value');
  });

  it('lists the additions as rows and nothing else', () => {
    const answer = read(FILE, { mode: 'expand', stored: stored() });
    const added = answer.changes.map(c => `${c.change} ${c.kind}:${c.type}${c.prop ? `.${c.prop}` : ''}`);
    assert.ok(added.includes('add-type fact:note'));
    assert.ok(added.includes('add-property entity:person.name'));
    assert.ok(!added.some(a => a.includes('entity:person.age')), 'a stored property was listed as added');
    assert.ok(!added.some(a => a.includes('entity:legacy')), 'a stored type the file lacks was listed');
  });
});

describe('update', () => {
  it('replaces the stored values the file states, adds what is absent, keeps what the file does not name', () => {
    const answer = read(FILE, { mode: 'update', stored: deepFreeze(stored()) });
    assert.deepEqual(answer.refusals, []);
    const t = answer.typeSchemas;
    assert.equal(t.entity.person.description, 'A person we know');
    assert.deepEqual(t.entity.person.propertySchemas.age, META.typeSchemas.entity.person.propertySchemas.age);
    assert.deepEqual(t.entity.person.propertySchemas.extra, { type: 'string' }, 'a stored property the file does not name was deleted');
    assert.deepEqual(t.entity.legacy, { description: 'A type the file does not know' }, 'a stored type the file does not name was deleted');
    assert.deepEqual(t.entity.contact, { $ref: 'library:contact' }, 'a library reference was edited field by field');
    assert.equal(t.edge.knows.functional, false, 'a field the file does not state was changed (an absence is no statement)');
    assert.deepEqual(t.edge.knows.endpoints, META.typeSchemas.edge.knows.endpoints);
  });

  it('lists each changed value with its place, what it was and what it becomes', () => {
    const answer = read(FILE, { mode: 'update', stored: stored() });
    const age = answer.changes.filter(c => c.kind === 'entity' && c.type === 'person' && c.prop === 'age');
    assert.deepEqual(age.map(c => [c.change, c.field, c.from, c.to]).sort(), [
      ['add-field', 'description', undefined, 'Age in years'],
      ['add-field', 'maximum', undefined, 150],
      ['change-field', 'minimum', 10, 0],
    ].sort());
    const description = answer.changes.find(c => c.kind === 'entity' && c.type === 'person' && c.prop === undefined && c.field === 'description');
    assert.deepEqual([description.change, description.from, description.to], ['change-field', 'Our own words', 'A person we know']);
  });

  it('changes nothing when the stored schema is what the file says', () => {
    const answer = read(FILE, { mode: 'update', stored: clone(META.typeSchemas) });
    assert.deepEqual(answer.changes, []);
    assert.deepEqual(answer.typeSchemas, META.typeSchemas);
  });

  it('does the same in expand: a file equal to the stored schema adds nothing', () => {
    const answer = read(FILE, { mode: 'expand', stored: clone(META.typeSchemas) });
    assert.deepEqual(answer.changes, []);
    assert.deepEqual(answer.typeSchemas, META.typeSchemas);
  });
});

describe('a refusal and a bad request', () => {
  const CONTRADICTION = [
    Q(ex('Shape'), 'rdf:type', 'sh:NodeShape'), Q(ex('Shape'), 'sh:targetClass', ex('Thing')), Q(ex('Shape'), 'sh:property', ex('PS')),
    Q(ex('PS'), 'sh:path', ex('size')), Q(ex('PS'), 'sh:datatype', 'xsd:string'), Q(ex('PS'), 'sh:datatype', 'xsd:boolean'),
  ];

  for (const mode of ['generate', 'expand', 'update']) {
    it(`a contradiction in the file is the answer in ${mode} mode: the stored schema back, no change`, () => {
      const was = mode === 'generate' ? { entity: {}, fact: {}, chrono: {}, edge: {} } : stored();
      const answer = read(CONTRADICTION, { mode, stored: clone(was) });
      assert.equal(answer.refusals.length, 1);
      assert.equal(answer.refusals[0].code, 'contradiction');
      assert.deepEqual(answer.typeSchemas, was);
      assert.deepEqual(answer.changes, []);
    });
  }

  it('throws for a mode that is none and for no source of declarations, never answers them', () => {
    const run = reader();
    const names = namesOf();
    assert.throws(() => run(FILE, { from: ['shacl'], mode: 'delete', names }), TypeError);
    assert.throws(() => run(FILE, { from: [], mode: 'generate', names }), TypeError);
    assert.throws(() => run(FILE, { from: ['data'], mode: 'generate', names }), TypeError);
  });

  it('never changes the quads or the stored schema it is handed', () => {
    const quads = deepFreeze(clone(FILE));
    const was = deepFreeze(stored());
    assert.doesNotThrow(() => read(quads, { mode: 'update', stored: was }));
    assert.deepEqual(was, stored());
  });
});
