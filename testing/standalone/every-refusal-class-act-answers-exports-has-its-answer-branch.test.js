/**
 * Every refusal class `files/act-answers.ts` exports has its answer branch in `fileActAnswerOf`.
 *
 * ## The defect it prevents
 *
 * `fileActAnswerOf` is the one place a thrown file-act refusal becomes a status, a `code` and a sentence, on every door. A
 * class added to the module and thrown by an act, with no `instanceof` branch beside the others, falls through to
 * `undefined`: the door then answers the generic `500` the module exists to replace, with the filesystem's or the driver's
 * own words. Nothing at the throw site says the answer is missing, and `a-file-act-answer-is-counted-by-its-code` reads
 * the `code` literals the branches spell, so a class with no branch spells none and is invisible to it as well.
 *
 * ## What it holds
 *
 * The classes are DERIVED from the module (`export class X extends Error`, comments removed) and the branches from the body
 * of `fileActAnswerOf` (`instanceof X`); the two sets must be equal, and the derivation has a floor so an empty read cannot
 * pass. A branch for a class the module no longer exports fails the same way: it answers nothing.
 *
 * What it does NOT hold, on purpose: whether a branch is reachable behind a parent class's earlier branch. No refusal class
 * extends another today, so a check for shadowing would assert about nothing; the day one does, that is its own question.
 *
 * The rule is exercised on synthetic source too, so a weakening of either read fails here.
 *
 * Run: node --test testing/standalone/every-refusal-class-act-answers-exports-has-its-answer-branch.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const ANSWERS = 'server/src/files/act-answers.ts';
/** The module has at least this many refusal classes today; a read that finds fewer has broken. */
const CLASS_FLOOR = 8;

/** The error classes a module exports, by name. */
const exportedErrorClasses = (src) =>
  [...new Set([...stripComments(src).matchAll(/^export\s+class\s+(\w+)\s+extends\s+Error\b/gm)].map(m => m[1]))].sort();

/** The classes `fileActAnswerOf` answers: every `instanceof X` in its body. */
const answeredClasses = (src) =>
  [...new Set([...bodyOf(stripComments(src), 'fileActAnswerOf', 'fileActAnswerOf').matchAll(/\binstanceof\s+(\w+)/g)].map(m => m[1]))].sort();

/** The two sets' differences, as sentences. */
function problems(src) {
  const classes = exportedErrorClasses(src);
  const answered = answeredClasses(src);
  return [
    ...classes.filter(c => !answered.includes(c)).map(c => `${c} is exported and has no branch in fileActAnswerOf`),
    ...answered.filter(c => !classes.includes(c)).map(c => `fileActAnswerOf answers ${c}, which the module does not export as a refusal class`),
  ];
}

describe('every refusal class act-answers.ts exports has its answer branch', () => {
  const src = readFileSync(ANSWERS, 'utf8');

  it('finds the classes and the branches (the reads themselves still work)', () => {
    assert.ok(exportedErrorClasses(src).length >= CLASS_FLOOR, `fewer than ${CLASS_FLOOR} exported refusal classes read from ${ANSWERS}`);
    assert.ok(answeredClasses(src).length >= CLASS_FLOOR, `fewer than ${CLASS_FLOOR} branches read from fileActAnswerOf`);
  });

  it('the exported classes and the answered classes are the same set', () => {
    assert.deepEqual(problems(src), []);
  });

  it('is exercised: a class with no branch, and a branch with no class, both fail; a class named only in a comment is not a branch', () => {
    const module = (classes, branches, comment = '') => `
export class A extends Error {}
${classes.map(c => `export class ${c} extends Error {}`).join('\n')}
export function fileActAnswerOf(err: unknown) {
  ${comment}
  if (err instanceof A) return { status: 409 };
  ${branches.map(c => `if (err instanceof ${c}) return { status: 409 };`).join('\n  ')}
  return undefined;
}
export function next() { return 1; }
`;
    assert.deepEqual(problems(module(['B'], ['B'])), []);
    assert.deepEqual(problems(module(['B'], [])), ['B is exported and has no branch in fileActAnswerOf']);
    assert.deepEqual(problems(module([], ['C'])), ['fileActAnswerOf answers C, which the module does not export as a refusal class']);
    assert.deepEqual(problems(module(['B'], [], '// if (err instanceof B) is next')), ['B is exported and has no branch in fileActAnswerOf']);
    assert.deepEqual(problems(module(['B'], ['B']).replace('export class A extends Error {}', 'class A extends Error {}')),
      ['fileActAnswerOf answers A, which the module does not export as a refusal class']);
  });
});
