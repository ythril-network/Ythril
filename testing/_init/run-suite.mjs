/**
 * `node testing/_init/run-suite.mjs <suite> [node --test flags]` — the runner for the stack suites
 * (`integration`, `sync`, `redteam`): `npm run test:integration`, `test:sync` and `test:redteam` are this file.
 *
 * ## What it prevents
 *
 * Those three scripts were `node --test --test-concurrency=1 testing/<dir>/*.test.js`, which ask nothing of
 * the set they run and can attach nothing to it:
 *
 *  - **A glob that matches nothing runs nothing and exits 0.** The files come from `trackedSources` — what the
 *    repository HAS, the question CI answers too — and the selection must reach a FLOOR read from the suite's
 *    own table below, else this THROWS. An empty list is not "all passed".
 *  - **A scratch test file left in the folder** runs on this machine and never in CI. Untracked test files are
 *    not run, and are WARNED about locally (not under CI, where there are none), so the divergence is said.
 *  - **No timing, no skip count.** The reporter is attached through `timingReporterFlags` like every other
 *    `node --test` runner, to `test-results/<suite>-1.jsonl`; the suite's own earlier results are cleared first,
 *    so a run's results are only its own.
 *  - **The recorder's credentials reaching a test.** The child's environment is `testChildEnv`'s: this one minus
 *    the `YTHRIL_TEST_RUNS_*` family.
 *  - **A runner whose status is the reporter's.** The exit status is node's own, and this runner exits with it:
 *    non-zero when node's was, and when node never gave one (killed by a signal, or never started).
 *  - **A command line over the platform limit** dies in the shell with no test output and nothing named. The
 *    suite is ONE `node --test` process, as it always was; if its path list would not fit, this refuses and says
 *    so, rather than starting a run that cannot.
 *
 * The suites share ONE live stack, so the files run `--test-concurrency=1`: run concurrently they latch
 * maintenance mode and report false failures. Needs the test stack up (`npm run test:up`).
 * `npm run test:standalone` is `run-standalone.mjs`, the other half.
 *
 * Run: node testing/_init/run-suite.mjs integration
 */
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../../scripts/_shared/script-cli.mjs';
import { timingReporterFlags, clearTimingResults } from '../_shared/timing-reporter-flags.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { runningUnderCi } from '../_shared/running-under-ci.mjs';
import { trackedSources, REPO_ROOT } from '../standalone/_sources.mjs';

/**
 * Each suite's folder and the FLOOR under which the selection is taken to be broken, not small. A floor is the
 * count that means the listing worked, set well under what a suite holds so adding or removing a test never
 * trips it; it is not a statement of how many tests there are.
 */
export const SUITES = Object.freeze({
  integration: { dir: 'testing/integration', floor: 50 },
  sync: { dir: 'testing/sync', floor: 20 },
  redteam: { dir: 'testing/red-team-tests', floor: 15 },
});

/** The shortest of the platforms' command-line limits (Windows: 32 767 characters), with room for the flags. */
const COMMAND_LINE_LIMIT = 30_000;

/** The test files directly inside `dir` (what the old `<dir>/*.test.js` glob matched). */
function directTests(dir, opts) {
  return trackedSources(dir, { ext: ['.test.js'], floor: 0, ...opts })
    .filter(f => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'))
    .sort();
}

/**
 * The files a suite runs, and the untracked test files it does not.
 *
 * @throws when the suite is unknown, or the selection falls under the suite's floor
 */
export function selectSuiteFiles(suite) {
  const spec = SUITES[suite];
  if (!spec) throw new Error(`run-suite: unknown suite ${JSON.stringify(suite)} — one of ${Object.keys(SUITES).join(', ')}`);
  const files = directTests(spec.dir);
  if (files.length === 0 || files.length < spec.floor) {
    throw new Error(
      `run-suite: ${suite} selected ${files.length} tracked test file(s) under ${spec.dir}, under its floor of `
      + `${spec.floor}. The listing is broken, not the tests: an empty selection runs nothing and exits 0, so this `
      + 'fails instead of reporting success about nothing.');
  }
  const tracked = new Set(files);
  const untracked = runningUnderCi() ? [] : directTests(spec.dir, { untracked: true }).filter(f => !tracked.has(f));
  return { files, untracked };
}

/**
 * Run one suite to completion.
 *
 * @param {string}   suite
 * @param {string[]} [passthrough] extra `node --test` flags (`--test-name-pattern=…`), placed before the files
 * @returns {{ status: number, files: number }} `status` 0 only when node exited 0
 */
export function runSuite(suite, passthrough = []) {
  const { files, untracked } = selectSuiteFiles(suite);
  if (untracked.length > 0) {
    console.warn(`run-suite: ${untracked.length} untracked test file(s) in ${SUITES[suite].dir} are NOT run, `
      + `because CI would not have them either: ${untracked.join(', ')}`);
  }
  clearTimingResults(suite);
  // Every tracked file of the suite, unless the caller narrowed the run with node flags (a name pattern): then a subset.
  const flags = timingReporterFlags({ suite, batch: 1, scope: passthrough.length === 0 ? 'full' : 'subset' });
  const args = ['--test', '--test-concurrency=1', ...flags.args, ...passthrough, ...files];
  const length = args.reduce((n, a) => n + a.length + 1, 0);
  if (length > COMMAND_LINE_LIMIT) {
    throw new Error(`run-suite: ${suite}'s command line would be ${length} characters, over the ${COMMAND_LINE_LIMIT} `
      + 'this runner allows, and the shell would refuse it with no test output. Split the suite across processes.');
  }
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit', env: testChildEnv(flags.env) });
  if (r.error) console.error(`run-suite: ${suite} did not run: ${r.error.message}`);
  else if (r.status === null) console.error(`run-suite: ${suite} was killed by ${r.signal}`);
  return { status: r.status === 0 ? 0 : 1, files: files.length };
}

if (isEntryPoint(import.meta.url)) {
  const [suite, ...passthrough] = process.argv.slice(2);
  if (!suite) {
    console.error(`usage: node ${relative(REPO_ROOT, fileURLToPath(import.meta.url))} <${Object.keys(SUITES).join('|')}> [node --test flags]`);
    process.exit(2);
  }
  const t0 = Date.now();
  const { status, files } = runSuite(suite, passthrough);
  console.log(`${suite}: ${files} file(s), ${status === 0 ? 'node exited 0' : 'FAILED'}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(status);
}
