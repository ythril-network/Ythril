/**
 * A property schema's grammar is written ONCE, and both doors agree on every value.
 *
 * ## The finding
 *
 * `api/schema-library.ts` declared its own `PropertySchemaZ` under the comment *"matches spaces.ts
 * PropertySchemaZ"* — a validation grammar duplicated, and acknowledged in a comment rather than shared. The
 * two objects were character-identical when this was found, which is exactly why it was worth a row: nothing
 * was broken yet, and nothing would have told anybody when it broke.
 *
 * A property schema decides what values a caller may STORE. Two copies means a value the inline door accepts
 * and the library door refuses, or the reverse, and the difference is invisible from either side. It is the
 * defect class this repo names as its most expensive, sitting behind a comment that admits it.
 *
 * ## Why the library's object is not simply the same object
 *
 * It differs in one place ON PURPOSE: `retention` is refused there. Nothing resolves a `$ref` when a retention
 * window is read — `chrono-retention.ts` and `ttl.ts` use the RAW space meta — so a window on a library entry
 * would never fire, and the field is refused with a reason rather than accepted and ignored. That difference is
 * real and is asserted elsewhere.
 *
 * So the fix is not "delete one". It is: share the grammar, keep the difference explicit. The deliberate
 * difference survives; an accidental one becomes impossible.
 *
 * ## Two directions, because both objects existing looked fine
 *
 * From the SOURCE, that there is one grammar and the library imports it. From BEHAVIOUR, that both doors return
 * the same verdict for every value in a table — including the ones the grammar is supposed to refuse, since a
 * gate that only feeds valid values cannot tell a strict schema from a permissive one.
 *
 * Run: node --test testing/standalone/one-property-schema-grammar.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const SPACES = 'server/src/spaces/body-schemas.ts';
const LIBRARY = 'server/src/api/schema-library.ts';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/**
 * Values to parse through both doors — valid ones AND one for every way the grammar refuses.
 *
 * The refusals are the half that matters. Two schemas that both accept `{type: 'string'}` prove nothing about
 * each other; two that disagree about `{type: 'int'}` are the defect this file exists for.
 */
const CASES = [
  { name: 'an empty object (every field is optional)', value: {}, valid: true },
  { name: 'a plain string property', value: { type: 'string' }, valid: true },
  { name: 'a required number with bounds', value: { type: 'number', minimum: 0, maximum: 10, required: true }, valid: true },
  { name: 'an enum of mixed primitives', value: { enum: ['a', 1, true] }, valid: true },
  { name: 'a default value', value: { type: 'boolean', default: false }, valid: true },
  { name: 'a numeric mergeFn on a number', value: { type: 'number', mergeFn: 'sum' }, valid: true },
  { name: 'a boolean mergeFn on a boolean', value: { type: 'boolean', mergeFn: 'or' }, valid: true },
  { name: 'a mergeFn with no type at all', value: { mergeFn: 'avg' }, valid: true },

  { name: 'an unknown type name', value: { type: 'int' }, valid: false },
  { name: 'an unknown key (the object is strict)', value: { retention: { days: 1 } }, valid: false },
  { name: 'a numeric mergeFn on a string', value: { type: 'string', mergeFn: 'sum' }, valid: false },
  { name: 'a boolean mergeFn on a number', value: { type: 'number', mergeFn: 'and' }, valid: false },
  { name: 'a mergeFn on a date', value: { type: 'date', mergeFn: 'min' }, valid: false },
  { name: 'an unknown mergeFn', value: { mergeFn: 'concat' }, valid: false },
  { name: 'a pattern over the length cap', value: { pattern: 'x'.repeat(501) }, valid: false },
  { name: 'a non-numeric minimum', value: { minimum: 'zero' }, valid: false },
  { name: 'an object as a default', value: { default: { a: 1 } }, valid: false },
];

let inlineZ, libraryZ;

describe('one property-schema grammar, shared', () => {
  before(async () => {
    ({ PropertySchemaZ: inlineZ } = await import('../../server/dist/spaces/body-schemas.js'));
    ({ LibraryTypeSchemaZ: libraryZ } = await import('../../server/dist/api/schema-library.js'));
  });

  it('both doors are reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof inlineZ?.safeParse, 'function', 'the inline grammar is not exported');
    assert.equal(typeof libraryZ?.safeParse, 'function',
      'LibraryTypeSchemaZ is not exported — the library door can then only be checked by reading its text, '
      + 'which is what let a second copy of the grammar sit there unnoticed');
  });

  for (const c of CASES) {
    it(`both doors agree: ${c.name}`, () => {
      const inline = inlineZ.safeParse(c.value).success;
      // Through the type schema, because that is how the library door actually reaches this grammar: a caller
      // sends a whole schema object, and `propertySchemas` is a record of them.
      const library = libraryZ.safeParse({ propertySchemas: { p: c.value } }).success;

      assert.equal(inline, c.valid,
        `the inline door ${inline ? 'accepted' : 'refused'} a value the table says is ${c.valid ? 'valid' : 'invalid'}`);
      assert.equal(library, inline,
        `the two doors DISAGREE about ${JSON.stringify(c.value)}: inline ${inline ? 'accepts' : 'refuses'} it, `
        + `the schema library ${library ? 'accepts' : 'refuses'} it. One rule, two verdicts, and a caller sees `
        + 'only whichever door they happened to use');
    });
  }

  it('and the deliberate difference survives — a library entry still refuses `retention`', () => {
    // The one place the two are MEANT to differ. A fix that shared too much would make this pass on the inline
    // door's behaviour, which accepts retention, and a window on a library entry never fires.
    assert.equal(libraryZ.safeParse({ retention: { days: 30 } }).success, false,
      'a library entry accepted a retention window, which nothing resolves a $ref for — so it would be stored '
      + 'and never applied');
    assert.equal(libraryZ.safeParse({ namingPattern: '^x' }).success, true,
      'the floor: if the library schema refused everything, the assertion above would pass for the wrong reason');
  });
});

describe('the grammar exists once', () => {
  it('only one module declares it', () => {
    /*
     * The source direction. Without it, the behavioural half above stays green while somebody adds a third
     * copy that happens to agree today — which is the state this row was filed from.
     */
    const offenders = [];
    for (const [p, s] of [[SPACES, src(SPACES)], [LIBRARY, src(LIBRARY)]]) {
      const declares = [...s.matchAll(/const PropertySchemaZ\s*=\s*z\./g)].length;
      if (declares > 0 && p !== SPACES) offenders.push(`${p} declares its own`);
      if (declares === 0 && p === SPACES) offenders.push(`${SPACES} no longer declares it — re-point this gate`);
    }
    assert.deepEqual(offenders, [],
      'a property schema decides what values a caller may store, so a second grammar means a value one door '
      + `accepts and the other refuses:\n  ${offenders.join('\n  ')}`);
  });

  it('and the library takes the one that exists', () => {
    // Since `Q-215` the library's whole body is built from the inline definition (`InlineTypeSchemaZ`), whose `propertySchemas` is
    // the shared grammar — so it needs no import of `PropertySchemaZ` of its own, and the copy that used to sit here cannot return.
    assert.match(src(LIBRARY), /import\s*\{[^}]*\b(?:PropertySchemaZ|InlineTypeSchemaZ)\b[^}]*\}\s*from\s*'\.\.\/spaces\/body-schemas\.js'/,
      'the schema library does not import the shared grammar, so whatever it validates with is a copy');
    assert.match(src(LIBRARY), /\.\.\.InlineTypeSchemaZ\.shape/, 'the library body is not built from the inline definition');
  });
});
