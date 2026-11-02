/**
 * A parse that needs the schema library, with no library installed or scoped, throws "no schema library installed" (Q-668, 6', S5, B4).
 *
 * ## The defect this prevents
 *
 * The library a `$ref` is read against is a module global of `@ythril/schema`, installed by the server at import
 * (`server/src/spaces/library-ref-expansion.ts`) and scoped by an app with `withSchemaLibrary`. Its default was `() => []`, so a parse
 * that ran before the install — a new server module importing a parse without the module that installs, a test, an app parsing
 * directly — read an EMPTY library and answered as if every entry were missing: a wrong refusal, or a `$ref` stripped, with nothing to
 * say the setup was wrong. The default now throws, at the one place every read reaches (`currentSchemaLibrary`, which the parse's
 * `z.preprocess(takeBackLibraryDefinition)` reads by reference), so a setup error is loud.
 *
 * What stays quiet on purpose: `validateSpaceMeta` without a `library` option reads `[]` (an app never meets the throw), and a parse
 * inside `withSchemaLibrary` reads the scoped library. And `withSchemaLibrary` refuses an async `read` (I3): the scope ends when `read`
 * returns, so an async read would run its awaited half against the throwing default — or another call's scope.
 *
 * This file imports ONLY `schema/dist`: importing anything of the server would install the server's library and hide the default.
 *
 * Run: node --test testing/standalone/a-schema-parse-with-no-library-installed-throws.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pkg from '../../schema/dist/index.js';

const NO_LIBRARY = /no schema library installed/;
/** A round-tripped `{ $ref, ...definition }`: the shape whose parse reads the library. */
const ROUND_TRIP = { $ref: 'library:service-v1', propertySchemas: { url: { type: 'string' } } };
const ENTRY = { name: 'service-v1', knowledgeType: 'entity', schema: { propertySchemas: { url: { type: 'string' } } } };

describe('with no library installed', () => {
  it('a { $ref, ...keys } through parseTypeSchema throws, naming the setup error', () => {
    assert.throws(() => pkg.parseTypeSchema('entity', 'service', ROUND_TRIP), NO_LIBRARY);
  });

  it('the same through parseSpaceMeta throws', () => {
    assert.throws(() => pkg.parseSpaceMeta({ typeSchemas: { entity: { service: ROUND_TRIP } } }), NO_LIBRARY);
  });

  it('libraryRefRefusal without a library throws (the broken-ref path reads the installed library)', () => {
    assert.equal(typeof pkg.libraryRefRefusal, 'function', '@ythril/schema exports libraryRefRefusal');
    assert.throws(() => pkg.libraryRefRefusal({ entity: { service: { $ref: 'library:service-v1' } } }), NO_LIBRARY);
  });

  it('inside withSchemaLibrary the same parse answers, and a matching entry takes the definition back', () => {
    const none = pkg.withSchemaLibrary([], () => pkg.parseTypeSchema('entity', 'service', ROUND_TRIP));
    assert.equal(none.ok, false);
    assert.match(none.refusal.error, /which does not exist/);
    const found = pkg.withSchemaLibrary([ENTRY], () => pkg.parseTypeSchema('entity', 'service', ROUND_TRIP));
    assert.equal(found.ok, true, found.ok ? '' : found.refusal.error);
    assert.deepEqual(found.schema, { $ref: 'library:service-v1' });
  });

  it('a parse that reads no library answers as before (a meta with no $ref)', () => {
    assert.equal(pkg.parseTypeSchema('entity', 'person', { propertySchemas: { email: { type: 'string' } } }).ok, true);
  });

  it('validateSpaceMeta without a library answers ok for a meta with no $ref, and refuses a $ref as missing, without throwing', () => {
    const plain = pkg.validateSpaceMeta({ typeSchemas: { entity: { person: { propertySchemas: { email: { type: 'string' } } } } } });
    assert.equal(plain.ok, true, plain.ok ? '' : plain.message);
    const ref = pkg.validateSpaceMeta({ typeSchemas: { entity: { service: { $ref: 'library:service-v1' } } } });
    assert.equal(ref.ok, false);
    assert.match(ref.message, /service-v1/);
  });
});

describe('withSchemaLibrary refuses an async read (I3)', () => {
  it('a read returning a promise throws, rather than leaving its awaited half outside the scope', () => {
    assert.throws(() => pkg.withSchemaLibrary([ENTRY], async () => pkg.parseTypeSchema('entity', 'service', ROUND_TRIP)), /async|promise|thenable/i);
  });

  it('a read returning any thenable throws too', () => {
    assert.throws(() => pkg.withSchemaLibrary([], () => ({ then() {} })), /async|promise|thenable/i);
  });

  it('a synchronous read is answered (the control)', () => {
    assert.equal(pkg.withSchemaLibrary([], () => 42), 42);
  });
});

// Found by Q-668's verify drive: a `$ref` without the `library:` prefix, beside other keys, was told its library entry "does not
// exist", although it names no library entry at all. It gets the format refusal a bare one gets, and reads no library.
describe('a $ref that is not a library reference', () => {
  it('beside other keys is refused for its format, not as a missing entry, with no library installed', () => {
    const r = pkg.parseTypeSchema('entity', 'x', { $ref: 'x', description: 'd' });
    assert.equal(r.ok, false);
    assert.match(r.refusal.error, /\$ref must be in format "library:<name>"/);
    assert.doesNotMatch(r.refusal.error, /does not exist/);
  });
});
