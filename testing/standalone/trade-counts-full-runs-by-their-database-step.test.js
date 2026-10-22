/**
 * `scripts/trade.mjs` counts the Full runs by their DATABASE STEP, and states what local preflight's missing database batch saved and cost (Q-588).
 *
 * ## The question, and why the report is a pure function
 *
 * Owner decision (2026-10-22): local preflight runs no database test file; CI's Full run runs them. Whether that trade is good is a
 * measurement: how often the database step of a Full run fails (what a local run would have caught earlier), and how much CI time
 * the skip saves against what the failures cost. `tradeReport({ runs, cutoverSha, isAncestor })` is that measurement over data
 * already read (the listing is `gh`'s, through `scripts/_shared/ci-run-reader.mjs`), so every row of the counting rules below is a
 * case over literal runs and no case needs a network.
 *
 * ## The input
 *
 * `runs`: `[{ id, ref, headSha, createdAt, attempts: [{ attempt, dbStep: { conclusion, startedAt, completedAt } | null }] }]`, `attempts`
 * from EVERY attempt of the run (`gh run view --json jobs` shows only the latest attempt: run 38605272758 is attempt 2 and its attempt 1
 * is readable only through the attempts endpoint), `dbStep` the step that runs `npm run test:standalone:db`, `null` when that step never
 * started. `cutoverSha`: Q-588's merge commit. `isAncestor(ancestor, descendant)`: does `ancestor` lie in `descendant`'s history
 * (`git merge-base --is-ancestor`'s order), synchronous, injected so no case needs a repository.
 *
 * ## The report this gate holds (names are the contract; the implementation is built against them)
 *
 * - `report.after`: the runs whose head descends from the cut-over, after exclusions: `{ counted, failures, timeouts, savedMinutes,
 *   costMinutes, netMinutes, calendarMinutes }`. `counted` is a number of runs; `failures` a number of runs whose database step failed
 *   in ANY attempt (a run is one failure, however many attempts failed); `timeouts` an array of run ids, a SUBSET of the failures (a
 *   database step that ended `cancelled` on a run no newer run of its bundle superseded); the four minutes figures are numbers, all in
 *   CI minutes except `calendarMinutes`, which is wall-clock and never enters `netMinutes`.
 * - `report.before`: `{ counted, failures }` over the runs whose head does NOT descend from the cut-over: the baseline, never mixed
 *   into `after`.
 * - `report.named`: `[{ id, ref, kind, reason }]`, one entry per run that was left out or could not be read, `kind` one of
 *   `superseded`, `not-a-bundle`, `never-started`, `missing-field`; `reason` is a sentence.
 * - `report.bundles`: `[{ bundle, runIds }]`, one entry per bundle (`bundle` is the number as a string, `'106'`).
 *
 * ## The counting rules, each its own case
 *
 * | a run | counted | note |
 * |---|---|---|
 * | database step `failure` in attempt 1, `success` in attempt 2 | one failure | the failed attempt is invisible to the latest-attempt view |
 * | database step `cancelled`, a newer run of the same bundle exists | excluded, named `superseded` | cancelled by a push, says nothing about the tests |
 * | database step `cancelled`, no newer run of the bundle | one failure AND a timeout | the job's 30-minute limit reads as cancelled |
 * | database step `null` (never started) | named `never-started`, not counted | a setup failure is not a test failure |
 * | a field missing (`startedAt`, `completedAt`, `conclusion`, `headSha`, `createdAt`, `ref`) | named `missing-field`, not counted | never zero minutes |
 * | `full-run/bundle-106-a0` and `full-run/bundle-106-a` | one bundle, `106` | a bundle spans refs |
 * | `full-run/probe-b85` | named `not-a-bundle`, not counted | a probe is no bundle |
 * | head not a descendant of the cut-over | `before`, never `after` | the history measures the old regime |
 *
 * ## The units (the part that drifts)
 *
 * - `savedMinutes`: the database step's minutes of every counted run's FIRST attempt (a Full run's database half, which a local
 *   preflight no longer runs: a proxy, since the local skip happens per preflight and its local time is not measured).
 * - `costMinutes`: the database step's minutes of the EXTRA runs a failure caused: the attempts after a run's first failed attempt,
 *   and every attempt of the runs that follow a failed run on the same bundle.
 * - `calendarMinutes`: from the failing database step's `completedAt` to the next green database step's `completedAt`, printed on its
 *   own line. A different unit from the two above: saved and cost are CI minutes, calendar is waiting.
 * - `netMinutes = savedMinutes - costMinutes`. Never a sum with the calendar figure.
 *
 * ## The command line and the source
 *
 * `bundleOf(ref)` and `checkLineRef(ref)` are exported, as is `checkListing(runs, limit)`, which refuses a listing that fills its
 * limit (a cut listing reads as a quiet history). `--line` refuses a ref that does not match `^full-run/[\w.-]+$` before any `gh` call.
 * The database step is found through `stepNameRunning` in the shared reader, derived from ci.yml, never named in `trade.mjs`.
 *
 * Red at base: `scripts/trade.mjs` does not exist, so every case that loads it fails on the import. The module is loaded when a case
 * runs, so each case is red on its own and not the whole file at once.
 *
 * Run: node --test testing/standalone/trade-counts-full-runs-by-their-database-step.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { loadCi, jobEntries, stepsOf } from '../_shared/ci-workflow.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

const TRADE = join(REPO_ROOT, 'scripts', 'trade.mjs');
const CUTOVER = 'c0ffee0000000000000000000000000000000000';
const BEFORE_SHA = 'b4b4b40000000000000000000000000000000000';
const AFTER_SHA = 'a1a1a10000000000000000000000000000000000';
const CLOSE = 1e-6;

/** The module under test, loaded when a case runs. */
async function trade() {
  const mod = await import(new URL(`file:///${TRADE.replace(/\\/g, '/')}`).href);
  for (const name of ['tradeReport', 'bundleOf', 'checkLineRef', 'checkListing']) {
    assert.equal(typeof mod[name], 'function', `scripts/trade.mjs must export ${name}`);
  }
  return mod;
}

