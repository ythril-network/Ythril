/**
 * The one reader of a workflow's runs through `gh` - what a maintainer command asks GitHub about a CI run, with the guards a
 * hand-written copy drops (Q-588, Q-584).
 *
 * ## What it prevents
 *
 * `scripts/skip-check.mjs` read one run with three guards of its own, and `scripts/trade.mjs` reads fifty. A second reader that
 * spells the guards again is this repo's most common defect (one rule, two implementations, the weaker one wins), and each guard
 * is the line a copy drops:
 *
 * - **A run id is all decimal digits, and is refused before any call.** An id becomes an argument of `gh run view` and, in
 *   {@link runAttemptsJobs}, part of an endpoint path: `../../orgs` or `1?x=2` would read another resource.
 * - **`gh` is called with an argument array and a 60 s bound, never a shell line.** A hang ends, and nothing is interpreted.
 * - **A missing or logged-out `gh` is named.** {@link GhNotInstalledError} and {@link GhNotLoggedInError} say what to do, so a
 *   report is never printed from nothing and a caller can tell the two apart.
 * - **A step is found by what it RUNS, in `ci.yml`, and exactly one must match** ({@link stepNameRunning}): a name written in a
 *   script goes stale at a rename and reads a step that is gone; a guess among two reads the wrong one.
 * - **Every attempt of a run is read** ({@link runAttemptsJobs}). `gh run view --json jobs` shows only the LATEST attempt (run
 *   38605272758 is attempt 2; its attempt 1 is readable only through the attempts endpoint), so a step that failed once and
 *   passed on the re-run is invisible to it. A page of jobs shorter than the endpoint's own total is refused, not read short.
 *
 * ## Why `test-times.mjs` keeps its own pager
 *
 * `scripts/test-times.mjs` lists Actions runs over REST with a token and downloads their artifacts; it runs where `gh` is not
 * installed (CI's advisory job) and reads trusted `main` runs only. This module serves maintainer commands on a machine that is
 * logged in to `gh`. They answer different questions with different credentials, so they are two readers on purpose, and a
 * change to how a run id is checked is made here and in that pager's own id handling, not by merging them.
 *
 * Every function takes an injected `gh` (or `exec`) so a gate can hand it a fake and assert on the argument arrays it receives.
 */
import { execFileSync } from 'node:child_process';
import { loadCi, jobEntries, stepsOf } from '../../testing/_shared/ci-workflow.mjs';

/** The repository every call reads, in one place: `gh run view` and the REST endpoint must name the same one. */
export const REPO_SLUG = 'ythril-network/Ythril';

/** `gh` is not on the PATH. */
export class GhNotInstalledError extends Error {
  constructor(cause) {
    super('gh is not installed or not on the PATH: install the GitHub CLI (https://cli.github.com) and run `gh auth login`');
    this.name = 'GhNotInstalledError';
    this.cause = cause;
  }
}

/** `gh` is installed and has no login. */
export class GhNotLoggedInError extends Error {
  constructor(cause) {
    super('gh is not logged in: run `gh auth login`');
    this.name = 'GhNotLoggedInError';
    this.cause = cause;
  }
}

/** A run id (or job id) as the string that goes into an argument or an endpoint path; throws on anything that is not all decimal digits. */
function decimalId(id, what = 'run id') {
  const text = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : id;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) throw new Error(`${what} ${JSON.stringify(id)} is not a decimal number`);
  return text;
}

/**
 * What `gh <args>` printed, as text. `args` must be an array of strings (a shell line is refused before anything runs).
 *
 * @param {string[]} args
 * @param {{ exec?: typeof execFileSync }} [options]  `exec` is `execFileSync`'s shape, injected by gates
 */
export function ghText(args, { exec = execFileSync } = {}) {
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new TypeError('gh is called with an argument array of strings, never a shell line');
  try {
    // timeout: the bound on every call, 60 s; a hung gh ends and says so.
    return String(exec('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    if (e?.code === 'ENOENT') throw new GhNotInstalledError(e);
    if (/gh auth login|not logged in/i.test(`${e?.message ?? ''}\n${e?.stderr ?? ''}`)) throw new GhNotLoggedInError(e);
    throw e;
  }
}

/** What `gh <args>` printed, parsed as JSON. */
export function ghJson(args, options) {
  const text = ghText(args, options);
  try { return JSON.parse(text); } catch { throw new Error(`gh ${args.slice(0, 2).join(' ')} printed no JSON`); }
}

/** The fields of a run that the readers use; `jobs` is the LATEST attempt's. */
const RUN_FIELDS = 'status,conclusion,attempt,headSha,jobs';

/** One run: `gh run view <id> --json status,conclusion,attempt,headSha,jobs`. Refuses an id that is not decimal before `gh` is called. */
export async function readRun(id, { gh = ghJson } = {}) {
  const runId = decimalId(id);
  return gh(['run', 'view', runId, '-R', REPO_SLUG, '--json', RUN_FIELDS]);
}

/** The failed log of one job (text): `gh run view --job <id> --log-failed`. */
export async function readFailedLog(jobId, { exec } = {}) {
  return ghText(['run', 'view', '--job', decimalId(jobId, 'job id'), '-R', REPO_SLUG, '--log-failed'], { exec });
}

/**
 * The jobs of EVERY attempt of a run, attempt 1 first: `[{ attempt, jobs }]`, each through
 * `repos/<repo>/actions/runs/<id>/attempts/<n>/jobs` (REST field names: `started_at`, `completed_at`).
 *
 * @param {string|number} id        the run id, decimal
 * @param {number} attempts         the run's latest attempt number (`attempt` of the run)
 * @param {{ gh?: Function, beforeAttempt?: (attempt: number) => void }} [options]  `beforeAttempt(n)` runs before each attempt's
 *   call and may throw to stop the reading: a caller's own deadline is checked BETWEEN the attempts of one run, not only between runs
 */
export async function runAttemptsJobs(id, attempts, { gh = ghJson, beforeAttempt } = {}) {
  const runId = decimalId(id);
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`attempts ${JSON.stringify(attempts)} is not a whole number from 1`);
  const out = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (beforeAttempt) beforeAttempt(attempt);
    // `-X GET` with `-F`: the page size goes in the query string (the default page holds 30 jobs).
    const answer = await gh(['api', `repos/${REPO_SLUG}/actions/runs/${runId}/attempts/${attempt}/jobs`, '-X', 'GET', '-F', 'per_page=100']);
    const jobs = Array.isArray(answer?.jobs) ? answer.jobs : [];
    if (typeof answer?.total_count === 'number' && answer.total_count > jobs.length) {
      throw new Error(`run ${runId} attempt ${attempt} lists ${jobs.length} of ${answer.total_count} jobs: a step in the rest would read as missing`);
    }
    out.push({ attempt, jobs });
  }
  return out;
}

/**
 * The name of the one step of `ci.yml` whose `run` matches `pattern`. Throws unless exactly one does, and unless that one has a
 * name: a guess would read the wrong step.
 *
 * @param {RegExp} pattern
 * @param {{ ci?: object }} [options]  the parsed workflow; the real `ci.yml` by default
 */
export function stepNameRunning(pattern, { ci = loadCi() } = {}) {
  const names = jobEntries(ci).flatMap(({ job }) => stepsOf(job))
    .filter(s => typeof s.run === 'string' && pattern.test(s.run)).map(s => s.name);
  if (names.length !== 1) throw new Error(`ci.yml holds ${names.length} step(s) running ${pattern}; expected one`);
  if (!names[0]) throw new Error(`the one step of ci.yml running ${pattern} has no name: a run's steps are read by name`);
  return names[0];
}
