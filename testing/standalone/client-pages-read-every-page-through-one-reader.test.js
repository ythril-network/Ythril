/**
 * A client page walk follows `nextSkip` through `readEveryPage`, never through an `expand` of its own.
 *
 * ## Why this gate exists
 *
 * `core/read-every-page.ts` ends a walk when `nextSkip` does not move forward. That is the line a hand-written
 * walk drops, because it reads like boilerplate: `expand(r => r.nextSkip ? page(r.nextSkip) : EMPTY)` looks complete
 * and follows a server that repeats itself for ever. The type history's two reads (the dialog and the Schema tab's
 * type list) were written that way, twice, beside the reader that exists for the purpose.
 *
 * ## The rule
 *
 * Under `client/src/app`, outside `core/read-every-page.ts` and the specs, no `expand(` has a callback that reads
 * `nextSkip`. A site that is not a page walk would be named in `NOT_A_PAGE_WALK` with its reason; none is today.
 *
 * ## It cannot pass vacuously
 *
 * The sources come from `git ls-files` through `_sources.mjs` (floor included), the reader's own file is found
 * before it is excluded, and the detector is run on two small texts first: one it must flag, one it must not.
 *
 * Run: node --test testing/standalone/client-pages-read-every-page-through-one-reader.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { join } from 'node:path';
import { stripFullLineComments } from './_strip-comments.mjs';

const READER = 'client/src/app/core/read-every-page.ts';

/** Sites that call `expand(` and read `nextSkip` without being a page walk: path -> why. Empty: every one is a walk. */
const NOT_A_PAGE_WALK = Object.freeze({});

/** Comments are stripped: a docblock that names `expand(` and `nextSkip` is not a call. */
const strip = stripFullLineComments;

/** The text from the `(` at `open` to its matching `)`, or null when the text ends first. */
function callText(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** The line numbers of every `expand(` call in `src` whose arguments read `nextSkip`. */
function expandsReadingNextSkip(src) {
  const text = strip(src);
  const lines = [];
  for (const m of text.matchAll(/\bexpand\s*\(/g)) {
    const call = callText(text, m.index + m[0].length - 1);
    if (call === null) throw new Error('an expand( call whose parentheses never close: the detector cannot read this file');
    if (/\bnextSkip\b/.test(call)) lines.push(text.slice(0, m.index).split('\n').length);
  }
  return lines;
}

describe('client page walks go through readEveryPage', () => {
  it('the detector flags a hand-written walk and passes an expand that does not page', () => {
    const walk = 'page().pipe(\n  expand(r => r.supported && r.answer.nextSkip ? page(r.answer.nextSkip) : EMPTY),\n)';
    assert.deepEqual(expandsReadingNextSkip(walk), [2]);
    assert.deepEqual(expandsReadingNextSkip('x.pipe(expand(n => n < 3 ? of(n + 1) : EMPTY))'), []);
    assert.deepEqual(expandsReadingNextSkip('// expand(r => r.nextSkip)\nconst a = 1;'), []);
  });

  it('no client source outside the reader has an expand that reads nextSkip', () => {
    const files = trackedSources('client/src/app', { specs: false });
    assert.ok(files.includes(READER), `${READER} is not among the tracked sources: the reader moved, and this gate would exclude nothing`);
    const found = [];
    for (const file of files.filter(f => f !== READER)) {
      const lines = expandsReadingNextSkip(readFileSync(join(REPO_ROOT, file), 'utf8'));
      if (lines.length && !Object.hasOwn(NOT_A_PAGE_WALK, file)) found.push(`${file}:${lines.join(',')}`);
    }
    assert.deepEqual(found, [], `a page walk written by hand drops readEveryPage's guard (a nextSkip that does not move forward ends the walk): ${found.join('; ')}`);
  });

  it('every site named as not a page walk still exists and still has the call', () => {
    for (const [file, why] of Object.entries(NOT_A_PAGE_WALK)) {
      assert.ok(why.length > 20, `${file}: the reason is a sentence`);
      assert.ok(expandsReadingNextSkip(readFileSync(join(REPO_ROOT, file), 'utf8')).length, `${file} no longer has such a call: remove it from the list`);
    }
  });
});
