/**
 * The shared reading of a split test, `testing/_shared/split-cases-held-once.mjs`, names every case of the split that no file holds, that two
 * files hold, that the wrong file holds or that a file holds a different number of times, and every case nobody listed (bundle-356, Q-937).
 *
 * ## What this prevents
 *
 * A test cut into several files so they run side by side is held only while every case stays in exactly one of them: a case dropped in the
 * move is a rule nobody checks, and a case in two files is a minute run twice whose copies drift apart. Each file stays green either way.
 * Every split had its own hand-written gate for it; this is the one reading they share, proven here on planted files, so a split gate only
 * declares its files and cases.
 *
 * Run: node --test testing/standalone/a-split-test-holds-each-case-in-exactly-one-file.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitCaseProblems, itTitles, assertSplitCasesHeldOnce } from '../_shared/split-cases-held-once.mjs';

const file = (...titles) => titles.map(t => `it('${t}', () => {});`).join('\n');
const planted = (a, b) => [{ file: 'a.test.js', text: a }, { file: 'b.test.js', text: b }];
const split = { 'a.test.js': ['one', 'one'], 'b.test.js': ['two'] };

describe('a split test holds each case in exactly one file', () => {
  it('reads a split that holds every case where it belongs, as often as listed, as no problem', () => {
    assert.deepEqual(splitCaseProblems(planted(file('one', 'one'), file('two')), split), []);
  });

  it('names a case that no file holds', () => {
    assert.deepEqual(splitCaseProblems(planted(file('one', 'one'), file()), split), ['missing: "two" is in no file']);
  });

  it('names a case that two files hold', () => {
    assert.deepEqual(splitCaseProblems(planted(file('one', 'one', 'two'), file('two')), split), ['twice: "two" is in a.test.js and b.test.js']);
  });

  it('names a case that only the other file holds', () => {
    assert.deepEqual(splitCaseProblems(planted(file('one', 'one', 'two'), file()), split), ['wrong file: "two" is in a.test.js, not b.test.js']);
  });

  it('names a case its file declares more or fewer times than the split lists', () => {
    assert.deepEqual(splitCaseProblems(planted(file('one'), file('two')), split), ['count: "one" is declared 1 time(s) in a.test.js, the split lists it 2']);
    assert.deepEqual(splitCaseProblems(planted(file('one', 'one', 'one'), file('two')), split), ['count: "one" is declared 3 time(s) in a.test.js, the split lists it 2']);
  });

  it('names a case nobody listed', () => {
    assert.deepEqual(splitCaseProblems(planted(file('one', 'one', 'three'), file('two')), split), ['unlisted: "three" in a.test.js']);
  });

  it('names a file of the split that is gone, and every case it held', () => {
    assert.deepEqual(splitCaseProblems([{ file: 'a.test.js', text: file('one', 'one') }], split),
      ['file gone: b.test.js is not among the files read', 'missing: "two" is in no file']);
  });

  it('refuses a split that lists one case under two files', () => {
    assert.throws(() => splitCaseProblems(planted(file('one'), file('one')), { 'a.test.js': ['one'], 'b.test.js': ['one'] }), /lists "one" under a\.test\.js and b\.test\.js/);
  });

  it('reads literal titles, and refuses a title it cannot read rather than leaving that case out', () => {
    assert.deepEqual(itTitles("it(`a b`, () => {});\nit('the walk\\'s verdict', () => {});\ndescribe('d', () => { it(\"inner\", () => {}); });", 'x.js'),
      ['a b', "the walk's verdict", 'inner']);
    assert.throws(() => itTitles('for (const l of ls) it(`a reader ${l}`, () => {});', 'x.js'), /x\.js:1 .*cannot be read/);
  });

  it('fails the gate on the repository when a file of the split is not tracked', () => {
    assert.throws(() => assertSplitCasesHeldOnce({
      'testing/standalone/a-split-test-holds-each-case-in-exactly-one-file.test.js': ['reads a split that holds every case where it belongs, as often as listed, as no problem'],
      'testing/standalone/no-such-split-half.test.js': ['x'],
    }), /file gone: testing\/standalone\/no-such-split-half\.test\.js/);
  });
});
