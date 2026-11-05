/**
 * Every key a space schema can carry is classified for the TypeScript conversion: translated into the source, reported in
 * `untranslated`, or irrelevant to a property type; a key nobody classified fails here (Q-669, slice-B S2 and D3).
 *
 * ## The defect this prevents
 *
 * `typesOfSpaceMeta` promises that nothing is silently dropped: what the TypeScript cannot carry is reported. That promise is made
 * against the vocabulary as it is today. The day `InlineTypeSchemaZ` gains a field, the converter would pass it over without a word
 * and every test written against today's fields would stay green. So the keys are read from the package's own zod shapes, never
 * listed by hand, and each must have a row in the tables below; the row's class is then checked against what the converter does.
 *
 * ## What is held
 *
 * - The keys of `InlineTypeSchemaZ.shape`, `PropertySchemaZ.shape`, the property `type` enum's options and `SpaceMetaBody.shape` each
 *   equal the keys of their table (an unclassified key and a row for a key that no longer exists both fail), above a floor.
 * - **reported**: a meta carrying the key yields an `untranslated` entry `{ reason: 'not-translated', field: <key> }` (with `kind` and
 *   `type` for a type field).
 * - **translated**: the key yields no entry; where it is carried as documentation, its value is in a comment of the source. How a
 *   `type`, an `enum` and `required` become member types is held by `a-space-schema-becomes-typescript-property-types.test.js`.
 * - **irrelevant**: the key yields no entry naming it.
 * - The reasons an entry may give are an exported tuple, `UNTRANSLATED_REASONS`, held here to its list (a new reason is a deliberate
 *   edit, as a new export is), and every entry this file's conversions produce gives one of them.
 * - The reader is proven on planted shapes: an extra key and a dropped row are each named.
 *
 * Run: node --test testing/standalone/every-schema-key-is-translated-reported-or-irrelevant.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schema, converted, assertReported, commentsOf } from './_typescript-of-space-meta.mjs';

const { InlineTypeSchemaZ, PropertySchemaZ, SpaceMetaBody } = schema;

/** The reasons an untranslated entry may give: the exported tuple is held to this list. */
const REASONS = [
  'not-translated', 'type-skipped', 'unknown-field', 'unresolved-ref', 'wrong-kind-ref', 'kind-not-verified', 'enum-emptied',
  'enum-too-long', 'renamed', 'no-type-schemas',
];

/** A type's own fields. `kind` is where the field may be set (default entity); `doc` is text the source must carry in a comment. */
const TYPE_FIELDS = {
  description: { class: 'translated', sample: 'TYPEDESCMARK', doc: 'TYPEDESCMARK' },
  propertySchemas: { class: 'translated', sample: { a: { type: 'string' } } },
  namingPattern: { class: 'reported', sample: '^[a-z]+$' },
  retention: { class: 'reported', sample: { days: 30 } },
  suppressEmbeddings: { class: 'reported', sample: true },
  whenDuePasses: { class: 'reported', sample: 'nothing', kind: 'chrono' },
  endpoints: { class: 'reported', sample: { from: ['person'] }, kind: 'edge' },
  functional: { class: 'reported', sample: true, kind: 'edge' },
  rules: { class: 'reported', sample: { named: { rule: 'true', message: 'always' } } },
};

/** A property's fields, each with the property it sits on. All are translated: as the member type, or as documentation. */
const PROPERTY_FIELDS = {
  description: { class: 'translated', sample: { type: 'string', description: 'PROPDESCMARK' }, doc: 'PROPDESCMARK' },
  type: { class: 'translated', sample: { type: 'number' } },
  enum: { class: 'translated', sample: { type: 'string', enum: ['one', 'two'] } },
  minimum: { class: 'translated', sample: { type: 'number', minimum: 12345 }, doc: '12345' },
  maximum: { class: 'translated', sample: { type: 'number', maximum: 67890 }, doc: '67890' },
  pattern: { class: 'translated', sample: { type: 'string', pattern: '^PATTERNMARK$' }, doc: 'PATTERNMARK' },
  mergeFn: { class: 'translated', sample: { type: 'number', mergeFn: 'sum' }, doc: 'sum' },
  required: { class: 'translated', sample: { type: 'string', required: true } },
  default: { class: 'translated', sample: { type: 'string', default: 'DEFAULTMARK' }, doc: 'DEFAULTMARK' },
};

/** The property type enum: each option and the member type it becomes (held by the property-types test). */
const PROPERTY_TYPES = { string: 'string', number: 'number', boolean: 'boolean', date: 'string' };

/** The space meta's own fields. */
const SPACE_FIELDS = {
  typeSchemas: { class: 'translated', sample: { entity: { t: {} } } },
  rules: { class: 'reported', sample: { named: { rule: 'true', message: 'always' } } },
  stampSkew: { class: 'reported', sample: { warnMinutes: 5 } },
  purpose: { class: 'irrelevant', sample: 'a purpose' },
  usageNotes: { class: 'irrelevant', sample: 'notes' },
  validationMode: { class: 'irrelevant', sample: 'warn' },
  strictLinkage: { class: 'irrelevant', sample: true },
  suppressEmbeddings: { class: 'irrelevant', sample: true },
  whenDuePasses: { class: 'irrelevant', sample: 'nothing' },
};

