/**
 * What does it cost, and what does it save, that local preflight runs no database test file? (Q-588)
 *
 * `node scripts/trade.mjs [--limit N] [--line <ref>...]` reads the push runs of `full-run.yml` through `gh` and counts them by
 * their DATABASE STEP: the step of `ci.yml` that runs `npm run test:standalone:db`, found by what it runs (the shared reader,
 * `./_shared/ci-run-reader.mjs`), never by a name written here.
 *
 * ## The question, and the three figures
 *
 * Owner decision (2026-10-22): local preflight runs the pure test files only; CI's Full run runs the database ones. Whether that
 * is a good trade is a measurement, in three units that are never added together:
 *
 * - **saved** (CI minutes): the database step's time in each counted run's FIRST attempt that ran the step (an attempt 1 that was
 *   a setup failure has no step; the first one that ran it is read). A proxy, and said so: the local skip
 *   happens per preflight and its local time is not measured; the figure is what a Full run spends on the database half.
 * - **cost** (CI minutes): the database step's time in the extra attempts and extra runs a failure caused - every attempt that
 *   started after a failed one and before the next green one, across the runs of one bundle.
 * - **calendar** (wall-clock minutes): from a failing database step's end to the next green database step's end. Waiting, not CI
 *   time, so it is printed on its own line and never inside `net` (`net = saved - cost`).
 *
 * ## The counting rules (`tradeReport`, a pure function over runs already read)
 *
 * | a run | counted | note |
 * |---|---|---|
 * | the database step failed in ANY attempt | one failure | `gh run view --json jobs` shows only the latest attempt; every attempt is read |
 * | the step was cancelled, a newer run of the SAME REF was created no later than the step's end | excluded, named `superseded` | that push cancelled it: `full-run.yml` cancels per ref (its concurrency group is the ref), so another ref of the bundle cancels nothing |
 * | the step was cancelled, no such run | one failure and a timeout | the job's 30-minute limit reads as cancelled; a push that came after the cancel did not cause it |
 * | no attempt ran the step | named `never-started` | a setup failure is not a test failure; an attempt 1 that never ran it and an attempt 2 that did is read from attempt 2 |
 * | the budget ended before the run was read (or between its attempts) | named `unread-budget` | a part-read run is not counted on the attempts read |
 * | git cannot place the run's head against the cut-over (not fetched, not a commit id, or the budget ended) | named `unplaced` | |
 * | a field is missing (`startedAt`, `completedAt`, `conclusion`, `headSha`, `createdAt`, `ref`, or no attempt) | named `missing-field` | never zero minutes |
 * | `full-run/bundle-106-a0` and `full-run/bundle-106-a` | one bundle, `106` | a bundle spans refs |
 * | `full-run/probe-b85` | named `not-a-bundle` | a probe is no bundle |
 * | the head does not descend from the cut-over | `before` | the old regime: those runs ran under a preflight that ran the database half |
 *
 * ## The cut-over
 *
 * Runs whose head descends from the commit that added this script to `origin/main` are "after"; every earlier run is the
 * baseline ("before"), reported apart, because it measures the regime this one replaced. The commit is DERIVED
 * (`git log origin/main --diff-filter=A -- scripts/trade.mjs`, the oldest), so nothing has to be edited after the merge, and a
 * rebase merge's rewritten SHA is the one found. When the script is not on `origin/main` yet, no run is "after" and the report
 * says so. Q-588's merge may be several commits; the first one carrying this file is the cut-over, which is at most a few
 * commits before the one that stopped preflight running the database half.
 *
 * ## Scope, and exit codes
 *
 * Pull request runs of `ci.yml` are outside the report: a bundle's database failure at pull-request time shows in its pull
 * request. Exit 0: a report was printed. Exit 2: a bad argument (refused before any `gh` call), `gh` missing or not logged in,
 * a listing that fills `--limit` (a cut listing reads as a quiet history), or any failed read. An overall budget of ten minutes
 * ends the reading; the report is printed with the runs it did not read named (`unread-budget`, `unplaced`). **What the bound
 * covers:** it is checked before every attempt's `gh` call (so between a run's attempts too) and before every `git` placement of
 * a head; a call already in flight is bounded by its own 60 s timeout, so the whole can run to the budget plus one call. The
 * first listing call and the one cut-over lookup are outside it, each with that 60 s bound.
 *
 * `--line <ref>...` prints one `trade:` line per bundle (for a Work-Log), reading only those bundles' runs.
 *
 * ## Recording a bundle, and reading the records back (Q-590)
 *
 * A figure that is printed and lost cannot show a trend, and whether skipping the database tests locally pays off is a question
 * about a trend. `--record <ref>...` writes ONE `Trade` chrono entry per BUNDLE to the Ythril instance
 * `YTHRIL_TEST_RUNS_URL` names (space `y-proj-ythril`, token `YTHRIL_TEST_RUNS_TOKEN`; the refs of one bundle, `bundle-106-a0` and
 * `bundle-106-a`, are one record, keyed `trade:106`). The type, its fields and the one-time declaration are
 * `scripts/_shared/telemetry-record.mjs`'s (`--type-schema` prints the `schema_update` arguments); the destination and the CI
 * refusal are `_shared/record-destination.mjs`'s; the lock around find-plus-write, taken after all reading, is
 * `_shared/record-lock.mjs`'s and lives in the git common dir.
 *
 * - **A bundle is refused, never recorded wrong,** and nothing is sent when any asked-for bundle is refused: the cut-over is
 *   unknown; the bundle has no counted run after it; a run of it is `unread-budget`, `unplaced` or `missing-field` (its figures
 *   would be partial). Each is named with its bundle on a `trade:` line, exit 2.
 * - **The entry's dates are the counted runs':** `startsAt` the first counted run's creation, `endsAt` the last completion of a
 *   counted run (the bundle entry of `tradeReport` carries `firstCreatedMs` and `lastCompletedMs`).
 * - **A re-record replaces** the stored record only when its run ids contain every run id the stored one holds: the listing shows
 *   the latest runs only, so an older run that has dropped off would otherwise be erased from the record. Otherwise the stored
 *   record is KEPT, and the line says it holds runs the listing no longer shows. Every field is written every time.
 * - **The listing is read at `--limit`, and once more at {@link RECORD_LIMIT_CEILING} when that filled it:** two reads at most, not
 *   one per doubling. A listing that fills the ceiling is refused naming `--limit`, because a record made from a cut listing is wrong.
 * - **A bundle's number is one bundle in any spelling:** `bundle-106` asked for reads the runs of `bundle-0106` too, and a listing
 *   that holds both spellings is refused naming both (their figures cannot be told apart).
 * - **Exit codes:** 0 recorded or kept; 2 for a bad argument, an unset destination, CI (`GITHUB_ACTIONS` / `CI`: CI never holds
 *   the token), a refused bundle, a failed write, a record lock still held when its wait runs out
 *   (`YTHRIL_TEST_RUNS_LOCK_WAIT_MS`, default two minutes; nothing was written), or any failed read. Never 0 for a recording that
 *   did not happen.
 * - **`--history`** reads the `Trade` records back: failure rate as sum(afterFailures) over sum(afterCounted) across records (not
 *   a mean of per-record rates), and the mean saved, cost and net per bundle, over the records with a counted run. It needs
 *   `YTHRIL_TEST_RUNS_URL` / `_TOKEN`, is refused under CI (the token is not there), and refuses when the instance holds more
 *   `Trade` records than it read. `--type-schema` prints indented JSON.
 * - **`gh` and `git` are started with `testChildEnv()`,** so the recorder's token is never handed to them.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { isEntryPoint } from './_shared/script-cli.mjs';
import { ghJson, runAttemptsJobs, stepNameRunning, REPO_SLUG } from './_shared/ci-run-reader.mjs';
import { FULL_RUN_WORKFLOW } from '../testing/_shared/ci-workflow-path.mjs';
import { testChildEnv } from '../testing/_shared/test-child-env.mjs';
import { recordDestination, refuseRecordingUnderCi } from './_shared/record-destination.mjs';
import { withRecordLock } from './_shared/record-lock.mjs';
import {
  TRADE_SPEC, TRADE_FORMAT_VERSION, telemetryTypeDeclaration, checkTelemetryProperties, upsertTelemetryRecords,
} from './_shared/telemetry-record.mjs';

const DEFAULT_LIMIT = 500;
/** The most runs `--record` reads: its limit doubles from `--limit` up to this, and a listing that still fills it is refused. */
export const RECORD_LIMIT_CEILING = 5000;
/** The overall bound on reading, in milliseconds. */
const BUDGET_MS = 10 * 60_000;
const USAGE = [
  'usage: node scripts/trade.mjs [--limit N] [--line <ref>...]      print the report, or one line per bundle',
  '       node scripts/trade.mjs [--limit N] --record <ref>...      record each bundle as a Trade entry (YTHRIL_TEST_RUNS_URL, YTHRIL_TEST_RUNS_TOKEN)',
  '       node scripts/trade.mjs --history                          the recorded trade over time',
  '       node scripts/trade.mjs --type-schema                      the schema_update arguments that declare the Trade type',
  '  (N a whole number from 1, default 500; a ref is full-run/<name>; the modes cannot be combined)',
  '  YTHRIL_TEST_RUNS_LOCK_WAIT_MS: how long --record waits for the record lock, in ms (a positive integer, default 120000)',
].join('\n');

