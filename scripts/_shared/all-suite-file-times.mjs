/**
 * The per-file times of EVERY test job in one snapshot (Q-923): the one question "how long does each test file of the repository take,
 * judged over CI's newest full runs of main", answered over rows already read from the records.
 *
 * ## What it prevents
 *
 * A slow-file check, run after a merge by the development flow and not held in this repository, names every test file over the time
 * budget from a `{ files: { path: ms } }` snapshot. That snapshot was the pure job's
 * alone, so the database, instance, integration, sync, red-team and client files, which are 14 of the 15 slowest, were never named. Built
 * for every job, the ways it goes wrong are closed here, none left to the caller:
 *
 * - **A snapshot that reads as "no slow files".** A job with no record on the instance (a shard not recorded yet, the client's) leaves its
 *   files out, and a snapshot without them answers "nothing slow" for every one. {@link allSuiteFileTimes} THROWS when no row holds a
 *   file, and when any job it was asked for holds none, naming the jobs. The snapshot is whole across the jobs or it is not made.
 * - **A time from a run that is not CI's own full run of main.** A laptop's run, a branch, a files-only or subset run, or a job the caller
 *   did not name sets no time ({@link isTrustedRun}); the same kind is what the reader asks the server for ({@link TRUSTED_RUN_KIND}),
 *   and the rows are checked again here.
 * - **A moved or repeated file counted twice.** The key is the path, so a file whose shard changed between runs is one key. A run recorded
 *   twice (the attempts of a rerun) counts once, by its newest record. Only the newest {@link FILE_TIMES_RUNS} runs that hold a file set
 *   its time, so the old shard's times fade out as the new shard's runs arrive.
 * - **A time nobody measured.** A time that is not a finite non-negative number, and a file named `__proto__`, are left out.
 *
 * It reads no record and writes no file (`scripts/test-times.mjs` asks the instance, `stage-costs.mjs` writes the snapshot), and the list
 * of jobs is the caller's (derived from the workflow's uploads, never written here, so a job added tomorrow is required the day it exists).
 */
import { newestThenHigherAttempt } from './newest-by.mjs';
import { medianOf } from './preflight-run-record.mjs';
import { isCount } from './measurements.mjs';

/** The newest runs of a job (and of a file) the per-file times rest on. */
export const FILE_TIMES_RUNS = 5;

/** What a `Test-Run` must be for its per-file times to rank the files: CI's own run, over main, of the whole suite. */
export const TRUSTED_RUN_KIND = Object.freeze({ source: 'ci', branch: 'main', scope: 'full' });

/** Whether `run` is of the trusted kind and of one of `jobs`. */
export const isTrustedRun = (run, jobs) => run !== null && typeof run === 'object'
  && Object.entries(TRUSTED_RUN_KIND).every(([key, value]) => run[key] === value) && jobs.includes(run.job);

/** Newest start first; the attempts of one run start together, so the higher attempt first: the one a run is counted by. */
const newestFirst = newestThenHigherAttempt('startsAt', (r) => r.attempt);

/**
 * Per test file, the median of its time over the newest {@link FILE_TIMES_RUNS} trusted runs that hold it, across `jobs`.
 *
 * @param {Array<{ job: string, source: string, branch: string, scope: string, runId: string, attempt?: number, startsAt: string, files: Record<string, number> | null }>} runs
 *   one row per recorded job of a run: its identity, when it started and its per-file times (null when its measurements could not be read);
 *   the attempts of one run are rows of one `runId`, and the newest start (then the higher `attempt`) is the one the run counts by
 * @param {{ jobs: string[] }} options every job the snapshot must cover
 * @returns {{ newestSourceAt: string, runs: number, files: Record<string, number> }} `runs` is the number of distinct runs the times rest on
 * @throws {Error} with no job asked for, no usable file at all, or a job in `jobs` that holds no file
 */
export function allSuiteFileTimes(runs, { jobs } = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('allSuiteFileTimes: no jobs to cover');
  const trusted = runs.filter(r => isTrustedRun(r, jobs) && typeof r.startsAt === 'string').sort(newestFirst);

  const byFile = new Map();
  const covered = new Set();
  for (const r of trusted) {
    if (r.files === null || typeof r.files !== 'object') continue;
    for (const [file, ms] of Object.entries(r.files)) {
      if (file === '__proto__' || !isCount(ms)) continue;
      covered.add(r.job);
      if (!byFile.has(file)) byFile.set(file, new Map());
      const ofRuns = byFile.get(file);
      const run = String(r.runId ?? r.startsAt);
      if (!ofRuns.has(run)) ofRuns.set(run, { startsAt: r.startsAt, ms });
    }
  }
  if (byFile.size === 0) throw new Error(`no recorded CI run of main (scope full) holds per-file times to measure (${runs.length} row(s), ${trusted.length} trusted)`);
  const missing = jobs.filter(job => !covered.has(job));
  if (missing.length) throw new Error(`no recorded CI run of main (scope full) holds per-file times for ${missing.join(', ')}: a snapshot without them would read as "no slow files" there`);

  const kept = new Map();
  const files = Object.fromEntries([...byFile].map(([file, ofRuns]) => {
    const newest = [...ofRuns].slice(0, FILE_TIMES_RUNS);
    for (const [run, { startsAt }] of newest) kept.set(run, startsAt);
    return [file, medianOf(newest.map(([, { ms }]) => ms))];
  }));
  return { newestSourceAt: [...kept.values()].sort().at(-1), runs: kept.size, files };
}