// ───────────────────────────────────────────────────────── fixtures ─────────────────────────────────────────────────────────

/** An ISO time `minutes` after `start`. */
const plus = (start, minutes) => new Date(Date.parse(start) + minutes * 60_000).toISOString().replace('.000Z', 'Z');

/** A database step that started at `startedAt` and ran `minutes`. */
const step = (conclusion, startedAt, minutes) => ({ conclusion, startedAt, completedAt: plus(startedAt, minutes) });

/** One attempt of a run. */
const attempt = (n, dbStep) => ({ attempt: n, dbStep });

/** One Full run; every field is overridable so a case can take one away. */
const run = (over = {}) => ({
  id: 1000,
  ref: 'full-run/bundle-100',
  headSha: AFTER_SHA,
  createdAt: '2026-10-23T08:00:00Z',
  attempts: [attempt(1, step('success', '2026-10-23T08:05:00Z', 10))],
  ...over,
});

/** The cut-over as git would answer it: only AFTER_SHA descends from CUTOVER. */
const isAncestorOf = (calls = []) => (ancestor, descendant) => { calls.push([ancestor, descendant]); return ancestor === CUTOVER && descendant === AFTER_SHA; };

async function report(runs, calls) {
  const { tradeReport } = await trade();
  return tradeReport({ runs, cutoverSha: CUTOVER, isAncestor: isAncestorOf(calls) });
}

const namedKinds = (r, id) => r.named.filter(n => n.id === id).map(n => n.kind);

// ───────────────────────────────────────────────────── the counting rules ─────────────────────────────────────────────────────

