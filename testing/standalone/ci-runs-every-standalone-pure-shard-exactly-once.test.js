/**
 * CI runs the pure standalone files (the ones that need no service, the text-only files apart) as `PURE_SHARDS` shard jobs, every pure file in
 * exactly one shard, the files packed by their recorded seconds; the text-only files still run once, first, in the first shard only
 * (bundle-356, Q-947).
 *
 * ## What it prevents
 *
 * Once Integration and Sync were split, the job with no services was the one a run waited for: it ended 805 s into Full run
 * 44706741831 while every other job ended by 569 s, nine `node --test` batches one after another (545 s of tests in main run
 * 44694257707). It becomes a matrix of two jobs. A file that silently runs in neither is the failure nobody would see:
 *
 *  - **A shard dropped from the matrix, repeated, or past the count**, or a planner that is not a partition: half the pure files
 *    run nowhere, or twice, and every job is green.
 *  - **A count the workflow says and the runner does not plan.**
 *  - **The text-only step run in both cells.** It needs no install and runs first; a matrix runs every step in every cell unless
 *    the step is pinned to one, so without the pin each text-only file runs twice.
 *  - **Two shards writing one results file or uploading under one name.** The gate merges every `test-results-*` artifact into one
 *    folder, so one shard's evidence would replace the other's and `executed-tests` would read half the files as all of them.
 *  - **A seconds table naming a file that is gone.**
 *  - **A runner that, given a wrong shard, runs everything or nothing** (`3/2`, `1/3`, a shard of the text or db kind).
 *  - **A recorder that loses the pure job**: both shards must be recorded under the standalone suite, and the file-times snapshot
 *    the preflight orders its slowest pure files by must read both shards' records, not only the job name the unsplit job had.
 *
 * ## How it is written
 *
 * The workflow rule is `shardJobProblems` of `_ci-shard-matrix.mjs`, the one copy the Integration and Sync gate calls too. The
 * files the shards must cover are read from git (`trackedTestFiles`, the top level of `testing/standalone`) less the files of the
 * three other kinds, and the shards are the runner's own selection (`pureShardFiles`): a planner that drops or repeats a file
 * leaves the two apart. The functions the change creates are asked for inside the cases, so each case fails on its own rule first.
 *
 * Run: node --test testing/standalone/ci-runs-every-standalone-pure-shard-exactly-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as splitModule from '../_shared/standalone-split.mjs';
import { textOnlyFiles } from '../_shared/text-only-test.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { loadCi, parseWorkflow, jobRunning, stepsOf, shellOf, expressionOf } from '../_shared/ci-workflow.mjs';
import { shardJobProblems, artifactNames, artifactPatternOf, downloadPatterns, matrixJobGateProblems, secondsTableProblems } from './_ci-shard-matrix.mjs';
import { expectedResultsStems } from '../../scripts/full-run-reuse.mjs';
import { withRecordingWorld, propertiesByKey, runTimes, everything, githubRun, githubJobs, resultsArtifact, T } from '../_shared/test-times-harness.mjs';
import { REPO_ROOT, trackedTestFiles } from './_sources.mjs';

const PURE_SCRIPT = 'test:standalone:pure';
const TABLE = 'testing/_shared/pure-file-seconds.json';
const RUNNER = 'testing/_init/run-standalone.mjs';
const path = (f) => `testing/standalone/${f}`;

/** The functions the change adds to the split, asked for inside a case so a base without them fails that case by name. */
function pureShardApi() {
  const { pureShardFiles, PURE_SHARDS, pureShardKind } = splitModule;
  assert.equal(typeof pureShardFiles, 'function', 'standalone-split.mjs exports no pureShardFiles: the pure kind has no shard plan');
  assert.ok(Number.isInteger(PURE_SHARDS) && PURE_SHARDS >= 2, `standalone-split.mjs declares PURE_SHARDS ${PURE_SHARDS}, not a count of two or more`);
  assert.equal(typeof pureShardKind, 'function', 'standalone-split.mjs exports no pureShardKind: two shards would write one results file name');
  return { pureShardFiles, PURE_SHARDS, pureShardKind };
}

