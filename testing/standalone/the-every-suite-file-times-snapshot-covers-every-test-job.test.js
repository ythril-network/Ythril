/**
 * The slow-file check names every test file over the time budget, and it reads one snapshot of per-file times. That snapshot was the
 * pure job's alone (`test-results/file-times.json`), so the database, instance, integration, sync, red-team and client files were never
 * named, and they are 14 of the 15 slowest. `--preflight-costs` and the drain also write `test-results/file-times-all.json`: per test file
 * of EVERY test job, the median of its time over the newest five trusted full runs of main (Q-923).
 *
 * ## The defect this refuses
 *
 * - **A snapshot that reads as "no slow files".** Built from the records that happen to be there, a snapshot missing a whole job (a shard
 *   whose records are not on the instance yet, the client's) would answer "nothing slow" for every file of that job. The builder THROWS
 *   for no row at all and for any job of the workflow with no file: a snapshot is whole across the jobs or it is not written.
 * - **A job list that rots.** The jobs are the results stems `ci.yml` uploads (`expectedResultsStems`), read when the snapshot is made,
 *   so a shard or a job added to the workflow is required of the snapshot the day it is written.
 * - **A record that is not CI's own run of main.** A laptop's run, a branch, a files-only or subset run, a job the workflow does not have
 *   contributes nothing, whatever the server was asked: the predicate is asked of the server and checked again here.
 * - **A moved file counted twice, or an old shard's times kept.** The key is the path. A file that changed shard is one key; a run
 *   recorded twice (a rerun's attempts) counts once; only the newest five runs that hold a file set its time.
 * - **The pure snapshot changing.** `file-times.json` is what it was: the pure job's files, and nothing another job holds.
 *
 * ## What it asserts
 *
 * - `allSuiteFileTimes(runs, { jobs })` (`scripts/_shared/all-suite-file-times.mjs`), a pure function over planted rows: every job's files
 *   present; the median over the runs that hold a file (the mean of the middle two for an even count); one key for a file of two shards;
 *   untrusted rows (source, branch, scope, job) and unusable files (a `__proto__` key, a time that is no count) contribute nothing; the
 *   newest five runs of a file only; a rerun's attempts once; no row, no trusted row, no file, or a job without a file THROWS.
 * - `node scripts/test-times.mjs --preflight-costs` writes `file-times.json` (the pure job, as before) and `file-times-all.json`, asking the
 *   server once per job of `ci.yml`; with a job unrecorded it writes the pure one only, says one every-suite line naming the job, writes the
 *   stage costs and exits 0. `--drain-unrecorded` writes it when it is missing or over a day old. Local fake instance only.
 *
 * Run: node --test testing/standalone/the-every-suite-file-times-snapshot-covers-every-test-job.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { makeWorkdir, runTimes, everything, ciRunDay, seedCiTestRun } from '../_shared/test-times-harness.mjs';
import { expectedResultsStems } from '../../scripts/full-run-reuse.mjs';

const url = (p) => pathToFileURL(join(REPO_ROOT, p)).href;
/** Imported inside each case, so a base without the module fails each case by name and not the whole file at load. */
const builder = async () => {
  const mod = await import(url('scripts/_shared/all-suite-file-times.mjs'));
  assert.equal(typeof mod.allSuiteFileTimes, 'function', 'scripts/_shared/all-suite-file-times.mjs must export allSuiteFileTimes');
  return mod.allSuiteFileTimes;
};

const DAY = 86_400_000;
const at = (ms) => new Date(ms).toISOString();
const ALL = 'file-times-all.json';
const PURE = 'file-times.json';
const JOBS_OF_CI = expectedResultsStems(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));

// ---- the builder, over planted rows ----------------------------------------------------------------------------------

/** One recorded job of one run, as the builder is handed it: its identity, the run's start and the job's per-file times. */
const row = (job, n, files, over = {}) => ({ job, source: 'ci', branch: 'main', scope: 'full', runId: String(n), startsAt: ciRunDay(n), files, ...over });

