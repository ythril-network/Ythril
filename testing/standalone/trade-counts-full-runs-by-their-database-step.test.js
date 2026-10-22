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
 *   `superseded`, `not-a-bundle`, `never-started`, `unread-budget` (the budget ended before the run, or between its attempts, was
 *   read), `unplaced` (git cannot place the head against the cut-over, or the budget ended first), `missing-field`; `reason` is a sentence.
 * - `report.bundles`: `[{ bundle, runIds }]`, one entry per bundle (`bundle` is the number as a string, `'106'`).
 *
 * ## The counting rules, each its own case
 *
 * | a run | counted | note |
 * |---|---|---|
 * | database step `failure` in attempt 1, `success` in attempt 2 | one failure | the failed attempt is invisible to the latest-attempt view |
 * | database step `cancelled`, a newer run of the SAME REF created no later than the step's end | excluded, named `superseded` | cancelled by a push (`full-run.yml` cancels per ref); another ref of the bundle cancels nothing |
 * | database step `cancelled`, no such run (a newer run on the ref came after the cancel, or only on another ref) | one failure AND a timeout | the job's 30-minute limit reads as cancelled |
 * | database step `null` in EVERY attempt (never started) | named `never-started`, not counted | a setup failure is not a test failure; attempt 1 null and attempt 2 run is read from attempt 2 |
 * | a field missing (`startedAt`, `completedAt`, `conclusion`, `headSha`, `createdAt`, `ref`) | named `missing-field`, not counted | never zero minutes |
 * | `full-run/bundle-106-a0` and `full-run/bundle-106-a` | one bundle, `106` | a bundle spans refs |
 * | `full-run/probe-b85` | named `not-a-bundle`, not counted | a probe is no bundle |
 * | head not a descendant of the cut-over | `before`, never `after` | the history measures the old regime |
 *
 * ## The units (the part that drifts)
 *
 * - `savedMinutes`: the database step's minutes of every counted run's FIRST attempt that ran the step (a Full run's database half, which a local
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

  // full-run.yml cancels per REF (concurrency group `full-run-${{ github.ref }}`): a push to the same ref creates a run, and that
  // creation cancels the one in flight. So a step is superseded only by a run of the SAME REF created no later than the step's end.
  it('a cancelled database step on a run a newer run of the same ref cancelled is excluded, named, and never counted', async () => {
    // The cancelled step ends 08:08; the newer run was created 08:06, the push that cancelled it.
    const superseded = run({ id: 1, ref: 'full-run/bundle-100', createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 3))] });
    const newer = run({ id: 2, ref: 'full-run/bundle-100', createdAt: '2026-10-23T08:06:00Z', attempts: [attempt(1, step('success', '2026-10-23T08:15:00Z', 10))] });
    const r = await report([superseded, newer]);
    assert.deepEqual(namedKinds(r, 1), ['superseded'], 'the superseded run is named');
    assert.equal(r.after.counted, 1, 'only the newer run is counted');
    assert.equal(r.after.failures, 0, 'a cancelled step on a superseded run is not a failure');
    assert.deepEqual(r.after.timeouts, []);
  });

  it('a newer run created at the very second the step was cancelled supersedes it ("no later than" the step\'s end)', async () => {
    const cancelled = run({ id: 1, createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 3))] });
    const newer = run({ id: 2, createdAt: '2026-10-23T08:08:00Z' });
    const r = await report([cancelled, newer]);
    assert.deepEqual(namedKinds(r, 1), ['superseded']);
  });

  it('another ref of the same bundle is NOT a supersession: bundle-106-a0 is cancelled by nothing that bundle-106-a does', async () => {
    // GitHub's concurrency group is the ref, so a run on another ref never cancels this one: the cancelled step is a timeout.
    const cancelled = run({ id: 1, ref: 'full-run/bundle-106-a0', createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 30))] });
    const otherRef = run({ id: 2, ref: 'full-run/bundle-106-a', createdAt: '2026-10-23T08:10:00Z' });
    const r = await report([cancelled, otherRef]);
    assert.deepEqual(namedKinds(r, 1), [], 'not superseded, so not named as left out');
    assert.equal(r.after.failures, 1);
    assert.deepEqual(r.after.timeouts, [1]);
  });

  it('a newer run on the same ref created AFTER the step was cancelled supersedes nothing: the cancel was a timeout, and the push came later', async () => {
    // The step ran 08:05 to 08:35 (the 30-minute limit); a push to the same ref at 09:00 did not cancel anything.
    const timedOut = run({ id: 1, createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 30))] });
    const later = run({ id: 2, createdAt: '2026-10-23T09:00:00Z' });
    const r = await report([timedOut, later]);
    assert.deepEqual(namedKinds(r, 1), [], 'it is counted');
    assert.equal(r.after.failures, 1);
    assert.deepEqual(r.after.timeouts, [1]);
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

  it('never-started means NO attempt ran the step: attempt 1 a setup failure and attempt 2 a failed database step is ONE failure, counted', async () => {
    const r = await report([run({ id: 1, attempts: [attempt(1, null), attempt(2, step('failure', '2026-10-23T09:00:00Z', 6))] })]);
    assert.deepEqual(namedKinds(r, 1), [], 'a run whose second attempt ran the step is not "never started"');
    assert.equal(r.after.counted, 1);
    assert.equal(r.after.failures, 1);
  });

  it('a run no attempt of which started the step is never-started', async () => {
    const r = await report([run({ id: 1, attempts: [attempt(1, null), attempt(2, null)] })]);
    assert.deepEqual(namedKinds(r, 1), ['never-started']);
    assert.equal(r.after.counted, 0);
  });

  it('saved is the minutes of the FIRST attempt that ran the step: attempt 1 never ran, attempt 2 failed (7), attempt 3 passed (9)', async () => {
    const r = await report([run({ id: 1, attempts: [
      attempt(1, null), attempt(2, step('failure', '2026-10-23T09:00:00Z', 7)), attempt(3, step('success', '2026-10-23T10:00:00Z', 9)),
    ] })]);
    assert.equal(r.after.savedMinutes, 7, 'the first attempt that ran it is what a Full run spends');
    assert.equal(r.after.costMinutes, 9, 'the repeat after its failure is the cost');
  });

  it('saved is the first attempt\'s minutes even when that attempt is the one left out of the counting (a superseded cancel): never the next one\'s', async () => {
    const r = await report([
      run({ id: 1, createdAt: '2026-10-23T08:00:00Z', attempts: [attempt(1, step('cancelled', '2026-10-23T08:05:00Z', 3)), attempt(2, step('success', '2026-10-23T12:00:00Z', 10))] }),
      run({ id: 2, createdAt: '2026-10-23T08:06:00Z', attempts: [attempt(1, step('success', '2026-10-23T08:10:00Z', 20))] }),
    ]);
    assert.deepEqual(namedKinds(r, 1), [], 'run 1 still has a kept attempt, so it is counted');
    assert.equal(r.after.savedMinutes, 3 + 20, 'run 1 saved its first attempt (3), not the second (10)');
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

describe('the names a left-out run is given: unread-budget and unplaced are not missing-field', () => {
  it('a run the budget ended before it was read is named unread-budget, never counted, never "no attempt to read"', async () => {
    const r = await report([run({ id: 1, attempts: [], unread: 'budget' }), run({ id: 2, ref: 'full-run/bundle-101' })]);
    assert.deepEqual(namedKinds(r, 1), ['unread-budget']);
    assert.match(r.named.find(n => n.id === 1).reason, /budget/i, 'the reason says the budget');
    assert.equal(r.after.counted, 1);
  });

  it('a head git cannot place against the cut-over is named unplaced, never counted, and the reason says what git said', async () => {
    const { tradeReport } = await trade();
    const r = tradeReport({
      runs: [run({ id: 1 }), run({ id: 2, ref: 'full-run/bundle-101', headSha: BEFORE_SHA })],
      cutoverSha: CUTOVER,
      isAncestor: (a, d) => { if (d === AFTER_SHA) throw new Error('git cannot place the commit (is it fetched?)'); return false; },
    });
    assert.deepEqual(namedKinds(r, 1), ['unplaced']);
    assert.match(r.named.find(n => n.id === 1).reason, /cannot place/);
    assert.equal(r.after.counted + r.before.counted, 1, 'only the run git could place is counted');
  });
});

// A recorded job in the shape of the attempts endpoint (`repos/<repo>/actions/runs/<id>/attempts/<n>/jobs`): REST field names.
const jobsWith = (name, over = {}) => [
  { id: 1, name: 'lint', status: 'completed', conclusion: 'success', started_at: '2026-10-23T08:00:00Z', completed_at: '2026-10-23T08:02:00Z',
    steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: '2026-10-23T08:00:00Z', completed_at: '2026-10-23T08:00:01Z' }] },
  { id: 2, name: 'tests', status: 'completed', conclusion: 'success', started_at: '2026-10-23T08:03:00Z', completed_at: '2026-10-23T08:30:00Z',
    steps: [
      { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: '2026-10-23T08:03:00Z', completed_at: '2026-10-23T08:03:02Z' },
      { name, status: 'completed', conclusion: 'success', number: 2, started_at: '2026-10-23T08:05:04Z', completed_at: '2026-10-23T08:22:44Z', ...over },
    ] },
];

