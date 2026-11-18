/**
 * The cases of "a failing space index is contained and named" are each in exactly one of the two files that hold the rule.
 *
 * ## What this prevents
 *
 * `a-failing-space-index-is-contained-and-named-db.test.js` was one file; its longest case, the background pass over one refused
 * index per declared index, is its own file now (`a-failing-space-index-in-the-background-pass-is-named-db.test.js`) so the
 * two run side by side. A rule cut across files is held only while every case stays in one of them: a case dropped in the move
 * is a rule nobody checks, and the same case in both is a minute run twice. Nothing else reads the two files together, and both
 * are green with a case missing.
 *
 * ## The rule, and its limit
 *
 * Each title below is declared by exactly one `it(...)` across the two files, in the file the table names, and neither file
 * declares a case the table does not list (a case added to either is added here, with the file it belongs in). A planted pair of
 * files shows each way of failing: a title missing, in both, in the wrong file, and a case nobody listed. The titles are the
 * cases' own words, so a reworded case is named here as missing; that is the price of holding the cut by name.
 *
 * Run: node --test testing/standalone/a-failing-space-index-cases-are-held-once-across-their-files.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { ts, parseSource } from '../_shared/syntax-tree.mjs';

const CONTAINED = 'testing/standalone/a-failing-space-index-is-contained-and-named-db.test.js';
const BACKGROUND = 'testing/standalone/a-failing-space-index-in-the-background-pass-is-named-db.test.js';

/** Every case of the rule and the file that holds it. */
const CASES = new Map([
  ['initSpace on a new space is not stopped by a refused report or best-effort index, and builds every other declared one', CONTAINED],
  ['the background pass names a refused index and builds every other index of the space', BACKGROUND],
  ['the background pass warns once about a refused best-effort index and reports no space failure for it', CONTAINED],
  ['a best-effort build that meets a store that is not answering is the walk\'s verdict, and does not use up the warning', CONTAINED],
  ['a sweep tick whose index listing hangs for one space says that space and still indexes the others', CONTAINED],
]);

/** The titles of the `it(...)` cases one source text declares, in order. */
function titlesOf(text, file) {
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'it'
      && n.arguments[0] && (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(parseSource(file, text));
  return out;
}

/** What is wrong with how `files` (`{ file, text }` each) hold `cases` (title to file), as one sentence each; empty when nothing is. */
function problemsOf(files, cases) {
  const held = new Map();
  for (const { file, text } of files) for (const title of titlesOf(text, file)) held.set(title, [...(held.get(title) ?? []), file]);
  const out = [];
  for (const [title, where] of cases) {
    const at = held.get(title) ?? [];
    if (at.length === 0) out.push(`missing: "${title}" is in no file`);
    else if (at.length > 1) out.push(`twice: "${title}" is in ${at.join(' and ')}`);
    else if (at[0] !== where) out.push(`wrong file: "${title}" is in ${at[0]}, not ${where}`);
  }
  for (const [title, at] of held) if (!cases.has(title)) out.push(`unlisted: "${title}" in ${at.join(', ')}`);
  return out;
}

describe('the cases of a failing space index are each held by exactly one of its two files', () => {
  it('every case is declared once, in the file the table names, and nothing else is declared', () => {
    const files = readTrackedSources([CONTAINED, BACKGROUND], { ext: ['.js'], floor: 2 });
    assert.deepEqual(files.map(f => f.file).sort(), [BACKGROUND, CONTAINED].sort(), 'the two files are not both tracked');
    assert.deepEqual(problemsOf(files, CASES), []);
  });

  describe('the reading names each way of failing, on a planted pair of files', () => {
    const planted = (a, b) => [{ file: 'a.test.js', text: a }, { file: 'b.test.js', text: b }];
    const cases = new Map([['one', 'a.test.js'], ['two', 'b.test.js']]);
    const file = (...titles) => titles.map(t => `it('${t}', () => {});`).join('\n');

    it('reads a pair that holds each case once, where it belongs, as no problem', () => {
      assert.deepEqual(problemsOf(planted(file('one'), file('two')), cases), []);
    });
    it('names a case that is in neither file', () => {
      assert.deepEqual(problemsOf(planted(file('one'), file()), cases), ['missing: "two" is in no file']);
    });
    it('names a case that is in both files', () => {
      assert.deepEqual(problemsOf(planted(file('one', 'two'), file('two')), cases), ['twice: "two" is in a.test.js and b.test.js']);
    });
    it('names a case that is in the other file', () => {
      assert.deepEqual(problemsOf(planted(file('one', 'two'), file()), cases), ['wrong file: "two" is in a.test.js, not b.test.js']);
    });
    it('names a case nobody listed', () => {
      assert.deepEqual(problemsOf(planted(file('one', 'three'), file('two')), cases), ['unlisted: "three" in a.test.js']);
    });
    it('reads a title written as a template and a title with an escaped quote', () => {
      assert.deepEqual(titlesOf("it(`a b`, () => {});\nit('the walk\\'s verdict', () => {});", 'x.js'), ['a b', "the walk's verdict"]);
    });
  });
});