describe('tradeReport: what a database step counts as', () => {
  it('a database step that failed in attempt 1 and passed in attempt 2 is ONE failure (attempt 1 is not invisible)', async () => {
    const r = await report([run({
      id: 1, attempts: [attempt(1, step('failure', '2026-10-23T08:05:00Z', 12)), attempt(2, step('success', '2026-10-23T09:00:00Z', 10))],
    })]);
    assert.equal(r.after.counted, 1, 'one run is counted');
    assert.equal(r.after.failures, 1, 'a failed attempt followed by a green one is one failure, not zero (the latest-attempt view) and not two');
    assert.deepEqual(r.after.timeouts, [], 'a failure is not a timeout');
  });

  it('a run whose attempts all passed is no failure', async () => {
    const r = await report([run({ id: 1 })]);
    assert.equal(r.after.counted, 1);
    assert.equal(r.after.failures, 0);
  });

  it('a run that failed in every attempt is still one failure', async () => {
    const r = await report([run({ id: 1, attempts: [attempt(1, step('failure', '2026-10-23T08:05:00Z', 5)), attempt(2, step('failure', '2026-10-23T09:00:00Z', 5))] })]);
    assert.equal(r.after.failures, 1);
  });

  it('a cancelled database step on a run a newer run of the same bundle superseded is excluded, named, and never counted', async () => {
    const superseded = run({ id: 1, ref: 'full-run/bundle-100', createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 3))] });
    const newer = run({ id: 2, ref: 'full-run/bundle-100', createdAt: '2026-10-23T08:10:00Z', attempts: [attempt(1, step('success', '2026-10-23T08:15:00Z', 10))] });
    const r = await report([superseded, newer]);
    assert.deepEqual(namedKinds(r, 1), ['superseded'], 'the superseded run is named');
    assert.equal(r.after.counted, 1, 'only the newer run is counted');
    assert.equal(r.after.failures, 0, 'a cancelled step on a superseded run is not a failure');
    assert.deepEqual(r.after.timeouts, []);
  });

  it('the newer run may be on another ref of the same bundle (bundle-106-a0 superseded by bundle-106-a)', async () => {
    const superseded = run({ id: 1, ref: 'full-run/bundle-106-a0', createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 3))] });
    const newer = run({ id: 2, ref: 'full-run/bundle-106-a', createdAt: '2026-10-23T08:10:00Z' });
    const r = await report([superseded, newer]);
    assert.deepEqual(namedKinds(r, 1), ['superseded']);
    assert.equal(r.after.failures, 0);
  });

  it('a cancelled step on a run of ANOTHER bundle is not superseded by it', async () => {
    const cancelled = run({ id: 1, ref: 'full-run/bundle-100', createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 30))] });
    const otherBundle = run({ id: 2, ref: 'full-run/bundle-101', createdAt: '2026-10-23T08:10:00Z' });
    const r = await report([cancelled, otherBundle]);
    assert.deepEqual(namedKinds(r, 1), [], 'a newer run elsewhere supersedes nothing');
    assert.equal(r.after.failures, 1);
  });

  it('a cancelled database step on a run NOT superseded is counted as a failure and reported as a timeout', async () => {
    const r = await report([run({ id: 7, attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 30))] })]);
    assert.equal(r.after.counted, 1);
    assert.equal(r.after.failures, 1, 'the 30-minute limit reads as cancelled: that is a failure');
    assert.deepEqual(r.after.timeouts, [7], 'and it is said to be a timeout');
    assert.deepEqual(namedKinds(r, 7), [], 'it is counted, so it is not named as left out');
  });

  it('a run whose database step never started is named and not counted (a setup failure is not a test failure)', async () => {
    const r = await report([run({ id: 1, attempts: [attempt(1, null)] }), run({ id: 2, ref: 'full-run/bundle-101' })]);
    assert.deepEqual(namedKinds(r, 1), ['never-started']);
    assert.equal(r.after.counted, 1, 'only the run that started its step is counted');
    assert.equal(r.after.failures, 0);
    assert.equal(r.after.savedMinutes, 10, 'its minutes are not counted as zero either: only the other run saved anything');
  });

  for (const field of ['startedAt', 'completedAt', 'conclusion']) {
    it(`a run whose database step lacks ${field} is named, never counted as zero minutes`, async () => {
      const broken = step('success', '2026-10-23T08:05:00Z', 10);
      delete broken[field];
      const r = await report([run({ id: 1, attempts: [attempt(1, broken)] }), run({ id: 2, ref: 'full-run/bundle-101' })]);
      assert.deepEqual(namedKinds(r, 1), ['missing-field'], `a step without ${field} is named`);
      assert.equal(r.after.counted, 1, 'it is not counted');
      assert.equal(r.after.savedMinutes, 10, 'and it adds no zero-minute run to the saving');
      assert.ok(Number.isFinite(r.after.savedMinutes) && Number.isFinite(r.after.netMinutes), 'no NaN reaches a total');
    });
  }

  for (const field of ['headSha', 'createdAt', 'ref']) {
    it(`a run lacking ${field} is named, never counted`, async () => {
      const broken = run({ id: 1 });
      delete broken[field];
      const r = await report([broken, run({ id: 2, ref: 'full-run/bundle-101' })]);
      assert.deepEqual(namedKinds(r, 1).includes('missing-field') || namedKinds(r, 1).includes('not-a-bundle'), true, `a run without ${field} is named: ${JSON.stringify(r.named)}`);
      assert.equal(r.after.counted + r.before.counted, 1, 'it is counted in neither half');
    });
  }

  it('a run with no attempts at all is named, not counted as a passing run', async () => {
    const r = await report([run({ id: 1, attempts: [] }), run({ id: 2, ref: 'full-run/bundle-101' })]);
    assert.ok(namedKinds(r, 1).length > 0, 'a run with nothing to read is named');
    assert.equal(r.after.counted, 1);
  });
});