describe('allSuiteFileTimes: one snapshot of every job\'s files', () => {
  const JOBS = ['pure', 'db-0', 'db-1', 'client'];
  const P = 'testing/standalone/pure-one.test.js';
  const D0 = 'testing/standalone/db-zero-db.test.js';
  const D1 = 'testing/standalone/db-one-db.test.js';
  const C = 'client/src/app/one.spec.ts';
  /** Every job present once, so a case about another rule is not refused for a missing job. */
  const everyJob = (n = 1) => [row('pure', n, { [P]: 100 }), row('db-0', n, { [D0]: 200 }), row('db-1', n, { [D1]: 300 }), row('client', n, { [C]: 400 })];

  it('holds every job\'s files, each as one key, in the shape of the pure snapshot', async () => {
    const allSuiteFileTimes = await builder();
    const snap = allSuiteFileTimes(everyJob(), { jobs: JOBS });
    assert.deepEqual(snap.files, { [P]: 100, [D0]: 200, [D1]: 300, [C]: 400 });
    assert.equal(snap.runs, 1);
    assert.equal(snap.newestSourceAt, ciRunDay(1));
    assert.deepEqual(Object.keys(snap), ['newestSourceAt', 'runs', 'files'], 'the shape drifted from {newestSourceAt, runs, files}, which the snapshot writer completes with generatedAt');
  });

  it('is the median over the runs that hold a file: the middle one for an odd count, the mean of the middle two for an even count', async () => {
    const allSuiteFileTimes = await builder();
    const runs = [row('db-1', 1, { [D1]: 1 }), row('client', 1, { [C]: 1 })];
    for (let n = 1; n <= 5; n++) runs.push(row('pure', n, { [P]: n * 100 }));
    for (let n = 1; n <= 4; n++) runs.push(row('db-0', n, { [D0]: n * 1000 }));
    const snap = allSuiteFileTimes(runs, { jobs: JOBS });
    assert.equal(snap.files[P], 300, 'five runs: 100 200 300 400 500');
    assert.equal(snap.files[D0], 2500, 'four runs: 1000 2000 3000 4000');
    assert.equal(snap.runs, 5);
    assert.equal(snap.newestSourceAt, ciRunDay(5));
  });

  it('a file whose shard changed between runs is one key, its time the median of the runs of both shards', async () => {
    const allSuiteFileTimes = await builder();
    const moved = 'testing/standalone/moved-db.test.js';
    const runs = [row('pure', 1, { [P]: 1 }), row('client', 1, { [C]: 1 })];
    for (const n of [1, 2, 3]) runs.push(row('db-0', n, { [moved]: n * 10 }));
    for (const n of [4, 5]) runs.push(row('db-1', n, { [moved]: n * 10 }));
    const snap = allSuiteFileTimes(runs, { jobs: JOBS });
    assert.equal(Object.keys(snap.files).filter(f => f === moved).length, 1);
    assert.equal(snap.files[moved], 30, 'the five runs on two shards: 10 20 30 40 50');
  });

  it('only the newest five runs that hold a file set its time: an older sixth does not', async () => {
    const allSuiteFileTimes = await builder();
    const runs = everyJob(1);
    runs.push(row('pure', 0, { [P]: 9_000_000 }));
    for (let n = 2; n <= 6; n++) runs.push(row('pure', n, { [P]: n * 100 }));
    const snap = allSuiteFileTimes(runs, { jobs: JOBS });
    assert.equal(snap.files[P], 400, 'the five newest are runs 2..6: 200 300 400 500 600');
  });

  it('a run recorded twice (a rerun\'s two attempts) counts once, the newer attempt\'s time', async () => {
    const allSuiteFileTimes = await builder();
    const runs = everyJob(1).filter(r => r.job !== 'pure');
    runs.push(row('pure', 7, { [P]: 100 }, { startsAt: at(Date.parse(ciRunDay(7)) + 3_600_000) }));
    runs.push(row('pure', 7, { [P]: 5000 }, { startsAt: ciRunDay(7) }));
    runs.push(row('pure', 6, { [P]: 300 }));
    const snap = allSuiteFileTimes(runs, { jobs: JOBS });
    assert.equal(snap.files[P], 200, 'two runs, 100 (the newer attempt of run 7) and 300; the older attempt\'s 5000 was counted');
    assert.equal(snap.runs, 3, 'runs 1 (the other jobs\'), 6 and 7 are the runs the times rest on');
  });

  it('a row that is not CI\'s run of main in full, or not of a job asked for, contributes nothing', async () => {
    const allSuiteFileTimes = await builder();
    const poison = { 'testing/standalone/poison.test.js': 8_000_000 };
    const runs = [
      ...everyJob(1),
      row('pure', 6, poison, { branch: 'feature/x' }),
      row('pure', 7, poison, { scope: 'files' }),
      row('pure', 8, poison, { scope: 'subset' }),
      row('pure', 9, poison, { source: 'local' }),
      row('some-other-job', 10, poison),
      row('pure', 11, poison, { source: undefined }),
    ];
    const snap = allSuiteFileTimes(runs, { jobs: JOBS });
    assert.deepEqual(Object.keys(snap.files).sort(), [C, D0, D1, P].sort(), 'a file of an untrusted row is in the snapshot');
    assert.equal(snap.runs, 1);
    assert.equal(snap.files[P], 100);
    assert.equal(snap.newestSourceAt, ciRunDay(1));
  });

  it('a time that is no count and a file named __proto__ are left out; the file\'s other runs still count', async () => {
    const allSuiteFileTimes = await builder();
    const files = JSON.parse(`{"__proto__": 5, "${P}": 100, "testing/standalone/bad-a.test.js": "300", "testing/standalone/bad-b.test.js": -1, "testing/standalone/bad-c.test.js": null}`);
    const runs = [row('pure', 1, files), row('db-0', 1, { [D0]: 2 }), row('db-1', 1, { [D1]: 3 }), row('client', 1, { [C]: 4 })];
    const snap = allSuiteFileTimes(runs, { jobs: JOBS });
    assert.deepEqual(Object.keys(snap.files).sort(), [C, D0, D1, P].sort());
    assert.equal(({}).polluted, undefined);
  });

  it('THROWS rather than answer from nothing: no row, no trusted row, rows holding no file', async () => {
    const allSuiteFileTimes = await builder();
    assert.throws(() => allSuiteFileTimes([], { jobs: JOBS }), /no .*row|no recorded/i);
    assert.throws(() => allSuiteFileTimes(everyJob().map(r => ({ ...r, branch: 'feature/x' })), { jobs: JOBS }), /no .*trusted|no recorded/i);
    assert.throws(() => allSuiteFileTimes(everyJob().map(r => ({ ...r, files: {} })), { jobs: JOBS }), /no .*file|no recorded/i);
    assert.throws(() => allSuiteFileTimes(everyJob().map(r => ({ ...r, files: null })), { jobs: JOBS }), /no .*file|no recorded/i);
  });

  it('THROWS, naming the job, when any job of the workflow holds no file: a snapshot missing a job reads as "no slow files" there', async () => {
    const allSuiteFileTimes = await builder();
    for (const missing of JOBS) {
      const runs = everyJob().filter(r => r.job !== missing);
      assert.throws(() => allSuiteFileTimes(runs, { jobs: JOBS }), (err) => err.message.includes(missing), `${missing} has no row and the snapshot was made`);
    }
    const emptyShard = everyJob().map(r => (r.job === 'db-1' ? { ...r, files: {} } : r));
    assert.throws(() => allSuiteFileTimes(emptyShard, { jobs: JOBS }), (err) => err.message.includes('db-1'), 'a shard whose record holds no file was counted as covered');
  });

  it('is handed a list of jobs: with none it throws instead of covering nothing', async () => {
    const allSuiteFileTimes = await builder();
    assert.throws(() => allSuiteFileTimes(everyJob(), { jobs: [] }));
    assert.throws(() => allSuiteFileTimes(everyJob(), {}));
  });
});

