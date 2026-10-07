/**
 * `scripts/test-times.mjs` flags a slow file or suite against a baseline that cannot be argued with, and `--trend`
 * reads the record store without paying for the part of it that is large.
 *
 * ## What this prevents
 *
 * A timing flag is only worth reading if it is rare and right. Four ways one is wrong, each pinned:
 *
 * 1. **The run flags itself away.** If the judged run is one of the "last 10" it is judged against, a suite that
 *    just got slower has pulled its own ceiling up. The judged run is EXCLUDED from its baseline (matched by its
 *    run id), tested with a history that contains it.
 * 2. **The baseline is whatever was recorded.** A subset run, a `--files` run, a failed run, an incomplete run, a
 *    run of a feature branch — none of them is "how long main takes", and a failing run is short because it
 *    stopped. Baselines come ONLY from `scope: full`, `outcome: passed`, `branch: main`. A history with none of
 *    those gives no baseline and therefore no flag, rather than a comparison against the wrong population.
 * 3. **The thresholds are one number.** A FILE is flagged over `max(p90 of its last 10 × 1.25, p90 + 30 s)` — the
 *    second term is what stops a 2 s file flagging at 2.6 s, the first what stops a 200 s file flagging at 231 s —
 *    and a SUITE over the max of its last 10 AND at least 20 % above the usual, so the fastest-ever-run's ceiling
 *    alone does not make a flag out of noise. The tests use histories where every reasonable reading of "p90" and
 *    of "the usual" agrees (a constant history), so they pin the thresholds, not one author's percentile code.
 * 4. **`--trend` downloads what it does not read.** A record carries its per-file measurements as a string of up to
 *    ~100 KB; a trend over 200 runs that reads them is 20 MB for a column of totals. `--trend` queries with a
 *    projection that EXCLUDES `measurements` (every call, asserted on the request), and it does not trust the
 *    server's predicate: a row of a subset run or another branch that comes back anyway is not drawn.
 *
 * ## The interface this pins
 *
 * A run summary is `{runId, startsAt, branch, scope, outcome, suites: {<suite>: {ms, files: {<file>: ms}}}}`.
 * `flagFiles(judged, history)` returns `[{suite, file, ms}]`, `flagSuites(judged, history)` returns `[{suite, ms}]`;
 * both exported from `scripts/test-times.mjs`. `--trend` is the CLI, reading `YTHRIL_TEST_RUNS_URL` / `_TOKEN`.
 *
 * Local server only; no real instance.
 *
 * Run: node --test testing/standalone/test-times-flags-and-trend.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startFakeYthril, FAKE_SPACE } from '../_shared/fake-ythril-tool-server.mjs';
import { makeWorkdir, runTimes, everything } from '../_shared/test-times-harness.mjs';

const MODULE = pathToFileURL(resolve(import.meta.dirname, '..', '..', 'scripts', 'test-times.mjs')).href;
let loaded;
const load = () => (loaded ??= import(MODULE));

const S = 1000;
const FILE = 'testing/standalone/a-slow-one.test.js';

/** A run summary; `n` orders runs in time (higher is newer). */
function run(n, { suite = 'standalone', suiteMs, files = {}, ...over } = {}) {
  return {
    runId: String(1000 + n),
    startsAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    branch: 'main', scope: 'full', outcome: 'passed',
    suites: { [suite]: { ms: suiteMs ?? Object.values(files).reduce((a, b) => a + b, 0), files } },
    ...over,
  };
}
const constant = (count, ms, from = 1, over = {}) => Array.from({ length: count }, (_, i) => run(from + i, { files: { [FILE]: ms }, suiteMs: 100 * S, ...over }));
const flagged = async (judged, history) => (await load()).flagFiles(judged, history);

