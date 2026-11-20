/**
 * CI runs the Integration and the Sync suite each as two shard jobs, every tracked file of a suite in exactly one of its
 * shards, the files packed by their recorded seconds (bundle-356, Q-947).
 *
 * ## What it prevents
 *
 * Both suites run their files one at a time against one live stack, so they were the two jobs a run waited for (tests 640 s
 * and 520 s in the newest main run before this). Each becomes a matrix of shard jobs, each shard on its own stack, the files
 * planned by the seconds the last run recorded so the halves take about the same time. Splitting a suite is exactly where a
 * test stops running and nothing goes red:
 *
 *  - **A shard dropped from the matrix** (`[1]` of 2): half the suite runs nowhere, and every job is green.
 *  - **A file in two shards**, by a repeated matrix value or a planner that is not a partition: it runs twice, on two stacks.
 *  - **A count in the workflow that the runner does not plan** (`1/3`, `2/3`, `3/3` against a runner that cuts in two): the
 *    jobs run three thirds of nothing the runner agreed to, so coverage is luck.
 *  - **Two shards that upload under one name**, or write one results file name: the gate merges every `test-results-*`
 *    artifact into one folder, so one shard's evidence silently replaces the other's and `executed-tests` and
 *    `unexpected-skips` read half the suite as the whole of it.
 *  - **A seconds table naming a file that is gone**: a plan made from names nobody has, read as a plan.
 *  - **A recorder that no longer attributes a shard to its suite**: the time records of a suite lose half of it.
 *  - **A gate that stops waiting for the matrix job**, or reads it as anything but one job whose result is the worst shard's.
 *
 * ## How it is written
 *
 * The workflow rule is `suiteShardProblems(doc, suite, …)` over the PARSED workflow: the job is the one whose steps run
 * `test:<suite>`, its shard argument is what its test step's env says, never a literal here, the files are the runner's own
 * selection per shard (`suiteShardFiles`), and the files they must cover are read from git independently of the runner
 * (`trackedTestFiles`, every depth under the suite's folder). It runs against a conforming miniature and single breakages
 * of it first, so each rule is seen to fire where the real file is already right. The modules the change creates are loaded
 * inside the cases (`importOrFail`), so each case fails on its own rule before they exist.
 *
 * Run: node --test testing/standalone/ci-runs-every-integration-and-sync-shard-exactly-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importOrFail } from '../_shared/import-or-fail.mjs';
import {
  loadCi, parseWorkflow, jobEntries, stepsOf, shellOf, usesOf, mergeGateEntries, isTrue, skipsWhenRunIsReused, REUSE_EMPTY,
  jobRunning, stepEnv,
} from '../_shared/ci-workflow.mjs';
import { expectedResultsStems } from '../../scripts/full-run-reuse.mjs';
import { withRecordingWorld, propertiesByKey, runTimes, everything, githubRun, githubJobs, resultsArtifact, T } from '../_shared/test-times-harness.mjs';
import { REPO_ROOT, trackedTestFiles } from './_sources.mjs';

const PLANNER = 'testing/_shared/pack-by-seconds.mjs';
const RUNNER = 'testing/_init/run-suite.mjs';
const TABLE = 'testing/_shared/suite-file-seconds.json';
const SHARDED = ['integration', 'sync'];
const DIRS = { integration: 'testing/integration', sync: 'testing/sync' };

const planner = () => importOrFail(PLANNER, 'packBySeconds and assertPartition, the one packing both shard plans call');
const runner = () => importOrFail(RUNNER, 'the shard argument of the suite runner (parseShard, suiteShardFiles, suiteRunPlan)');

/** Every tracked test file under a suite's folder, at any depth, read from git and not from the runner's selection. */
const trackedOf = (suite) => trackedTestFiles({ root: REPO_ROOT }).filter((f) => f.startsWith(`${DIRS[suite]}/`));

// ───────────────────────────────────────── (a) the packing ─────────────────────────────────────────