let kindsMemo;
/**
 * The pure files, read from git: every tracked top-level standalone test file less the database, instance and text-only ones, and
 * those three kinds, so a case can say the four together are every tracked file.
 */
function kinds() {
  if (kindsMemo) return kindsMemo;
  const split = splitModule.splitStandalone({ root: REPO_ROOT });
  const tracked = trackedTestFiles({ root: REPO_ROOT, dirs: ['testing/standalone'] })
    .filter((f) => f.endsWith('.test.js') && !f.slice('testing/standalone/'.length).includes('/'));
  const db = new Set(split.offlineDb.map(path));
  const instance = new Set(split.needsInstance.map(path));
  const text = new Set(textOnlyFiles(split, { root: REPO_ROOT }));
  const pure = tracked.filter((f) => !db.has(f) && !instance.has(f) && !text.has(f));
  kindsMemo = { split, tracked, db, instance, text, pure };
  return kindsMemo;
}

const shardsOf = () => {
  const { pureShardFiles, PURE_SHARDS } = pureShardApi();
  return Array.from({ length: PURE_SHARDS }, (_, i) => pureShardFiles(kinds().pure, { index: i + 1, count: PURE_SHARDS }));
};

// ───────────────────────────────────────── (a) the runner's pure shards ─────────────────────────────────────────