// ---- the writer, through the script ------------------------------------------------------------------------------------

describe('test-times writes file-times-all.json beside file-times.json (a fake instance, a scratch repository)', () => {
  const suiteOf = (job) => (job === 'client-tests' ? 'client' : job.startsWith('standalone') ? 'standalone' : job);
  const fileOf = (job, which) => `testing/${suiteOf(job)}/${job}-${which}.test.js`;
  /** Five runs of one job: its file `a` in all five (100..500, scaled by `scale`), its file `b` in four (the fifth lacks it). */
  const seedJob = (server, job, scale = 1) => {
    for (let n = 1; n <= 5; n++) {
      const rows = [[fileOf(job, 'a'), n * 100 * scale]];
      if (n !== 5) rows.push([fileOf(job, 'b'), n * 1000 * scale]);
      seedCiTestRun(server, { n, job, suite: suiteOf(job), rows });
    }
  };
  const seedEveryJob = (server, except = []) => JOBS_OF_CI.forEach((job, i) => { if (!except.includes(job)) seedJob(server, job, i + 1); });
  const seedPreflightRun = (server) => {
    const startsAt = '2026-11-16T10:01:00.000Z';
    return server.seed({
      type: 'Preflight-Run', title: 'preflight run', startsAt, endsAt: startsAt,
      properties: { recordKey: `local:h:${startsAt}:preflight`, formatVersion: 1, source: 'local', mode: 'full', commit: 'a'.repeat(40), branch: 'main', dirty: false, host: 'h', outcome: 'passed', wallMs: 1000, stageCount: 1, stages: JSON.stringify([{ name: 'alpha', kind: 'source', ms: 1000, outcome: 'passed' }]), runner: 'container' },
    });
  };
  const readJson = (dir, name) => JSON.parse(readFileSync(join(dir, 'test-results', name), 'utf8'));
  const resultsOf = (dir) => (existsSync(join(dir, 'test-results')) ? readdirSync(join(dir, 'test-results')).sort() : []);
  const withInstance = async (fn) => {
    const server = await startFakeYthril();
    const work = makeWorkdir();
    try { return await fn({ server, work, env: { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token, RUNNER_HEAD: 'planted-head' } }); } finally { await server.close(); work.cleanup(); }
  };
  const testRunFilters = (server) => server.callsTo('filter').filter(c => JSON.stringify(c.args.filter ?? {}).includes('Test-Run'));
  const aboutEverySuite = (r) => everything(r).split(/\r?\n/).filter(l => /every-suite/i.test(l));

  /** The ci.yml jobs are the ones this test seeds: a workflow with no db shard would make the cases below vacuous. */
  it('the jobs of ci.yml include the pure job, the client\'s and every db shard (the cases below mean what they say)', () => {
    assert.ok(JOBS_OF_CI.includes('standalone-pure') && JOBS_OF_CI.includes('client-tests'), JOBS_OF_CI.join(' '));
    assert.ok(JOBS_OF_CI.filter(j => /^standalone-db-\d+$/.test(j)).length >= 2, JOBS_OF_CI.join(' '));
    assert.ok(JOBS_OF_CI.length >= 6, JOBS_OF_CI.join(' '));
  });

  it('--preflight-costs writes both: file-times-all.json from every job of ci.yml, file-times.json from the pure job only, byte for byte as before', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      seedEveryJob(server);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(resultsOf(work.dir), [ALL, PURE, 'stage-costs.json'], 'the write left a temporary file, or lacks a snapshot');

      const pureIndex = JOBS_OF_CI.indexOf('standalone-pure');
      const scale = pureIndex + 1;
      const pure = readJson(work.dir, PURE);
      assert.deepEqual(Object.keys(pure), ['generatedAt', 'newestSourceAt', 'runs', 'files'], 'the pure snapshot changed its shape');
      assert.equal(pure.runs, 5);
      assert.equal(pure.newestSourceAt, ciRunDay(5));
      assert.deepEqual(pure.files, { [fileOf('standalone-pure', 'a')]: 300 * scale, [fileOf('standalone-pure', 'b')]: 2500 * scale }, 'the pure snapshot holds another job\'s file, or lost its own');

      const all = readJson(work.dir, ALL);
      assert.deepEqual(Object.keys(all), ['generatedAt', 'newestSourceAt', 'runs', 'files'], 'the every-suite snapshot is not in the shape of file-times.json');
      assert.equal(all.runs, 5);
      assert.equal(all.newestSourceAt, ciRunDay(5));
      assert.ok(Math.abs(Date.parse(all.generatedAt) - Date.now()) < 120_000, all.generatedAt);
      const expected = {};
      JOBS_OF_CI.forEach((job, i) => { expected[fileOf(job, 'a')] = 300 * (i + 1); expected[fileOf(job, 'b')] = 2500 * (i + 1); });
      assert.deepEqual(all.files, expected, 'a job\'s file is missing from the every-suite snapshot, or its median is not the median of its five runs');
    });
  });

  it('the snapshot is one a reader of file-times.json accepts (the same validated shape)', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      seedEveryJob(server);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const { readSnapshot } = await import(url('scripts/_shared/stage-costs.mjs'));
      const dir = join(work.dir, 'test-results');
      const { snapshot, why } = readSnapshot(dir, ALL, { validate: (s) => typeof s.files === 'object' && Object.values(s.files).every(v => Number.isFinite(v) && v >= 0) && Number.isFinite(s.runs) });
      assert.equal(why, '');
      assert.ok(Object.keys(snapshot.files).length >= JOBS_OF_CI.length * 2);
    });
  });

  it('asks the server for each job of ci.yml once, with source ci, branch main, scope full', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      seedEveryJob(server);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const asked = testRunFilters(server).map(c => c.args.filter);
      for (const job of JOBS_OF_CI) {
        const hits = asked.filter(f => f['properties.job'] === job && f['properties.source'] === 'ci' && f['properties.branch'] === 'main' && f['properties.scope'] === 'full');
        assert.ok(hits.length >= 1, `no filter call carries job ${job} with source, branch and scope:\n${asked.map(f => JSON.stringify(f)).join('\n')}`);
      }
    });
  });

  it('checks the records again: a branch, a scope, a laptop\'s run and another job, answered by a server that ignores the filter, are not counted', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      seedEveryJob(server);
      const poison = [['testing/standalone/poison.test.js', 8_000_000]];
      seedCiTestRun(server, { n: 6, job: 'standalone-pure', rows: poison, over: { branch: 'feature/x' } });
      seedCiTestRun(server, { n: 7, job: 'standalone-pure', rows: poison, over: { scope: 'files' } });
      seedCiTestRun(server, { n: 8, job: 'standalone-pure', rows: poison, over: { source: 'local' } });
      seedCiTestRun(server, { n: 9, job: 'a-job-ci-does-not-have', rows: poison });
      server.respond = (call, body) => {
        if (call.tool !== 'filter' || !JSON.stringify(body.filter ?? {}).includes('Test-Run')) return undefined;
        const wanted = body.filter?._id;
        let rows = server.store.filter(e => e.type === 'Test-Run' && (wanted === undefined || e._id === wanted));
        rows = [...rows].sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1)).map(x => structuredClone(x));
        if (body.projection?.['properties.measurements'] === 0) rows.forEach(x => { delete x.properties.measurements; });
        if (Object.values(body.projection ?? {}).includes(1)) rows = rows.map(x => ({ _id: x._id, properties: { measurements: x.properties.measurements } }));
        return { status: 200, body: { ok: true, text: 'answer in data', data: { collection: 'chrono', results: rows, count: rows.length, total: rows.length, limit: rows.length, skip: 0, truncated: false } } };
      };
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const all = readJson(work.dir, ALL);
      assert.ok(!Object.keys(all.files).some(f => f.includes('poison')), 'a record that is not CI\'s full run of main, or of a job ci.yml has, set a time');
      assert.equal(all.runs, 5);
      assert.equal(Object.keys(all.files).length, JOBS_OF_CI.length * 2);
    });
  });

  it('with one job unrecorded it writes the pure snapshot only, says one every-suite line naming that job, writes the stage costs and exits 0', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      const lacking = JOBS_OF_CI.find(j => /^standalone-db-\d+$/.test(j));
      seedEveryJob(server, [lacking]);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(resultsOf(work.dir), [PURE, 'stage-costs.json'], 'an every-suite snapshot was written without a whole job');
      const lines = aboutEverySuite(r);
      assert.equal(lines.length, 1, `the missing snapshot is not one line:\n${everything(r)}`);
      assert.ok(lines[0].includes(lacking), `the line does not name the job with no times: ${lines[0]}`);
    });
  });

  it('with only the pure job recorded, the pure snapshot is as before and the every-suite one is refused in one line', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      seedJob(server, 'standalone-pure');
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(resultsOf(work.dir), [PURE, 'stage-costs.json']);
      assert.deepEqual(readJson(work.dir, PURE).files, { [fileOf('standalone-pure', 'a')]: 300, [fileOf('standalone-pure', 'b')]: 2500 });
      assert.equal(aboutEverySuite(r).length, 1, everything(r));
    });
  });

  it('a refused read of the records is one every-suite line, and changes neither the stage costs nor the exit status', async () => {
    await withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      seedEveryJob(server);
      server.respond = (call, body) => (call.tool === 'filter' && JSON.stringify(body.filter ?? {}).includes('Test-Run')
        ? { status: 500, body: { ok: false, error: 'the instance is busy', data: null } } : undefined);
      const r = await runTimes(['--preflight-costs'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(resultsOf(work.dir), ['stage-costs.json']);
      assert.equal(aboutEverySuite(r).length, 1, everything(r));
    });
  });

  describe('--drain-unrecorded', () => {
    const planted = (generatedAt) => ({ generatedAt, newestSourceAt: generatedAt, runs: 99, files: { 'testing/standalone/planted.test.js': 7 } });
    /** A snapshot already in the folder, dated `generatedAt`, its modification time the same. */
    const plant = (dir, name, generatedAt) => {
      mkdirSync(join(dir, 'test-results'), { recursive: true });
      const file = join(dir, 'test-results', name);
      writeFileSync(file, JSON.stringify(planted(generatedAt)));
      utimesSync(file, new Date(generatedAt), new Date(generatedAt));
    };
    const drained = (leave) => withInstance(async ({ server, work, env }) => {
      seedPreflightRun(server);
      seedEveryJob(server);
      if (leave) leave(work.dir);
      const r = await runTimes(['--drain-unrecorded'], { cwd: work.dir, env });
      assert.equal(r.code, 0, everything(r));
      const saved = Object.fromEntries([PURE, ALL].map(n => [n, existsSync(join(work.dir, 'test-results', n)) ? readJson(work.dir, n) : null]));
      return { r, saved };
    });

    it('writes it when it is missing', async () => {
      const { saved } = await drained();
      assert.equal(saved[ALL]?.runs, 5);
      assert.equal(Object.keys(saved[ALL].files).length, JOBS_OF_CI.length * 2);
    });

    it('leaves one a day old or less alone (23 hours), and writes the pure one on its own clock', async () => {
      const when = at(Date.now() - 23 * 3_600_000);
      const { saved } = await drained((d) => plant(d, ALL, when));
      assert.deepEqual(saved[ALL], planted(when), 'an every-suite snapshot under a day old was written again');
      assert.equal(saved[PURE]?.runs, 5, 'the pure snapshot waited on the every-suite one\'s age');
    });

    it('writes it again when it is 25 hours old, and when it is dated in the future', async () => {
      const old = await drained((d) => plant(d, ALL, at(Date.now() - 25 * 3_600_000)));
      assert.notEqual(old.saved[ALL].runs, 99, 'a snapshot over a day old stayed');
      const future = await drained((d) => plant(d, ALL, at(Date.now() + 2 * DAY)));
      assert.notEqual(future.saved[ALL].runs, 99, 'a snapshot dated in the future stayed, and would stay for ever');
    });

    it('a fresh pure snapshot does not hold back a missing every-suite one', async () => {
      const when = at(Date.now() - 3_600_000);
      const { saved } = await drained((d) => plant(d, PURE, when));
      assert.deepEqual(saved[PURE], planted(when));
      assert.equal(saved[ALL]?.runs, 5, 'the every-suite snapshot was not written because the pure one was fresh');
    });
  });
});
