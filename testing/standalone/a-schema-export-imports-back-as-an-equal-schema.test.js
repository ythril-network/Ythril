/**
 * A schema this product exports reads back as an equal schema (bundle-270, slice S8, Q-754; amendments A7 and A13).
 *
 * ## The defect this prevents
 *
 * A user who exports a space's schema and imports the file into an empty space expects the same types. A reader that drops a field the export
 * wrote gives a space that looks imported and is not; one that reads a field looser (a required property that comes back optional, a one-only
 * edge label that comes back many, an allowed-values list that comes back open) gives a strict space that accepts what the schema forbade.
 * `schemaFromRdf` in `server/src/rdf/schema-from-rdf.ts` is the inverse of `schemaGraph` (`schema-owl-shacl.ts`); this file holds that inverse
 * against the forward mapping's own output, never against a hand-written copy of it.
 *
 * ## What it holds
 *
 * - **Each knowledge type**: the entity, fact, chrono and edge types of the export's fixture space come back equal, field by field, from the
 *   shapes, from the shapes and the OWL axioms together, and through the text the writers write (Turtle and JSON-LD, read by the import parser).
 * - **Every field of a type and a property is in the fixture**: the field lists are read from the schema package's own zod shapes, so a field
 *   added to the schema fails here until the fixture states it and the export carries it.
 * - **What the export does not carry** is written out below as a list; each entry is shown to be what it says (the schema states it, the read
 *   back has it not), and the forward mapping's own list of fields it does not export must equal the space-level part of it.
 * - **OWL alone** reads back what OWL carries (the own terms, their labels, comments, ranges, enumerations and restrictions), as a literal
 *   expected schema.
 * - **The answer is type schemas only** (A7): no validation mode, strict linkage, purpose or space rule is an answer field; the ontology's
 *   statements about them are named as not taken.
 *
 * Run: node --test testing/standalone/a-schema-export-imports-back-as-an-equal-schema.test.js (after the server and schema builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, FP, read, exported, throughText, forward } from './_schema-from-rdf-doors.mjs';

const schemaPackage = await import('../../schema/dist/index.js');

const clone = (x) => structuredClone(x);

/** The fixture space with the fields its base lacks: a type's rules, embedding suppression, and retention on an entity. */
const FULL = (() => {
  const meta = clone(META);
  meta.typeSchemas.entity.person.rules = { adult: { rule: 'self.age >= 18', message: 'must be an adult' }, named: { rule: 'size(self.name) > 0', message: 'a name is needed' } };
  meta.typeSchemas.entity.gadget = { suppressEmbeddings: true, retention: { days: 90 }, description: 'A thing that is not embedded' };
  meta.typeSchemas.fact.note.suppressEmbeddings = false;
  return meta;
})();

/** What the export does not carry, written out (amendment A13): a list in this test, never read from the reader. */
const NOT_CARRIED_TYPE_LEVEL = [
  { field: 'required: false', stated: m => { m.typeSchemas.entity.person.propertySchemas.name.required = false; }, reads: m => { delete m.typeSchemas.entity.person.propertySchemas.name.required; } },
  { field: 'functional: false', stated: m => { m.typeSchemas.edge.reports_to.functional = false; }, reads: m => { delete m.typeSchemas.edge.reports_to.functional; } },
  { field: 'enum: []', stated: m => { m.typeSchemas.entity.person.propertySchemas.status.enum = []; }, reads: m => { delete m.typeSchemas.entity.person.propertySchemas.status.enum; } },
  { field: 'an empty description', stated: m => { m.typeSchemas.entity.robot.description = ''; }, reads: m => { delete m.typeSchemas.entity.robot.description; } },
  { field: 'an enum member that does not fit its declared type', stated: m => { m.typeSchemas.entity.person.propertySchemas.level.enum = [1, 'two', 3]; }, reads: m => { m.typeSchemas.entity.person.propertySchemas.level.enum = [1, 3]; } },
  { field: 'a default that does not fit its declared type', stated: m => { m.typeSchemas.entity.person.propertySchemas.active.default = 'yes'; }, reads: m => { delete m.typeSchemas.entity.person.propertySchemas.active.default; } },
  { field: 'an endpoints member spelled entity:<type>, and a member twice', stated: m => { m.typeSchemas.edge.knows.endpoints = { from: ['entity:person', 'person'], to: ['person', 'UNTYPED'] }; }, reads: m => { m.typeSchemas.edge.knows.endpoints = { from: ['person'], to: ['person', 'UNTYPED'] }; } },
];
/** The fields of the space the export does not write at all, each by the forward mapping's own reason. */
const NOT_EXPORTED_SPACE_FIELDS = ['usageNotes', 'suppressEmbeddings', 'whenDuePasses', 'stampSkew', 'rdf'];
/** The fields of the space the export carries and this reader leaves to the space's own door (amendment A7: type schemas only). */
const SPACE_FIELDS_LEFT_TO_THE_SPACE = { purpose: 'rdfs:comment', validationMode: 'ythril:validationMode', strictLinkage: 'ythril:strictLinkage', rules: 'ythril:rule' };