// ────────────────────────────────────────────────────── the pure part ──────────────────────────────────────────────────────

/**
 * The bundle number (a string) of a ref `full-run/bundle-<n>` or `full-run/b<n>`, with an optional `-suffix` or `.suffix`;
 * null for anything else. Both spellings are in the history (`full-run/b169` is a bundle's Full run), so the short one counts.
 */
export function bundleOf(ref) {
  if (typeof ref !== 'string') return null;
  const m = /^full-run\/(?:bundle-|b)(\d+)(?:[-.][\w.-]*)?$/.exec(ref);
  return m ? m[1] : null;
}

/**
 * A bundle's number as the one spelling a comparison or a record key uses: `0106` and `106` are one bundle. Every place that asks
 * "is this the bundle that was asked for" compares through it (the runs to read, the record's runs, its key), so a run pushed to
 * `full-run/bundle-0106` is read when `bundle-106` is asked for, and the two spellings meet in the refusal instead of being missed.
 */
export const keyNumber = (bundle) => String(Number(bundle));

/** A `--line` ref: `full-run/<name>` with word characters, dots and dashes. Throws on anything else, before any `gh` call. */
export function checkLineRef(ref, flag = '--line') {
  if (typeof ref !== 'string' || !/^full-run\/[\w.-]+$/.test(ref)) throw new Error(`${flag} takes refs of the form full-run/<name>, not ${JSON.stringify(ref)}`);
  return ref;
}

