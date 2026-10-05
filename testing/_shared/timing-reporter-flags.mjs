/**
 * The ONE place the timing reporter is attached to a `node --test` run (bundle-56, Q-370 part 1).
 *
 * `timingReporterFlags({ suite, batch })` returns the flags and the environment a runner adds to its
 * `node --test` command; `clearTimingResults(suite)` removes what an earlier run of the same suite left. Every
 * runner that starts `node --test` — `run-suite`, `run-standalone`, preflight — goes through them, and a gate
 * derives the runners from what they CALL, so a fourth cannot forget.
 *
 * ## What it prevents
 *
 * A measurement that costs the tests, or measures the wrong thing. Each point is a way a hand-written
 * `--test-reporter=…` line fails, probed on Node 22 and 24 (bundle-56 probe P1, reliability R1/R2):
 *
 *  - **A missing destination directory ends the run with exit 7 before one test starts.** Node opens the
 *    `--test-reporter-destination` file itself, outside any `try` a reporter can hold, and `test-results/` is
 *    gitignored, so it does not exist on a fresh clone, a fresh CI runner or after `git clean`. The directory is
 *    made HERE, first, so no caller can leave out the line that looks like boilerplate. If it cannot be made
 *    the helper does not throw: the reporter says so once and the tests run.
 *  - **Adding a reporter silences the console.** `--test-reporter=./ours.mjs` alone prints only what ours prints,
 *    and the `# fail` / `# skipped` tail every log reader and flow check greps is gone. The default reporter is
 *    named EXPLICITLY beside ours — tap when stdout is not a TTY (what CI's log is), spec when it is (what a
 *    terminal shows), the same on every Node version — so the output with the reporter equals the output without.
 *  - **A second invocation overwrites the first.** `run-standalone` and preflight are several `node --test`
 *    processes; one file per suite keeps only the last. The destination is per invocation, `<suite>-<batch>.jsonl`.
 *  - **A name that leaves the folder.** Suite and batch are names, not paths; anything else throws.
 *  - **A partial run read as a whole one.** Only the runner knows whether it ran the whole suite, a subset or
 *    named files; it says so (`scope`), the reporter writes it into the sentinel, and a caller that does not say
 *    is `subset`, never `full`.
 *  - **Last run's file read as this run's.** A batch plan that shrank leaves the old, higher-numbered files
 *    behind, and the summariser would count them. Each runner clears its own `<suite>-*` first.
 *
 * Pairing: node pairs `--test-reporter` and `--test-reporter-destination` BY POSITION and refuses unequal
 * counts (ERR_INVALID_ARG_VALUE), so the args are always the two pairs `[console, stdout, ours, stdout]`. Ours
 * writes its own file and gives the stream nothing. Every arg is a whitespace-free `--flag=value` string, so a
 * runner may join them into a shell line (preflight does), and the reporter is named by file URL, so it does not
 * depend on the working directory.
 *
 * The flags are NOT part of `offlineRuns`' plan: the batch budget and the cap are about the files, and
 * `a-db-file-runs-in-a-capped-batch` stays about them. A runner appends these after the plan's own args.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TIMING_ENV, TIMING_SCOPES, DEFAULT_TIMING_SCOPE, TIMING_RESULTS_FOLDER } from './timing-reporter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTER_URL = pathToFileURL(join(HERE, 'timing-reporter.mjs')).href;

/** Where timing files go by default; gitignored. */
export const TIMING_RESULTS_DIR = resolve(HERE, '..', '..', TIMING_RESULTS_FOLDER);

/** A plain name: it becomes part of a file name and must not be able to leave the folder. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function plainName(kind, value) {
  const s = String(value ?? '');
  if (!PLAIN_NAME.test(s) || s.includes('..')) {
    throw new Error(`timingReporterFlags: ${kind} ${JSON.stringify(value)} is not a plain name (letters, digits, . _ -)`);
  }
  return s;
}

/**
 * Flags, environment and destination for one `node --test` invocation.
 *
 * @param {object}  p
 * @param {string}  p.suite  the suite: standalone, integration, sync, redteam, preflight
 * @param {string|number} p.batch the invocation inside it: pure-1, db-2, 1
 * @param {string}  [p.dir]  where the file goes; default `<repo>/test-results`
 * @param {boolean} [p.stdoutIsTTY] default `process.stdout.isTTY`, which is what node itself keys its default on
 * @param {'full'|'subset'|'files'} [p.scope] what the run covers, which only the runner knows: the whole suite, a
 *   subset of it, or named files. Written into the sentinel. Default `subset`: a run that does not say is never
 *   `full`, because a baseline of partial runs that merely did not say so is a wrong baseline.
 * @returns {{ args: string[], env: Record<string,string>, destination: string }}
 *   `args` go after `--test`; `env` is merged into the child's environment; `destination` is the absolute file.
 */
export function timingReporterFlags({
  suite, batch, dir = TIMING_RESULTS_DIR, stdoutIsTTY = Boolean(process.stdout.isTTY), scope = DEFAULT_TIMING_SCOPE,
} = {}) {
  const suiteName = plainName('suite', suite);
  const batchName = plainName('batch', batch);
  if (!TIMING_SCOPES.includes(scope)) {
    throw new Error(`timingReporterFlags: scope ${JSON.stringify(scope)} is not one of ${TIMING_SCOPES.join(', ')}`);
  }
  const folder = resolve(dir);
  try { mkdirSync(folder, { recursive: true }); } catch { /* the reporter says so once; the tests still run */ }
  const destination = join(folder, `${suiteName}-${batchName}.jsonl`);
  return {
    args: [
      `--test-reporter=${stdoutIsTTY ? 'spec' : 'tap'}`, '--test-reporter-destination=stdout',
      `--test-reporter=${REPORTER_URL}`, '--test-reporter-destination=stdout',
    ],
    env: {
      [TIMING_ENV.destination]: destination,
      [TIMING_ENV.suite]: suiteName,
      [TIMING_ENV.batch]: batchName,
      [TIMING_ENV.scope]: scope,
    },
    destination,
  };
}

/**
 * Remove the files an earlier run of `suite` left in `dir` (`<suite>-*`, files only), so a run's results are
 * only its own. Never throws: a folder that is not there has nothing to clear.
 *
 * @returns {number} how many files were removed
 */
export function clearTimingResults(suite, { dir = TIMING_RESULTS_DIR } = {}) {
  const prefix = `${plainName('suite', suite)}-`;
  let removed = 0;
  try {
    for (const entry of readdirSync(resolve(dir), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      rmSync(join(resolve(dir), entry.name), { force: true });
      removed++;
    }
  } catch { /* no folder, nothing to clear */ }
  return removed;
}
