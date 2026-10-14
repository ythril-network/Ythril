/**
 * A type, a property or a rule NAMED like an object's internals is refused by the one schema body, at every door (bundle-23 wave 1).
 *
 * ## What it prevents
 *
 * `out[key] = value` with the key `__proto__` does not add a key: it replaces the prototype of the object being built. The schema body
 * names things by key — a type under its knowledge type, a property under its type, a rule under its space — so a type CALLED by such a
 * name was accepted by the body and then silently NOT STORED (zod drops it from the record while parsing), and the merges, the library
 * `$ref` comparison and the layer clash scan below it all read an object whose shape the caller chose. Wave 0 made the library
 * comparison stop writing such a key into its text (`util/canonical-json.ts` leaves it out, as the space hash always did), which left
 * the body as the only place that can refuse it.
 *
 * ## What holds
 *
 * - `TypeSchemasZ`, `PutSchemaBody`, `SpaceMetaBody` and the library's entry body refuse a type, a property or a rule so named, in the
 *   body's own words, not as an "unrecognized key" for something it merely has not heard of;
 * - the tolerant reader (R6-7) does not mistake it for an UNKNOWN key to drop and name: it is invalid, and the meta is refused whole;
 * - the single-type door (`parseTypeSchema`) refuses it as the URL's type name;
 * - a name that merely resembles one (`toString`, `Constructor`) is a name like any other.
 *
 * The keys are minted with `JSON.parse`, which makes `__proto__` an OWN property, which is how a request body carries it; an object
 * literal would set the prototype instead and the case would test nothing.
 *
 * Run: node --test testing/standalone/a-name-that-reaches-an-objects-internals-is-refused-by-the-schema-body.test.js
 * (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const bodies = await import('../../server/dist/spaces/body-schemas.js');
const { mergeReplicatedMeta } = await import('../../server/dist/sync/replicated-meta.js');
const { LibraryTypeSchemaZ } = await import('../../server/dist/api/schema-library.js');

const INTERNAL = ['__proto__', 'constructor', 'prototype'];
/** An object with `name` as an OWN key holding `value`. */
const keyed = (name, value) => JSON.parse(`{${JSON.stringify(name)}:${JSON.stringify(value)}}`);
const says = (result) => (result.success ? '' : JSON.stringify(result.error.issues));

describe('a name that reaches an object\'s internals is refused, not stored and not dropped', () => {
  for (const name of INTERNAL) {
    it(`a type named ${name}: the type-schema map, the PUT body and the meta body refuse it`, () => {
      const typeSchemas = { entity: keyed(name, { namingPattern: '^a' }) };
      for (const [what, result] of [
        ['TypeSchemasZ', bodies.TypeSchemasZ.safeParse(typeSchemas)],
        ['PutSchemaBody', bodies.PutSchemaBody.safeParse({ typeSchemas })],
        ['SpaceMetaBody', bodies.SpaceMetaBody.safeParse({ typeSchemas })],
      ]) {
        assert.equal(result.success, false, `${what} ACCEPTED a type named ${name} (and the type is not in what it returned: it was dropped on the way)`);
        assert.match(says(result), /internals/, `${what} refused it, but not for what it is: ${says(result).slice(0, 200)}`);
      }
    });

    it(`a property named ${name}: refused in a type, and in a library entry`, () => {
      const inline = { propertySchemas: keyed(name, { type: 'string' }) };
      assert.equal(bodies.TypeSchemasZ.safeParse({ entity: { T: inline } }).success, false, 'the inline body accepted it');
      const library = LibraryTypeSchemaZ.safeParse(inline);
      assert.equal(library.success, false, 'the library body accepted it');
      assert.match(says(library), /internals/);
    });

    it(`a space rule named ${name}: refused`, () => {
      const result = bodies.SpaceMetaBody.safeParse({ rules: keyed(name, { rule: 'true', message: 'm' }) });
      assert.equal(result.success, false);
      assert.match(says(result), /internals/);
    });

    it(`the tolerant reader reads a type named ${name} as INVALID, not as an unknown field to drop: the meta is refused whole`, () => {
      const result = mergeReplicatedMeta({ purpose: 'kept' }, { purpose: 'new', typeSchemas: { entity: keyed(name, { namingPattern: '^a' }) } });
      assert.ok(result.invalid, 'a layer carrying a type so named was read');
      assert.equal(result.changed, false);
      assert.equal(result.meta.purpose, 'kept', 'part of a meta that does not parse was applied');
    });

    it(`the single-type door refuses ${name} as the type's name`, () => {
      const result = bodies.parseTypeSchema('entity', name, { namingPattern: '^a' });
      assert.equal(result.ok, false);
      assert.match(result.message, /internals/);
    });
  }

  it('a name that merely resembles one is a name like any other (the controls)', () => {
    for (const name of ['toString', 'Constructor', 'protoype', 'hasOwnProperty', '__proto']) {
      const typeSchemas = { entity: keyed(name, { namingPattern: '^a', propertySchemas: keyed(name, { type: 'string' }) }) };
      const result = bodies.TypeSchemasZ.safeParse(typeSchemas);
      assert.equal(result.success, true, `${name} was refused: ${says(result).slice(0, 200)}`);
      assert.deepEqual(Object.keys(result.data.entity), [name], `${name} was accepted and then lost on the way`);
    }
  });
});
