/**
 * Every standalone test that reads metric declarations from source reads them through `_metric-sources.mjs`, which finds every module that declares a metric.
 *
 * ## The defect this prevents
 *
 * `metrics/registry.ts` (over its size ceiling) is being split into one module per slice. About ten tests read its text for what a metric is called, what
 * its help says, which labels it has and whether it is pre-declared at zero. Each slice would otherwise hand-edit every one of them, as the first slice
 * (`sync-tombstone-metrics.ts`) did for two; the one it forgot stays green and reads the registry only, so a metric that moved out is neither required in the
 * docs nor checked for its labels. The helper reads the directory (through git), so a new module is read without an edit.
 *
 * ## What this proves
 *
 *  1. the helper's set is the set of modules that really declare a metric, derived here from every tracked server source and not from the helper's own rule;
 *  2. a metric planted in a new module is read, a module that declares none (a comment that mentions `new Counter(`) is not, and a checkout with no
 *     `registry.ts` is refused rather than read as empty;
 *  3. the docs-coverage scanner, copied into a scratch checkout with the planted module, fails and names the undocumented metric (and passes without it);
 *  4. no standalone test names `registry.ts` (or lists the declaring modules by hand) outside this test's allow file, so a new scanner written the old way fails here.
 *
 * Run: node --test testing/standalone/the-metric-scanners-see-every-module-that-declares-a-metric.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

const HELPER = './_metric-sources.mjs';
const METRICS_DIR = 'server/src/metrics';
const DECLARES = /\bnew\s+(?:Counter|Gauge|Histogram|Summary)\b/;
const PLANTED_NAME = 'ythril_planted_slice_total';
const PLANTED_SLICE = `import { Counter, type Registry } from 'prom-client';\nexport function declarePlanted(register: Registry) {\n  return new Counter({\n    name: '${PLANTED_NAME}',\n    help: 'Planted by the-metric-scanners test.',\n    registers: [register],\n  });\n}\n`;
const PLANTED_NONE = `// A slice that declares nothing, whose comment says new Counter({ name: 'ythril_not_a_metric_total' }) for a reader.\nexport const noSlice = 1;\n`;

/** A scratch repository holding the tracked metrics modules, plus whatever else `more` lists (repo-relative paths copied from this checkout). */
function scratchCheckout(more = []) {
  const repo = makeScratchRepo({ prefix: 'ythril-metric-sources-' });
  const files = [...trackedSources([METRICS_DIR], { floor: 5 }), ...more];
  for (const f of files) {
    mkdirSync(dirname(join(repo.dir, f)), { recursive: true });
    copyFileSync(join(REPO_ROOT, f), join(repo.dir, f));
  }
  repo.git('add', '-A');
  return repo;
}
const plant = (repo, rel, text) => { mkdirSync(dirname(join(repo.dir, rel)), { recursive: true }); writeFileSync(join(repo.dir, rel), text); };