/** Throws when a listing fills its limit: older runs were cut, and a cut listing reads as a quiet history. */
export function checkListing(runs, limit) {
  if (runs.length >= limit) throw new Error(`the listing holds ${runs.length} runs, which fills the limit of ${limit}: older runs are cut; raise --limit`);
  return runs;
}

/**
 * The arguments, or a thrown usage error: `{ limit, lines, record, typeSchema, history }`. `--line` and `--record` take every ref
 * up to the next `--` option, each a bundle's ref. The four modes (the plain report, `--line`, `--record`, `--history`,
 * `--type-schema`) are exclusive, and `--limit` belongs to the ones that read runs.
 */
export function parseArgs(argv) {
  let limit = null;
  const lines = [];
  const record = [];
  let typeSchema = false;
  let history = false;
  const modes = [];
  const mode = (flag) => { if (!modes.includes(flag)) modes.push(flag); };
  const refsOf = (flag, i) => {
    const refs = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) refs.push(checkLineRef(argv[++i], flag));
    if (refs.length === 0) throw new Error(`${flag} takes at least one ref`);
    for (const ref of refs) if (bundleOf(ref) === null) throw new Error(`${flag} ${ref} is no bundle: a bundle's ref is full-run/bundle-<n> or full-run/b<n>`);
    return refs;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      const v = argv[++i];
      if (v === undefined || !/^[1-9]\d*$/.test(v)) throw new Error('--limit takes a whole number from 1');
      limit = Number(v);
    } else if (a === '--line' || a === '--record') {
      const refs = refsOf(a, i);
      i += refs.length;
      (a === '--line' ? lines : record).push(...refs);
      mode(a);
    } else if (a === '--history') { history = true; mode(a); }
    else if (a === '--type-schema') { typeSchema = true; mode(a); }
    else {
      throw new Error(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  if (modes.length > 1) throw new Error(`${modes[0]} cannot be combined with ${modes[1]}: one mode at a time`);
  if (limit !== null && (history || typeSchema)) throw new Error(`--limit reads runs, and ${modes[0]} reads none`);
  return { limit: limit ?? DEFAULT_LIMIT, lines, record, typeSchema, history };
}

const FAILING = new Set(['failure', 'timed_out']);
const KNOWN = new Set(['success', 'cancelled', ...FAILING]);

/** One attempt's database step as minutes, or `{ missing }` naming the field it lacks. */
function readStep(step) {
  for (const f of ['conclusion', 'startedAt', 'completedAt']) {
    if (typeof step[f] !== 'string' || !step[f]) return { missing: f };
  }
  const startedMs = Date.parse(step.startedAt);
  const completedMs = Date.parse(step.completedAt);
  if (Number.isNaN(startedMs)) return { missing: 'startedAt' };
  if (Number.isNaN(completedMs) || completedMs < startedMs) return { missing: 'completedAt' };
  if (!KNOWN.has(step.conclusion)) return { missing: `a conclusion it reads (it is ${JSON.stringify(step.conclusion)})` };
  return { conclusion: step.conclusion, completedMs, minutes: (completedMs - startedMs) / 60_000 };
}

/** The figures of one bundle's runs (already classified, one bucket), in the order the runs were made. */
function afterTotals(entries) {
  const t = { counted: 0, failures: 0, timeouts: [], savedMinutes: 0, costMinutes: 0, calendarMinutes: 0, unresolved: [], firstCreatedMs: null, lastCompletedMs: null };
  let openAt = null;
  let openId = null;
  for (const e of [...entries].sort((a, b) => a.createdMs - b.createdMs || a.id - b.id)) {
    t.counted += 1;
    t.firstCreatedMs ??= e.createdMs;
    for (const s of e.steps) t.lastCompletedMs = Math.max(t.lastCompletedMs ?? -Infinity, s.completedMs);
    t.savedMinutes += e.firstMinutes;
    if (e.failed) t.failures += 1;
    if (e.timeout) t.timeouts.push(e.id);
    for (const s of e.steps) {
      // An attempt that starts while a failure is still unanswered is a repeat the failure caused: that is the cost.
      if (openAt !== null) t.costMinutes += s.minutes;
      if (s.conclusion !== 'success') {
        if (openAt === null) { openAt = s.completedMs; openId = e.id; }
      } else if (openAt !== null) {
        t.calendarMinutes += (s.completedMs - openAt) / 60_000;
        openAt = null;
      }
    }
  }
  if (openAt !== null) t.unresolved.push(openId);
  t.netMinutes = t.savedMinutes - t.costMinutes;
  return t;
}

/**
 * The report over runs already read.
 *
 * @param {{ runs: Array<{ id: number, ref: string, headSha: string, createdAt: string,
 *   attempts: Array<{ attempt: number, dbStep: { conclusion: string, startedAt: string, completedAt: string } | null }> }>,
 *   cutoverSha: string | null, isAncestor: (ancestor: string, descendant: string) => boolean }} input
 *   `dbStep` is the step that runs the database tests (null when it never started); `cutoverSha` null means no run is "after". A run
 *   the budget ended before it was read carries `unread: 'budget'` and no attempts. `isAncestor` throwing names the run `unplaced`.
 * @returns {{ after: object, before: { counted: number, failures: number }, named: object[], bundles: object[] }}
 */
export function tradeReport({ runs, cutoverSha, isAncestor }) {
  const named = [];
  const nameIt = (run, kind, reason) => named.push({ id: run.id, ref: run.ref, kind, reason });
  const stampOf = (run) => (typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : NaN);

  // The runs of each bundle, for the per-bundle figures (a bundle spans refs).
  const bundleRuns = new Map();
  for (const run of runs) {
    const bundle = bundleOf(run.ref);
    if (bundle === null) continue;
    if (!bundleRuns.has(bundle)) bundleRuns.set(bundle, []);
    bundleRuns.get(bundle).push(run);
  }
  // A cancelled step is superseded only by a push: a newer run of the SAME REF (full-run.yml's concurrency group is the ref, so
  // another ref of the bundle cancels nothing), created no later than the moment the step was cancelled. A newer run created after
  // it did not cancel anything, and the step's end was the job's own limit.
  const supersedes = (run, step) => runs.some(o => o !== run && o.ref === run.ref && stampOf(o) > stampOf(run) && stampOf(o) <= step.completedMs);

  const entries = new Map(); // bundle -> { after: [], before: [] }
  const bucketsOf = (bundle) => { if (!entries.has(bundle)) entries.set(bundle, { after: [], before: [] }); return entries.get(bundle); };
  const ancestry = new Map();

  for (const run of runs) {
    const lacks = ['ref', 'headSha', 'createdAt'].find(f => typeof run[f] !== 'string' || !run[f]);
    if (lacks) { nameIt(run, 'missing-field', `the run has no ${lacks}`); continue; }
    const bundle = bundleOf(run.ref);
    if (bundle === null) { nameIt(run, 'not-a-bundle', `${run.ref} is no bundle (a bundle's ref is full-run/bundle-<n> or full-run/b<n>)`); continue; }
    const createdMs = stampOf(run);
    if (Number.isNaN(createdMs)) { nameIt(run, 'missing-field', `createdAt ${JSON.stringify(run.createdAt)} is not a time`); continue; }
    if (run.unread === 'budget') { nameIt(run, 'unread-budget', 'the budget ended before the run was read (every attempt of a run is read, or none)'); continue; }
    if (!Array.isArray(run.attempts) || run.attempts.length === 0) { nameIt(run, 'missing-field', 'the run has no attempt to read'); continue; }
    if (run.attempts.every(a => a.dbStep == null)) { nameIt(run, 'never-started', 'the database step never started in any attempt (a setup failure, not a test failure)'); continue; }

    let broken = null;
    const steps = [];
    for (const a of run.attempts) {
      if (a.dbStep == null) continue; // a later attempt that did not run the step adds no minutes, and none are invented
      const read = readStep(a.dbStep);
      if (read.missing) { broken = `attempt ${a.attempt}'s database step lacks ${read.missing}`; break; }
      steps.push(read);
    }
    if (broken) { nameIt(run, 'missing-field', broken); continue; }

    // A cancelled step that a newer push to the same ref cancelled says nothing about the tests.
    const kept = steps.filter(s => !(s.conclusion === 'cancelled' && supersedes(run, s)));
    if (kept.length === 0) { nameIt(run, 'superseded', 'its database step was cancelled by a newer run of the same ref, created before the cancel ended'); continue; }

    let after;
    if (cutoverSha == null) after = false;
    else {
      try {
        if (!ancestry.has(run.headSha)) ancestry.set(run.headSha, Boolean(isAncestor(cutoverSha, run.headSha)));
        after = ancestry.get(run.headSha);
      } catch (e) {
        nameIt(run, 'unplaced', `its head ${run.headSha.slice(0, 8)} could not be placed against the cut-over: ${String(e.message ?? e).split('\n')[0]}`);
        continue;
      }
    }
    bucketsOf(bundle)[after ? 'after' : 'before'].push({
      id: run.id, createdMs, steps: kept, firstMinutes: steps[0].minutes,
      failed: kept.some(s => s.conclusion !== 'success'),
      timeout: kept.some(s => s.conclusion === 'cancelled' || s.conclusion === 'timed_out'),
    });
  }

  const total = { counted: 0, failures: 0, timeouts: [], savedMinutes: 0, costMinutes: 0, calendarMinutes: 0, unresolved: [] };
  const before = { counted: 0, failures: 0 };
  const bundles = [...bundleRuns.keys()].sort((a, b) => Number(a) - Number(b)).map((bundle) => {
    const b = entries.get(bundle) ?? { after: [], before: [] };
    const { firstCreatedMs, lastCompletedMs, ...bundleAfter } = afterTotals(b.after);
    const bundleBefore = { counted: b.before.length, failures: b.before.filter(e => e.failed).length };
    for (const k of ['counted', 'failures', 'savedMinutes', 'costMinutes', 'calendarMinutes']) total[k] += bundleAfter[k];
    total.timeouts.push(...bundleAfter.timeouts);
    total.unresolved.push(...bundleAfter.unresolved);
    before.counted += bundleBefore.counted;
    before.failures += bundleBefore.failures;
    // firstCreatedMs / lastCompletedMs: the counted runs' creation and completion (null when none counted), for a record's dates.
    return { bundle, runIds: bundleRuns.get(bundle).map(r => r.id), after: bundleAfter, before: bundleBefore, firstCreatedMs, lastCompletedMs };
  });
  total.netMinutes = total.savedMinutes - total.costMinutes;
  return { after: total, before, named, bundles };
}

// ───────────────────────────────────────────────────── printing the report ──────────────────────────────────────────────────

const mins = (m) => `${m.toFixed(1)} min`;
const ids = (list) => (list.length ? list.join(', ') : 'none');

/** The report as lines for a person. `notes` are the facts about how it was read (cut-over unknown, the budget). */
export function reportLines(report, { cutoverSha, limit, notes = [] }) {
  const { after, before, named } = report;
  const lines = [
    'trade: local preflight runs no database test file; CI\'s Full run runs them (Q-588).',
    `Scope: push runs of full-run.yml, the latest ${limit} at most. Pull request runs of ci.yml are outside this report: a bundle's database failure at pull-request time shows in its pull request.`,
    'Saved is CI time (the database step of each Full run), a proxy: the local skip happens per preflight and its local time is not measured.',
    cutoverSha ? `Cut-over: ${cutoverSha.slice(0, 8)}, the first commit on origin/main that holds scripts/trade.mjs.` : 'Cut-over: unknown (scripts/trade.mjs is not on origin/main yet), so every run is reported as before.',
    ...notes,
    '',
    `Before the cut-over (the baseline, under a preflight that ran the database half): ${before.counted} run(s) counted, ${before.failures} database-step failure(s).`,
    `After the cut-over: ${after.counted} run(s) counted, ${after.failures} database-step failure(s), ${after.timeouts.length} of them timeouts (runs: ${ids(after.timeouts)}).`,
    `  CI minutes: saved ${mins(after.savedMinutes)}, cost ${mins(after.costMinutes)}, net ${mins(after.netMinutes)}.`,
    `  Calendar: ${mins(after.calendarMinutes)} of waiting from a failing database step to the next green one (not in net).`,
  ];
  if (after.unresolved.length) lines.push(`  Failures with no green step after them (runs: ${ids(after.unresolved)}): their waiting is not in the calendar figure.`);
  if (named.length) {
    lines.push('', `Left out or unreadable (${named.length}):`);
    for (const n of named) lines.push(`  ${n.id} ${n.ref ?? '(no ref)'} [${n.kind}] ${n.reason}`);
  }
  return lines;
}

/** One `trade:` line for a bundle, for a Work-Log. */
export function bundleLine(ref, entry, { limit, notes = [] }) {
  const suffix = notes.length ? ` [${notes.join(' ')}]` : '';
  if (!entry) return `trade: ${ref} bundle ${bundleOf(ref)}: no run of this bundle among the latest ${limit} push runs of full-run.yml${suffix}`;
  const { after: a, before: b } = entry;
  const kept = `after the cut-over ${a.counted} counted, ${a.failures} failure(s), ${a.timeouts.length} timeout(s), CI saved ${mins(a.savedMinutes)} cost ${mins(a.costMinutes)} net ${mins(a.netMinutes)}, calendar ${mins(a.calendarMinutes)} (proxy: CI time)`;
  return `trade: ${ref} bundle ${entry.bundle}, ${entry.runIds.length} run(s): ${kept}; before the cut-over ${b.counted} counted, ${b.failures} failure(s)${suffix}`;
}

// ───────────────────────────────────────────────────── reading, and the CLI ─────────────────────────────────────────────────

/** The database step of one attempt's jobs (REST field names), or null when no job holds it or it was skipped (it never started). */
export function dbStepOf(jobs, stepName) {
  const step = jobs.flatMap(j => j.steps ?? []).find(s => s.name === stepName);
  if (!step || step.conclusion === 'skipped') return null;
  return { conclusion: step.conclusion, startedAt: step.started_at, completedAt: step.completed_at };
}

/**
 * The oldest commit on origin/main that added this script: `{ sha }`, or `{ sha: null }` when the log is empty (it is not there
 * yet), or `{ sha: null, why }` when git cannot say (not found, no origin/main) or answers with something that is no commit id.
 *
 * @param {{ exec?: typeof execFileSync }} [options]  injected by gates
 */
export function cutoverOnMain({ exec = execFileSync } = {}) {
  try {
    const out = String(exec('git', ['log', 'origin/main', '--diff-filter=A', '--format=%H', '--', 'scripts/trade.mjs'], { encoding: 'utf8', timeout: 60_000, env: testChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
    const shas = out.split(/\r?\n/).filter(Boolean);
    if (shas.length === 0) return { sha: null };
    const oldest = shas[shas.length - 1];
    if (!COMMIT_ID.test(oldest)) return { sha: null, why: `git log printed ${JSON.stringify(oldest.slice(0, 60))}, which is no commit id` };
    return { sha: oldest };
  } catch (e) {
    return { sha: null, why: String(e.message ?? e).split('\n')[0] };
  }
}

/**
 * `git merge-base --is-ancestor`: true, false, or a thrown error when git cannot answer (an unfetched commit). Both ids must be
 * 40 lowercase hex characters, refused before git is called: an id becomes an argument, and `--upload-pack=x` is no commit.
 *
 * @param {{ exec?: typeof execFileSync }} [options]  injected by gates
 */
export function gitIsAncestor(ancestor, descendant, { exec = execFileSync } = {}) {
  for (const sha of [ancestor, descendant]) if (typeof sha !== 'string' || !COMMIT_ID.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit id`);
  try {
    exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { timeout: 60_000, env: testChildEnv(), stdio: 'ignore' });
    return true;
  } catch (e) {
    if (e?.status === 1) return false;
    throw new Error(`git cannot place the commit (is it fetched? run git fetch origin): ${e?.message ?? e}`);
  }
}

const COMMIT_ID = /^[0-9a-f]{40}$/;

/** Thrown when the overall budget has ended: the reading stops, and what was not reached is named, never read short. */
export class BudgetEndedError extends Error {
  constructor() { super('the budget ended'); this.name = 'BudgetEndedError'; }
}

/** The budget as a check: throws {@link BudgetEndedError} once `now()` is past `deadline`. */
function checkBudget({ deadline, now }) {
  return () => { if (now() > deadline) throw new BudgetEndedError(); };
}

/**
 * `isAncestor` under the same budget as the reads: once the deadline has passed it throws instead of calling git, so the head is
 * named `unplaced` (with the budget as its reason) and the time git takes is counted against the ten minutes.
 */
export function placeWithin(isAncestor, { deadline, now = Date.now }) {
  const check = checkBudget({ deadline, now });
  return (ancestor, descendant) => {
    try { check(); } catch { throw new Error('the budget ended before git could place this head'); }
    return isAncestor(ancestor, descendant);
  };
}

/**
 * Reads the attempts of every run `wanted` asks for (all, when `wanted` is null; `wanted` holds bundle keys, {@link keyNumber}, so
 * both spellings of a number are read), checking the budget before every attempt's `gh`
 * call. A run the budget ended before or between its attempts is returned with `unread: 'budget'` and NO attempts (a part-read run
 * would count as one that never failed in the attempts it was not asked for) and its id is listed in `unread`. A probe is kept
 * unread for the report to name, unless a bundle was asked for.
 *
 * @returns {Promise<{ runs: object[], unread: number[] }>}
 */
export async function readRuns({ listing, wanted, stepName, deadline, now = Date.now, gh = ghJson }) {
  const beforeAttempt = checkBudget({ deadline, now });
  const runs = [];
  const unread = [];
  for (const r of listing) {
    const base = { id: r.databaseId, ref: r.headBranch, headSha: r.headSha, createdAt: r.createdAt, attempts: [] };
    const bundle = bundleOf(r.headBranch);
    if (bundle === null) { if (!wanted) runs.push(base); continue; } // a probe: named by the report, never read
    if (wanted && !wanted.has(keyNumber(bundle))) continue;
    if (!Number.isInteger(r.attempt)) { runs.push(base); continue; }
    try {
      const read = await runAttemptsJobs(r.databaseId, r.attempt, { gh, beforeAttempt });
      runs.push({ ...base, attempts: read.map(({ attempt, jobs }) => ({ attempt, dbStep: dbStepOf(jobs, stepName) })) });
    } catch (e) {
      if (!(e instanceof BudgetEndedError)) throw e;
      unread.push(r.databaseId);
      runs.push({ ...base, unread: 'budget' });
    }
  }
  return { runs, unread };
}

// ───────────────────────────────────────────────────── recording a bundle ────────────────────────────────────────────────────

const round2 = (x) => Math.round(x * 100) / 100;
const KINDS_THAT_MAKE_FIGURES_PARTIAL = ['unread-budget', 'unplaced', 'missing-field'];

/**
 * The `Trade` payloads for `bundles` (numbers as text), or the reasons a bundle cannot be recorded. Pure: a report already read.
 *
 * A bundle is refused, never recorded wrong, when the cut-over is unknown (every run would read as "before"); when it has no
 * counted run after the cut-over (a record of nothing); when a run of it is `unread-budget`, `unplaced` or `missing-field` (its
 * figures would be partial); or when its number is spelled two ways in the listing (`bundle-106` and `bundle-0106` are two
 * entries of the report, and one record, so their figures cannot be told apart). The runs of every spelling were read when ANY
 * spelling was asked for, so the refusal fires whenever the listing holds two, not only when both were asked.
 *
 * @param {{ report: ReturnType<typeof tradeReport>, runs: object[], cutoverSha: string|null, bundles: string[] }} input
 * @returns {{ payloads: object[], refusals: string[] }}  each refusal is one line naming the bundle and the reason
 */
export function tradeRecords({ report, runs, cutoverSha, bundles }) {
  const payloads = [];
  const refusals = [];
  for (const key of bundles) {
    const mine = runs.filter(r => bundleOf(r.ref) !== null && keyNumber(bundleOf(r.ref)) === key);
    const entries = report.bundles.filter(b => keyNumber(b.bundle) === key);
    const named = report.named.filter(n => mine.some(r => r.id === n.id));
    const partial = named.filter(n => KINDS_THAT_MAKE_FIGURES_PARTIAL.includes(n.kind));
    if (!cutoverSha) { refusals.push(`bundle ${key}: the cut-over is unknown (scripts/trade.mjs is not on origin/main, or git cannot say), so no run can be told from the old regime`); continue; }
    if (entries.length > 1) { refusals.push(`bundle ${key}: its number is spelled two ways in the listing (${entries.map(e => e.bundle).join(', ')}); ask for one spelling`); continue; }
    if (partial.length) { refusals.push(`bundle ${key}: its figures would be partial: ${partial.map(n => `run ${n.id} ${n.ref} [${n.kind}] ${n.reason}`).join('; ')}`); continue; }
    const entry = entries[0];
    if (!entry || entry.after.counted < 1) { refusals.push(`bundle ${key}: no counted run after the cut-over, so there is nothing to record`); continue; }
    const { after: a, before: b } = entry;
    const properties = checkTelemetryProperties(TRADE_SPEC, {
      recordKey: `trade:${key}`, formatVersion: TRADE_FORMAT_VERSION, bundle: key,
      refs: [...new Set(mine.map(r => r.ref))].sort().join(','), runIds: mine.map(r => r.id).sort((x, y) => x - y).join(','), cutoverSha,
      afterCounted: a.counted, afterFailures: a.failures, afterTimeouts: a.timeouts.length, afterUnresolved: a.unresolved.length,
      savedMinutes: round2(a.savedMinutes), costMinutes: round2(a.costMinutes), netMinutes: round2(a.netMinutes), calendarMinutes: round2(a.calendarMinutes),
      supersededCount: named.filter(n => n.kind === 'superseded').length, neverStartedCount: named.filter(n => n.kind === 'never-started').length,
      beforeCounted: b.counted, beforeFailures: b.failures,
    });
    payloads.push({
      title: `Trade of bundle ${key}`, status: 'completed',
      startsAt: new Date(entry.firstCreatedMs).toISOString(), endsAt: new Date(entry.lastCompletedMs).toISOString(), properties,
    });
  }
  return { payloads, refusals };
}

/** The run ids a stored record holds, as numbers-as-text. */
const idsOf = (runIds) => String(runIds ?? '').split(',').filter(Boolean);

/**
 * Replace a stored record only when the new run ids contain every stored one: the listing shows the latest runs only, so an older
 * run that has dropped off must not be erased from the record. `missing` is filled with what each kept record holds that the
 * listing no longer shows, for the line that says so.
 */
function replaceUnlessItForgetsRuns(missing) {
  return (stored, next) => {
    const now = new Set(idsOf(next.runIds));
    const lost = idsOf(stored.runIds).filter(id => !now.has(id));
    if (lost.length) missing.set(next.recordKey, lost);
    return lost.length === 0;
  };
}

/** What a recorded bundle's line says about the runs it left out. */
const leftOut = (p) => [['superseded', p.supersededCount], ['never-started', p.neverStartedCount]].filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';

/** Write the payloads under the lock and say each outcome. Exit 0 unless a record was not written. */
async function recordPayloads({ payloads, dest }) {
  const missing = new Map();
  let outcomes;
  const locked = await withRecordLock(async () => { outcomes = await upsertTelemetryRecords(dest.api, TRADE_SPEC, payloads, { replaceWhen: replaceUnlessItForgetsRuns(missing) }); return true; });
  if (locked === null) { console.error('trade: another recorder holds the record lock (in the git common dir): nothing was written; run it again'); return 2; }
  let failed = false;
  for (const o of outcomes) {
    const p = payloads.find(x => x.properties.recordKey === o.key).properties;
    if (o.outcome === 'failed') { failed = true; console.error(`trade: ${o.key} not recorded: ${o.error}`); }
    else if (o.outcome === 'kept') console.log(`trade: ${o.key} kept: the stored record holds run(s) ${missing.get(o.key).join(', ')} the listing no longer shows, so it was not replaced`);
    else console.log(`trade: ${o.key} ${o.outcome}: ${idsOf(p.runIds).length} run(s), ${p.afterCounted} counted after the cut-over; left out: ${leftOut(p)}`);
  }
  return failed ? 2 : 0;
}

/** `--history`: the records read back, summed (a rate is failures over runs across records, never a mean of rates). */
async function printHistory() {
  const refused = refuseRecordingUnderCi('trade', '--history', 'CI never holds the token that reads the records, so nothing is read');
  if (refused) return refused;
  const dest = recordDestination();
  if (dest.why) { console.error(`trade: ${dest.why}`); return 2; }
  const READ = 500;
  try {
    const answer = await dest.api.call('filter', { space: TRADE_SPEC.space, collection: 'chrono', filter: { type: TRADE_SPEC.type }, sort: 'startsAt', dir: 'asc', limit: READ });
    const rows = (answer?.data?.results ?? []).filter(r => r?.type === TRADE_SPEC.type && r.properties);
    if (typeof answer?.data?.total === 'number' && answer.data.total > rows.length) throw new Error(`the instance holds ${answer.data.total} Trade records and ${rows.length} were read: a history of part of them would read as the whole`);
    const known = rows.map(r => r.properties).filter(p => p.formatVersion === TRADE_FORMAT_VERSION);
    const counted = known.filter(p => Number.isFinite(p.afterCounted) && p.afterCounted >= 1);
    console.log(`trade history: ${rows.length} record(s) of ${TRADE_SPEC.type}, ${counted.length} with a counted run after the cut-over${known.length < rows.length ? ` (${rows.length - known.length} of a format version this script does not read were skipped)` : ''}.`);
    if (!counted.length) { console.log('  Nothing to total yet.'); return 0; }
    const sum = (k) => counted.reduce((s, p) => s + p[k], 0);
    const mean = (k) => sum(k) / counted.length;
    console.log(`  Failure rate: ${(100 * sum('afterFailures') / sum('afterCounted')).toFixed(1)}% (${sum('afterFailures')} database-step failure(s) in ${sum('afterCounted')} counted run(s), summed over the records, not a mean of their rates).`);
    console.log(`  Mean saved per bundle: ${mins(mean('savedMinutes'))}.`);
    console.log(`  Mean cost per bundle: ${mins(mean('costMinutes'))}.`);
    console.log(`  Mean net per bundle: ${mins(mean('netMinutes'))} (saved minus cost).`);
    console.log(`  Mean calendar per bundle: ${mins(mean('calendarMinutes'))} of waiting (not in net).`);
    return 0;
  } catch (e) {
    console.error(`trade: ${String(e.message ?? e).split('\n')[0]}`);
    return 2;
  }
}

/**
 * The listing of push runs of `full-run.yml`. For a report it is read once and refused when it fills `limit`. For `--record` it is
 * read at `limit`, and when that fills, once more at {@link RECORD_LIMIT_CEILING} (two reads at most); a listing that fills the
 * ceiling is refused naming `--limit`.
 */
function readListing({ limit, growing, gh = ghJson }) {
  const read = (n) => gh([
    'run', 'list', '-R', REPO_SLUG, '-w', basename(FULL_RUN_WORKFLOW), '-e', 'push', '-L', String(n),
    '--json', 'databaseId,headBranch,headSha,createdAt,attempt',
  ]);
  if (!growing) return checkListing(read(limit), limit);
  const first = Math.min(limit, RECORD_LIMIT_CEILING);
  const listing = read(first);
  if (listing.length < first) return listing;
  // The first read filled its limit, so older runs were cut. Read ONCE more, at the ceiling: a listing is the same bytes at any
  // width, and a step-by-step growth would read the whole history again at every step.
  const wide = first < RECORD_LIMIT_CEILING ? read(RECORD_LIMIT_CEILING) : listing;
  if (wide.length >= RECORD_LIMIT_CEILING) throw new Error(`the listing still fills ${RECORD_LIMIT_CEILING} runs, the most --record reads (a --limit above ${RECORD_LIMIT_CEILING} is read as ${RECORD_LIMIT_CEILING}): older runs would be cut, and a record made from a cut listing is wrong`);
  return wide;
}

async function main(argv, { now = Date.now } = {}) {
  let options;
  try { options = parseArgs(argv); } catch (e) {
    console.error(`trade: ${e.message}\n${USAGE}`);
    return 2;
  }
  const { limit, lines: lineRefs, record: recordRefs } = options;
  if (options.typeSchema) { console.log(JSON.stringify(telemetryTypeDeclaration(TRADE_SPEC), null, 2)); return 0; }
  if (options.history) return printHistory();
  let dest = null;
  if (recordRefs.length) {
    const refused = refuseRecordingUnderCi('trade', '--record');
    if (refused) return refused;
    dest = recordDestination();
    if (dest.why) { console.error(`trade: ${dest.why}`); return 2; }
  }
  const deadline = now() + BUDGET_MS;
  try {
    const stepName = stepNameRunning(/npm run test:standalone:db/);
    // The first external call: a missing or logged-out gh stops here, before anything is printed from nothing.
    const listing = readListing({ limit, growing: recordRefs.length > 0 });
    const wanted = lineRefs.length || recordRefs.length ? new Set([...lineRefs, ...recordRefs].map(ref => keyNumber(bundleOf(ref)))) : null;

    const { runs, unread } = await readRuns({ listing, wanted, stepName, deadline, now });

    const cutover = cutoverOnMain();
    const notes = [];
    if (unread.length) notes.push(`The ${BUDGET_MS / 60_000}-minute budget ended the reading: ${unread.length} run(s) were not read (${unread.join(', ')}) and are named below as unread-budget.`);
    if (!cutover.sha && cutover.why) notes.push(`The cut-over could not be derived: ${cutover.why}`);
    const report = tradeReport({ runs, cutoverSha: cutover.sha, isAncestor: placeWithin(gitIsAncestor, { deadline, now }) });
    if (report.named.some(n => n.kind === 'unplaced')) notes.push('Some heads could not be placed against the cut-over (git has not fetched them, or the budget ended): they are named below as unplaced.');

    if (recordRefs.length) {
      const { payloads, refusals } = tradeRecords({ report, runs, cutoverSha: cutover.sha, bundles: [...new Set(recordRefs.map(r => keyNumber(bundleOf(r))))] });
      if (refusals.length) {
        for (const why of refusals) console.error(`trade: refused ${why}`);
        console.error('trade: nothing was written: a refused bundle is not recorded, and neither are the others of this call');
        return 2;
      }
      return await recordPayloads({ payloads, dest });
    }
    if (wanted) {
      for (const ref of lineRefs) console.log(bundleLine(ref, report.bundles.find(b => b.bundle === bundleOf(ref)), { limit, notes }));
    } else {
      for (const l of reportLines(report, { cutoverSha: cutover.sha, limit, notes })) console.log(l);
    }
    return 0;
  } catch (e) {
    console.error(`trade: ${String(e.message ?? e).split('\n')[0]}`);
    return 2;
  }
}

if (isEntryPoint(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
