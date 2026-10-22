/**
 * A sentence that names a list constant does not say how many it holds, or that it holds none.
 *
 * ## Why this, and the sentence it was written from
 *
 * `CLAUDE.md` told every contributor that `REST_ONLY_CAPABILITIES` **is EMPTY** and that *"a row added there is a
 * regression, not a plan"*. The list had held rows for a long time, each with a reason, and the rule was being
 * read as if adding one were forbidden. The sentence was true on the day it was written (`Q-468`), and it is the
 * pattern `pitfall-a-count-in-prose-rots` names: **a number or an emptiness written beside a list is a second copy of
 * a fact the list already holds**, correct until the next row, with nothing that ever contradicts it. The same
 * file counts a list of fields, and a set of userguide pages, in words, and both have grown since; those two are not
 * this gate's to find (see the limit below) and were corrected by hand, which is how this class is normally met and
 * why it keeps coming back.
 *
 * ## What it reads
 *
 * **The subject set is derived**: every top-level constant in `server/src` and `testing/` named in
 * SCREAMING_SNAKE_CASE whose initializer is a list (an array, a `Set`, a `Map`, `Object.freeze([...])` or an object
 * literal), read from the sources with comments out. **The prose** is `CLAUDE.md` and every `.md` under `docs/`,
 * tokenised ONCE into the backticked identifiers each sentence names, and looked up in a `Set`: a regular
 * expression per constant over every page is the cost that makes a gate nobody runs.
 *
 * A sentence naming one such constant may not also state a COUNT: a number (digits or a word) followed within
 * two words by a plural noun (`four rows`, `5 fields`, `the same five fields`), or an emptiness (`empty`,
 * `none`, `zero`, `no entries`). Say what the list IS FOR and where it lives; the reader who needs the number
 * reads the list.
 *
 * ## Stated limits
 *
 * It holds sentences that name the constant in backticks. A count that sits one sentence away (`the same five fields`
 * after a sentence that named the list) is not tied to it, and a number that counts something else in the same
 * sentence (a version, a date, a ticket id) is not a count of the list: only `<number> <plural noun>` and the
 * emptiness words are read, which is what keeps scalars, versions and env defaults out. Constants are held by
 * SCREAMING_SNAKE_CASE name, so a list kept under a lowercase name is not reached.
 *
 * ## Derived, and floored
 *
 * Constants, source files and pages are all derived. The constants found, the pages read and the constants that prose
 * actually names are each floored, so a tokenizer that stopped matching, or an extraction that found no lists,
 * cannot report a clean result about nothing.
 *
 * ## Seen red
 *
 * On the base this was written against: `CLAUDE.md`'s `REST_ONLY_CAPABILITIES` sentence.
 *
 * Run: node --test testing/standalone/a-list-constant-is-not-counted-in-prose.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/**
 * Every top-level SCREAMING_SNAKE_CASE constant whose initializer is a list: `const NAME[: type] = [`,
 * `= {`, `= new Set([`, `= new Map(`, `= Object.freeze([` / `Object.freeze({`.
 */
