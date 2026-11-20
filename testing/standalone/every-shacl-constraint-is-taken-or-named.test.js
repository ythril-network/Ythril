/**
 * Every SHACL Core constraint a shape states is mapped to the schema field it came from, or named as not taken with its shape, the constraint
 * and why (bundle-270, slice S8, Q-754; plan section 3 (g)).
 *
 * ## The defect this prevents
 *
 * A type schema has a few fields and SHACL Core has some thirty constraint components. A reader that maps the ones it knows and passes over
 * the rest gives a strict-looking space that accepts what the file's shape forbade, and nobody can tell which constraint was lost. So each
 * constraint of Core is in exactly one of two columns of the reader's table (`SHACL_CONSTRAINTS`, in `schema-from-rdf.ts`): mapped to a field,
 * or not taken with a reason; a constraint in neither fails here; and the table is not trusted: each constraint is stated on a shape of a
 * file, read, and the answer must say what the table says. A constraint that would be read looser than it was written (`xsd:integer` as a
 * `number`, `sh:minExclusive` as a `minimum`, a bare `sh:pattern` on a value that may be a number) is not mapped, and a cardinality the
 * schema cannot express (`sh:minCount 2`, `sh:maxCount 2`) is not rounded to the nearest one it can.
 *
 * ## What it holds
 *
 * - **The two columns**: the list of Core's constraint components is written out in this file (from the SHACL recommendation, section 4); each
 *   is in the reader's table once, as mapped or as not taken, and the table names no constraint outside Core and its parameters.
 * - **Each constraint, on a shape**: a mapped constraint gives a `taken` entry for the field its row names, with the value; a constraint not
 *   taken gives a `notTaken` entry with the shape's address, the constraint and the reason of its row.
 * - **A statement is counted once**: every statement of the file is taken, named or outside, never lost.
 * - **A predicate the reader does not know** on a taken shape is named, not passed over.
 *
 * Run: node --test testing/standalone/every-shacl-constraint-is-taken-or-named.test.js (after the server and schema builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mod, read, reader, Q, N, I, LIT, LANG, LIST, INT, DEC, BOOL, ex, iriOf } from './_schema-from-rdf-doors.mjs';

/** SHACL Core's constraint components with the parameters they carry (the SHACL recommendation, section 4), written out. */
const CORE_CONSTRAINTS = [
  'sh:class', 'sh:datatype', 'sh:nodeKind',
  'sh:minCount', 'sh:maxCount',
  'sh:minExclusive', 'sh:minInclusive', 'sh:maxExclusive', 'sh:maxInclusive',
  'sh:minLength', 'sh:maxLength', 'sh:pattern', 'sh:flags', 'sh:languageIn', 'sh:uniqueLang',
  'sh:equals', 'sh:disjoint', 'sh:lessThan', 'sh:lessThanOrEquals',
  'sh:not', 'sh:and', 'sh:or', 'sh:xone',
  'sh:node', 'sh:property', 'sh:qualifiedValueShape', 'sh:qualifiedMinCount', 'sh:qualifiedMaxCount', 'sh:qualifiedValueShapesDisjoint',
  'sh:closed', 'sh:ignoredProperties', 'sh:hasValue', 'sh:in',
];

const NODE = ex('PersonShape');
const CLASS = ex('Person');
const PROP = ex('ageShape');
const PATH = ex('age');

/** A node shape of `Person` with one property shape (an IRI, so the answer can name it) and the statements `props` add to that property shape. */
function file(props, onNode = []) {
  return [
    Q(NODE, 'rdf:type', 'sh:NodeShape'), Q(NODE, 'sh:targetClass', CLASS), Q(NODE, 'sh:property', PROP), ...onNode,
    Q(PROP, 'rdf:type', 'sh:PropertyShape'), Q(PROP, 'sh:path', PATH), ...props,
  ];
}
const p = (predicate, object) => Q(PROP, predicate, object);
const numberOr = () => [p('sh:or', LIST(N('n1'), N('n2'))), Q(N('n1'), 'sh:datatype', 'xsd:decimal'), Q(N('n2'), 'sh:datatype', 'xsd:integer')];