describe('the pure kind cut into shards', () => {
  it('the shards together are every pure file read from git, once each, every shard non-empty and alphabetical', () => {
    const { pure, tracked, db, instance, text } = kinds();
    assert.ok(pure.length >= 500, `only ${pure.length} pure file(s) found`);
    assert.equal(pure.length + db.size + instance.size + text.size, tracked.length, 'the four kinds are not every tracked standalone file once');
    const shards = shardsOf();
    const all = shards.flat();
    assert.equal(new Set(all).size, all.length, 'a pure file is in two shards');
    assert.deepEqual([...all].sort(), pure, 'the shards are not the pure files');
    for (const s of shards) {
      assert.ok(s.length > 0, 'an empty shard');
      assert.deepEqual(s, [...s].sort(), 'a shard is not in alphabetical order');
    }
  });

  it('refuses a count the runner does not plan and an index outside it, rather than running everything or nothing', () => {
    const { pureShardFiles, PURE_SHARDS } = pureShardApi();
    const { pure } = kinds();
    assert.throws(() => pureShardFiles(pure, { index: 1, count: PURE_SHARDS + 1 }), /shard/);
    assert.throws(() => pureShardFiles(pure, { index: 0, count: PURE_SHARDS }), /shard/);
    assert.throws(() => pureShardFiles(pure, { index: PURE_SHARDS + 1, count: PURE_SHARDS }), /shard/);
  });

  it('the plan runs one shard\'s pure files with a shard, every pure file without one, and the text kind the same either way', () => {
    const { PURE_SHARDS } = pureShardApi();
    const { split } = kinds();
    const filesOf = (runs, kind) => runs.filter((r) => r.kind === kind).flatMap((r) => r.files);
    const whole = splitModule.offlineRuns(split, { kinds: ['text', 'pure'] });
    const shards = shardsOf();
    for (let k = 1; k <= PURE_SHARDS; k++) {
      const one = splitModule.offlineRuns(split, { kinds: ['text', 'pure'], pureShard: { index: k, count: PURE_SHARDS } });
      assert.deepEqual(filesOf(one, 'pure'), shards[k - 1], `shard ${k}: the plan's pure batches are not the shard's files`);
      assert.deepEqual(filesOf(one, 'text'), filesOf(whole, 'text'), `shard ${k}: the plan changed the text kind`);
    }
    assert.deepEqual([...filesOf(whole, 'pure')].sort(), kinds().pure, 'without a shard the plan does not run every pure file');
  });

  it('each shard writes results files of its own name, apart from the other shard and from a whole run', () => {
    const { pureShardKind, PURE_SHARDS } = pureShardApi();
    const names = Array.from({ length: PURE_SHARDS }, (_, i) => pureShardKind({ index: i + 1, count: PURE_SHARDS }));
    assert.equal(new Set([...names, 'pure']).size, names.length + 1, `results names collide: ${names.join(', ')}`);
    for (const n of names) assert.match(n, /^pure-[\w.-]+$/, `${n}: a shard's results are not named as the pure kind's`);
  });

  it('the runner refuses a wrong shard argument before it runs or clears anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-shard-refusal-'));
    try {
      for (const args of [['--only=pure', '--shard=3/2'], ['--only=pure', '--shard=1/4'], ['--only=pure', '--shard=abc'],
        ['--only=text', '--shard=1/2'], ['--only=db', '--shard=1/2'], ['--shard=1/2'], ['--only=pure', '--shard=1/2', '--shard=2/2']]) {
        const r = spawnSync(process.execPath, [RUNNER, ...args, '--allow-stale'], {
          cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: testChildEnv({ YTHRIL_TEST_RESULTS_DIR: dir }),
        });
        const out = `${r.stdout}\n${r.stderr}`;
        assert.notEqual(r.status, 0, `${args.join(' ')} was accepted:\n${out.slice(0, 600)}`);
        assert.match(r.stderr, /shard/, `${args.join(' ')} failed without naming the shard:\n${out.slice(0, 600)}`);
        assert.doesNotMatch(out, /^(ok|not ok) \d+/m, `${args.join(' ')} ran tests before refusing`);
      }
      assert.deepEqual(readdirSync(dir), [], 'a refused run wrote results');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ───────────────────────────────────────── (b) the seconds table ─────────────────────────────────────────

describe('the committed seconds table of the pure files', () => {
  it('exists, names only tracked pure files, each with positive seconds at or above its floor, and carries the median of every recorded file below it', () => {
    assert.ok(existsSync(join(REPO_ROOT, TABLE)), `${TABLE} is not there: the pure shards have no recorded seconds to be planned by`);
    const table = JSON.parse(readFileSync(join(REPO_ROOT, TABLE), 'utf8'));
    const pure = new Set(kinds().pure);
    assert.deepEqual(secondsTableProblems(table, pure, 'the pure kind'), []);
    // Most pure files take a fifth of a second, so the table lists the files at or above its floor and says what an unlisted one weighs.
    assert.ok(table.floor > 0 && table.median > 0 && table.median < table.floor, `floor ${table.floor} and median ${table.median}: an unlisted file must weigh less than every listed one`);
    const under = Object.entries(table.seconds).filter(([, s]) => s < table.floor);
    assert.deepEqual(under, [], 'a listed file is under the table\'s floor');
    const timed = kinds().pure.filter((f) => f in table.seconds).length;
    assert.ok(timed >= 100, `only ${timed} of ${pure.size} pure files have a recorded time`);
    assert.ok(splitModule.PURE_FILE_SECONDS_PATH?.replace(/\\/g, '/').endsWith(TABLE), `the split reads its seconds from ${splitModule.PURE_FILE_SECONDS_PATH}, not ${TABLE}`);
    assert.equal(splitModule.loadPureFileSeconds().median, table.median, 'the split does not read the median the table carries');
  });

  it('a file the table does not list is planned at the table\'s median, not at the median of the listed files', async () => {
    const { packBySeconds } = await import('../_shared/pack-by-seconds.mjs');
    // Listed 10 and 9 (their median 9.5). Unlisted x, y at the table's 0.5: a→0 (10), b→1 (9), x→1 (9.5), y→1 (10).
    // At the listed files' 9.5 each they would be packed first: a→0 (10), x→1 (9.5), y→1 (19), b→0 (19).
    const seconds = { 'a.test.js': 10, 'b.test.js': 9 };
    assert.deepEqual(packBySeconds(['a.test.js', 'b.test.js', 'x.test.js', 'y.test.js'], 2, seconds, { unnamed: 0.5 }), [['a.test.js'], ['b.test.js', 'x.test.js', 'y.test.js']]);
    assert.deepEqual(packBySeconds(['a.test.js', 'b.test.js', 'x.test.js', 'y.test.js'], 2, seconds), [['a.test.js', 'b.test.js'], ['x.test.js', 'y.test.js']]);
  });

  it('the check refuses a planted entry whose file does not exist', () => {
    const [some] = kinds().pure;
    const planted = { seconds: { [some]: 3, [some.replace(/\.test\.js$/, '-gone.test.js')]: 4 } };
    assert.match(secondsTableProblems(planted, new Set(kinds().pure), 'the pure kind').join('\n'), /-gone\.test\.js is in the table and is not a tracked test file/);
  });
});

// ───────────────────────────────────────── (c)(d)(e) the workflow ─────────────────────────────────────────

/** The steps of the pure job that run the text kind (directly: the step that runs it needs no install). */
const textSteps = (job) => stepsOf(job).filter((s) => /run-standalone\.mjs\s+--only=text\b/.test(shellOf(s)));

/**
 * Every way the pure matrix job fails to run the text kind exactly once, in its first cell, as sentences: one text step, and its
 * `if` names the job's matrix axis equal to its first value.
 */
function textStepProblems(doc) {
  const { id, job } = jobRunning(doc, PURE_SCRIPT);
  const steps = textSteps(job);
  if (steps.length !== 1) return [`${id}: ${steps.length} step(s) run the text kind, not one`];
  const axes = Object.entries(job.strategy?.matrix ?? {}).filter(([, v]) => Array.isArray(v));
  if (axes.length === 0) return [];
  const condition = steps[0].if == null ? '' : expressionOf(steps[0].if);
  const pinned = axes.some(([axis, values]) => new RegExp(`^matrix\\.${axis}\\s*==\\s*'?${values[0]}'?$`).test(condition.trim()));
  return pinned ? [] : [`${id}: the text step runs in every cell of the matrix (its if is ${JSON.stringify(condition)}), so each text-only file runs ${axes[0][1].length} times`];
}

const MINI = (over = {}) => `
on: push
jobs:
  standalone-pure:
    name: Standalone (no services)
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: ${over.matrix ?? '[1, 2]'}
    steps:
      - name: Text
${over.textIf === undefined ? "        if: matrix.shard == 1\n" : over.textIf}        run: node testing/_init/run-standalone.mjs --only=text
      - name: Pure
        run: npm run test:standalone:pure -- --shard="$PURE_SHARD"
        env:
          PURE_SHARD: \${{ matrix.shard }}/${over.count ?? '2'}
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-standalone-pure-\${{ matrix.shard }}-\${{ github.run_attempt }}
          path: test-results/
`;
const FILES = ['testing/standalone/a.test.js', 'testing/standalone/b.test.js', 'testing/standalone/c.test.js'];
const HONEST = (k, n) => FILES.filter((_, i) => i % n === k - 1);
const miniDoc = (over) => parseWorkflow(MINI(over));
const miniProblems = (over = {}, shardFiles = HONEST) => [
  ...shardJobProblems(miniDoc(over), PURE_SCRIPT, { shardFiles, declared: 2, tracked: FILES, what: 'pure' }), ...textStepProblems(miniDoc(over)),
].join('\n');

describe('the rule, run against a miniature of the pure job and single breakages of it', () => {
  it('holds for the conforming shape', () => assert.equal(miniProblems(), ''));
  it('fires on a dropped shard', () => assert.match(miniProblems({ matrix: '[1]' }), /no job runs shard\(s\) 2 of 2[\s\S]*1 of 3 pure file\(s\) are in no job's shard/));
  it('fires on a repeated shard', () => assert.match(miniProblems({ matrix: '[1, 2, 2]' }), /appear twice[\s\S]*run in more than one job/));
  it('fires on a planted file in two shards', () => assert.match(miniProblems({}, (k, n) => [...HONEST(k, n), ...(k === 2 ? [FILES[0]] : [])]), /1 pure file\(s\) run in more than one job, first testing\/standalone\/a\.test\.js/));
  it('fires on a planted file in no shard', () => assert.match(miniProblems({}, (k, n) => HONEST(k, n).filter((f) => f !== FILES[2])), /1 of 3 pure file\(s\) are in no job's shard, first testing\/standalone\/c\.test\.js/));
  it('fires on a count the workflow and the runner disagree on', () => assert.match(miniProblems({ count: '3', matrix: '[1, 2, 3]' }), /cuts pure in 3 and the runner plans 2/));
  it('fires on a text step that runs in every cell', () => assert.match(miniProblems({ textIf: '' }), /text step runs in every cell[\s\S]*runs 2 times/));
  it('fires on a text step pinned to a cell that is not the first', () => assert.match(miniProblems({ textIf: '        if: matrix.shard == 2\n' }), /text step runs in every cell/));
});

describe('ci.yml runs every pure shard once, and the text-only files once', () => {
  const ci = loadCi();

  it('a matrix over the runner\'s shards, every pure file in exactly one, fail-fast off, one upload name per shard', () => {
    const { pureShardFiles, PURE_SHARDS } = pureShardApi();
    const { pure } = kinds();
    assert.deepEqual(shardJobProblems(ci, PURE_SCRIPT, {
      shardFiles: (index, count) => pureShardFiles(pure, { index, count }), declared: PURE_SHARDS, tracked: pure, what: 'pure',
    }), []);
  });

  it('the text-only step runs in the first shard only', () => assert.deepEqual(textStepProblems(ci), []));

  it('the shards\' artifact names differ, keep the pure job\'s name, and each is one the gate\'s and the advisory job\'s download selects', () => {
    const names = artifactNames(ci, PURE_SCRIPT);
    assert.ok(names.length >= 2, `${names.length} artifact name(s) derived`);
    assert.equal(new Set(names).size, names.length, `artifact names collide: ${names.join(', ')}`);
    const { id } = jobRunning(ci, PURE_SCRIPT);
    for (const name of names) assert.ok(name.startsWith(`test-results-${id}-`), `${name} does not carry the job id ${id}`);
    const patterns = downloadPatterns(ci);
    assert.ok(patterns.length >= 2, `${patterns.length} download-artifact step(s) with a pattern found`);
    for (const name of names) for (const p of patterns) assert.ok(artifactPatternOf(p).test(name), `${name} is not selected by ${p}`);
  });

  it('the merge gate waits for the matrix job, reads its result, and the job stands down as ONE job beside a reused run', () => {
    assert.deepEqual(matrixJobGateProblems(ci, PURE_SCRIPT), []);
  });
});

// ───────────────────────────────────────── the recorder ─────────────────────────────────────────

describe('the recorder attributes both pure shards to the standalone suite', () => {
  it('records one (job, suite) per pure shard stem ci.yml uploads, each under the standalone suite', async () => {
    const { id } = jobRunning(loadCi(), PURE_SCRIPT);
    const own = expectedResultsStems(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')).filter((s) => s.startsWith(`${id}-`));
    assert.ok(own.length >= 2, `ci.yml uploads ${own.length} pure results stem(s) (${own.join(', ')}), not one per shard`);
    const artifacts = own.map((stem, i) => resultsArtifact(7100 + i, `test-results-${stem}-1`,
      [`standalone-pure-${i + 1}of${own.length}-1.jsonl`, { suite: 'standalone', batch: `pure-${i + 1}of${own.length}-1`, files: [{ file: `testing/standalone/f${i}.test.js`, ms: 3000, tests: [T('one', 3000)] }] }]));
    const world = { runs: [githubRun(4101)], jobsByRun: { 4101: githubJobs(id, 'test') }, artifactsByRun: { 4101: artifacts } };
    await withRecordingWorld(world, async ({ ythril, dir, env }) => {
      const r = await runTimes(['--record-ci'], { cwd: dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(Object.keys(propertiesByKey(ythril)).sort(), own.map((stem) => `ci:4101:1:${stem}:standalone`).sort());
    });
  });
});
