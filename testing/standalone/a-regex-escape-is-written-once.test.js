/**
 * The escape that turns text into a regular expression's literal is written once: `scripts/_shared/escape-regexp.mjs` (Q-683).
 *
 * ## The rule
 *
 * No tracked `.mjs`, `.js` or `.cjs` under `scripts/` or `testing/` spells the escape inline: a `.replace` (or `.replaceAll`) of a character class that holds
 * every regex metacharacter (`. * + ? ^ $ { } ( ) | [ ] \`) by a replacement that writes the match back with a backslash (`$&`). A caller imports `escapeRegExp`.
 *
 * ## What bought it
 *
 * Bundle-225's diff pass found the spelling about twenty times, a fresh copy among them (`_relative-specifier.mjs`, which escaped `-` and `/` as well), and a
 * copy is free to drift: one that leaves out the backslash ends a pattern early, one that adds `-` or `/` breaks under the `u` flag. The folds moved every copy
 * into the module; this holds that none comes back.
 *
 * ## What it leaves alone
 *
 * A class that lacks a metacharacter on purpose is a different question: a glob translator that keeps `*`, an escape of two characters. Only the full set is the
 * escape this module owns.
 *
 * ## It cannot pass by reading nothing
 *
 * The files come from `git ls-files` through `trackedSources` (floor inside), comments are blanked through `blankComments` (line numbers kept), and the matcher is proven red on a
 * planted copy of each spelling, in memory.
 *
 * Run: node --test testing/standalone/a-regex-escape-is-written-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';

const MODULE = 'scripts/_shared/escape-regexp.mjs';
const FLOOR = 1000;

/** The characters a pattern gives a meaning to; a class holding all of them is the escape. */
const METACHARACTERS = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'];

/** `.replace(` / `.replaceAll(` of a regex literal that is one character class, followed by a replacement string that holds `$&`. Group 1 is the class body. */
const REPLACE_BY_MATCH = /\.replace(?:All)?\(\s*\/\[((?:\\.|[^\]\\])*)\]\/[a-z]*\s*,\s*(?:'[^'\n]*\$&[^'\n]*'|"[^"\n]*\$&[^"\n]*"|(?:String\.raw)?`[^`]*\$&[^`]*`)/g;

/** The characters a class body names, escapes read as the character they escape (`\]` is `]`, `\\` is a backslash). */
function charactersOf(body) {
  const out = new Set();
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length) i++;
    out.add(body[i]);
  }
  return out;
}

/** The 1-based lines of `source` (comments stripped, so a comment may quote the pattern) that spell the escape inline. */
export function inlineEscapeLines(source) {
  const code = blankComments(source);
  const lines = [];
  for (const match of code.matchAll(REPLACE_BY_MATCH)) {
    const named = charactersOf(match[1]);
    if (METACHARACTERS.every((c) => named.has(c))) lines.push(code.slice(0, match.index).split('\n').length);
  }
  return lines;
}

/** The class of the standard escape, built from pieces so this file never spells the inline shape it refuses. */
const STANDARD_CLASS = '.*+?^${}()|[\\]\\\\';
const plant = (cls, replacement) => `const lit = text.replace(/[${cls}]/g, ${replacement});`;

describe('the matcher this gate stands on (each refuses a planted copy, in memory)', () => {
  it('refuses the standard escape spelled inline, in each quoting of the replacement', () => {
    for (const replacement of ["'\\\\$&'", '"\\\\$&"', 'String.raw`\\$&`', '`\\\\$&`']) {
      assert.deepEqual(inlineEscapeLines(`\n${plant(STANDARD_CLASS, replacement)}\n`), [2], replacement);
    }
  });

  it('refuses it with the characters in another order, with `-` and `/` added, and through replaceAll', () => {
    assert.deepEqual(inlineEscapeLines(plant('\\\\^$.*+?()[\\]{}|', "'\\\\$&'")), [1]);
    assert.deepEqual(inlineEscapeLines(plant(`${STANDARD_CLASS}/-`, "'\\\\$&'")), [1]);
    assert.deepEqual(inlineEscapeLines(plant(STANDARD_CLASS, "'\\\\$&'").replace('.replace(', '.replaceAll(')), [1]);
  });

  it('leaves a comment, a different set and a replacement that is not the match alone', () => {
    assert.deepEqual(inlineEscapeLines(`// ${plant(STANDARD_CLASS, "'\\\\$&'")}\n/* ${plant(STANDARD_CLASS, "'\\\\$&'")} */`), []);
    assert.deepEqual(inlineEscapeLines(plant('.+^$()|[\\]\\\\', "'\\\\$&'")), [], 'a glob translator that keeps `*` is another question');
    assert.deepEqual(inlineEscapeLines(plant('-.', "'\\\\$&'")), []);
    assert.deepEqual(inlineEscapeLines(plant(STANDARD_CLASS, "''")), [], 'no `$&`: it does not write the match back');
  });

  it('the module itself escapes what the matcher names, so the rule and the code agree', () => {
    assert.equal(escapeRegExp(METACHARACTERS.join('')), METACHARACTERS.map((c) => `\\${c}`).join(''));
    assert.equal(escapeRegExp('a-b/c'), 'a-b/c', '`-` and `/` stay: `\\-` outside a class is a SyntaxError under the `u` flag');
    assert.doesNotThrow(() => new RegExp(escapeRegExp('@scope/name-x.y'), 'u'));
  });
});

describe('the repository spells the regex escape once', () => {
  it('no tracked script or test spells it inline outside the module (import escapeRegExp)', () => {
    const files = trackedSources(['scripts', 'testing'], { ext: ['.mjs', '.js', '.cjs'], floor: FLOOR, exclude: [MODULE] });
    const sites = files.flatMap((file) => inlineEscapeLines(readFileSync(join(REPO_ROOT, file), 'utf8')).map((line) => `${file}:${line}`));
    assert.deepEqual(sites, [], 'the regex escape is written inline here: import escapeRegExp from scripts/_shared/escape-regexp.mjs');
  });

  it('the module is tracked and is read by the scan', () => {
    const all = trackedSources(['scripts'], { ext: ['.mjs'], floor: 10 });
    assert.ok(all.includes(MODULE), `${MODULE} is not tracked`);
  });
});