describe('a schema this product exports reads back as an equal schema', () => {
  for (const kind of ['entity', 'fact', 'chrono', 'edge']) {
    it(`the ${kind} types come back equal from the shapes`, () => {
      const answer = read(exported(FULL), { from: ['shacl'] });
      assert.deepEqual(answer.refusals, []);
      assert.deepEqual(answer.typeSchemas[kind], FULL.typeSchemas[kind]);
    });
  }

  it('the whole schema comes back equal from the shapes and the OWL axioms together', () => {
    const answer = read(exported(FULL), { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(answer.typeSchemas, FULL.typeSchemas);
  });

  for (const format of ['turtle', 'jsonld']) {
    it(`the whole schema comes back equal through the ${format} the writers write`, async () => {
      const answer = read(await throughText(FULL, format), { from: ['declared', 'shacl'] });
      assert.deepEqual(answer.refusals, []);
      assert.deepEqual(answer.typeSchemas, FULL.typeSchemas);
    });
  }

  it('every field of a type and of a property is stated by the fixture, read from the schema package\'s own shapes', () => {
    const propertyFields = Object.keys(schemaPackage.PropertySchemaZ.shape);
    const typeFields = Object.keys(schemaPackage.InlineTypeSchemaZ.shape);
    const properties = Object.values(FULL.typeSchemas).flatMap(types => Object.values(types)).flatMap(def => Object.values(def.propertySchemas ?? {}));
    const types = Object.values(FULL.typeSchemas).flatMap(types => Object.values(types));
    const missing = [
      ...propertyFields.filter(f => !properties.some(p => Object.hasOwn(p, f))).map(f => `property.${f}`),
      ...typeFields.filter(f => !types.some(t => Object.hasOwn(t, f))).map(f => `type.${f}`),
    ];
    assert.deepEqual(missing, [], `the fixture does not state: ${missing.join(', ')}; the round trip does not hold them`);
  });

  it('the answer is the same whatever order the quads come in', () => {
    const quads = exported(FULL);
    const shuffled = [...quads].reverse();
    assert.deepEqual(read(shuffled, { from: ['declared', 'shacl'] }).typeSchemas, FULL.typeSchemas);
  });
});

describe('what the export does not carry', () => {
  for (const row of NOT_CARRIED_TYPE_LEVEL) {
    it(`${row.field}: stated by the schema, written as nothing, read back without it`, () => {
      const stated = clone(FULL);
      row.stated(stated);
      const expected = clone(FULL);
      row.reads(expected);
      assert.notDeepEqual(stated.typeSchemas, expected.typeSchemas, 'the row states nothing the read back differs in');
      assert.deepEqual(read(exported(stated), { from: ['shacl'] }).typeSchemas, expected.typeSchemas);
    });
  }

  it('the space fields the forward mapping does not export are the ones this list names, no more', () => {
    const rows = forward.SCHEMA_FIELD_EXPORT.space;
    const notExported = Object.entries(rows).filter(([, row]) => row.reason !== undefined).map(([name]) => name).filter(name => name !== 'typeSchemas');
    assert.deepEqual(notExported.sort(), [...NOT_EXPORTED_SPACE_FIELDS].sort());
  });

  it('the answer holds type schemas only: the space fields the export carries are named as not taken, never answered', () => {
    const meta = clone(FULL);
    meta.purpose = 'A space of people';
    meta.validationMode = 'strict';
    meta.strictLinkage = true;
    meta.rules = { cap: { rule: 'true', message: 'always', kinds: ['entity'] } };
    const answer = read(exported(meta), { from: ['declared', 'shacl'] });
    assert.deepEqual(Object.keys(answer).sort(), ['changes', 'counts', 'notTaken', 'refusals', 'taken', 'typeSchemas']);
    assert.deepEqual(Object.keys(answer.typeSchemas).sort(), ['chrono', 'edge', 'entity', 'fact']);
    const space = answer.notTaken.filter(n => n.why === 'space-level');
    for (const [field, constraint] of Object.entries(SPACE_FIELDS_LEFT_TO_THE_SPACE)) {
      assert.ok(space.some(n => n.constraint === constraint), `the space's ${field} (the ontology's ${constraint}) is not named as a space-level statement left to the space`);
    }
  });

  it('the space fields the export carries are exactly the ones left to the space', () => {
    const carried = Object.entries(forward.SCHEMA_FIELD_EXPORT.space).filter(([, row]) => row.reason === undefined).map(([name]) => name);
    assert.deepEqual(carried.sort(), Object.keys(SPACE_FIELDS_LEFT_TO_THE_SPACE).sort());
  });
});

describe('OWL alone reads back what OWL carries', () => {
  it('the own classes, properties, labels, comments, ranges, enumerations and restrictions, and no more', () => {
    const answer = read(exported(FULL), { from: ['declared'] });
    assert.deepEqual(answer.refusals, []);
    assert.deepEqual(answer.typeSchemas, {
      entity: {
        person: {
          description: 'A person we know',
          propertySchemas: {
            name: { type: 'string', description: 'The full name' },
            age: { type: 'number', minimum: 0, maximum: 150, description: 'Age in years' },
            status: { enum: ['active', 'retired'] },
            level: { enum: [1, 2, 3] },
            born: {},
            active: { type: 'boolean' },
            score: { type: 'number', mergeFn: 'avg' },
            loose: {},
            code: {},
          },
        },
        robot: {},
        gadget: { description: 'A thing that is not embedded' },
      },
      fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
      chrono: { meeting: { propertySchemas: { room: { type: 'string' } } } },
      edge: {
        knows: { description: 'One person knows another', propertySchemas: { since: {}, strength: { type: 'number', minimum: 0, maximum: 1 } } },
        reports_to: { functional: true },
      },
    });
  });

  it('what OWL does not carry is named, shape by shape and term by term', () => {
    const answer = read(exported(FULL), { from: ['declared'] });
    assert.ok(answer.notTaken.some(n => n.constraint === 'rdfs:range' && n.why === 'no-field' && n.subject.endsWith('#born')), 'a date property\'s rdfs:Literal range is not named');
    assert.equal(answer.counts.statements, answer.counts.taken + answer.counts.notTaken + answer.counts.outside, 'a statement is neither taken nor named nor outside');
  });
});