describe('bundles: a bundle is a ref full-run/bundle-<n> or full-run/b<n>, with an optional suffix', () => {
  // Both spellings are in the real history (full-run/b169 is run 39812174362); a bundle pushed under the short one
  // must count as that bundle, not vanish from the totals as "not a bundle".
  it('bundleOf reads the number out of the ref, whatever follows it', async () => {
    const { bundleOf } = await trade();
    for (const [ref, bundle] of [['full-run/bundle-106', '106'], ['full-run/bundle-106-a', '106'], ['full-run/bundle-106-a0', '106'], ['full-run/bundle-7', '7'], ['full-run/bundle-106.1', '106'], ['full-run/b169', '169'], ['full-run/b85-x', '85']]) {
      assert.equal(String(bundleOf(ref)), bundle, `${ref} is bundle ${bundle}`);
    }
  });

  it('bundleOf answers nothing for a ref that is no bundle', async () => {
    const { bundleOf } = await trade();
    for (const ref of ['full-run/probe-b85', 'full-run/', 'main', 'bundle-106', 'full-run/bundle-', 'full-run/bundle-x', 'refs/heads/full-run/bundle-1', 'full-run/b', 'full-run/bx', 'full-run/bundles-1', '']) {
      assert.ok(bundleOf(ref) == null, `${JSON.stringify(ref)} is no bundle, got ${JSON.stringify(bundleOf(ref))}`);
    }
  });

  it('runs on full-run/bundle-106-a0 and full-run/bundle-106-a are one bundle, 106', async () => {
    const r = await report([
      run({ id: 1, ref: 'full-run/bundle-106-a0', createdAt: '2026-10-23T08:00:00Z' }),
      run({ id: 2, ref: 'full-run/bundle-106-a', createdAt: '2026-10-23T09:00:00Z' }),
      run({ id: 3, ref: 'full-run/bundle-107', createdAt: '2026-10-23T09:30:00Z' }),
    ]);
    const b106 = r.bundles.filter(b => String(b.bundle) === '106');
    assert.equal(b106.length, 1, `one bundle entry for 106, got ${JSON.stringify(r.bundles)}`);
    assert.deepEqual([...b106[0].runIds].sort(), [1, 2]);
    assert.equal(r.bundles.length, 2, 'bundle 107 is the other');
  });

  it('full-run/probe-b85 is excluded and named, and is no bundle', async () => {
    const r = await report([run({ id: 1, ref: 'full-run/probe-b85' }), run({ id: 2, ref: 'full-run/bundle-101' })]);
    assert.deepEqual(namedKinds(r, 1), ['not-a-bundle']);
    assert.equal(r.after.counted, 1);
    assert.equal(r.bundles.length, 1);
    assert.ok(r.bundles.every(b => !b.runIds.includes(1)), 'a probe is in no bundle');
  });
});

