/**
 * A test that asserts "this took less than ..." states the ceiling as a rule, never as a bound plus a literal margin.
 *
 * ## What happened
 *
 * A database test asserted that a walk over three stalled spaces took less than three bounds plus three seconds. On a
 * database job where the heavy files run beside each other the walk took 6616 ms, the assertion failed, and the main
 * branch's run was red on a change that had touched no product file. The three seconds were a guess at the overhead of a
 * quiet machine.
 *
 * ## The rule
 *
 * A ceiling on elapsed time exists to tell the right behaviour from one defect: the code waited for something it should
 * have cut short. So the ceiling is written from that defect's own duration (the stall the test planted, the budget the
 * code would have spent), with the constant that names it. Then the margin is as wide as the test's own fixture allows,
 * and a loaded runner cannot fail it without the defect. A literal number of milliseconds added to a bound names nothing:
 * it is a guess about the machine, and it is refused here.
 *
 * Text only: it reads the tracked test files and runs nothing.
 *
 * Run: node --test testing/standalone/a-time-ceiling-in-a-test-is-a-rule-never-a-literal-margin.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedTestFiles } from './_sources.mjs';

const SELF = 'a-time-ceiling-in-a-test-is-a-rule-never-a-literal-margin.test.js';

/** An elapsed-time assertion whose ceiling ends in a plus sign and a literal of three or more digits. */
const literalMargin = () => /assert\.ok\(\s*[^,\n]*(?:Date\.now\(\)\s*-\s*\w+|\b\w*(?:took|elapsed)\w*)\s*<=?\s*[^,\n]*\+\s*\d[\d_]{2,}\s*,/;

/** The lines of a source that assert an elapsed time under a bound plus a literal margin. */
function literalMargins(source) {
  return String(source).split(/\r?\n/).map((line, i) => ({ line: i + 1, text: line.trim() })).filter((l) => literalMargin().test(l.text));
}

describe('a time ceiling in a test is a rule, never a literal margin', () => {
  it('the rule finds a bound plus a literal, and leaves a ceiling written from a named duration alone', () => {
    const ok = 'assert' + '.ok(';
    assert.equal(literalMargins(`${ok}Date.now() - started < 3 * BOUND_MS + 3000, 'too slow');`).length, 1);
    assert.equal(literalMargins(`${ok}tookMs <= BOUND_MS + 1_500, 'x');`).length, 1);
    assert.equal(literalMargins(`${ok}tookMs < STALL_MS - 500, 'x');`).length, 0, 'a ceiling under the planted stall is the rule itself');
    assert.equal(literalMargins(`${ok}Date.now() - started < 2 * BOUND_MS + STALL_MS, 'x');`).length, 0, 'a named duration is no literal');
    assert.equal(literalMargins(`${ok}count < limit + 100, 'x');`).length, 0, 'not an elapsed time');
  });

  it('no tracked test file asserts an elapsed time under a bound plus a literal margin', () => {
    const found = [];
    for (const file of trackedTestFiles()) {
      if (file.endsWith(SELF)) continue;
      for (const hit of literalMargins(readFileSync(join(REPO_ROOT, file), 'utf8'))) found.push(`${file}:${hit.line} ${hit.text}`);
    }
    assert.deepEqual(found, [], 'write each ceiling from the duration of the defect it tells apart (the planted stall, the budget), with its constant');
  });
});
