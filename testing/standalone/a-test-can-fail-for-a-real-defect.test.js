/**
 * A test case must be able to fail for a real defect - not only for an edit to a constant.
 *
 * ## The failure this prevents (Q-732)
 *
 * Owner, 2026-11-10: "tests that do not really test something should be removed. Like testing a constant for it's value
 * or similar nonsense". `it('the cap is ten', () => { assert.equal(CAP, 10); })` goes red only when someone changes the
 * constant, and then the fix is to change the test: it restates the source. 61 such sites stood at d113c922.
 *
 * ## The rule
 *
 * A case whose every assertion compares a restated constant with a literal is refused (`_restated-constants.mjs` says
 * exactly what that is). A case that has one on purpose is listed in `a-test-can-fail-for-a-real-defect.allow.json` with
 * a reason of three words or more and a `reviewBy` date; an entry past its date, or one that no longer names a case this
 * rule flags, fails here, so the list cannot rot.
 *
 * The planted snippets are LITERAL: a fixture read from the code under test would assert that the code equals itself.
 *
 * Run: node --test testing/standalone/a-test-can-fail-for-a-real-defect.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restatedConstantCases } from './_restated-constants.mjs';
import { testFiles, testBodies } from './_test-bodies.mjs';
import { parseSource } from '../_shared/syntax-tree.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./a-test-can-fail-for-a-real-defect.allow.json', import.meta.url), 'utf8'));
const ENTRIES = ALLOW.entries;
const CASE_FLOOR = 800;

const flagged = (text) => restatedConstantCases({ files: [{ file: 'planted.test.js', text }] });
const wrap = (body) => `import assert from 'node:assert/strict';\nit('x', () => { ${body} });\n`;

describe('the gate recognises a case that only restates a constant', () => {
  it('flags a constant compared with a number, either way round', () => {
    assert.deepEqual(flagged(wrap('assert.equal(CAP, 10);')), [{ file: 'planted.test.js', line: 2, title: 'x' }]);
    assert.equal(flagged(wrap('assert.equal(10, CAP);')).length, 1);
    assert.equal(flagged(wrap('assert.strictEqual(mod.FORCE_LABEL, "forced");')).length, 1);
  });

  it('flags a constant\'s length, a negative number, arithmetic of literals and a literal array', () => {
    assert.equal(flagged(wrap('assert.deepEqual(mod.ALLOWED_KINDS.length, 12);')).length, 1);
    assert.equal(flagged(wrap('assert.equal(wb.CLAIM_OP_MS, 10 * 60_000);')).length, 1);
    assert.equal(flagged(wrap('assert.equal(OFFSET, -1);')).length, 1);
    assert.equal(flagged(wrap('assert.deepEqual(MODES, ["a", "b"]);')).length, 1);
    assert.equal(flagged(wrap('assert.strict.deepStrictEqual(LIMITS, { max: 5, min: null });')).length, 1);
    assert.equal(flagged(`const MIN = 60_000;\nit('x', () => { assert.equal(attempts.WINDOW_MS, 15 * MIN); });\n`).length, 1);
    assert.equal(flagged(`it('x', () => { expect(MODEL_SLOT_DEFAULT_MS.embed).toBe(5000); });\n`).length, 1);
  });

  it('flags a case of several pins and nothing else, and reports its line and title', () => {
    const text = `it('first', () => {});\n\nit('the figures', () => {\n  assert.equal(A_MAX, 5);\n  assert.equal(B_MAX, 'x');\n});\n`;
    assert.deepEqual(flagged(text), [{ file: 'planted.test.js', line: 3, title: 'the figures' }]);
  });

  it('does not flag a case that also asserts on a call\'s result', () => {
    assert.equal(flagged(wrap('assert.equal(CAP, 10); assert.equal(run(3), 4);')).length, 0);
    assert.equal(flagged(wrap('assert.equal(CAP, 10); assert.ok(run());')).length, 0);
    assert.equal(flagged(wrap('assert.equal(CAP, 10); assert.throws(() => run());')).length, 0);
  });

  it('does not flag a constant compared with a computed value', () => {
    assert.equal(flagged(wrap('assert.equal(CAP, other.length + 1);')).length, 0);
    assert.equal(flagged(wrap('assert.equal(CAP, hello.maxWriteBatchSize - 1);')).length, 0);
    assert.equal(flagged(wrap('assert.equal(CAP, readDoc("cap"));')).length, 0);
    assert.equal(flagged(wrap('assert.equal(CAP, `${base}x`);')).length, 0);
  });

  it('does not flag a capitalised name the file computes from a call', () => {
    assert.equal(flagged(`const WALKERS = SOURCES.filter(walksUp);\nit('x', () => { assert.equal(WALKERS.length, 1); });\n`).length, 0);
    assert.equal(flagged(`const RESULT = scan();\nit('x', () => { assert.deepEqual(RESULT.offenders, []); });\n`).length, 0);
    assert.equal(flagged(`const CAP = mod.CAP;\nit('x', () => { assert.equal(CAP, 10); });\n`).length, 1);
  });

  it('does not flag a quoted fixture, a comment, or a case with no assertion', () => {
    assert.equal(flagged(wrap('const src = "assert.equal(CAP, 10);"; run(src);')).length, 0);
    assert.equal(flagged(wrap('// assert.equal(CAP, 10);\nrun();')).length, 0);
    assert.equal(flagged(wrap('const x = CAP + 10; run(x);')).length, 0);
  });

  it('does not flag an assertion inside a nested function as the case\'s own', () => {
    assert.equal(flagged(wrap('assert.equal(run(), 1); const f = () => assert.equal(CAP, 10);')).length, 0);
  });
});

describe('the repository', () => {
  const files = testFiles();
  const cases = files.reduce((n, { file, text }) => n + testBodies(parseSource(file, text.replace(/\r\n/g, '\n'))).length, 0);
  const allowed = (c) => ENTRIES.some(e => e.file === c.file && e.title === c.title);
  const found = restatedConstantCases({ files });

  it(`read at least ${CASE_FLOOR} cases (read ${cases}), so an empty listing cannot pass`, () => {
    assert.ok(cases >= CASE_FLOOR, `only ${cases} cases were read from ${files.length} files`);
  });

  it('no case only restates a constant, unless the allowlist names it', () => {
    const open = found.filter(c => !allowed(c));
    assert.deepEqual(open.map(c => `${c.file}:${c.line} ${c.title}`), [],
      `${open.length} case(s) can fail only when a constant is edited. Remove each (the constant is its own record), or drive the behaviour that uses it; `
      + 'a pin kept on purpose goes in a-test-can-fail-for-a-real-defect.allow.json with a reason and a reviewBy date.');
  });
});

describe(`the allowlist (${ENTRIES.length} entries)`, () => {
  const today = new Date().toISOString().slice(0, 10);
  const files = testFiles();
  const found = restatedConstantCases({ files });
  const label = (e) => `${e.file} "${e.title}"`;

  it('every entry has a file, a title, a reason of three words or more and a reviewBy date', () => {
    const bad = ENTRIES.filter(e => !(typeof e.file === 'string' && e.file && typeof e.title === 'string' && e.title
      && typeof e.reason === 'string' && e.reason.trim().split(/\s+/).length >= 3
      && typeof e.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)
      && !Number.isNaN(Date.parse(e.reviewBy)) && new Date(e.reviewBy).toISOString().slice(0, 10) === e.reviewBy));
    assert.deepEqual(bad.map(label), [], 'each entry needs file, title, reason (3+ words) and reviewBy (YYYY-MM-DD)');
  });

  it('no entry is past its reviewBy date', () => {
    const late = ENTRIES.filter(e => typeof e.reviewBy === 'string' && e.reviewBy < today);
    assert.deepEqual(late.map(e => `${label(e)} (reviewBy ${e.reviewBy}, today ${today})`), [], 'review the entry: remove the case, or renew the date with a reason');
  });

  it('every entry still names a case this rule flags', () => {
    const gone = ENTRIES.filter(e => !found.some(c => c.file === e.file && c.title === e.title));
    assert.deepEqual(gone.map(label), [], 'the case is gone or no longer only restates a constant: delete the entry');
  });
});