describe('the cut-over: a run from before Q-588 never counts as after', () => {
  it('a run whose head is not a descendant of the cut-over is in the before-baseline and never in the after totals', async () => {
    const calls = [];
    const r = await report([
      run({ id: 1, ref: 'full-run/bundle-90', headSha: BEFORE_SHA, attempts: [attempt(1, step('failure', '2026-10-01T08:05:00Z', 15))] }),
      run({ id: 2, ref: 'full-run/bundle-91', headSha: BEFORE_SHA }),
      run({ id: 3, ref: 'full-run/bundle-100', headSha: AFTER_SHA }),
    ], calls);
    assert.deepEqual({ counted: r.before.counted, failures: r.before.failures }, { counted: 2, failures: 1 }, 'the two old runs are the baseline, with their failure');
    assert.deepEqual({ counted: r.after.counted, failures: r.after.failures }, { counted: 1, failures: 0 }, 'the old failure is not in the after totals');
    assert.equal(r.after.savedMinutes, 10, 'the old runs add nothing to the saving');
    assert.ok(calls.length >= 2 && calls.every(([ancestor]) => ancestor === CUTOVER), `isAncestor is asked about the cut-over for every run: ${JSON.stringify(calls)}`);
    assert.ok(calls.some(([, d]) => d === BEFORE_SHA) && calls.some(([, d]) => d === AFTER_SHA), 'with each run\'s own head');
  });

  it('with no run after the cut-over the after totals are zero runs, not an error and not the baseline', async () => {
    const r = await report([run({ id: 1, headSha: BEFORE_SHA })]);
    assert.equal(r.after.counted, 0);
    assert.equal(r.after.failures, 0);
    assert.equal(r.before.counted, 1);
  });
});