const LIST_CONSTANT = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{3,})\b[^=\n]*=\s*(?:Object\.freeze\(\s*|new\s+(?:Set|Map)\b[^(\n]*\(\s*)?[[{]/gm;

const SOURCES = [
  ...trackedSources('server/src', { ext: ['.ts', '.js', '.mjs'], floor: 100 }),
  ...trackedSources('testing', { ext: ['.ts', '.js', '.mjs'], floor: 100 }),
];

const CONSTANTS = new Set();
for (const file of SOURCES) {
  const text = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
  for (const m of text.matchAll(LIST_CONSTANT)) CONSTANTS.add(m[1]);
}

const PAGES = [
  'CLAUDE.md',
  ...trackedSources('docs', { ext: ['.md'], floor: 30 }),
];

const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|dozen|hundred)';
const singular = w => w.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
/**
 * What a list's members are called, in the vocabulary a sentence about a list uses. A number counts THE LIST only
 * when the noun after it is one of these, or a word of the constant's own name (`DERIVED_FIELDS` — fields): `two
 * right answers` and `three sites` name something else that happens to sit in the same sentence. It errs toward
 * missing a count whose noun is neither, which is the stated limit.
 */
const MEMBER_NOUNS = new Set(['row', 'entry', 'item', 'member', 'name', 'key', 'field', 'type', 'route', 'tool', 'value',
  'element', 'case', 'rule', 'label', 'id', 'path', 'option', 'flag', 'column', 'capability', 'operator', 'schema',
  'prefix', 'code', 'word', 'kind']);
const NUMBER_THEN_WORDS = new RegExp(`(?<![\\w.-])(\\d+|${NUMBER_WORD})(?![\\w.])\\s+([\\w\`'-]+(?:\\s+[\\w\`'-]+)*)`, 'gi');
/** How many words after a number may be the noun it counts (`five distinct rows`): a rule, held in code and not in the regex. */
const WORDS_AFTER_A_NUMBER = 3;
const EMPTINESS = /\b(?:empty|none|zero)\b/i;

/**
 * The count phrase a sentence states about a list constant, or null: an emptiness (`EMPTY`, `none`, `zero`), or
 * a number followed within two words by a noun that is a member noun of lists in general or of this one by name.
 */
function countOf(sentence, constant) {
  const own = new Set(constant.split('_').map(singular));
  const empty = EMPTINESS.exec(sentence);
  if (empty) return empty[0];
  for (const m of sentence.matchAll(NUMBER_THEN_WORDS)) {
    // PLURAL only: a number counts a noun in the plural (`five fields`), and `two right answers` carries the
    // singular `right` as a modifier that happens to be a word of `ROUTE_RIGHTS`.
    const plural = w => /(?:ies|s)$/i.test(w) && (MEMBER_NOUNS.has(singular(w)) || own.has(singular(w)));
    if (m[2].split(/\s+/).slice(0, WORDS_AFTER_A_NUMBER).some(plural)) return m[0];
  }
  return null;
}

/**
 * Every sentence of a page that names a backticked identifier, with its line: `{ page, line, sentence, names }`.
 * A page is tokenised once; `names` are the backticked identifiers in the sentence.
 */
function sentencesNaming(page) {
  const text = readFileSync(join(REPO_ROOT, page), 'utf8').replace(/\r\n/g, '\n');
  const out = [];
  let offset = 0;
  for (const block of text.split(/\n{2,}/)) {
    const blockStart = text.indexOf(block, offset);
    offset = blockStart + block.length;
    let from = 0;
    for (const sentence of block.split(/(?<=[.!?])\s+(?=[A-Z`*(\[])/)) {
      const at = block.indexOf(sentence, from);
      from = at + sentence.length;
      const names = [...sentence.matchAll(/`([A-Za-z_][\w.]*)`/g)].map(m => m[1]);
      if (names.length === 0) continue;
      const line = text.slice(0, blockStart + at).split('\n').length;
      // The line a name is on, not the line its sentence starts on: a sentence runs over several, and the reader greps for the name.
      const lineOf = name => line + (sentence.slice(0, Math.max(0, sentence.indexOf(`\`${name}\``))).match(/\n/g) ?? []).length;
      out.push({ page, line, lineOf, sentence: sentence.replace(/\s+/g, ' ').trim(), names });
    }
  }
  return out;
}

const SENTENCES = PAGES.flatMap(sentencesNaming);
const NAMED = new Set(SENTENCES.flatMap(s => s.names.filter(n => CONSTANTS.has(n))));

describe('the scan reads before it concludes', () => {
  it('finds the list constants, the pages and the sentences that name them', () => {
    assert.ok(CONSTANTS.size >= 100, 'too few list constants were found in the sources; the initializer pattern stopped matching');
    assert.ok(CONSTANTS.has('ALL_TOOLS') || CONSTANTS.has('ROUTE_RIGHTS'), 'a list constant every reader knows was not found; the extraction is broken');
    assert.ok(PAGES.length >= 30, 'too few pages were read');
    assert.ok(NAMED.size >= 10, 'too few list constants are named in prose; the tokenizer stopped finding backticked names');
  });

  it('the count pattern reads a count and an emptiness, and leaves a version alone', () => {
    assert.ok(countOf('the same five fields', 'SOME_LIST'), 'a number word and a member noun is a count');
    assert.ok(countOf('there are 4 rows here', 'SOME_LIST'), 'digits and a member noun is a count');
    assert.ok(countOf('there are 3 gizmos here', 'GIZMO_LIST'), 'a noun taken from the constant\'s own name is a count');
    assert.ok(countOf('the list is EMPTY', 'SOME_LIST'), 'an emptiness is a count of none');
    assert.equal(countOf('since 5.0 it takes a space', 'SOME_LIST'), null, 'a version is not a count');
    assert.equal(countOf('on 2026-08-13 it changed', 'SOME_LIST'), null, 'a date is not a count');
    assert.equal(countOf('there are two right answers and three sites', 'ROUTE_RIGHTS'), null,
      'a singular word of the constant\'s name used as a modifier is not the plural noun being counted');
    assert.equal(countOf('three sites in one file', 'SOME_LIST'), null, 'a number counting something other than the list is not a count of it');
  });
});

describe('a list constant is not counted in prose', () => {
  it('no sentence naming one states a count or an emptiness', () => {
    const offenders = [];
    for (const s of SENTENCES) {
      for (const constant of s.names.filter(n => CONSTANTS.has(n))) {
        const hit = countOf(s.sentence, constant);
        if (hit) {
          offenders.push(`${s.page}:${s.lineOf(constant)} names \`${constant}\` and states a count ("${hit.trim()}"): ${s.sentence.slice(0, 140)}`);
          break;
        }
      }
    }
    assert.deepEqual(offenders, [],
      'prose counts a list that the code already holds:\n  ' + offenders.join('\n  ')
      + '\n\nA number or an emptiness beside a list is correct until its next row and then silently wrong. Say what the list is for '
      + 'and where it lives; the reader who needs the number reads the list.');
  });
});