describe('dbStepOf: the database step of one attempt\'s jobs, in the attempts endpoint\'s field names', () => {
  // The step's name is derived from ci.yml, as the CLI does, so a rename cannot leave this reading a step that is gone.
  const stepName = async () => {
    const { stepNameRunning } = await import(new URL(`file:///${join(REPO_ROOT, 'scripts', '_shared', 'ci-run-reader.mjs').replace(/\\/g, '/')}`).href);
    return stepNameRunning(/npm run test:standalone:db/);
  };

  it('reads started_at and completed_at as startedAt and completedAt, and the conclusion, of the step found by its name', async () => {
    const { dbStepOf } = await trade();
    assert.equal(typeof dbStepOf, 'function', 'scripts/trade.mjs must export dbStepOf');
    const name = await stepName();
    assert.deepEqual(dbStepOf(jobsWith(name), name), { conclusion: 'success', startedAt: '2026-10-23T08:05:04Z', completedAt: '2026-10-23T08:22:44Z' });
  });

  it('finds the step in whichever job holds it, and keeps a failure\'s conclusion', async () => {
    const { dbStepOf } = await trade();
    const name = await stepName();
    assert.equal(dbStepOf(jobsWith(name, { conclusion: 'failure' }), name).conclusion, 'failure');
  });

  it('a skipped step never started: null, not a step of zero minutes', async () => {
    const { dbStepOf } = await trade();
    const name = await stepName();
    assert.equal(dbStepOf(jobsWith(name, { conclusion: 'skipped', started_at: null, completed_at: null }), name), null);
  });

  it('no job holds the step: null; a job without steps is no error', async () => {
    const { dbStepOf } = await trade();
    assert.equal(dbStepOf(jobsWith('some other step'), 'the step'), null);
    assert.equal(dbStepOf([{ id: 3, name: 'bare' }], 'the step'), null);
    assert.equal(dbStepOf([], 'the step'), null);
  });

  it('a step still running keeps its null fields, so the counting names it missing-field instead of reading zero minutes', async () => {
    const { dbStepOf } = await trade();
    const name = await stepName();
    const got = dbStepOf(jobsWith(name, { status: 'in_progress', conclusion: null, completed_at: null }), name);
    assert.deepEqual(got, { conclusion: null, startedAt: '2026-10-23T08:05:04Z', completedAt: null });
    const r = await report([run({ id: 1, attempts: [attempt(1, got)] })]);
    assert.deepEqual(namedKinds(r, 1), ['missing-field']);
  });
});