describe('the helper returns the modules that declare a metric', () => {
  it('is registry.ts plus every tracked server source that constructs a metric, and no module that declares none', async () => {
    const { metricSources } = await import(HELPER);
    const real = trackedSources(['server/src'], { floor: 100, specs: false, untracked: true })
      .filter(f => DECLARES.test(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    const got = metricSources().map(s => s.file);
    assert.ok(real.includes(`${METRICS_DIR}/sync-tombstone-metrics.ts`), 'the first slice no longer declares a metric: re-point this case');
    assert.deepEqual([...got].sort(), [...new Set([...real, `${METRICS_DIR}/registry.ts`])].sort(),
      'the helper reads a module that declares nothing, or misses one that declares a metric (also outside server/src/metrics)');
    assert.equal(got[0], `${METRICS_DIR}/registry.ts`, 'registry.ts comes first');
    assert.ok(metricSources().every(s => s.text.length > 0), 'a source was read empty');
  });

  it('reads a metric planted in a new module, ignores a module that declares none, and refuses a checkout without registry.ts', async () => {
    const { metricSources, declaredMetricNames } = await import(HELPER);
    const repo = scratchCheckout();
    try {
      plant(repo, `${METRICS_DIR}/planted-slice.ts`, PLANTED_SLICE);
      plant(repo, `${METRICS_DIR}/planted-none.ts`, PLANTED_NONE);
      const files = metricSources({ root: repo.dir }).map(s => s.file);
      assert.ok(files.includes(`${METRICS_DIR}/planted-slice.ts`), `the planted module is not read: ${files.join(', ')}`);
      assert.ok(!files.includes(`${METRICS_DIR}/planted-none.ts`), 'a module that only mentions new Counter( in a comment is read as a declaring one');
      assert.ok(declaredMetricNames({ root: repo.dir }).includes(PLANTED_NAME), 'the planted metric name is not found');
      assert.ok(!declaredMetricNames({ root: repo.dir }).includes('ythril_not_a_metric_total'), 'a name inside a comment is read as declared');
      repo.git('rm', '-q', '-f', `${METRICS_DIR}/registry.ts`);
      assert.throws(() => metricSources({ root: repo.dir }), /registry\.ts/, 'a checkout without registry.ts is read as an empty registry');
    } finally { repo.cleanup(); }
  });
});

describe('the docs-coverage scanner, on a scratch checkout, sees the planted module', () => {
  /** Copies the real scanner and what it imports into `repo` and runs it there: its paths follow its own location, so it reads the scratch checkout. */
  const runCoverage = (repo) => {
    const r = spawnSync(process.execPath, ['--test', 'testing/standalone/metric-docs-coverage.test.js'], { cwd: repo.dir, env: testChildEnv(), encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const layout = () => [
    'testing/standalone/metric-docs-coverage.test.js', 'testing/standalone/_docs.mjs', 'testing/standalone/_sources.mjs',
    'testing/standalone/_strip-comments.mjs', 'testing/standalone/_metric-sources.mjs',
    ...trackedSources(['docs'], { ext: null, floor: 20 }),
  ].filter(f => { try { readFileSync(join(REPO_ROOT, f)); return true; } catch { return false; } });

  it('passes on the tracked layout and fails naming the metric once an undocumented one is planted', () => {
    const repo = scratchCheckout(layout());
    try {
      const clean = runCoverage(repo);
      assert.equal(clean.status, 0, `the copied scanner does not pass on the tracked layout, so its red below would mean nothing:\n${clean.out.slice(-1500)}`);
      plant(repo, `${METRICS_DIR}/planted-slice.ts`, PLANTED_SLICE);
      const planted = runCoverage(repo);
      assert.notEqual(planted.status, 0, 'the docs-coverage scanner did not fail on a metric declared in a new module');
      assert.ok(planted.out.includes(PLANTED_NAME), `it failed without naming the undocumented metric:\n${planted.out.slice(-1500)}`);
    } finally { repo.cleanup(); }
  });
});

describe('no standalone test reads the registry by name', () => {
  const ALLOW_FILE = new URL('./the-metric-scanners-see-every-module-that-declares-a-metric.allow.json', import.meta.url);
  const SELF = 'testing/standalone/the-metric-scanners-see-every-module-that-declares-a-metric.test.js';
  /** A path to registry.ts (any spelling a test uses) or the first slice named by hand. */
  const NAMES_THE_SOURCE = /server\/src\/metrics\/registry\.[jt]s|'metrics',\s*'registry\.[jt]s'|sync-tombstone-metrics\.ts/;
  const entries = JSON.parse(readFileSync(ALLOW_FILE, 'utf8')).entries;
  const tests = trackedSources(['testing/standalone'], { ext: ['.js', '.mjs'], floor: 200, untracked: true }).filter(f => f !== SELF);
  const naming = tests.filter(f => NAMES_THE_SOURCE.test(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));

  it('finds the tests (the scan itself works)', () => {
    assert.ok(tests.length >= 200 && tests.includes('testing/standalone/metric-docs-coverage.test.js'), `only ${tests.length} test files listed`);
  });

  it('a test that names it reads it through _metric-sources.mjs, or is in the allow file with a reason', () => {
    const allowed = new Set(entries.map(e => e.file));
    const code = (f) => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
    const offenders = naming.filter(f => !allowed.has(f)
      && (!readFileSync(join(REPO_ROOT, f), 'utf8').includes('_metric-sources.mjs') || /sync-tombstone-metrics\.ts/.test(code(f))));
    assert.deepEqual(offenders, [], 'these read registry.ts (or list the declaring modules) on their own, so a metric that moves to its own module escapes them; '
      + 'read it with metricSources() from ./_metric-sources.mjs');
  });

  it('every allow entry names a test that still reads it, with a reason and a review date not past', () => {
    for (const e of entries) {
      assert.ok(e.reason && e.reason.length > 20, `${e.file}: no reason`);
      assert.match(e.reviewBy ?? '', /^\d{4}-\d{2}-\d{2}$/, `${e.file}: no reviewBy`);
      assert.ok(e.reviewBy >= new Date().toISOString().slice(0, 10), `${e.file}: review date ${e.reviewBy} is past`);
      assert.ok(naming.includes(e.file), `${e.file}: allowed but it no longer names registry.ts`);
    }
  });
});