/**
 * One row per way a constraint can be stated. `constraint` is the Core constraint it exercises; `taken` is `[field, value]` of the property
 * `age` of `Person`, or `notTaken` is `[constraint, why]` named on the shape. Written by hand, never read from the reader.
 */
const ROWS = [
  { constraint: 'sh:minCount', quads: file([p('sh:minCount', INT(1))]), taken: ['required', true] },
  { constraint: 'sh:maxCount', quads: file([p('sh:maxCount', INT(1))]), taken: ['(every property)', undefined] },
  { constraint: 'sh:datatype', quads: file([p('sh:datatype', 'xsd:string')]), taken: ['type', 'string'] },
  { constraint: 'sh:datatype', quads: file([p('sh:datatype', 'xsd:boolean')]), taken: ['type', 'boolean'] },
  { constraint: 'sh:datatype', quads: file([p('sh:datatype', 'xsd:decimal')]), taken: ['type', 'number'] },
  { constraint: 'sh:minInclusive', quads: file([p('sh:datatype', 'xsd:decimal'), p('sh:minInclusive', DEC(0))]), taken: ['minimum', 0] },
  { constraint: 'sh:maxInclusive', quads: file([p('sh:datatype', 'xsd:decimal'), p('sh:maxInclusive', DEC(150))]), taken: ['maximum', 150] },
  { constraint: 'sh:minLength', quads: file([p('sh:minCount', INT(1)), p('sh:minLength', INT(1))]), taken: ['required', true] },
  { constraint: 'sh:pattern', quads: file([p('sh:datatype', 'xsd:string'), p('sh:pattern', LIT('^[A-Z]'))]), taken: ['pattern', '^[A-Z]'] },
  { constraint: 'sh:or', quads: file(numberOr()), taken: ['type', 'number'] },
  { constraint: 'sh:in', quads: file([p('sh:in', LIST(LIT('a'), LIT('b')))]), taken: ['enum', ['a', 'b']] },
  { constraint: 'sh:property', quads: file([]), taken: ['propertySchemas', undefined] },

  { constraint: 'sh:class', quads: file([p('sh:class', ex('Thing'))]), notTaken: ['sh:class', 'no-field'] },
  { constraint: 'sh:nodeKind', quads: file([p('sh:nodeKind', 'sh:Literal')]), notTaken: ['sh:nodeKind', 'no-field'] },
  { constraint: 'sh:minExclusive', quads: file([p('sh:datatype', 'xsd:decimal'), p('sh:minExclusive', DEC(0))]), notTaken: ['sh:minExclusive', 'looser-field'] },
  { constraint: 'sh:maxExclusive', quads: file([p('sh:datatype', 'xsd:decimal'), p('sh:maxExclusive', DEC(9))]), notTaken: ['sh:maxExclusive', 'looser-field'] },
  { constraint: 'sh:maxLength', quads: file([p('sh:maxLength', INT(20))]), notTaken: ['sh:maxLength', 'no-field'] },
  { constraint: 'sh:flags', quads: file([p('sh:datatype', 'xsd:string'), p('sh:pattern', LIT('^a')), p('sh:flags', LIT('i'))]), notTaken: ['sh:flags', 'no-field'] },
  { constraint: 'sh:pattern', quads: file([p('sh:datatype', 'xsd:string'), p('sh:pattern', LIT('^a')), p('sh:flags', LIT('i'))]), notTaken: ['sh:pattern', 'no-field'] },
  { constraint: 'sh:languageIn', quads: file([p('sh:languageIn', LIST(LIT('en')))]), notTaken: ['sh:languageIn', 'no-field'] },
  { constraint: 'sh:uniqueLang', quads: file([p('sh:uniqueLang', BOOL(true))]), notTaken: ['sh:uniqueLang', 'no-field'] },
  { constraint: 'sh:equals', quads: file([p('sh:equals', ex('other'))]), notTaken: ['sh:equals', 'no-field'] },
  { constraint: 'sh:disjoint', quads: file([p('sh:disjoint', ex('other'))]), notTaken: ['sh:disjoint', 'no-field'] },
  { constraint: 'sh:lessThan', quads: file([p('sh:lessThan', ex('other'))]), notTaken: ['sh:lessThan', 'no-field'] },
  { constraint: 'sh:lessThanOrEquals', quads: file([p('sh:lessThanOrEquals', ex('other'))]), notTaken: ['sh:lessThanOrEquals', 'no-field'] },
  { constraint: 'sh:not', quads: file([p('sh:not', N('x')), Q(N('x'), 'sh:datatype', 'xsd:string')]), notTaken: ['sh:not', 'no-field'] },
  { constraint: 'sh:and', quads: file([p('sh:and', LIST(N('x'))), Q(N('x'), 'sh:datatype', 'xsd:string')]), notTaken: ['sh:and', 'no-field'] },
  { constraint: 'sh:xone', quads: file([p('sh:xone', LIST(N('x'), N('y'))), Q(N('x'), 'sh:datatype', 'xsd:string'), Q(N('y'), 'sh:datatype', 'xsd:boolean')]), notTaken: ['sh:xone', 'no-field'] },
  { constraint: 'sh:node', quads: file([p('sh:node', ex('OtherShape'))]), notTaken: ['sh:node', 'no-field'] },
  { constraint: 'sh:qualifiedValueShape', quads: file([p('sh:qualifiedValueShape', ex('OtherShape')), p('sh:qualifiedMinCount', INT(1))]), notTaken: ['sh:qualifiedValueShape', 'no-field'] },
  { constraint: 'sh:qualifiedMinCount', quads: file([p('sh:qualifiedValueShape', ex('OtherShape')), p('sh:qualifiedMinCount', INT(1))]), notTaken: ['sh:qualifiedMinCount', 'no-field'] },
  { constraint: 'sh:qualifiedMaxCount', quads: file([p('sh:qualifiedValueShape', ex('OtherShape')), p('sh:qualifiedMaxCount', INT(2))]), notTaken: ['sh:qualifiedMaxCount', 'no-field'] },
  { constraint: 'sh:qualifiedValueShapesDisjoint', quads: file([p('sh:qualifiedValueShape', ex('OtherShape')), p('sh:qualifiedValueShapesDisjoint', BOOL(true))]), notTaken: ['sh:qualifiedValueShapesDisjoint', 'no-field'] },
  { constraint: 'sh:closed', quads: file([], [Q(NODE, 'sh:closed', BOOL(true))]), notTaken: ['sh:closed', 'no-field'] },
  { constraint: 'sh:ignoredProperties', quads: file([], [Q(NODE, 'sh:closed', BOOL(true)), Q(NODE, 'sh:ignoredProperties', LIST(I(iriOf('rdf:type'))))]), notTaken: ['sh:ignoredProperties', 'no-field'] },
  { constraint: 'sh:hasValue', quads: file([p('sh:hasValue', LIT('x'))]), notTaken: ['sh:hasValue', 'no-field'] },

  // a constraint of Core stated in a way that would read looser than it was written, or in a form no field holds
  { constraint: 'sh:minCount', quads: file([p('sh:minCount', INT(2))]), notTaken: ['sh:minCount', 'no-field'] },
  { constraint: 'sh:maxCount', quads: file([p('sh:maxCount', INT(2))]), notTaken: ['sh:maxCount', 'no-field'] },
  { constraint: 'sh:maxCount', quads: file([p('sh:maxCount', INT(0))]), notTaken: ['sh:maxCount', 'no-field'] },
  { constraint: 'sh:datatype', quads: file([p('sh:datatype', 'xsd:integer')]), notTaken: ['sh:datatype', 'looser-field'] },
  { constraint: 'sh:datatype', quads: file([p('sh:datatype', 'xsd:date')]), notTaken: ['sh:datatype', 'looser-field'] },
  { constraint: 'sh:datatype', quads: file([p('sh:datatype', ex('Money'))]), notTaken: ['sh:datatype', 'no-field'] },
  { constraint: 'sh:minInclusive', quads: file([p('sh:minInclusive', DEC(0))]), notTaken: ['sh:minInclusive', 'looser-field'] },
  { constraint: 'sh:maxInclusive', quads: file([p('sh:datatype', 'xsd:string'), p('sh:maxInclusive', DEC(0))]), notTaken: ['sh:maxInclusive', 'looser-field'] },
  { constraint: 'sh:minLength', quads: file([p('sh:minLength', INT(1))]), notTaken: ['sh:minLength', 'no-field'] },
  { constraint: 'sh:minLength', quads: file([p('sh:minCount', INT(1)), p('sh:minLength', INT(3))]), notTaken: ['sh:minLength', 'no-field'] },
  { constraint: 'sh:pattern', quads: file([p('sh:pattern', LIT('^A'))]), notTaken: ['sh:pattern', 'looser-field'] },
  { constraint: 'sh:pattern', quads: file([p('sh:datatype', 'xsd:string'), p('sh:pattern', LIT('\\p{L}+'))]), notTaken: ['sh:pattern', 'unreadable-value'] },
  { constraint: 'sh:or', quads: file([p('sh:or', LIST(N('x'), N('y'))), Q(N('x'), 'sh:datatype', 'xsd:string'), Q(N('y'), 'sh:datatype', 'xsd:boolean')]), notTaken: ['sh:or', 'no-field'] },
  { constraint: 'sh:in', quads: file([p('sh:in', LIST(LIT('a'), LANG('b', 'en')))]), notTaken: ['sh:in', 'unreadable-value'] },
  { constraint: 'sh:in', quads: file([p('sh:in', LIST(LIT('a'), ex('iri')))]), notTaken: ['sh:in', 'unreadable-value'] },
];

