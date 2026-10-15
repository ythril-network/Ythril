/**
 * The schema library accepts what the inline door accepts, and its PATCH keeps what it accepted (`Q-215`).
 *
 * ## What was found
 *
 * `LibraryTypeSchemaZ` was a second copy of `TypeSchemaZ`, written when the library began and kept "in step" by a comment. It was not:
 * it lacks `description` and `whenDuePasses`, and its `PATCH /:name` merged exactly two keys (`namingPattern`, `propertySchemas`), so
 * `suppressEmbeddings`, `endpoints` and `functional` were ACCEPTED by the body and then DROPPED by the merge — an answer of 200 and an
 * entry that had not changed. `deleteFields` recognised the same two keys and refused every other path, and the 400 for a bad name
 * said *"lowercase"* while the name pattern accepts upper case.
 *
 * ## What holds here, and how each part is derived
 *
 * - **The keys are read from the `TypeSchema` interface**, never listed: a field added to the type is then either covered by a sample
 *   below or fails this file, which is the moment its library behaviour is decided. `$ref` (the library's own pointer: an entry is
 *   inline) and `_unresolvedRef` (`@internal`, never stored) are the two named exceptions, each with its reason.
 * - **Both doors accept every key**, except `retention`, which the library refuses on purpose with a reason (`library-retention-refusal`).
 * - **A PATCH of any accepted key lands in the stored entry** and leaves the rest of the schema as it was.
 * - **`deleteFields` takes any schema key path**, dotted ones included, and still refuses a path that names nothing.
 * - **The 400 for a bad name says what the pattern says.** Behavioural: a name the pattern accepts (upper case) is let through to a
 *   404, a name it refuses is a 400, and that 400 may not claim the thing the first just disproved.
 *
 * Run: node --test testing/standalone/the-library-door-takes-what-the-inline-door-takes.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-library-parity-');

/** Keys of `TypeSchema` that are not a stored schema field, each with the reason. */
const NOT_STORED = new Map([
  ['$ref', 'the library pointer itself: an entry is an inline definition, no recursive references'],
  ['_unresolvedRef', '@internal: set on in-memory resolved copies, never present in stored config'],
]);

/**
 * A valid value per `TypeSchema` key, and the collection it is valid under. Literal on purpose: it is what a caller would send, not a
 * rule derived from the code under test. A key with no row fails `every schema key has a sample`.
 */
const SAMPLES = {
  description: { kind: 'entity', value: 'what this type is for' },
  namingPattern: { kind: 'entity', value: '^[a-z]+$' },
  retention: { kind: 'chrono', value: { days: 30 } },
  whenDuePasses: { kind: 'chrono', value: 'nothing' },
  propertySchemas: { kind: 'entity', value: { tier: { type: 'string' } } },
  suppressEmbeddings: { kind: 'entity', value: true },
  endpoints: { kind: 'edge', value: { from: ['person'], to: ['team'] } },
  functional: { kind: 'edge', value: true },
  // F-46: added with the key (TypeSchema.rules); a rule that reads no property, so the sample needs no propertySchemas beside it.
  rules: { kind: 'entity', value: { titled: { rule: "self.title != ''", message: 'needs a title' } } },
};

