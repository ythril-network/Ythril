/**
 * Whether a stored record STILL HOLDS A DERIVED FIELD (its vector, that vector's model, or its `matchedText`) is asked in ONE
 * module (`server/src/brain/holds-derived.ts`), in the three spellings the store and the code need (Q-656, bundle-211).
 *
 * ## What it prevents
 *
 * The backfill's candidate query (`$or` of `$exists`), its walk's aggregation (`$ne [{ $type }, 'missing']`) and the worker's JS
 * test (`Object.keys(UNSET_DERIVED).some(f => f in doc)`) each wrote "the record still holds a derived field" over a field list
 * each took from `UNSET_DERIVED` by hand. They agree on "present even as `null`" today; a fourth spelling, or one of the three
 * changing, leaves a textless row that the worker would clear and the backfill never queues. One module owns the field list and
 * the three spellings, so the list cannot be taken by hand again.
 *
 * ## What is asked, with the comments stripped
 *
 * - the detector flags each planted copy of a spelling (the gate cannot pass because its pattern is broken), and leaves alone
 *   what is not this question: `UNSET_DERIVED` handed to an `$unset` or a writer whole, a `$eq [{ $type }, 'missing']` on one field;
 * - no file in `server/src` outside `brain/holds-derived.ts` takes the keys, values or entries of `UNSET_DERIVED`, or writes
 *   `$ne: [{ $type: ... }, 'missing']`.
 *
 * Run: node --test testing/standalone/a-held-derived-field-is-asked-in-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HOME = 'server/src/brain/holds-derived.ts';

/** The spellings, each with the name it is reported under. */
const SPELLINGS = [
  ['the derived field list taken by hand', /Object\.(?:keys|values|entries)\(\s*UNSET_DERIVED\s*\)/],
  ['an aggregation on a field being present', /\$ne\s*:\s*\[\s*\{\s*\$type\s*:\s*(?:`[^`]*`|'[^']*'|"[^"]*")\s*\}\s*,\s*['"]missing['"]/],
];

const spellingsIn = (src) => SPELLINGS.filter(([, re]) => re.test(stripComments(src))).map(([name]) => name);

describe('a held derived field is asked for in one module', () => {
  it('the detector flags each planted copy and leaves what is not this question alone', () => {
    assert.deepEqual(spellingsIn('const f = Object.keys(UNSET_DERIVED);'), ['the derived field list taken by hand']);
    assert.deepEqual(spellingsIn('const has = Object.keys( UNSET_DERIVED ).some(f => f in doc);'), ['the derived field list taken by hand']);
    assert.deepEqual(spellingsIn('for (const [k] of Object.entries(UNSET_DERIVED)) {}'), ['the derived field list taken by hand']);
    assert.deepEqual(spellingsIn("{ $or: F.map(f => ({ $ne: [{ $type: `$${f}` }, 'missing'] })) }"), ['an aggregation on a field being present']);
    assert.deepEqual(spellingsIn("{ $ne: [ { $type: '$matchedText' }, \"missing\" ] }"), ['an aggregation on a field being present']);
    // Not this question: the whole record handed to a writer, another test of one field, a comment that names the spelling.
    assert.deepEqual(spellingsIn('await write({ unset: UNSET_DERIVED });'), []);
    assert.deepEqual(spellingsIn("const missing = (field) => ({ $eq: [{ $type: `$${field}` }, 'missing'] });"), []);
    assert.deepEqual(spellingsIn("// was Object.keys(UNSET_DERIVED).some(f => f in doc)\nconst f = 1;"), []);
  });

  it('no file outside holds-derived.ts spells the question itself', () => {
    const files = trackedSources('server/src', { floor: 200 }).filter(f => f !== HOME);
    const copies = [];
    for (const f of files) {
      for (const name of spellingsIn(readFileSync(f, 'utf8'))) copies.push(`${f}: ${name}`);
    }
    assert.deepEqual(copies, [], 'a module spells "holds a derived field" itself instead of importing it from brain/holds-derived.ts');
  });
});
