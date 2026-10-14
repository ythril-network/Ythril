/**
 * The merge functions the editor OFFERS are the ones the API ACCEPTS.
 *
 * ## The report
 *
 * Owner, 2026-08-15, editing a type's properties: *"i dont understand what i did wrong..."* — with a
 * screenshot of the schema dialog showing a wall of zod JSON,
 *
 *     mergeFn is incompatible with the declared type
 *     (numeric fns require type "number", boolean fns require type "boolean")
 *     path: [ meta, typeSchemas, entity, Task, propertySchemas, deadline ]
 *
 * They had done nothing wrong. `deadline` was type `date`, and the merge-function dropdown offered `min` —
 * all seven functions, for every type, because the control listed them as static `<option>` elements. The
 * server's `PropertySchemaZ.refine` accepts none at all on `string` or `date`.
 *
 * A control that offers a value its own API refuses has moved a validation rule into the user's head, and the
 * only way to learn it is to be refused. That is the defect; the validator is right.
 *
 * ## Why a gate rather than "we fixed the dropdown"
 *
 * The fix puts the rule in `client/src/app/shared/merge-fns.ts`, which is a SECOND COPY of a server rule.
 * This repo's most expensive recurring defect is one rule with two implementations where the weaker one wins
 * silently — so the copy is only acceptable while something compares it. This reads the server's `.refine`
 * source and the client's arrays and fails when they disagree, which turns a copy into a cache.
 *
 * If a rule is ever added that this cannot parse, it fails LOUDLY rather than passing vacuously: the counts
 * are asserted before the contents.
 *
 * Run: node --test testing/standalone/merge-fns-match-the-server.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = 'server/src/spaces/body-schemas.ts';
const LIBRARY = 'server/src/api/schema-library.ts';
const CLIENT = 'client/src/app/shared/merge-fns.ts';

const read = (p) => readFileSync(p, 'utf8');
/** Line comments first, then block — a block-open inside a line comment otherwise swallows real code. */
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** `new Set(['a','b'])` assigned to a named const, as both servers write it. */
function setLiteral(src, name) {
  const m = new RegExp(`${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`).exec(strip(src));
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** `A = ['a','b'] as const` — the client's shape. */
function arrayLiteral(src, name) {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(strip(src));
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

describe('the merge-function lists agree across the API and the editor', () => {
  it('the numeric and boolean sets are the same on both sides', () => {
    const serverNumeric = setLiteral(read(SERVER), 'numericFns');
    const serverBoolean = setLiteral(read(SERVER), 'booleanFns');
    const clientNumeric = arrayLiteral(read(CLIENT), 'NUMERIC_MERGE_FNS');
    const clientBoolean = arrayLiteral(read(CLIENT), 'BOOLEAN_MERGE_FNS');

    // Parsed at all, before compared — an unparsed side is an empty array, and two empty arrays are equal.
    assert.ok(serverNumeric?.length, `could not parse numericFns from ${SERVER}`);
    assert.ok(serverBoolean?.length, `could not parse booleanFns from ${SERVER}`);
    assert.ok(clientNumeric?.length, `could not parse NUMERIC_MERGE_FNS from ${CLIENT}`);
    assert.ok(clientBoolean?.length, `could not parse BOOLEAN_MERGE_FNS from ${CLIENT}`);

    assert.deepEqual([...clientNumeric].sort(), [...serverNumeric].sort());
    assert.deepEqual([...clientBoolean].sort(), [...serverBoolean].sort());
  });

  it('the server has only ONE copy of the rule now', () => {
    /*
     * This used to assert that the library's own copy AGREED with the inline one — the best available check
     * while there were two, and its own comment said so: *"deliberate or not, two copies still drift"*.
     *
     * There is one now. `schema-library.ts` imports the shared `PropertySchemaZ` instead of restating the
     * grammar, so agreement is not something to check — it is something that cannot fail. What is worth
     * checking is that the second copy has not come back, which is a stronger claim than the two matching.
     *
     * `one-property-schema-grammar.test.js` holds the rest: that both doors return the same verdict for the
     * same value, refusals included.
     */
    assert.equal(setLiteral(read(LIBRARY), 'numericFns'), null,
      'the schema library declares its own merge-function sets again — import the grammar instead');
    assert.equal(setLiteral(read(LIBRARY), 'booleanFns'), null,
      'the schema library declares its own merge-function sets again — import the grammar instead');
    // Since Q-215 the library's body is built from `InlineTypeSchemaZ` (whose `propertySchemas` IS the shared grammar), so that is the import.
    assert.match(read(LIBRARY), /(?:PropertySchemaZ|InlineTypeSchemaZ)[^;]*from '\.\.\/spaces\/body-schemas\.js'/,
      'and it no longer imports the shared one, so whatever it validates with is a copy');
  });

  it('string and date still accept NO merge function on the server', () => {
    // The half the old client lists missed entirely: they cleared an incompatible fn when switching between
    // number and boolean, and left it alone for string and date, which accept none.
    assert.match(
      strip(read(SERVER)),
      /if \(data\.type === 'string' \|\| data\.type === 'date'\) return false;/,
      'the string/date refusal changed — merge-fns.ts returns [] for both and must be revisited',
    );
  });

  it('an undeclared type still accepts any of the seven', () => {
    // The client must not narrow here: refusing a combination the API accepts is the same defect pointing the
    // other way, and it is the one nobody reports because it looks like a missing feature.
    assert.match(
      strip(read(SERVER)),
      /return numericFns\.has\(data\.mergeFn\) \|\| booleanFns\.has\(data\.mergeFn\);/,
      'the undeclared-type fallback changed — mergeFnsFor(undefined) returns all seven and must be revisited',
    );
  });

  it('no component writes its own list of merge functions', () => {
    // Both editors listed all seven as static options. That is what offered `date` + `min`.
    const offenders = [
      'client/src/app/pages/settings/schema-type-editor.component.ts',
      'client/src/app/shared/prop-schema-table.component.ts',
    ].filter((f) => /value="(avg|sum|xor)"/.test(strip(read(f))));
    assert.deepEqual(offenders, [], 'these hard-code merge-function options instead of asking mergeFnsFor()');
  });
});
