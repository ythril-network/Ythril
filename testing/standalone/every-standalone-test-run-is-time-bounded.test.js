/**
 * Every `node --test` the standalone runner starts is TIME-BOUNDED: a per-test limit on the command line and a wall-clock limit on the child
 * (`testing/_shared/test-file-bound.mjs`).
 *
 * ## Why
 *
 * A -db test that waited for a driver call the changed code no longer made ran for seven hours in the Docker runner and named nothing
 * (bundle-255, 2026-11-08). The bound turns that into a failure in minutes that names the test; this gate keeps a spawn site from dropping it.
 *
 * ## The rule, over a derived set
 *
 * The set is every child-process start in `testing/_init/run-standalone.mjs` (`spawn(`, `spawnSync(`), read from its source with comments stripped.
 * Each takes its arguments from `boundedTestArgs(` (no `'--test'` literal is left in the runner) and its time from `batchTimeoutMs(`.
 *
 * ## Seen red
 *
 * On the base (f02258f8) the runner wrote `['--test', ...]` at both sites, with no `--test-timeout` and no child time limit: the first case fails.
 *
 * Run: node --test testing/standalone/every-standalone-test-run-is-time-bounded.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_strip-comments.mjs';
import { boundedTestArgs, batchTimeoutMs, TEST_FILE_TIMEOUT_MS } from '../_shared/test-file-bound.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNNER = 'testing/_init/run-standalone.mjs';
const src = stripComments(readFileSync(resolve(ROOT, RUNNER), 'utf8'));
const count = (re) => (src.match(re) ?? []).length;

describe('every standalone test run is time-bounded', () => {
  it('fixture check: the runner starts children (the set is not empty)', () => {
    assert.ok(count(/\bspawn(Sync)?\(/g) >= 2, `${RUNNER} starts fewer than two children: the derivation found nothing to check`);
  });

  it('no `--test` in the runner is written by hand: every one comes from boundedTestArgs', () => {
    assert.equal(count(/['"`]--test['"`]/g), 0, `${RUNNER} writes a '--test' of its own, which carries no time bound: use boundedTestArgs(...)`);
  });

  it('every child the runner starts takes its arguments from boundedTestArgs and its wall-clock limit from batchTimeoutMs', () => {
    const starts = count(/\bspawn(Sync)?\(/g);
    const bounded = count(/\bspawn(Sync)?\(\s*'node',\s*boundedTestArgs\(/g);
    assert.equal(bounded, starts, `${starts} child start(s) in ${RUNNER}, ${bounded} with boundedTestArgs`);
    assert.ok(count(/\bbatchTimeoutMs\(/g) >= starts, `${RUNNER}: a child start has no wall-clock limit (batchTimeoutMs)`);
  });

  it('the bound is a finite limit on the command line, before the caller\'s flags', () => {
    assert.ok(Number.isFinite(TEST_FILE_TIMEOUT_MS) && TEST_FILE_TIMEOUT_MS > 0, `TEST_FILE_TIMEOUT_MS is ${TEST_FILE_TIMEOUT_MS}`);
    assert.deepEqual(boundedTestArgs('--x', 'a.js'), ['--test', `--test-timeout=${TEST_FILE_TIMEOUT_MS}`, '--x', 'a.js']);
    assert.equal(batchTimeoutMs(0), TEST_FILE_TIMEOUT_MS, 'an empty batch still gets one file\'s bound');
    assert.equal(batchTimeoutMs(3), 3 * TEST_FILE_TIMEOUT_MS);
  });
});
