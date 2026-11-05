/**
 * In every test file, `mongoSkipReason()` is asked before the file declares its first test.
 *
 * ## The defect it prevents
 *
 * The probe (`_mongo-harness.mjs` isTestMongoUp) is a TCP connect with a 1.5 s socket timer. A file that asks it AFTER
 * an earlier `describe(` has been declared asks it while those tests run: on an event loop kept busy by them, the timer
 * fires before the connect callback, the probe answers "down" with the stack up, and under CI the file fails as
 * "needs the test MongoDB". Bundle-233's flood-backstop file did this twice behind its 3 002-request truth table.
 *
 * ## What it holds
 *
 * For every tracked test file under testing/ that calls `mongoSkipReason(` (comments stripped), the first call comes
 * before the first `describe(`, `it(` or `test(` call. Proven on planted sources: a probe after a describe is named; a
 * probe at the top passes; a file with no probe is not read.
 *
 * Run: node --test testing/standalone/the-mongo-probe-runs-before-any-test-of-its-file.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** This file plants the late form in strings for its own proof, so scanning it would name it. */
const SELF = 'testing/standalone/the-mongo-probe-runs-before-any-test-of-its-file.test.js';
const PROBE = /(?<![\w$.])mongoSkipReason\s*\(/;
const FIRST_TEST = /(?<![\w$.])(?:describe|it|test)\s*\(/;

/** Whether `source` asks the probe only after declaring a test. */
export function probesLate(source) {
  const code = stripComments(source);
  const probe = code.search(PROBE);
  if (probe < 0) return false;
  const firstTest = code.search(FIRST_TEST);
  return firstTest >= 0 && firstTest < probe;
}

describe('the Mongo probe runs before any test of its file', () => {
  it('the scanner names a late probe and passes an early one (planted)', () => {
    // The probe's name is assembled, not written: a-db-file-runs-in-a-capped-batch finds the files that open the database by
    // the call spelled out, and this file opens none.
    const probe = `${'mongoSkip'}Reason()`;
    assert.equal(probesLate(`describe('a', () => {});\ndescribe('b', { skip: await ${probe} }, () => {});`), true);
    assert.equal(probesLate(`const skip = await ${probe};\ndescribe('b', { skip }, () => {});`), false);
    assert.equal(probesLate(`describe('a', () => {}); // ${probe} in a comment\n`), false);
    assert.equal(probesLate("describe('a', () => {});"), false);
  });

  it('no tracked test file asks it after declaring a test', () => {
    const files = trackedSources(['testing'], { ext: ['.test.js', '.test.mjs'], floor: 50, untracked: true }).filter(f => f !== SELF);
    let probing = 0;
    const late = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (PROBE.test(stripComments(text))) probing++;
      if (probesLate(text)) late.push(f);
    }
    assert.ok(probing >= 10, `only ${probing} test files ask mongoSkipReason: the scan reads nothing`);
    assert.deepEqual(late, [], 'ask the Mongo probe into a `const skip` at the top of the file, before any describe: asked later it races the tests already running');
  });
});