describe('packBySeconds: longest first into the emptier shard', () => {
  it('places each file, longest first, into the shard with the fewest seconds so far, and lists each shard alphabetically', async () => {
    const { packBySeconds } = await planner();
    const seconds = { 'a.test.js': 10, 'b.test.js': 6, 'c.test.js': 5, 'd.test.js': 4, 'e.test.js': 1 };
    // a→0 (10), b→1 (6), c→1 (11), d→0 (14), e→1 (12).
    assert.deepEqual(packBySeconds(['e.test.js', 'd.test.js', 'c.test.js', 'b.test.js', 'a.test.js'], 2, seconds), [
      ['a.test.js', 'd.test.js'],
      ['b.test.js', 'c.test.js', 'e.test.js'],
    ]);
  });

  it('takes a file with no recorded time at the median of the table, not at nothing', async () => {
    const { packBySeconds } = await planner();
    // Median 9: x weighs 9, so a→0 (10), b→1 (9), x→1 (18), c→0 (11). At 0 it would be a→0, b→1, c→1, x→0.
    const seconds = { 'a.test.js': 10, 'b.test.js': 9, 'c.test.js': 1 };
    assert.deepEqual(packBySeconds(['a.test.js', 'b.test.js', 'c.test.js', 'x.test.js'], 2, seconds), [
      ['a.test.js', 'c.test.js'],
      ['b.test.js', 'x.test.js'],
    ]);
  });

  it('refuses a count that leaves a shard empty, and assertPartition refuses a file missing, repeated or in two shards', async () => {
    const { packBySeconds, assertPartition } = await planner();
    assert.throws(() => packBySeconds(['only.test.js'], 2, {}), /hold no file/);
    assert.throws(() => assertPartition(['a', 'b'], [['a'], ['a', 'b']], 'plan'), /plan: .*not a partition/);
    assert.throws(() => assertPartition(['a', 'b'], [['a'], []], 'plan'), /not a partition|hold no file/);
    assert.throws(() => assertPartition(['a', 'b', 'c'], [['a'], ['b']], 'plan'), /not a partition/);
    assert.doesNotThrow(() => assertPartition(['a', 'b'], [['b'], ['a']], 'plan'));
  });
});

// ───────────────────────────────────────── (b) the seconds table ─────────────────────────────────────────

/** Every way the table is wrong, as sentences: an entry naming no tracked file of a sharded suite, a value that is not seconds. */
function tableProblems(table, tracked) {
  const seconds = table?.seconds;
  if (!seconds || typeof seconds !== 'object') return ['the table has no `seconds` map'];
  const v = [];
  for (const [file, s] of Object.entries(seconds)) {
    if (!tracked.has(file)) v.push(`${file} is in the table and is not a tracked test file of ${SHARDED.join(' or ')}`);
    if (!(typeof s === 'number' && Number.isFinite(s) && s > 0)) v.push(`${file}: ${JSON.stringify(s)} is not a positive number of seconds`);
  }
  return v;
}

describe('the committed seconds table of the two suites', () => {
  const tracked = new Set(SHARDED.flatMap(trackedOf));

  it('exists, names only tracked files of the two suites, each with positive seconds, and times most of each suite', () => {
    assert.ok(existsSync(join(REPO_ROOT, TABLE)), `${TABLE} is not there: the shards have no recorded seconds to be planned by`);
    const table = JSON.parse(readFileSync(join(REPO_ROOT, TABLE), 'utf8'));
    assert.deepEqual(tableProblems(table, tracked), []);
    for (const suite of SHARDED) {
      const files = trackedOf(suite);
      const timed = files.filter((f) => f in table.seconds).length;
      assert.ok(timed * 2 > files.length, `${suite}: only ${timed} of ${files.length} files have a recorded time; the plan would be the median's`);
    }
  });

  it('the check refuses a planted entry whose file does not exist', () => {
    const [some] = [...tracked];
    assert.ok(some, 'no tracked file of the two suites found');
    const planted = { seconds: { [some]: 3, [some.replace(/\.test\.js$/, '-gone.test.js')]: 4 } };
    assert.match(tableProblems(planted, tracked).join('\n'), /-gone\.test\.js is in the table and is not a tracked test file/);
  });
});