describe('a file is flagged over max(p90 × 1.25, p90 + 30 s) of its last 10 qualifying runs', () => {
  it('flags a 10 s file at 41 s and not at 39 s — the +30 s term governs a small file', async () => {
    const history = constant(10, 10 * S);
    assert.deepEqual((await flagged(run(50, { files: { [FILE]: 41 * S } }), history)).map(f => f.file), [FILE]);
    assert.deepEqual(await flagged(run(50, { files: { [FILE]: 39 * S } }), history), []);
  });

  it('does not flag a small file for a proportional rise alone (12 s against 10 s)', async () => {
    assert.deepEqual(await flagged(run(50, { files: { [FILE]: 12 * S } }), constant(10, 10 * S)), []);
  });

  it('flags a 200 s file at 251 s and not at 249 s — the ×1.25 term governs a large file', async () => {
    const history = constant(10, 200 * S);
    assert.deepEqual((await flagged(run(50, { files: { [FILE]: 249 * S } }), history)), []);
    const out = await flagged(run(50, { files: { [FILE]: 251 * S } }), history);
    assert.equal(out.length, 1);
    assert.equal(out[0].file, FILE);
    assert.equal(out[0].ms, 251 * S);
    assert.equal(out[0].suite, 'standalone');
  });

  it('reads only the newest 10 runs, whatever order the history arrives in', async () => {
    const old = constant(5, 500 * S, 1);
    const fresh = constant(10, 10 * S, 6);
    const judged = run(50, { files: { [FILE]: 41 * S } });
    assert.equal((await flagged(judged, [...fresh, ...old])).length, 1, 'old slow runs are outside the last 10');
    const slowNow = constant(10, 500 * S, 6);
    const fastThen = constant(5, 10 * S, 1);
    assert.deepEqual(await flagged(judged, [...fastThen, ...slowNow]), [], 'old fast runs are outside the last 10');
  });

  it('flags nothing for a file that has no baseline, and nothing at all for an empty history', async () => {
    const judged = run(50, { files: { [FILE]: 900 * S, 'testing/standalone/brand-new.test.js': 900 * S } });
    assert.deepEqual(await flagged(judged, []), []);
    const out = await flagged(judged, constant(10, 10 * S));
    assert.deepEqual(out.map(f => f.file), [FILE], 'a file the history never saw is new, not slow');
  });
});

describe('a suite is flagged over the max of its last 10 AND 20 % above the usual', () => {
  const judgedAt = (ms, n = 50) => run(n, { suiteMs: ms * S, files: {} });
  const hist = (ms, count = 10, from = 1, over = {}) => Array.from({ length: count }, (_, i) => run(from + i, { suiteMs: ms * S, files: {}, ...over }));

  it('flags 121 s against a constant 100 s, and not 119 s', async () => {
    const { flagSuites } = await load();
    assert.deepEqual(flagSuites(judgedAt(119), hist(100)), []);
    assert.deepEqual(flagSuites(judgedAt(121), hist(100)).map(s => s.suite), ['standalone']);
  });

  it('never flags a suite at or under the max of its last 10, however far above the usual it is', async () => {
    const { flagSuites } = await load();
    const history = [...hist(50, 9), run(10, { suiteMs: 100 * S, files: {} })];
    assert.deepEqual(flagSuites(judgedAt(90), history), [], '90 s is 80 % over the usual 50 s but under the slowest of the last 10');
  });

  it('excludes the judged run from its own baseline', async () => {
    const { flagSuites } = await load();
    const judged = run(50, { suiteMs: 150 * S, files: {} });
    const history = [...hist(100, 9), judged]; // the history CONTAINS the run being judged
    assert.deepEqual(flagSuites(judged, history).map(s => s.suite), ['standalone'], 'were the judged run its own baseline, 150 s would be the max and could not exceed it');
  });

  it('flags nothing without a baseline', async () => {
    const { flagSuites } = await load();
    assert.deepEqual(flagSuites(judgedAt(9999), []), []);
  });
});

describe('baselines come only from scope full, outcome passed, branch main', () => {
  const POPULATIONS = [
    ['a subset run', { scope: 'subset' }],
    ['a --files run', { scope: 'files' }],
    ['a failed run', { outcome: 'failed' }],
    ['an incomplete run', { outcome: 'incomplete' }],
    ['a cancelled run', { outcome: 'cancelled' }],
    ['a run of a feature branch', { branch: 'feature/x' }],
    ['a run of a release branch', { branch: 'release/5.6.x' }],
  ];

  it('has a table worth its name', () => { assert.ok(POPULATIONS.length >= 6); });

  for (const [what, over] of POPULATIONS) {
    it(`ignores ${what} — its 500 s file does not raise the ceiling for a 41 s one`, async () => {
      const qualifying = constant(10, 10 * S, 1);
      const junk = constant(10, 500 * S, 11, over); // NEWER than every qualifying run
      const judged = run(50, { files: { [FILE]: 41 * S } });
      assert.equal((await flagged(judged, [...qualifying, ...junk])).length, 1);
    });

    it(`gives no baseline from ${what} alone, so flags nothing`, async () => {
      const judged = run(50, { files: { [FILE]: 900 * S } });
      assert.deepEqual(await flagged(judged, constant(10, 10 * S, 1, over)), []);
    });
  }

  it('applies the same population to suites', async () => {
    const { flagSuites } = await load();
    const hist = (ms, over, from) => Array.from({ length: 10 }, (_, i) => run(from + i, { suiteMs: ms * S, files: {}, ...over }));
    const judged = run(50, { suiteMs: 130 * S, files: {} });
    const junk = POPULATIONS.flatMap(([, over], k) => hist(500, over, 100 + k * 20));
    assert.deepEqual(flagSuites(judged, [...hist(100, {}, 1), ...junk]).map(s => s.suite), ['standalone']);
  });
});

