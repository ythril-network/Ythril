/**
 * What every test of `scripts/trade.mjs --record` / `--history` needs to run the real CLI against a fixture and read what it did.
 *
 * ## What it prevents
 *
 * A test of what trade WRITES to a Ythril instance has to run the whole script: the exit code, the refusal before any call and
 * the environment of the children are all properties of the process, and a hand-built report would prove the hand-built report.
 * The three inputs live here once: a history of runs as `gh` shows it (`tradeRuns`, written for the preload
 * `fake-gh-and-git-preload.mjs`), a Ythril instance that keeps a store (`fake-ythril-tool-server.mjs`), and a scrubbed child
 * environment (`cleanEnv`). A test then says only which runs exist and which flags it passes.
 *
 * ## The history the tests share
 *
 * `BUNDLE_130` is chosen so that EVERY field of a record has a distinct, non-zero, hand-checkable value (see `BUNDLE_130_FIGURES`):
 * a repeat after a failure (cost and calendar), a cancelled step that a newer push of the same ref superseded, a run whose
 * database step never started, a run the old regime made (the baseline), and a timeout nobody answered (unresolved). Minutes are
 * chosen so that two figures need rounding to two decimals. Only a figure that differs from every other can show that one
 * field was written from another.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stepNameRunning } from '../../scripts/_shared/ci-run-reader.mjs';
import { cleanEnv } from './test-times-harness.mjs';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const TRADE = join(REPO_ROOT, 'scripts', 'trade.mjs');
const PRELOAD = pathToFileURL(join(import.meta.dirname, 'fake-gh-and-git-preload.mjs')).href;

/** The three heads the history uses: the cut-over itself, one that descends from it, one from the old regime. */
export const SHAS = Object.freeze({ cutover: 'c'.repeat(40), after: 'b'.repeat(40), before: 'a'.repeat(40) });

/** A time on the day every fixture happens, `at('10:02:30')`. */
export const at = (hms) => `2026-10-20T${hms}Z`;

/** The step of `ci.yml` that runs the database tests, found as trade finds it. */
export const dbStepName = () => stepNameRunning(/npm run test:standalone:db/);

/** One attempt's database step; `null` is an attempt whose job holds no such step (it never started). */
export const dbStep = (conclusion, from, to) => ({ conclusion, from: at(from), to: to === null ? null : at(to) });

/** A run of `full-run.yml`: `attempts` is one entry per attempt (a {@link dbStep} or null). */
export const tradeRun = (id, ref, sha, created, attempts) => ({ id, ref, sha, created: at(created), attempts });

export const BUNDLE_130 = Object.freeze([
  tradeRun(1006, 'full-run/bundle-130', SHAS.before, '09:00:00', [dbStep('failure', '09:00:00', '09:05:00')]),
  tradeRun(1001, 'full-run/bundle-130', SHAS.after, '10:00:00', [dbStep('failure', '10:00:00', '10:10:00'), dbStep('success', '10:20:00', '10:28:00')]),
  tradeRun(1002, 'full-run/bundle-130-b', SHAS.after, '11:00:00', [dbStep('success', '11:00:00', '11:00:20')]),
  tradeRun(1003, 'full-run/bundle-130-b', SHAS.after, '12:00:00', [dbStep('cancelled', '12:00:00', '12:05:00')]),
  tradeRun(1004, 'full-run/bundle-130-b', SHAS.after, '12:02:00', [dbStep('success', '12:02:00', '12:02:30')]),
  tradeRun(1005, 'full-run/bundle-130', SHAS.after, '13:00:00', [null]),
  tradeRun(1007, 'full-run/bundle-130', SHAS.after, '14:00:00', [dbStep('cancelled', '14:00:00', '14:30:00')]),
]);

/**
 * What a record of {@link BUNDLE_130} says, worked by hand from the rules in `scripts/trade.mjs`'s docblock (the counted runs are
 * 1001, 1002, 1004 and 1007; 1003 was superseded by 1004, 1005 never started, 1006 is the baseline).
 *
 * saved = 10 + 20/60 + 0.5 + 30 = 40.8333; cost = attempt 2 of 1001 = 8; net = 32.8333; calendar = 10:10 to 10:28 = 18.
 */