/** The keys `actual` has that `table` does not classify, and the rows `table` has for keys `actual` lacks. */
function classificationGaps(actual, table) {
  const rows = Object.keys(table);
  return { unclassified: actual.filter(k => !rows.includes(k)).sort(), stale: rows.filter(k => !actual.includes(k)).sort() };
}

const SHAPES = {
  'InlineTypeSchemaZ.shape': [Object.keys(InlineTypeSchemaZ.shape), TYPE_FIELDS, 9],
  "PropertySchemaZ's shape": [Object.keys(PropertySchemaZ.shape), PROPERTY_FIELDS, 9],
  'the property type enum': [[...PropertySchemaZ.shape.type.unwrap().options], PROPERTY_TYPES, 4],
  'SpaceMetaBody.shape': [Object.keys(SpaceMetaBody.shape), SPACE_FIELDS, 9],
};

const comments = (source) => commentsOf(source).map(c => c.text).join('\n');
const produced = [];
const run = (meta) => { const out = converted(meta); produced.push(...out.untranslated); return out; };

describe('the reader, proven on planted shapes', () => {
  it('an extra key is unclassified, a dropped row is named, and the real shapes are read above a floor', () => {
    const keys = Object.keys(InlineTypeSchemaZ.shape);
    assert.deepEqual(classificationGaps([...keys, 'plantedKey'], TYPE_FIELDS), { unclassified: ['plantedKey'], stale: [] });
    const { namingPattern: _dropped, ...withoutRow } = TYPE_FIELDS;
    assert.deepEqual(classificationGaps(keys, withoutRow).unclassified, ['namingPattern']);
    for (const [name, [actual, , floor]] of Object.entries(SHAPES)) assert.ok(actual.length >= floor, `${name} reads ${actual.length} keys`);
  });
});

describe('every key is classified', () => {
  for (const [name, [actual, table]] of Object.entries(SHAPES)) {
    it(`${name}: every key has a row, and every row a key`, () => {
      assert.deepEqual(classificationGaps(actual, table), { unclassified: [], stale: [] }, `${name}: classify the new key or drop the row`);
    });
  }
});

describe('the samples are what the parse accepts (the premise of each row)', () => {
  it('each type field, property field and space field sample parses where it is set', () => {
    for (const [field, row] of Object.entries(TYPE_FIELDS)) {
      const parse = schema.parseTypeSchema(row.kind ?? 'entity', 't', { [field]: row.sample });
      assert.ok(parse.ok, `${field}: ${JSON.stringify(parse.refusal)}`);
    }
    for (const [field, row] of Object.entries(PROPERTY_FIELDS)) {
      const parse = schema.parseTypeSchema('entity', 't', { propertySchemas: { p: row.sample } });
      assert.ok(parse.ok, `${field}: ${JSON.stringify(parse.refusal)}`);
    }
    for (const [field, row] of Object.entries(SPACE_FIELDS)) {
      const parse = SpaceMetaBody.safeParse({ [field]: row.sample });
      assert.ok(parse.success, `${field}: ${parse.error?.message}`);
    }
  });
});

describe('the converter does what each row says', () => {
  for (const [field, row] of Object.entries(TYPE_FIELDS)) {
    it(`type field ${field} is ${row.class}`, () => {
      const kind = row.kind ?? 'entity';
      const { source, untranslated } = run({ typeSchemas: { [kind]: { t: { [field]: row.sample } } } });
      if (row.class === 'reported') assertReported(untranslated, { reason: 'not-translated', kind, type: 't', field }, field);
      else assert.deepEqual(untranslated, [], `${field} is translated, and nothing is reported`);
      if (row.doc) assert.ok(comments(source).includes(row.doc), `${field}'s value is carried in a comment`);
    });
  }

  for (const [field, row] of Object.entries(PROPERTY_FIELDS)) {
    it(`property field ${field} is ${row.class}`, () => {
      const { source, untranslated } = run({ typeSchemas: { entity: { t: { propertySchemas: { p: row.sample } } } } });
      assert.deepEqual(untranslated, [], `${field} is translated, and nothing is reported`);
      if (row.doc) assert.ok(comments(source).includes(row.doc), `${field}'s value is carried in a comment`);
    });
  }

  for (const [field, row] of Object.entries(SPACE_FIELDS)) {
    it(`space field ${field} is ${row.class}`, () => {
      const meta = { typeSchemas: { entity: { t: {} } }, [field]: row.sample };
      const { untranslated } = run(meta);
      if (row.class === 'reported') assertReported(untranslated, { reason: 'not-translated', field }, field);
      else assert.deepEqual(untranslated.filter(u => u.field === field), [], `${field} is ${row.class}, and no entry names it`);
      if (row.class !== 'reported') assert.deepEqual(untranslated.filter(u => u.reason === 'not-translated'), [], 'nothing else is reported');
    });
  }
});

describe('the reasons are an exported tuple', () => {
  it('UNTRANSLATED_REASONS is the list, and every entry produced here gives one of them', () => {
    assert.ok(Array.isArray(schema.UNTRANSLATED_REASONS), 'the schema package exports UNTRANSLATED_REASONS (Q-669, D3)');
    assert.deepEqual([...schema.UNTRANSLATED_REASONS], REASONS);
    assert.ok(produced.length > 0, 'the conversions above produced entries to check');
    const unknown = produced.filter(u => !schema.UNTRANSLATED_REASONS.includes(u.reason));
    assert.deepEqual(unknown, [], 'an entry gives a reason the tuple lacks');
  });
});