describe('the units: saved, cost and calendar time are three figures, and net is saved minus cost', () => {
  it('the recorded Full run 39812174362 saves its database step\'s 17 min 40 s, and costs nothing', async () => {
    // The step's times are read from the recorded run, found by the step's name in ci.yml: the fixture is what gh gave.
    const recorded = JSON.parse(readFileSync(join(REPO_ROOT, 'testing', 'standalone', '_fixtures', 'skip-check', 'run-success.json'), 'utf8'));
    const named = jobEntries(loadCi()).flatMap(({ job }) => stepsOf(job)).filter(s => typeof s.run === 'string' && /npm run test:standalone:db/.test(s.run)).map(s => s.name);
    assert.equal(named.length, 1, 'ci.yml has one step that runs the database tests');
    const dbStep = recorded.jobs.flatMap(j => j.steps).find(s => s.name === named[0]);
    assert.ok(dbStep, `the recorded run holds the step '${named[0]}'`);
    assert.deepEqual([dbStep.startedAt, dbStep.completedAt], ['2026-10-22T16:15:04Z', '2026-10-22T16:32:44Z'], 'the step is the recorded one');
    const r = await report([run({
      id: 39812174362, ref: 'full-run/bundle-105', headSha: AFTER_SHA, createdAt: '2026-10-22T16:13:50Z',
      attempts: [attempt(1, { conclusion: dbStep.conclusion, startedAt: dbStep.startedAt, completedAt: dbStep.completedAt })],
    })]);
    assert.ok(Math.abs(r.after.savedMinutes - (17 + 40 / 60)) < CLOSE, `saved is 17 min 40 s = 17.667 minutes, got ${r.after.savedMinutes}`);
    assert.equal(r.after.costMinutes, 0);
    assert.ok(Math.abs(r.after.netMinutes - (17 + 40 / 60)) < CLOSE);
  });

  it('saved is the first attempt\'s database minutes of every counted run, summed', async () => {
    const r = await report([
      run({ id: 1, ref: 'full-run/bundle-100', attempts: [attempt(1, step('success', '2026-10-23T08:05:00Z', 10))] }),
      run({ id: 2, ref: 'full-run/bundle-101', attempts: [attempt(1, step('success', '2026-10-23T09:05:00Z', 15))] }),
      run({ id: 3, ref: 'full-run/bundle-102', attempts: [attempt(1, step('success', '2026-10-23T10:05:00Z', 12.5))] }),
    ]);
    assert.equal(r.after.savedMinutes, 37.5);
    assert.equal(r.after.costMinutes, 0, 'nothing failed, so nothing was repeated');
    assert.equal(r.after.netMinutes, 37.5);
  });

  it('cost is the database minutes of the extra attempts a failure caused: attempt 1 failed, attempt 2 ran 11 minutes', async () => {
    const r = await report([run({
      id: 1, attempts: [attempt(1, step('failure', '2026-10-23T08:05:00Z', 14)), attempt(2, step('success', '2026-10-23T09:00:00Z', 11))],
    })]);
    assert.equal(r.after.savedMinutes, 14, 'the run\'s first attempt is what a Full run costs');
    assert.equal(r.after.costMinutes, 11, 'the repeat is the cost');
    assert.equal(r.after.netMinutes, 3, 'net is saved minus cost, in the same unit');
  });

  it('cost is also the database minutes of the runs that follow a failed run on the same bundle', async () => {
    const r = await report([
      run({ id: 1, ref: 'full-run/bundle-106-a0', createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('failure', '2026-10-23T08:05:00Z', 20))] }),
      run({ id: 2, ref: 'full-run/bundle-106-a', createdAt: '2026-10-23T09:00:00Z', attempts: [attempt(1, step('success', '2026-10-23T09:05:00Z', 16))] }),
    ]);
    assert.equal(r.after.failures, 1);
    assert.equal(r.after.costMinutes, 16, 'the second run exists because the first failed: its minutes are the cost');
    assert.equal(r.after.netMinutes, r.after.savedMinutes - r.after.costMinutes);
  });

  it('calendar time is reported on its own: from the failing step\'s end to the next green step\'s end, and never inside net', async () => {
    const r = await report([run({
      id: 1, attempts: [attempt(1, step('failure', '2026-10-23T08:00:00Z', 10)), attempt(2, step('success', '2026-10-23T10:00:00Z', 10))],
    })]);
    // failed step ends 08:10, the green one 10:10: 120 minutes of waiting; CI minutes: saved 10, cost 10.
    assert.equal(r.after.calendarMinutes, 120);
    assert.equal(r.after.costMinutes, 10);
    assert.equal(r.after.netMinutes, 0, 'net is saved - cost in CI minutes; the 120 waiting minutes are not in it');
    assert.notEqual(r.after.calendarMinutes, r.after.costMinutes, 'the fixture tells the two units apart');
  });

  it('a counted timeout is a failure whose minutes are in the saving like any other run', async () => {
    const r = await report([run({ id: 7, attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 30))] })]);
    assert.equal(r.after.savedMinutes, 30);
  });
});

describe('a listing that fills its limit is refused', () => {
  it('checkListing throws when the listing is exactly the limit or more, and says the limit', async () => {
    const { checkListing } = await trade();
    for (const n of [500, 501]) {
      assert.throws(() => checkListing(Array.from({ length: n }, (_, i) => ({ id: i })), 500), /limit|500|cut|truncat/i, `${n} runs of a limit of 500 is a cut listing`);
    }
  });

  it('checkListing accepts a listing under the limit, including an empty one is not mistaken for full', async () => {
    const { checkListing } = await trade();
    assert.doesNotThrow(() => checkListing(Array.from({ length: 499 }, (_, i) => ({ id: i })), 500));
    assert.doesNotThrow(() => checkListing([], 500));
  });
});

