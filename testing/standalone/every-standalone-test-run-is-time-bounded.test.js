/**
 * Every `node --test` the standalone runner AND preflight's pure stage start is TIME-BOUNDED: a per-test limit on the command line and a
 * wall-clock limit on the child (`testing/_shared/test-file-bound.mjs`).
 *
 * ## Why
 *
 * A -db test that waited for a driver call the changed code no longer made ran for seven hours in the Docker runner and named nothing
 * (bundle-255, 2026-11-08). The bound turns that into a failure in minutes that names the test; this gate keeps a spawn site from dropping it.
 * Preflight's pure batches had no bound at all (`execFileSync('node', ['--test', ...])`): a file that hangs after its tests would hold
 * the whole preflight for ever. They now run through `runTestUnits` (`testing/_shared/run-test-units.mjs`, extracted from the runner's
 * `runShardUnits`), which holds the bound, so the bound is in one place and a caller cannot start a unit without it (Q-863).
 *
 * ## The rule, over a derived set
 *
 * The set is `testing/_init/run-standalone.mjs`, the unit runner `testing/_shared/run-test-units.mjs`, and every file under `scripts/`,
 * `testing/_init/` and `testing/_shared/` that calls `runTestUnits(` (derived from the tracked tree, so a new caller is covered without editing
 * this file); preflight is one, and the cases name it so the derivation cannot lose it unseen. Read with comments stripped:
 *
 * - no `'--test'` is written by hand in any of them: every one comes from `boundedTestArgs`;
 * - every child the unit runner and the runner start with `boundedTestArgs(` gets its wall-clock limit from `batchTimeoutMs(`;
 * - the unit runner is where the units are started (a `spawn` of `node` with `boundedTestArgs`), and the runner's -db shards and
 *   preflight's pure stage reach it through `runTestUnits(`, never a start of their own.
 *
 * ## Seen red
 *
 * On the base (f02258f8) the runner wrote `['--test', ...]` at both sites, with no `--test-timeout` and no child time limit: the first case fails.
 * On d113c9e6 (this change's base) preflight writes `execFileSync('node', ['--test', ...r.args, ...])` by hand, `run-test-units.mjs` does not exist and
 * the runner's -db shards still start their own children: the cases over those three fail.
 *
 * Run: node --test testing/standalone/every-standalone-test-run-is-time-bounded.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { boundedTestArgs, batchTimeoutMs, TEST_FILE_TIMEOUT_MS } from '../_shared/test-file-bound.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNNER = 'testing/_init/run-standalone.mjs';
const UNITS = 'testing/_shared/run-test-units.mjs';
const PREFLIGHT = 'scripts/preflight.mjs';
const BOUND_MODULE = 'testing/_shared/test-file-bound.mjs';

const read = (file) => (existsSync(resolve(ROOT, file)) ? stripComments(readFileSync(resolve(ROOT, file), 'utf8')) : null);
const countIn = (src, re) => (src.match(re) ?? []).length;

/** Every start of a unit or a batch: `spawn('node', boundedTestArgs(` and the sync and file forms of it. */
const BOUNDED_START = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*'node',\s*boundedTestArgs\(/g;
const ANY_START = /\bspawn(?:Sync)?\(/g;
const HAND_WRITTEN = /['"`]--test['"`]/g;
const CALLS_UNITS = /\brunTestUnits\(/g;

/** Every way `src` (comments stripped) starts a test run without the bound, as messages. Empty means the rule holds for it. */
function unboundedStarts(file, src) {
  const out = [];
  const written = countIn(src, HAND_WRITTEN);
  if (written > 0) out.push(`${file} writes a '--test' of its own ${written} time(s), which carries no time bound: use boundedTestArgs(...), or runTestUnits(...)`);
  const bounded = countIn(src, BOUNDED_START);
  const named = countIn(src, /\bboundedTestArgs\(/g);
  if (named > bounded) out.push(`${file}: ${named} use(s) of boundedTestArgs but ${bounded} child start(s) built from it directly (spawn('node', boundedTestArgs(...)))`);
  if (bounded > 0 && countIn(src, /\bbatchTimeoutMs\(/g) < bounded) {
    out.push(`${file}: ${bounded} bounded child start(s) and fewer uses of batchTimeoutMs: a child has no wall-clock limit`);
  }
  return out;
}

/** The callers of `runTestUnits(`, derived from the tracked tree. */
const callers = () => trackedSources(['scripts', 'testing/_init', 'testing/_shared'], { ext: ['.mjs', '.js'], floor: 10 })
  .filter((f) => f !== UNITS && countIn(read(f) ?? '', CALLS_UNITS) > 0);

describe('every standalone test run is time-bounded', () => {
  it('fixture check: the runner starts children (the set is not empty)', () => {
    const src = read(RUNNER);
    assert.ok(src, `${RUNNER} is missing`);
    assert.ok(countIn(src, ANY_START) >= 1, `${RUNNER} starts no child itself: the derivation found nothing to check`);
  });

  it('no `--test` in the runner is written by hand: every one comes from boundedTestArgs', () => {
    assert.equal(countIn(read(RUNNER), HAND_WRITTEN), 0, `${RUNNER} writes a '--test' of its own, which carries no time bound: use boundedTestArgs(...)`);
  });

  it('every batch the runner starts itself takes its arguments from boundedTestArgs and its wall-clock limit from batchTimeoutMs', () => {
    const src = read(RUNNER);
    const starts = countIn(src, ANY_START);
    assert.deepEqual(unboundedStarts(RUNNER, src), []);
    assert.equal(countIn(src, BOUNDED_START), starts, `${starts} child start(s) in ${RUNNER}, ${countIn(src, BOUNDED_START)} with boundedTestArgs`);
    assert.ok(countIn(src, /\bbatchTimeoutMs\(/g) >= starts, `${RUNNER}: a child start has no wall-clock limit (batchTimeoutMs)`);
  });

  it('the unit runner starts every unit as `node` with boundedTestArgs and a batchTimeoutMs limit, never through a shell', () => {
    const src = read(UNITS);
    assert.ok(src, `${UNITS} does not exist: the units have no bounded runner`);
    assert.ok(countIn(src, BOUNDED_START) >= 1, `${UNITS} starts no child with boundedTestArgs`);
    assert.deepEqual(unboundedStarts(UNITS, src), []);
    assert.ok(countIn(src, /\bbatchTimeoutMs\(/g) >= 1, `${UNITS}: no unit has a wall-clock limit (batchTimeoutMs)`);
    assert.equal(countIn(src, /\bshell\s*:\s*true|\bexec(?:Sync)?\(/g), 0, `${UNITS} starts a unit through a shell`);
  });

  it('the runner\'s -db shards run their units through runTestUnits, with no children of their own beside the single batch', () => {
    const src = read(RUNNER);
    assert.ok(countIn(src, CALLS_UNITS) >= 1, `${RUNNER} does not call runTestUnits: the -db shards still run their own pool, a second copy of the bound`);
    assert.equal(countIn(src, /\bspawn\(/g), 0, `${RUNNER} still starts an async child of its own (spawn(...)): that is the pool runTestUnits replaced`);
  });

  it('preflight\'s pure units run through runTestUnits: no `--test` of its own, no child start of its own for a batch', () => {
    const found = callers();
    assert.ok(found.includes(PREFLIGHT), `${PREFLIGHT} does not call runTestUnits (callers found: ${found.join(', ') || 'none'}): its pure batches start unbounded children`);
    const src = read(PREFLIGHT);
    assert.deepEqual(unboundedStarts(PREFLIGHT, src), []);
    assert.equal(countIn(src, /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*'node',\s*\[\s*['"`]--test/g), 0,
      `${PREFLIGHT} starts a node --test batch by hand: no pool, no time bound`);
  });

  it('every caller of runTestUnits (derived from the tree) is clean of a hand-written `--test`', () => {
    for (const file of callers()) assert.deepEqual(unboundedStarts(file, read(file)), [], file);
  });

  it('the bound is a finite limit on the command line, before the caller\'s flags', () => {
    assert.ok(Number.isFinite(TEST_FILE_TIMEOUT_MS) && TEST_FILE_TIMEOUT_MS > 0, `TEST_FILE_TIMEOUT_MS is ${TEST_FILE_TIMEOUT_MS}`);
    assert.deepEqual(boundedTestArgs('--x', 'a.js'), ['--test', `--test-timeout=${TEST_FILE_TIMEOUT_MS}`, '--x', 'a.js']);
    assert.equal(batchTimeoutMs(0), TEST_FILE_TIMEOUT_MS, 'an empty batch still gets one file\'s bound');
    assert.equal(batchTimeoutMs(3), 3 * TEST_FILE_TIMEOUT_MS);
  });

  describe('the rule over planted sources (a copy of the real text with the bound taken out)', () => {
    it('a hand-written --test in the unit runner, or in preflight, is named', () => {
      for (const file of [UNITS, PREFLIGHT]) {
        const src = read(file);
        assert.ok(src, `${file} is missing: nothing to plant a defect in`);
        const planted = src.replace(/\bboundedTestArgs\(/, "['--test', ").concat("\nexecFileSync('node', ['--test', 'x.js']);\n");
        assert.ok(unboundedStarts(file, planted).length > 0, `a hand-written '--test' in ${file} left the rule green`);
      }
    });

    it('a unit start without its wall-clock limit is named', () => {
      const src = read(UNITS);
      assert.ok(src, `${UNITS} is missing: nothing to plant a defect in`);
      const planted = src.replaceAll('batchTimeoutMs(', 'Math.max(');
      assert.notEqual(planted, src, 'the unit runner never calls batchTimeoutMs');
      assert.ok(unboundedStarts(UNITS, planted).length > 0, 'a unit start with no batchTimeoutMs left the rule green');
    });

    it('a start built from boundedTestArgs through a variable, away from its spawn, is named', () => {
      const planted = "const args = boundedTestArgs('--x');\nspawn('node', args);\n";
      assert.ok(unboundedStarts('planted', planted).length > 0, 'boundedTestArgs used away from the spawn left the rule green');
    });
  });
});