describe('cutoverOnMain and gitIsAncestor: git, through an injected exec', () => {
  const SHA_OLD = '1111111111111111111111111111111111111111';
  const SHA_NEW = '2222222222222222222222222222222222222222';
  /** An exec fake: records `[file, args]` and answers or throws. */
  const fakeExec = (answer) => { const calls = []; const exec = (file, args) => { calls.push([file, args]); return answer(file, args); }; exec.calls = calls; return exec; };
  const failing = (message, extra = {}) => () => { throw Object.assign(new Error(message), extra); };

  it('cutoverOnMain asks git for the commits that ADDED scripts/trade.mjs on origin/main, as an argument array, and takes the OLDEST', async () => {
    const { cutoverOnMain } = await trade();
    assert.equal(typeof cutoverOnMain, 'function', 'scripts/trade.mjs must export cutoverOnMain');
    const exec = fakeExec(() => `${SHA_NEW}\n${SHA_OLD}\n`);
    assert.deepEqual(cutoverOnMain({ exec }), { sha: SHA_OLD }, 'git log lists newest first: the last line is the cut-over');
    assert.equal(exec.calls.length, 1);
    const [file, args] = exec.calls[0];
    assert.equal(file, 'git');
    assert.deepEqual(args, ['log', 'origin/main', '--diff-filter=A', '--format=%H', '--', 'scripts/trade.mjs']);
  });

  it('cutoverOnMain reads Windows line endings', async () => {
    const { cutoverOnMain } = await trade();
    assert.deepEqual(cutoverOnMain({ exec: fakeExec(() => `${SHA_NEW}\r\n${SHA_OLD}\r\n`) }), { sha: SHA_OLD });
  });

  it('cutoverOnMain answers sha null WITHOUT a why when the script is not on origin/main yet (an empty log is an answer)', async () => {
    const { cutoverOnMain } = await trade();
    assert.deepEqual(cutoverOnMain({ exec: fakeExec(() => '') }), { sha: null });
  });

  it('cutoverOnMain answers sha null WITH a why when git is not found', async () => {
    const { cutoverOnMain } = await trade();
    const got = cutoverOnMain({ exec: fakeExec(failing('spawn git ENOENT', { code: 'ENOENT' })) });
    assert.equal(got.sha, null);
    assert.match(got.why, /ENOENT/);
  });

  it('cutoverOnMain answers sha null WITH a why when origin/main does not exist (a clone with no remote)', async () => {
    const { cutoverOnMain } = await trade();
    const got = cutoverOnMain({ exec: fakeExec(failing("Command failed: git log origin/main\nfatal: ambiguous argument 'origin/main': unknown revision", { status: 128 })) });
    assert.equal(got.sha, null);
    assert.match(got.why, /Command failed/);
    assert.ok(!got.why.includes('\n'), 'one line');
  });

  it('cutoverOnMain refuses a line that is no commit id: a garbage answer is not a cut-over', async () => {
    const { cutoverOnMain } = await trade();
    const got = cutoverOnMain({ exec: fakeExec(() => 'warning: something\n') });
    assert.equal(got.sha, null);
    assert.ok(got.why, 'and says why');
  });

  it('gitIsAncestor is true when git exits 0, with the ids as their own arguments after the subcommand', async () => {
    const { gitIsAncestor } = await trade();
    assert.equal(typeof gitIsAncestor, 'function', 'scripts/trade.mjs must export gitIsAncestor');
    const exec = fakeExec(() => '');
    assert.equal(gitIsAncestor(SHA_OLD, SHA_NEW, { exec }), true);
    assert.deepEqual(exec.calls[0], ['git', ['merge-base', '--is-ancestor', SHA_OLD, SHA_NEW]]);
  });

  it('gitIsAncestor is false when git exits 1 (not an ancestor)', async () => {
    const { gitIsAncestor } = await trade();
    assert.equal(gitIsAncestor(SHA_OLD, SHA_NEW, { exec: fakeExec(failing('exit 1', { status: 1 })) }), false);
  });

  it('gitIsAncestor THROWS when git cannot answer (exit 128, an unfetched commit), and says to fetch', async () => {
    const { gitIsAncestor } = await trade();
    assert.throws(() => gitIsAncestor(SHA_OLD, SHA_NEW, { exec: fakeExec(failing('fatal: Not a valid commit name', { status: 128 })) }), /git fetch origin/);
  });

  for (const bad of ['', 'abc', '--upload-pack=x', `${SHA_OLD}0`, 'A'.repeat(40), 'HEAD', `${SHA_OLD}\n`, null, undefined]) {
    it(`gitIsAncestor refuses ${JSON.stringify(bad)} before git is called`, async () => {
      const { gitIsAncestor } = await trade();
      for (const [a, d] of [[bad, SHA_NEW], [SHA_OLD, bad]]) {
        const exec = fakeExec(() => '');
        assert.throws(() => gitIsAncestor(a, d, { exec }), /not a commit id/);
        assert.equal(exec.calls.length, 0, 'git was not called');
      }
    });
  }
});