describe('the two columns of the table of SHACL constraints', () => {
  it('holds each constraint of Core once, as mapped or as not taken, and none outside Core', () => {
    assert.ok(Array.isArray(mod.SHACL_CONSTRAINTS), 'SHACL_CONSTRAINTS is not exported by server/src/rdf/schema-from-rdf.ts: no constraint is in either column');
    const mapped = mod.SHACL_CONSTRAINTS.filter(r => r.outcome === 'mapped').map(r => r.constraint);
    const notTaken = mod.SHACL_CONSTRAINTS.filter(r => r.outcome === 'not-taken').map(r => r.constraint);
    const inNeither = CORE_CONSTRAINTS.filter(c => !mapped.includes(c) && !notTaken.includes(c));
    assert.deepEqual(inNeither, [], `constraints of SHACL Core in neither column: ${inNeither.join(', ')}`);
    const inBoth = CORE_CONSTRAINTS.filter(c => mapped.includes(c) && notTaken.includes(c));
    assert.deepEqual(inBoth, [], `constraints in both columns: ${inBoth.join(', ')}`);
    const twice = mod.SHACL_CONSTRAINTS.map(r => r.constraint).filter((c, i, all) => all.indexOf(c) !== i);
    assert.deepEqual(twice, [], `constraints with two rows: ${twice.join(', ')}`);
    const outside = [...mapped, ...notTaken].filter(c => !CORE_CONSTRAINTS.includes(c));
    assert.deepEqual(outside, [], `rows for something that is no constraint of Core: ${outside.join(', ')}`);
  });

  it('a row of the table that maps names the fields it maps to, and a row that does not names its reason', () => {
    for (const row of mod.SHACL_CONSTRAINTS) {
      if (row.outcome === 'mapped') assert.ok(Array.isArray(row.fields) && row.fields.length > 0, `${row.constraint} is mapped to no field`);
      else assert.ok(typeof row.why === 'string' && row.why !== '', `${row.constraint} is not taken for no reason`);
    }
  });

  it('every constraint of Core is stated on a shape below, at least once', () => {
    const exercised = new Set(ROWS.map(r => r.constraint));
    const unexercised = CORE_CONSTRAINTS.filter(c => !exercised.has(c));
    assert.deepEqual(unexercised, [], `no case states: ${unexercised.join(', ')}`);
  });
});

