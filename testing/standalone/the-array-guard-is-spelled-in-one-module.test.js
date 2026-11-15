/**
 * The array guard of a type match, `$not: { $type: 'array' }`, is spelled in ONE module of the server (`spaces/type-field-clause.ts`)
 * (Q-744, bundle-268 fix round 2, S3).
 *
 * ## What it prevents
 *
 * On a field holding an array, MongoDB's `$eq` and `$in` match an ELEMENT, so a type match that leaves the guard out reads `['T', 'X']` as a
 * record of T. `type-field-clause.ts` says it alone owns the guard (`guardedTypeValue` for one name, `guardedTypeList` for a list), so a caller
 * that builds a type match through it cannot leave the guard out; a second hand-written spelling (the filter's `older` branch had one) is a copy
 * that stops following the first. This sweeps `server/src` for the spelling outside the one module. The detector is held by planted copies, so
 * a pattern edited into silence fails here instead of reporting a clean sweep.
 *
 * Not the guard: `{ $type: 'array' }` on its own (a vector field holds an array), and a `$type` list that names `'array'` among other types (the
 * unnamed-type read asks which stamps carry a type that is no string).
 *
 * ## Seen red
 *
 * On the tree before the fold: `server/src/brain/schema-version-filter.ts` spelled `$not: { $type: 'array' }` itself.
 *
 * Run: node --test testing/standalone/the-array-guard-is-spelled-in-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

/** The one module that owns the guard. */
const OWNER = 'server/src/spaces/type-field-clause.ts';
/** The fewest files this sweep may find: the server is far larger, so a short list means the listing broke. */
const SERVER_FLOOR = 300;

const Q = `['"\`]`;
/** The guard as a program spells it: `$not` over `{ $type: 'array' }`, with or without quoted keys. */
const GUARD = new RegExp(`\\$not${Q}?\\s*:\\s*\\{\\s*${Q}?\\$type${Q}?\\s*:\\s*${Q}array${Q}\\s*\\}`);

/** The files of `sources` (comments blanked) that spell the guard, the owner left out. */
export function guardSpellings(sources) {
  return sources.filter(({ file, text }) => file !== OWNER && GUARD.test(blankComments(text))).map(s => s.file);
}

describe('the array guard of a type match is one module\'s', () => {
  it('no file under server/src spells it but the one module', () => {
    const sources = readTrackedSources('server/src', { untracked: true, floor: SERVER_FLOOR });
    assert.ok(sources.some(s => s.file === OWNER), `${OWNER} is not in the sweep`);
    assert.deepEqual(guardSpellings(sources), [],
      'a hand-written `$not: { $type: \'array\' }`: build the match through guardedTypeValue / guardedTypeList / stampedTypeValue / stampedTypeList '
      + '(spaces/type-field-clause.ts), so no caller can leave the guard out');
  });

  it('the owner spells it, and exports the list form beside the single one', () => {
    const owner = readTrackedSources('server/src', { untracked: true, floor: SERVER_FLOOR }).find(s => s.file === OWNER);
    assert.ok(owner && GUARD.test(blankComments(owner.text)), 'the owner no longer spells the guard: the sweep looks for the wrong thing');
    assert.match(blankComments(owner.text), /export\s+const\s+guardedTypeList\b|export\s+function\s+guardedTypeList\b/, 'no list form of the guard');
  });
});

describe('the sweep sees what it claims to', () => {
  const planted = (text, file = 'server/src/planted.ts') => guardSpellings([{ file, text }]);

  it('it finds the guard in each spelling', () => {
    assert.deepEqual(planted(`const m = { $in: names, $not: { $type: 'array' } };`), ['server/src/planted.ts']);
    assert.deepEqual(planted(`const m = {$not:{$type:"array"}};`), ['server/src/planted.ts']);
    assert.deepEqual(planted(`const m = { '$not': { '$type': 'array' } };`), ['server/src/planted.ts']);
    assert.deepEqual(planted(`x ? { $not: {\n  $type: 'array' } } : {}`), ['server/src/planted.ts']);
  });

  it('it does not find a vector field\'s array check, a $type list, or a comment', () => {
    assert.deepEqual(planted(`find({ [vectorPath]: { $type: 'array' } })`), []);
    assert.deepEqual(planted(`const f = { t: { $type: [...SCALARS, 'array'] } };`), []);
    assert.deepEqual(planted(`// { $not: { $type: 'array' } } keeps exactly the string\nconst x = 1;`), []);
  });

  it('the owner itself is not reported', () => {
    assert.deepEqual(planted(`export const g = { $not: { $type: 'array' } };`, OWNER), []);
  });
});
