/**
 * A schema-library entry refuses `retention`, and the refusal explains itself.
 *
 * ## What was actually wrong, having read the code
 *
 * This was filed as "two surfaces, one weaker: the library cannot express a field the inline schema can". Two thirds
 * of that dissolved on reading:
 *
 *  - the client already strips it — `typeSchemaFromState(..., { withRetention: false })`;
 *  - the docs already state it AND give the reason, in `04-brain-api.md`.
 *
 * So the omission was never an oversight. A library entry is referenced by any number of spaces, and a delete policy
 * is not a property of a shape. What was missing was the explanation at the **point of refusal**: `.strict()` alone
 * answers `Unrecognized key(s) in object: 'retention'`, which tells a direct API caller that a field valid one place
 * is invalid here, and nothing about why — inviting them to report it as a bug.
 *
 * That is the whole change, and this test pins the two things that make it worth having: the field is still refused,
 * and the message says why.
 *
 * Run: node --test testing/standalone/library-retention-refusal.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../server/src/api/schema-library.ts', import.meta.url), 'utf8');
/** Comments must not satisfy any of this — the block above the schema describes the very rule being checked. */
const CODE = SRC.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The `retention` declaration only.
 *
 * Sliced from the key FORWARD, not between the key and the first `}).strict()` — that was the first version, and this
 * file has an earlier `.strict()` schema, so the end index came out BEFORE the start and every slice was empty. Two
 * assertions then passed vacuously against an empty string while looking specific.
 */
const RETENTION_DECL = (() => {
  const a = CODE.indexOf('retention: z.never(');
  return a < 0 ? '' : CODE.slice(a, CODE.indexOf('}).optional(),', a));
})();

describe('the refusal', () => {
  it('still refuses retention — the field is not quietly accepted', () => {
    // The one thing that must not change. Widening the library to hold a window would give a linked type a delete
    // policy inherited from the library, which is new behaviour nobody asked for.
    assert.match(CODE, /retention: z\.never\(/);
  });

  it('keeps .strict(), so an ordinary typo is still rejected', () => {
    // The explicit key is for the ONE field whose absence is a design decision. A genuine misspelling should still
    // get the generic answer rather than silently landing in the entry.
    assert.match(CODE, /\}\)\.strict\(\)/);
  });

  it('explains why, naming the reason rather than the rule', () => {
    // "Not allowed" is what `.strict()` already said. The message has to carry the design reason, or the caller has
    // no way to tell a deliberate refusal from a bug.
    assert.ok(RETENTION_DECL.length > 0, 'the declaration was not found — the slice is broken, not the code');
    assert.match(RETENTION_DECL, /referenced by any number of spaces/);
    assert.match(RETENTION_DECL, /belongs to a type in a space/);
  });

  it('tells the caller what to do instead', () => {
    // An error that only says no leaves the caller stuck. Both routes out are named.
    assert.ok(RETENTION_DECL.length > 0, 'the declaration was not found — the slice is broken, not the code');
    assert.match(RETENTION_DECL, /inline definition/);
    assert.match(RETENTION_DECL, /recordTtlDays/);
  });
});

describe('the two surfaces are otherwise in step', () => {
  it('the library accepts suppressEmbeddings, as the inline schema does', () => {
    // The field that WAS a real gap of this shape, closed when it shipped. Pinned so the library does not fall behind
    // again the next time a per-type field is added.
    // Since Q-215 the library's body is built from the inline definition's own shape, so the field cannot be missing from it unless the
    // inline body lacks it (`the-library-door-takes-what-the-inline-door-takes.test.js` runs it, for every key).
    assert.match(CODE, /\.\.\.InlineTypeSchemaZ\.shape/);
  });

  it('the client strips retention rather than relying on the 400', () => {
    // Belt and braces, and the belt is the client: a UI that posted a field it knew would be refused would surface
    // the error to an operator who did nothing wrong.
    const tab = readFileSync(new URL('../../client/src/app/pages/settings/space-schema-tab.component.ts', import.meta.url), 'utf8');
    assert.match(tab, /withRetention: false/);
  });
});