export const BUNDLE_130_FIGURES = Object.freeze({
  recordKey: 'trade:130', bundle: '130', cutoverSha: SHAS.cutover,
  refs: 'full-run/bundle-130,full-run/bundle-130-b', runIds: '1001,1002,1003,1004,1005,1006,1007',
  afterCounted: 4, afterFailures: 2, afterTimeouts: 1, afterUnresolved: 1,
  savedMinutes: 40.83, costMinutes: 8, netMinutes: 32.83, calendarMinutes: 18,
  supersededCount: 1, neverStartedCount: 1, beforeCounted: 1, beforeFailures: 1,
});

/** The numeric fields of a record, and the text ones, as the design names them (`recordKey` is the identity, a string). */
export const NUMBER_FIELDS = Object.freeze(['formatVersion', 'afterCounted', 'afterFailures', 'afterTimeouts', 'afterUnresolved',
  'savedMinutes', 'costMinutes', 'netMinutes', 'calendarMinutes', 'supersededCount', 'neverStartedCount', 'beforeCounted', 'beforeFailures']);
export const TEXT_FIELDS = Object.freeze(['recordKey', 'bundle', 'refs', 'runIds', 'cutoverSha']);

/** A bundle whose runs all ran after the cut-over and are green: `ref`'s runs, one per entry of `starts` (`['10:00:00', '10:03:00']`). */
export const greenRuns = (firstId, ref, starts) => starts.map((from, i) => {
  const [h, m] = from.split(':');
  return tradeRun(firstId + i, ref, SHAS.after, from, [dbStep('success', from, `${h}:${String(Number(m) + 3).padStart(2, '0')}:00`)]);
});

/** The fixture file the preload reads, for `runs`. */
function fixtureOf(runs, { cutover, descends, unplaceable, budgetEndsAfterApiCalls }) {
  const name = dbStepName();
  const jobs = {};
  for (const r of runs) {
    r.attempts.forEach((a, i) => {
      const steps = a === null ? [{ name: 'Some other step', conclusion: 'success', started_at: r.created, completed_at: r.created }]
        : [{ name, conclusion: a.conclusion, started_at: a.from, completed_at: a.to }];
      jobs[`${r.id}/${i + 1}`] = { total_count: 1, jobs: [{ steps }] };
    });
  }
  const listing = [...runs].sort((a, b) => b.created.localeCompare(a.created))
    .map(r => ({ databaseId: r.id, headBranch: r.ref, headSha: r.sha, createdAt: r.created, attempt: r.attempts.length }));
  return { listing, jobs, cutover, descends, unplaceable, budgetEndsAfterApiCalls };
}

/**
 * Run `node scripts/trade.mjs <args>` in the repository root with `gh` and `git` faked, and resolve with what it printed, how it
 * ended and every `gh`/`git` call it made (`calls`). `server` is a fake Ythril instance (its URL and token are put in the
 * environment unless `env` says otherwise); `env` is added on top of a scrubbed environment, a value of `undefined` leaves a
 * variable out.
 *
 * @param {string[]} args
 * @param {{ runs?: object[], cutover?: string|null, descends?: string[], unplaceable?: string[], budgetEndsAfterApiCalls?: number,
 *   server?: { url: string, token: string }, env?: Record<string, string|undefined>, timeoutMs?: number }} [o]
 *   `cutover` defaults to {@link SHAS}`.cutover`, and `descends` to the one head that ran after it.
 */
export async function runTrade(args, { runs = BUNDLE_130, cutover = SHAS.cutover, descends = [SHAS.after], unplaceable = [], budgetEndsAfterApiCalls, server, env = {}, timeoutMs = 60_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trade-record-'));
  const fixture = join(dir, 'fixture.json');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(fixture, JSON.stringify(fixtureOf(runs, { cutover, descends, unplaceable, budgetEndsAfterApiCalls })));
  writeFileSync(log, '');
  const given = { ...(server ? { YTHRIL_TEST_RUNS_URL: server.url, YTHRIL_TEST_RUNS_TOKEN: server.token } : {}), ...env };
  const childEnv = cleanEnv({ FAKE_GH_GIT_FIXTURE: fixture, FAKE_GH_GIT_LOG: log, ...given });
  for (const [k, v] of Object.entries(given)) if (v === undefined) delete childEnv[k];
  try {
    return await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, ['--import', PRELOAD, TRADE, ...args], { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`trade ${args.join(' ')} did not finish within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`)); }, timeoutMs);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
        resolveRun({ code, stdout, stderr, calls });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Everything the child printed, for the checks that a word appears somewhere or a secret nowhere. */
export const everything = (r) => `${r.stdout}\n${r.stderr}`;