/** The members of `interface TypeSchema`, read from the source. */
function typeSchemaKeys() {
  const file = 'server/src/config/types-knowledge.ts';
  const sf = parseSource(file, stripComments(readFileSync(file, 'utf8')));
  let keys = null;
  sf.forEachChild(function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TypeSchema') {
      keys = node.members.filter(m => m.name).map(m => m.name.getText(sf).replace(/^['"]|['"]$/g, ''));
      return;
    }
    ts.forEachChild(node, visit);
  });
  assert.ok(keys, `${file} no longer declares interface TypeSchema — re-anchor this gate`);
  return keys;
}

describe('the library door takes what the inline door takes', () => {
  let inst, TypeSchemasZ;
  before(async () => {
    inst = await bootSchemaInstance(dir, {});
    ({ TypeSchemasZ } = await import('../../server/dist/spaces/body-schemas.js'));
  });
  after(() => inst?.close());

  const stored = typeSchemaKeys().filter(k => !NOT_STORED.has(k));
  let n = 0;
  const entryName = (key) => `parity-${key.toLowerCase()}-${n++}`;

  it('every schema key has a sample (a key added to TypeSchema is decided here or this fails)', () => {
    assert.ok(stored.length >= 7, `only ${stored.length} schema keys found in interface TypeSchema — the scan lost its subject`);
    assert.deepEqual(stored.filter(k => !(k in SAMPLES)), [],
      'TypeSchema gained a key with no sample here: say what the library does with it');
    assert.deepEqual(Object.keys(SAMPLES).filter(k => !stored.includes(k)), [], 'a sample names a key TypeSchema no longer has');
  });

  describe('both doors accept every key', () => {
    for (const key of stored) {
      const { kind, value } = SAMPLES[key];
      it(`${key}: the inline door accepts it under ${kind}`, () => {
        const parsed = TypeSchemasZ.safeParse({ [kind]: { Sample: { [key]: value } } });
        assert.equal(parsed.success, true, `the inline door refused ${key}: ${parsed.error?.message?.slice(0, 300)}`);
      });
      if (key === 'retention') continue;
      it(`${key}: the library door accepts it under ${kind}, and stores it`, async () => {
        const name = entryName(key);
        const answer = await inst.library.post({ name, knowledgeType: kind, typeName: 'Sample', schema: { [key]: value } });
        assert.equal(answer.refused, false, `the library refused ${key}, which the inline door accepts: ${answer.text.slice(0, 300)}`);
        assert.deepEqual(inst.heldEntry(name).schema[key], value, `the library accepted ${key} and did not keep it`);
      });
    }
    it('retention is the one difference: the library refuses it, and says why', async () => {
      const answer = await inst.library.post({ name: entryName('retention'), knowledgeType: 'chrono', typeName: 'Sample', schema: { retention: { days: 30 } } });
      assert.equal(answer.refused, true, 'the library accepted a retention window, which nothing resolves through a $ref');
      assert.match(answer.text, /retention/i);
      assert.match(answer.text, /space|reference|\$ref|type in a space/i, 'the refusal does not say why the library differs');
    });
  });

  describe('PATCH keeps what it accepted', () => {
    for (const key of stored.filter(k => k !== 'retention')) {
      const { kind, value } = SAMPLES[key];
      it(`${key}: a PATCH lands in the stored entry and leaves the rest of the schema alone`, async () => {
        const name = entryName(`patch-${key}`);
        const seeded = { propertySchemas: { keep: { type: 'string' } } };
        const created = await inst.library.post({ name, knowledgeType: kind, typeName: 'Sample', schema: structuredClone(seeded) });
        assert.equal(created.refused, false, created.text);
        const answer = await inst.library.patch(name, { schema: { [key]: value } });
        assert.equal(answer.refused, false, `PATCH refused ${key}: ${answer.text.slice(0, 300)}`);
        const held = inst.heldEntry(name).schema;
        const why = `PATCH answered ${answer.status} for ${key} and the stored entry does not hold it: ${JSON.stringify(held)}. A body that accepts a key its merge then drops is the defect this file exists for`;
        if (key === 'propertySchemas') assert.deepEqual(held.propertySchemas?.tier, value.tier, why);
        else assert.deepEqual(held[key], value, why);
        assert.deepEqual(held.propertySchemas?.keep, seeded.propertySchemas.keep, `PATCH of ${key} lost a property that was not named`);
      });
    }
  });

  describe('deleteFields takes any schema key path', () => {
    for (const key of stored.filter(k => !['retention', 'propertySchemas'].includes(k))) {
      const { kind, value } = SAMPLES[key];
      it(`${key}: deleting it removes it and nothing else`, async () => {
        const name = entryName(`del-${key}`);
        const created = await inst.library.post({ name, knowledgeType: kind, typeName: 'Sample', schema: { [key]: value, propertySchemas: { keep: { type: 'string' } } } });
        assert.equal(created.refused, false, created.text);
        const answer = await inst.library.patch(name, { deleteFields: [key] });
        assert.equal(answer.refused, false, `deleteFields refused ${key}, a schema key the library stores: ${answer.text.slice(0, 300)}`);
        const held = inst.heldEntry(name).schema;
        assert.equal(held[key], undefined, `${key} is still on the entry after deleteFields named it: ${JSON.stringify(held)}`);
        assert.ok(held.propertySchemas?.keep, `deleting ${key} removed a property it did not name`);
      });
    }

    it('a dotted path inside a key: endpoints.from leaves endpoints.to', async () => {
      const name = entryName('del-endpoints-from');
      await inst.library.post({ name, knowledgeType: 'edge', typeName: 'Sample', schema: { endpoints: { from: ['person'], to: ['team'] } } });
      const answer = await inst.library.patch(name, { deleteFields: ['endpoints.from'] });
      assert.equal(answer.refused, false, `deleteFields refused endpoints.from: ${answer.text.slice(0, 300)}`);
      assert.deepEqual(inst.heldEntry(name).schema.endpoints, { to: ['team'] });
    });

    it('a path that names nothing the schema has is still refused, naming it', async () => {
      const name = entryName('del-typo');
      await inst.library.post({ name, knowledgeType: 'entity', typeName: 'Sample', schema: { namingPattern: '^a' } });
      const answer = await inst.library.patch(name, { deleteFields: ['namingPatern'] });
      assert.equal(answer.refused, true, 'a typo in deleteFields was accepted and silently did nothing');
      assert.match(answer.text, /namingPatern/);
    });

    it('rules.<name> (F-46): listed until a type schema accepts rules', { todo: 'F-46: the type schema has no rules field yet' }, () => {});
  });

  describe('the 400 for a bad name says what the name pattern says', () => {
    it('an upper-case name passes the pattern, so a refusal may not call the pattern lowercase', async () => {
      const upper = await inst.library.patch('Upper-Case', { description: 'x' });
      assert.equal(upper.status, 404, `an upper-case name was refused (${upper.status}); the pattern is the authority and the next assertion reads from it`);
      for (const [verb, call] of [['PATCH', () => inst.library.patch('-bad', { description: 'x' })], ['PUT', () => inst.library.put('-bad', { knowledgeType: 'entity', typeName: 't', schema: {} })]]) {
        const bad = await call();
        assert.equal(bad.status, 400, `${verb} with a name the pattern refuses answered ${bad.status}`);
        assert.doesNotMatch(bad.text, /lowercase/i,
          `${verb}: the 400 says the name must be lowercase, and an upper-case name was just accepted by the same pattern`);
      }
    });
  });
});