describe('the budget: runs the ten minutes did not reach are named, and the bound is checked between attempts and before git', () => {
  const STEP = 'the database step';
  const entry = (id, attempts = 1, over = {}) => ({ databaseId: id, headBranch: `full-run/bundle-${id}`, headSha: AFTER_SHA, createdAt: '2026-10-23T08:00:00Z', attempt: attempts, ...over });
  /** A gh fake answering every attempts call with one database step, advancing a fake clock by `cost` ms per call. */
  const clockedGh = (clock, cost) => {
    const calls = [];
    const gh = (args) => {
      calls.push(args); clock.t += cost;
      return { total_count: 1, jobs: [{ steps: [{ name: STEP, conclusion: 'success', started_at: '2026-10-23T08:05:00Z', completed_at: '2026-10-23T08:15:00Z' }] }] };
    };
    gh.calls = calls;
    return gh;
  };

  it('a run past the deadline is not read and is marked unread, and the report names it unread-budget', async () => {
    const { readRuns, tradeReport } = await trade();
    assert.equal(typeof readRuns, 'function', 'scripts/trade.mjs must export readRuns');
    const clock = { t: 0 };
    const gh = clockedGh(clock, 2000);
    const { runs, unread } = await readRuns({ listing: [entry(1), entry(2), entry(3)], wanted: null, stepName: STEP, deadline: 1000, now: () => clock.t, gh });
    assert.deepEqual(unread, [2, 3], 'run 1 was read before the deadline; the others were not');
    assert.equal(gh.calls.length, 1, 'gh is not called for a run past the deadline');
    assert.deepEqual(runs.map(r => r.id), [1, 2, 3]);
    assert.equal(runs[0].attempts.length, 1);
    assert.deepEqual(runs.slice(1).map(r => [r.unread, r.attempts.length]), [['budget', 0], ['budget', 0]]);
    const r = tradeReport({ runs, cutoverSha: CUTOVER, isAncestor: isAncestorOf() });
    assert.deepEqual([namedKinds(r, 2), namedKinds(r, 3)], [['unread-budget'], ['unread-budget']]);
    assert.equal(r.after.counted, 1);
  });

  it('the deadline is also checked BETWEEN a run\'s attempts: a run cut after attempt 1 of 3 is unread whole, not counted on attempt 1 alone', async () => {
    const { readRuns } = await trade();
    const clock = { t: 0 };
    const gh = clockedGh(clock, 2000);
    const { runs, unread } = await readRuns({ listing: [entry(1, 3)], wanted: null, stepName: STEP, deadline: 1000, now: () => clock.t, gh });
    assert.equal(gh.calls.length, 1, 'attempt 2 was not asked for after the deadline');
    assert.deepEqual(unread, [1]);
    assert.equal(runs[0].unread, 'budget');
    assert.deepEqual(runs[0].attempts, [], 'a partly read run carries no attempts, so it cannot be counted as a run that never failed');
  });

  it('within the deadline every attempt is read and nothing is unread', async () => {
    const { readRuns } = await trade();
    const clock = { t: 0 };
    const gh = clockedGh(clock, 1);
    const { runs, unread } = await readRuns({ listing: [entry(1, 2)], wanted: null, stepName: STEP, deadline: 1000, now: () => clock.t, gh });
    assert.deepEqual(unread, []);
    assert.deepEqual(runs[0].attempts.map(a => [a.attempt, a.dbStep?.conclusion]), [[1, 'success'], [2, 'success']]);
  });

  it('a probe is kept for the report to name but never read, and a bundle not asked for is skipped (--line)', async () => {
    const { readRuns } = await trade();
    const clock = { t: 0 };
    const gh = clockedGh(clock, 1);
    const listing = [entry(1, 1, { headBranch: 'full-run/probe-b85' }), entry(2), entry(3)];
    const all = await readRuns({ listing, wanted: null, stepName: STEP, deadline: 1000, now: () => clock.t, gh });
    assert.deepEqual(all.runs.map(r => r.id), [1, 2, 3]);
    assert.equal(gh.calls.length, 2, 'the probe was not read');
    const some = await readRuns({ listing, wanted: new Set(['2']), stepName: STEP, deadline: 1000, now: () => clock.t, gh });
    assert.deepEqual(some.runs.map(r => r.id), [2], 'only the wanted bundle');
  });

  it('git calls are under the same budget: placeWithin refuses once the deadline has passed, so the head is named unplaced', async () => {
    const { placeWithin, tradeReport } = await trade();
    assert.equal(typeof placeWithin, 'function', 'scripts/trade.mjs must export placeWithin');
    const clock = { t: 0 };
    const placed = placeWithin(isAncestorOf(), { deadline: 1000, now: () => clock.t });
    assert.equal(placed(CUTOVER, AFTER_SHA), true, 'inside the budget it answers as git does');
    clock.t = 2000;
    assert.throws(() => placed(CUTOVER, AFTER_SHA), /budget/i);
    const r = tradeReport({ runs: [run({ id: 1 })], cutoverSha: CUTOVER, isAncestor: placed });
    assert.deepEqual(namedKinds(r, 1), ['unplaced']);
    assert.match(r.named[0].reason, /budget/i);
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