describe('each constraint, stated on the property shape of a type, is read as its row says', () => {
  for (const [i, row] of ROWS.entries()) {
    const how = row.taken ? `is taken as ${row.taken[0]}` : `is not taken (${row.notTaken[1]})`;
    it(`${row.constraint} (case ${i + 1}) ${how}`, () => {
      const answer = read(row.quads, { from: ['shacl'] });
      assert.deepEqual(answer.refusals, []);
      if (row.taken) {
        const [field, value] = row.taken;
        const entries = answer.taken.filter(t => t.field === field && t.where.type === 'Person');
        assert.ok(entries.length > 0, `no statement was taken as ${field}`);
        if (value !== undefined) assert.deepEqual(entries.find(t => t.where.prop === 'age')?.value ?? entries[0].value, value);
        const table = mod.SHACL_CONSTRAINTS.find(r => r.constraint === row.constraint);
        assert.equal(table.outcome, 'mapped', `${row.constraint} is stated and taken, and the table says it is not`);
        assert.ok(table.fields.includes(field), `the table maps ${row.constraint} to ${table.fields.join(', ')}, not ${field}`);
      } else {
        const [constraint, why] = row.notTaken;
        const named = answer.notTaken.filter(n => n.constraint === constraint);
        assert.equal(named.length, 1, `${constraint} is named ${named.length} times, not once`);
        assert.equal(named[0].why, why);
        assert.ok([PROP, NODE].includes(named[0].subject), `the entry names ${named[0].subject}, not the shape that states it`);
        assert.equal(typeof named[0].message, 'string');
      }
      assert.equal(answer.counts.statements, answer.counts.taken + answer.counts.notTaken + answer.counts.outside, 'a statement was lost');
    });
  }
});