describe('--trend', () => {
  const QUALIFYING = [
    { commit: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', day: '2026-09-01', ms: 480_000 },
    { commit: '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', day: '2026-09-02', ms: 495_000 },
    { commit: '3333333ccccccccccccccccccccccccccccccccc', day: '2026-09-03', ms: 470_000 },
  ];
  const DECOYS = [
    { commit: '9999991ddddddddddddddddddddddddddddddddd', day: '2026-09-04', ms: 30_000, scope: 'files' },
    { commit: '9999992eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', day: '2026-09-05', ms: 40_000, outcome: 'failed' },
    { commit: '9999993fffffffffffffffffffffffffffffffff', day: '2026-09-06', ms: 50_000, branch: 'feature/x' },
  ];
  const seedRun = (server, r, i) => server.seed({
    title: 'standalone', startsAt: `${r.day}T10:00:00.000Z`, endsAt: `${r.day}T10:08:00.000Z`,
    properties: {
      recordKey: `ci:${i}:1:standalone-pure:standalone`, source: 'ci', commit: r.commit, branch: r.branch ?? 'main', runId: String(i), attempt: 1,
      job: 'standalone-pure', suite: 'standalone', outcome: r.outcome ?? 'passed', scope: r.scope ?? 'full', layout: 'ci-parallel-v2', formatVersion: 1,
      ms: r.ms, files: 3, tests: 30, passed: 30, failed: 0, cancelled: 0, skipped: 0, todo: 0, dirty: false,
      measurements: JSON.stringify({ files: Array.from({ length: 3 }, (_, k) => ({ file: `f${k}.test.js`, ms: 1, pad: 'x'.repeat(30_000) })) }),
    },
  });

  /** A projection that does not select `measurements`: an exclusion that names it, or an inclusion that does not. */
  const withoutMeasurements = (projection) => {
    if (!projection || typeof projection !== 'object') return false;
    const entries = Object.entries(projection);
    const selectsIt = entries.some(([k, v]) => /measurements$/.test(k) && v !== 0);
    const excludesIt = entries.some(([k, v]) => /measurements$/.test(k) && v === 0);
    const inclusion = entries.some(([, v]) => v === 1);
    return !selectsIt && (excludesIt || inclusion);
  };

  async function trend(serverOpts = {}) {
    const server = await startFakeYthril(serverOpts);
    const work = makeWorkdir();
    QUALIFYING.forEach((r, i) => seedRun(server, r, i + 1));
    DECOYS.forEach((r, i) => seedRun(server, r, i + 10));
    return { server, work, close: async () => { await server.close(); work.cleanup(); } };
  }

  it('asks for Test-Run chronos of branch main, scope full, outcome passed — and never selects `measurements`', async () => {
    const t = await trend();
    try {
      const r = await runTimes(['--trend'], { cwd: t.work.dir, env: { YTHRIL_TEST_RUNS_URL: t.server.url, YTHRIL_TEST_RUNS_TOKEN: t.server.token } });
      assert.equal(r.code, 0, everything(r));
      const reads = t.server.callsTo('filter');
      assert.ok(reads.length >= 1, '--trend reads through `filter`');
      for (const c of reads) {
        assert.equal(c.args.space, FAKE_SPACE);
        assert.equal(c.args.collection, 'chrono');
        assert.ok(withoutMeasurements(c.args.projection), `every read excludes measurements; sent ${JSON.stringify(c.args.projection)}`);
        const predicate = JSON.stringify(c.args.filter);
        for (const word of ['Test-Run', 'properties.branch', 'main', 'properties.scope', 'full', 'properties.outcome', 'passed']) {
          assert.ok(predicate.includes(word), `the predicate names ${word}: ${predicate}`);
        }
      }
      assert.equal(t.server.callsTo('save_chrono').length + t.server.callsTo('update_chrono').length + t.server.callsTo('delete_chrono').length, 0, '--trend writes nothing');
    } finally { await t.close(); }
  });

  it('draws the qualifying runs and states the first recorded one', async () => {
    const t = await trend();
    try {
      const r = await runTimes(['--trend'], { cwd: t.work.dir, env: { YTHRIL_TEST_RUNS_URL: t.server.url, YTHRIL_TEST_RUNS_TOKEN: t.server.token } });
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /standalone/);
      for (const q of QUALIFYING) assert.ok(r.stdout.includes(q.commit.slice(0, 7)), `the run at ${q.commit.slice(0, 7)} is drawn:\n${r.stdout}`);
      assert.ok(r.stdout.includes('2026-09-01'), `the first recorded run's day is stated:\n${r.stdout}`);
    } finally { await t.close(); }
  });

  it('limits the rows per suite: `--last N` draws the newest N of EACH suite, so the suite recorded most recently does not push the others off the page (the client joins the node suites, bundle-73)', async () => {
    const server = await startFakeYthril();
    const work = makeWorkdir();
    try {
      const SUITES = [['standalone', 'standalone-pure', 1], ['client', 'client-tests', 6]]; // [suite, job, first day]: the client's runs are the newer ones
      for (const [suite, job, firstDay] of SUITES) {
        for (let n = 0; n < 5; n++) {
          const day = `2026-09-${String(firstDay + n).padStart(2, '0')}`;
          server.seed({
            title: suite, startsAt: `${day}T10:00:00.000Z`, endsAt: `${day}T10:08:00.000Z`,
            properties: {
              recordKey: `ci:${firstDay + n}:1:${job}:${suite}`, source: 'ci', commit: `${suite === 'client' ? 'c' : 'a'}${String(n).padStart(6, '0')}`.padEnd(40, 'f'),
              branch: 'main', runId: String(firstDay + n), attempt: 1, job, suite, outcome: 'passed', scope: 'full', layout: 'ci-parallel-v2', formatVersion: 1,
              ms: 100_000 + n, files: 3, tests: 30, passed: 30, failed: 0, cancelled: 0, skipped: 0, todo: 0, dirty: false, measurements: '{"files":[]}',
            },
          });
        }
      }
      const r = await runTimes(['--trend', '--last', '3'], { cwd: work.dir, env: { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token } });
      assert.equal(r.code, 0, everything(r));
      const rows = (suite) => r.stdout.split('\n').filter(l => new RegExp(`^${suite}\\s`).test(l));
      assert.equal(rows('standalone').length, 3, `the newest 3 standalone runs are drawn:\n${r.stdout}`);
      assert.equal(rows('client').length, 3, `the newest 3 client runs are drawn:\n${r.stdout}`);
    } finally { await server.close(); work.cleanup(); }
  });

  it('does not trust the server\'s predicate: a subset, failed or feature-branch row that comes back anyway is not drawn', async () => {
    const t = await trend();
    // A server that ignores the predicate and answers with every row (measurements still stripped, as asked).
    t.server.respond = (call) => {
      if (call.tool !== 'filter') return undefined;
      const rows = t.server.store.map(e => ({ ...structuredClone(e), properties: { ...e.properties, measurements: undefined } }));
      return { status: 200, body: { ok: true, text: 'x', data: { collection: 'chrono', results: rows, count: rows.length, total: rows.length, limit: 200, skip: 0, truncated: false } } };
    };
    try {
      const r = await runTimes(['--trend'], { cwd: t.work.dir, env: { YTHRIL_TEST_RUNS_URL: t.server.url, YTHRIL_TEST_RUNS_TOKEN: t.server.token } });
      assert.equal(r.code, 0, everything(r));
      for (const q of QUALIFYING) assert.ok(r.stdout.includes(q.commit.slice(0, 7)));
      for (const d of DECOYS) assert.ok(!r.stdout.includes(d.commit.slice(0, 7)), `a ${JSON.stringify(d)} row must not be drawn:\n${r.stdout}`);
    } finally { await t.close(); }
  });
});