describe('--line: a ref is refused unless it is full-run/<name>', () => {
  it('checkLineRef accepts full-run/ followed by word characters, dots and dashes', async () => {
    const { checkLineRef } = await trade();
    for (const ref of ['full-run/bundle-106', 'full-run/bundle-106-a0', 'full-run/bundle-106.1', 'full-run/probe_b85']) {
      assert.doesNotThrow(() => checkLineRef(ref), `${ref} is a ref`);
    }
  });

  for (const bad of ['', 'main', 'full-run/', 'full-run/a b', 'full-run/x;rm -rf', 'full-run/a/b', 'full-run/../x', '--json', 'full-run/bundle-1\n', ' full-run/bundle-1', 'refs/heads/full-run/bundle-1', 'full-run/$(id)', 'FULL-RUN/bundle-1']) {
    it(`checkLineRef refuses ${JSON.stringify(bad)}`, async () => {
      const { checkLineRef } = await trade();
      assert.throws(() => checkLineRef(bad), `${JSON.stringify(bad)} was accepted`);
    });
  }

  it('checkLineRef refuses what is not a string', async () => {
    const { checkLineRef } = await trade();
    for (const bad of [undefined, null, 5, ['full-run/bundle-1']]) assert.throws(() => checkLineRef(bad));
  });
});

describe('the command line (the refusals that need no gh)', () => {
  const ask = (...args) => spawnSync(process.execPath, [TRADE, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, env: testChildEnv({ PATH: '' }),
  });

  for (const args of [['--line', 'main'], ['--line', 'full-run/a b'], ['--line', '--limit'], ['--limit', 'abc'], ['--limit', '0'], ['--limit', '-5'], ['--limit', '1.5'], ['--statc'], ['bundle-1']]) {
    it(`refuses ${JSON.stringify(args)} with exit 2, before any gh call`, () => {
      const r = ask(...args);
      assert.equal(r.status, 2, `status ${r.status}; stderr: ${r.stderr}`);
      assert.match(`${r.stderr}${r.stdout}`, /usage|--line|--limit|argument/i, 'the refusal says how to call it');
    });
  }

  it('answers exit 2 and says gh when gh is not on the PATH (no report is printed from nothing)', () => {
    const r = ask();
    assert.equal(r.status, 2, `status ${r.status}; stderr: ${r.stderr}`);
    assert.match(`${r.stderr}${r.stdout}`, /\bgh\b/i, 'the message names gh');
  });
});

describe('trade reads the database step from ci.yml, through the shared reader', () => {
  const source = () => stripComments(readFileSync(TRADE, 'utf8'));

  it('imports stepNameRunning from the shared reader and asks it for the step that runs test:standalone:db', () => {
    const src = source();
    const imp = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/_shared\/ci-run-reader\.mjs['"]/.exec(src);
    assert.ok(imp, 'scripts/trade.mjs imports nothing from ./_shared/ci-run-reader.mjs');
    assert.ok(imp[1].split(',').map(s => s.trim()).includes('stepNameRunning'), 'the step finder is not the shared one');
    assert.match(src, /stepNameRunning\(\s*\/[^/\n]*test:standalone:db/, 'the step is found by the command it runs');
  });

  it('never spells the step\'s name: it is derived from ci.yml, so a rename cannot leave trade reading a step that is gone', () => {
    const names = jobEntries(loadCi()).flatMap(({ job }) => stepsOf(job)).filter(s => typeof s.run === 'string' && /npm run test:standalone:db/.test(s.run)).map(s => s.name);
    assert.equal(names.length, 1, 'ci.yml has one step that runs the database tests');
    assert.ok(!source().includes(names[0]), `scripts/trade.mjs spells the step name '${names[0]}'`);
  });
});