describe('what the table does not know', () => {
  it('a predicate a taken shape carries that is no constraint is named, not passed over', () => {
    const answer = read(file([p(ex('custom'), LIT('x')), p('sh:severity', 'sh:Warning')]), { from: ['shacl'] });
    assert.deepEqual(answer.notTaken.filter(n => n.subject === PROP).map(n => n.constraint).sort(), [ex('custom'), 'sh:severity'].sort());
  });

  it('a shape of no target is not a type, and says so', () => {
    const answer = read([Q(ex('LoneShape'), 'rdf:type', 'sh:NodeShape'), Q(ex('LoneShape'), 'sh:property', PROP), Q(PROP, 'sh:path', PATH)], { from: ['shacl'] });
    assert.deepEqual(answer.typeSchemas, { entity: {}, fact: {}, chrono: {}, edge: {} });
    assert.ok(answer.notTaken.some(n => n.subject === ex('LoneShape')), 'the shape that targets nothing is not named');
  });

  it('a file with no shape and no declaration answers no type, and its one statement is outside the schema', () => {
    const answer = read([Q(ex('a'), ex('b'), LIT('c'))], { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.typeSchemas, { entity: {}, fact: {}, chrono: {}, edge: {} });
    assert.deepEqual(answer.counts, { statements: 1, taken: 0, notTaken: 0, outside: 1 });
  });

  it('an empty file answers an empty schema, and a refusal of nothing', () => {
    const answer = read([], { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.typeSchemas, { entity: {}, fact: {}, chrono: {}, edge: {} });
    assert.deepEqual(answer.refusals, []);
    assert.equal(typeof reader(), 'function');
  });
});