// ───────────────────────────────────────── (c) the runner's shard argument ─────────────────────────────────────────

describe('run-suite takes a shard <k>/<n> and runs only that shard', () => {
  it('reads <k>/<n>, 1-based, and refuses anything else rather than running everything or nothing', async () => {
    const { parseShard } = await runner();
    assert.deepEqual(parseShard('1/2'), { index: 1, count: 2 });
    assert.deepEqual(parseShard('2/2'), { index: 2, count: 2 });
    for (const bad of ['0/2', '3/2', '1/0', 'a/2', '1.5/2', '', '1', '1/2/3', '-1/2', ' /2']) {
      assert.throws(() => parseShard(bad), /shard/, `${JSON.stringify(bad)} was accepted`);
    }
  });

  for (const suite of SHARDED) {
    it(`${suite}: the shards together are every tracked file once, each alphabetical; a count the runner does not plan is refused`, async () => {
      const { suiteShardFiles, SUITES } = await runner();
      const n = SUITES[suite].shards;
      assert.ok(Number.isInteger(n) && n >= 2, `${suite} declares ${n} shard(s)`);
      const shards = Array.from({ length: n }, (_, i) => suiteShardFiles(suite, { index: i + 1, count: n }));
      const all = shards.flat();
      assert.deepEqual([...all].sort(), trackedOf(suite));
      assert.equal(new Set(all).size, all.length, 'a file is in two shards');
      for (const s of shards) {
        assert.ok(s.length > 0, 'an empty shard');
        assert.deepEqual(s, [...s].sort(), 'a shard is not in alphabetical order');
      }
      assert.throws(() => suiteShardFiles(suite, { index: 1, count: n + 1 }), /shard/);
    });
  }

  it('a shard\'s run plan runs its files only, writes a results file no other shard and no whole run writes, and is the whole suite without a shard', async () => {
    const { suiteRunPlan, suiteShardFiles, selectSuiteFiles } = await runner();
    const dir = mkdtempSync(join(tmpdir(), 'suite-shard-plan-'));
    try {
      const one = suiteRunPlan('integration', [], { index: 1, count: 2 }, { dir });
      const two = suiteRunPlan('integration', [], { index: 2, count: 2 }, { dir });
      const whole = suiteRunPlan('integration', [], null, { dir });
      assert.deepEqual(one.files, suiteShardFiles('integration', { index: 1, count: 2 }));
      assert.deepEqual(two.files, suiteShardFiles('integration', { index: 2, count: 2 }));
      assert.deepEqual(whole.files, selectSuiteFiles('integration').files);
      const destinations = [one, two, whole].map((p) => p.flags.destination);
      assert.equal(new Set(destinations).size, 3, `results files collide: ${destinations.join(', ')}`);
      for (const p of [one, two, whole]) assert.equal(p.scope, 'full', 'a shard and a whole run each cover what they were given');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ───────────────────────────────────────── (d)(e)(f) the workflow ─────────────────────────────────────────

/** `test-results-*-<attempt>` artifact patterns as a RegExp, the attempt taken as the literal 1. */
function artifactPatternOf(pattern) {
  const literal = String(pattern).replace(/\$\{\{\s*(?:github\.run_attempt|steps\.[\w-]+\.outputs\.attempt)\s*\}\}/g, '1');
  assert.ok(!/\$\{\{/.test(literal), `the artifact pattern ${pattern} holds an expression this rule cannot read`);
  return new RegExp(`^${literal.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/**
 * What a suite job's test step says about its shard: the env var its `--shard=` reads, that var's `${{ matrix.<axis> }}/<n>`,
 * and the matrix's values for that axis. A string when the job does not say it that way.
 */
function shardOfJob(id, job, script) {
  const step = stepsOf(job).find((s) => shellOf(s).includes(script));
  const arg = /--shard="?\$\{?(\w+)\}?"?/.exec(shellOf(step) ?? '');
  if (!arg) return `${id}: its test step does not pass --shard="$<VAR>" (${JSON.stringify(shellOf(step))})`;
  const value = String(stepEnv(job, step, arg[1]) ?? '');
  const m = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}\/(\d+)$/.exec(value.trim());
  if (!m) return `${id}: ${arg[1]} is ${JSON.stringify(value)}, not \${{ matrix.<axis> }}/<count>`;
  const values = job.strategy?.matrix?.[m[1]];
  if (!Array.isArray(values)) return `${id}: no matrix over ${m[1]}: strategy.matrix is ${JSON.stringify(job.strategy?.matrix)}`;
  return { axis: m[1], count: Number(m[2]), values: values.map(Number) };
}

/**
 * Every way `doc` fails to run `suite` as shards that cover `tracked` once each, as sentences. `shardFiles(k, n)` is the runner's
 * selection, `declared` the count the runner plans.
 */
function suiteShardProblems(doc, suite, { shardFiles, declared, tracked }) {
  const script = `test:${suite}`;
  const { id, job } = jobRunning(doc, script);
  const shard = shardOfJob(id, job, script);
  if (typeof shard === 'string') return [shard];
  const problems = [];
  if (isTrue(job.strategy['fail-fast']) || job.strategy['fail-fast'] === undefined) problems.push(`${id}: fail-fast is not false, so the first red shard cancels the other`);
  const { count, values, axis } = shard;
  if (count !== declared) problems.push(`${id}: the workflow cuts ${suite} in ${count} and the runner plans ${declared}, so the jobs run shards the runner never made`);
  const expected = Array.from({ length: count }, (_, i) => i + 1);
  const missing = expected.filter((k) => !values.includes(k));
  const repeated = values.filter((v, i) => values.indexOf(v) !== i);
  const outside = values.filter((v) => !expected.includes(v));
  if (missing.length) problems.push(`${id}: no job runs shard(s) ${missing.join(', ')} of ${count}, so their files run nowhere`);
  if (repeated.length) problems.push(`${id}: shard(s) ${[...new Set(repeated)].join(', ')} appear twice in the matrix, so their files run twice`);
  if (outside.length) problems.push(`${id}: matrix value(s) ${outside.join(', ')} are not a shard from 1 to ${count}`);
  if (count === declared) {
    const ran = values.filter((k) => expected.includes(k)).flatMap((k) => shardFiles(k, count));
    const notRun = tracked.filter((f) => !ran.includes(f));
    const twice = ran.filter((f, i) => ran.indexOf(f) !== i);
    if (notRun.length) problems.push(`${id}: ${notRun.length} of ${tracked.length} ${suite} file(s) are in no job's shard, first ${notRun[0]}`);
    if (twice.length) problems.push(`${id}: ${new Set(twice).size} ${suite} file(s) run in more than one job, first ${twice[0]}`);
  }
  const uploads = stepsOf(job).filter((s) => usesOf(s)?.action === 'actions/upload-artifact');
  if (uploads.length === 0) problems.push(`${id}: uploads no artifact`);
  for (const u of uploads) {
    if (!String(u.with?.name ?? '').includes(`matrix.${axis}`)) problems.push(`${id}: upload "${u.name}" is named ${JSON.stringify(u.with?.name)}, which does not carry matrix.${axis}, so the shards upload under one name`);
  }
  return problems;
}

/** The artifact names a suite's matrix job uploads, one per shard, attempt 1. */
function artifactNames(doc, suite) {
  const script = `test:${suite}`;
  const { id, job } = jobRunning(doc, script);
  const shard = shardOfJob(id, job, script);
  if (typeof shard === 'string') throw new Error(shard);
  return stepsOf(job).filter((s) => usesOf(s)?.action === 'actions/upload-artifact').flatMap((u) => shard.values.map((v) => String(u.with.name)
    .replace(/\$\{\{\s*matrix\.[\w-]+\s*\}\}/g, String(v)).replace(/\$\{\{\s*github\.run_attempt\s*\}\}/g, '1')));
}

/** The conforming miniature: one suite job, a two-way matrix, fail-fast off, the shard through env, an upload named by it. */
const MINI = (over = {}) => `
on: push
jobs:
  integration:
    name: Integration
    runs-on: ubuntu-latest
    strategy:
      fail-fast: ${over.failFast ?? 'false'}
      matrix:
        shard: ${over.matrix ?? '[1, 2]'}
    steps:
      - name: Run integration tests
        run: npm run test:integration -- --shard="$SUITE_SHARD"
        env:
          SUITE_SHARD: \${{ matrix.shard }}/${over.count ?? '2'}
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ${over.artifact ?? 'test-results-integration-${{ matrix.shard }}-${{ github.run_attempt }}'}
          path: test-results/
`;
/** A fixed four-file suite and an honest planner over it, so a breakage is the one thing that differs. */
const FILES = ['testing/integration/a.test.js', 'testing/integration/b.test.js', 'testing/integration/c.test.js', 'testing/integration/d.test.js'];
const HONEST = (k, n) => FILES.filter((_, i) => i % n === k - 1);
const miniProblems = (over = {}, shardFiles = HONEST) => suiteShardProblems(parseWorkflow(MINI(over)), 'integration', { shardFiles, declared: 2, tracked: FILES }).join('\n');

describe('the rule, run against a miniature and single breakages of it', () => {
  it('holds for the conforming shape', () => assert.equal(miniProblems(), ''));
  it('fires on a shard dropped from the matrix', () => assert.match(miniProblems({ matrix: '[1]' }), /no job runs shard\(s\) 2 of 2[\s\S]*2 of 4 integration file\(s\) are in no job's shard/));
  it('fires on a repeated shard', () => assert.match(miniProblems({ matrix: '[1, 1, 2]' }), /appear twice[\s\S]*run in more than one job/));
  it('fires on a planted planner that puts one file in both shards', () => {
    assert.match(miniProblems({}, (k, n) => [...HONEST(k, n), ...(k === 2 ? [FILES[0]] : [])]), /1 integration file\(s\) run in more than one job, first testing\/integration\/a\.test\.js/);
  });
  it('fires on a planted planner that leaves a file out', () => {
    assert.match(miniProblems({}, (k, n) => HONEST(k, n).filter((f) => f !== FILES[3])), /1 of 4 integration file\(s\) are in no job's shard, first testing\/integration\/d\.test\.js/);
  });
  it('fires when the workflow\'s count and the runner\'s differ', () => assert.match(miniProblems({ count: '3', matrix: '[1, 2, 3]' }), /cuts integration in 3 and the runner plans 2/));
  it('fires on a shard value past the count', () => assert.match(miniProblems({ matrix: '[1, 3]' }), /not a shard from 1 to 2/));
  it('fires on fail-fast left on', () => assert.match(miniProblems({ failFast: 'true' }), /fail-fast/));
  it('fires on an upload name without the shard', () => assert.match(miniProblems({ artifact: 'test-results-integration-${{ github.run_attempt }}' }), /does not carry matrix\.shard/));
  it('fires on a job with no shard argument', () => {
    const doc = parseWorkflow('on: push\njobs:\n  integration:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:integration\n');
    assert.match(suiteShardProblems(doc, 'integration', { shardFiles: HONEST, declared: 2, tracked: FILES }).join('\n'), /does not pass --shard/);
  });
});

describe('ci.yml runs every shard of Integration and Sync, once each', () => {
  const ci = loadCi();

  for (const suite of SHARDED) {
    it(`${suite}: a matrix over the runner's shards, every tracked file once, fail-fast off, one upload name per shard`, async () => {
      const { suiteShardFiles, SUITES } = await runner();
      const tracked = trackedOf(suite);
      assert.ok(tracked.length >= 20, `only ${tracked.length} tracked ${suite} file(s) found`);
      assert.deepEqual(suiteShardProblems(ci, suite, {
        shardFiles: (index, count) => suiteShardFiles(suite, { index, count }), declared: SUITES[suite].shards, tracked,
      }), []);
    });

    it(`${suite}: the shards' artifact names differ and each is one the gate's and the advisory job's download selects`, () => {
      const names = artifactNames(ci, suite);
      assert.ok(names.length >= 2, `${names.length} artifact name(s) derived`);
      assert.equal(new Set(names).size, names.length, `artifact names collide: ${names.join(', ')}`);
      const patterns = jobEntries(ci).flatMap(({ job }) => stepsOf(job)).filter((s) => usesOf(s)?.action === 'actions/download-artifact' && s.with?.pattern).map((s) => s.with.pattern);
      assert.ok(patterns.length >= 2, `${patterns.length} download-artifact step(s) with a pattern found; the gate and the advisory job each have one`);
      for (const name of names) for (const p of patterns) assert.ok(artifactPatternOf(p).test(name), `${name} is not selected by ${p}`);
    });

    it(`${suite}: the merge gate waits for the matrix job, reads its result, and the job stands down as ONE job beside a reused run`, () => {
      const { id, job } = jobRunning(ci, `test:${suite}`);
      const gates = mergeGateEntries(ci);
      assert.equal(gates.length, 1);
      assert.ok([].concat(gates[0].job.needs).includes(id), `Build & Test does not need ${id}`);
      assert.ok(stepsOf(gates[0].job).map((s) => shellOf(s)).join('\n').includes(`needs.${id}.result`), `Build & Test does not read needs.${id}.result`);
      assert.ok(skipsWhenRunIsReused(job), `${id} does not stand down on a reused run: it must wait for \`reuse\` and carry \`if: !cancelled() && ${REUSE_EMPTY}\``);
      assert.ok(job.strategy?.matrix, `${id} is not a matrix job`);
      const advisory = jobEntries(ci).find((j) => isTrue(j.job['continue-on-error']));
      assert.ok(advisory && [].concat(advisory.job.needs).includes(id), `the advisory job does not wait for ${id}`);
    });
  }
});

// ───────────────────────────────────────── the recorder ─────────────────────────────────────────

describe('the recorder attributes every shard of a suite to that suite', () => {
  it('records one (job, suite) per shard stem ci.yml uploads, each under its suite', async () => {
    const stems = expectedResultsStems(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
    const shardStems = SHARDED.map((suite) => [suite, stems.filter((s) => s === suite || s.startsWith(`${suite}-`))]);
    for (const [suite, own] of shardStems) assert.ok(own.length >= 2, `${suite}: ci.yml uploads ${own.length} results stem(s) (${own.join(', ')}), not one per shard`);
    const artifacts = shardStems.flatMap(([suite, own], si) => own.map((stem, i) => resultsArtifact(7000 + si * 10 + i, `test-results-${stem}-1`,
      [`${suite}-${i + 1}of${own.length}.jsonl`, { suite, batch: `${i + 1}of${own.length}`, files: [{ file: `${DIRS[suite]}/f${i}.test.js`, ms: 3000, tests: [T('one', 3000)] }] }])));
    const world = { runs: [githubRun(4001)], jobsByRun: { 4001: githubJobs('integration', 'sync', 'test') }, artifactsByRun: { 4001: artifacts } };
    await withRecordingWorld(world, async ({ ythril, dir, env }) => {
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      const expected = shardStems.flatMap(([suite, own]) => own.map((stem) => `ci:4001:1:${stem}:${suite}`)).sort();
      assert.deepEqual(Object.keys(propertiesByKey(ythril)).sort(), expected);
    });
  });
});
