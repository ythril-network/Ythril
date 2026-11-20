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
 * ## One shard of a suite (`--shard=<k>/<n>`)
 *
 * CI runs Integration and Sync each as `n` jobs, each with a stack of its own (bundle-356, Q-947): one serial suite on one
 * stack was the job every run waited for. `--shard=<k>/<n>` (1-based) runs only shard `k`, the files `packBySeconds` gives it
 * from the recorded seconds in `_shared/suite-file-seconds.json`, alphabetical inside the shard as the whole suite runs. What
 * the shard argument cannot do:
 *
 *  - **Run everything, or nothing, when it is wrong.** `0/2`, `3/2`, `1/3` for a suite the runner cuts in two, `abc` are
 *    REFUSED (`parseShard`, `suiteShardFiles`): a wrong index that ran the whole suite would run it twice across the jobs, one
 *    that ran nothing would report success about nothing. The count must be the suite's own `shards`, which
 *    `ci-runs-every-integration-and-sync-shard-exactly-once` holds equal to the workflow's.
 *  - **Overwrite another shard's results.** CI merges every job's `test-results/` into one folder, so a shard writes
 *    `<suite>-<k>of<n>.jsonl` (`suiteBatch`), never the whole run's `<suite>-1.jsonl` and never another shard's name.
 *
 * Without `--shard` the whole suite runs on one stack, as `npm run test:integration` always did.
 *
 * Run: node testing/_init/run-suite.mjs integration [--shard=1/2]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../../scripts/_shared/script-cli.mjs';
import { timingReporterFlags, clearTimingResults } from '../_shared/timing-reporter-flags.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { runningUnderCi } from '../_shared/running-under-ci.mjs';
import { trackedSources, REPO_ROOT } from '../standalone/_sources.mjs';
import { packBySeconds } from '../_shared/pack-by-seconds.mjs';

/**
 * Each suite's folder, the FLOOR under which the selection is taken to be broken, not small, and the number of
 * shards CI cuts it in (1: one job). A floor is the count that means the listing worked, set well under what a
 * suite holds so adding or removing a test never trips it; it is not a statement of how many tests there are.
 */
export const SUITES = Object.freeze({
  integration: { dir: 'testing/integration', floor: 50, shards: 2 },
  sync: { dir: 'testing/sync', floor: 20, shards: 2 },
  redteam: { dir: 'testing/red-team-tests', floor: 15, shards: 1 },
});

/** `suite-file-seconds.json`: the seconds each Integration and Sync file took in one recorded CI run, by repository path. */
export const SUITE_FILE_SECONDS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '_shared', 'suite-file-seconds.json');

/** The recorded seconds by repository path; `{}` when the table is not there (every file is then planned at one weight). */
export function loadSuiteFileSeconds(path = SUITE_FILE_SECONDS_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')).seconds ?? {}; } catch { return {}; }
}

/**
 * `<k>/<n>` as `{ index: k, count: n }`, 1-based. THROWS on anything else (`0/2`, `3/2`, `1.5/2`, `abc`, a blank): a shard
 * argument that is wrong must stop the run, never select every file or none.
 */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text ?? ''));
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!m || count < 1 || index < 1 || index > count) {
    throw new Error(`run-suite: shard ${JSON.stringify(text)} is not <k>/<n> with 1 <= k <= n`);
  }
  return { index, count };
}

/**
 * The files of shard `index` of `count` of a suite: `packBySeconds` over the suite's tracked files and the recorded seconds,
 * alphabetical inside the shard. THROWS when `count` is not the suite's own `shards`, or `index` is outside it.
 *
 * @param {string} suite
 * @param {{ index: number, count: number }} shard
 * @param {{ files?: string[], seconds?: Record<string, number> }} [given] the suite's files and the table (read when not given)
 */
export function suiteShardFiles(suite, { index, count }, { files, seconds } = {}) {
  const spec = SUITES[suite];
  if (!spec) throw new Error(`run-suite: unknown suite ${JSON.stringify(suite)}`);
  if (count !== spec.shards) {
    throw new Error(`run-suite: ${suite} is planned in ${spec.shards} shard(s), so shard ${index}/${count} is none of them`);
  }
  if (!Number.isInteger(index) || index < 1 || index > count) throw new Error(`run-suite: shard ${index}/${count} is not one of ${count}`);
  const shards = packBySeconds(files ?? selectSuiteFiles(suite).files, count, seconds ?? loadSuiteFileSeconds(), { who: `run-suite ${suite}` });
  return shards[index - 1];
}

/** The results batch of a run: `1` for the whole suite, `<k>of<n>` for a shard, so no two shards and no whole run share a file. */
export const suiteBatch = (shard) => (shard ? `${shard.index}of${shard.count}` : 1);

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
 * What one run of a suite (or of one shard of it) starts: its files, the reporter's flags and destination, and the scope
 * the results say. Starts nothing and clears nothing, so the plan can be read without a stack.
 *
 * @param {string}   suite
 * @param {string[]} [passthrough] extra `node --test` flags (`--test-name-pattern=…`)
 * @param {{ index: number, count: number } | null} [shard] one shard of the suite, or the whole suite
 * @param {{ dir?: string }} [opts] the results folder (the reporter's default when not given)
 * @returns {{ files: string[], untracked: string[], flags: { args: string[], env: Record<string,string>, destination: string }, scope: string }}
 */
export function suiteRunPlan(suite, passthrough = [], shard = null, { dir } = {}) {
  const { files: all, untracked } = selectSuiteFiles(suite);
  const files = shard ? suiteShardFiles(suite, shard, { files: all }) : all;
  // Every tracked file of the suite or of the shard, unless the caller narrowed the run with node flags (a name pattern): then a subset.
  const scope = passthrough.length === 0 ? 'full' : 'subset';
  const flags = timingReporterFlags({ suite, batch: suiteBatch(shard), scope, ...(dir ? { dir } : {}) });
  return { files, untracked, flags, scope };
}

/**
 * Run one suite, or one shard of it, to completion.
 *
 * @param {string}   suite
 * @param {string[]} [passthrough] extra `node --test` flags (`--test-name-pattern=…`), placed before the files
 * @param {{ index: number, count: number } | null} [shard] one shard of the suite (`parseShard`), or the whole suite
 * @returns {{ status: number, files: number }} `status` 0 only when node exited 0
 */
export function runSuite(suite, passthrough = [], shard = null) {
  const { files, untracked, flags } = suiteRunPlan(suite, passthrough, shard);
  if (untracked.length > 0) {
    console.warn(`run-suite: ${untracked.length} untracked test file(s) in ${SUITES[suite].dir} are NOT run, `
      + `because CI would not have them either: ${untracked.join(', ')}`);
  }
  clearTimingResults(suite);
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
  const [suite, ...rest] = process.argv.slice(2);
  if (!suite) {
    console.error(`usage: node ${relative(REPO_ROOT, fileURLToPath(import.meta.url))} <${Object.keys(SUITES).join('|')}> [--shard=<k>/<n>] [node --test flags]`);
    process.exit(2);
  }
  const shardArgs = rest.filter((a) => a.startsWith('--shard='));
  const passthrough = rest.filter((a) => !a.startsWith('--shard='));
  if (shardArgs.length > 1) {
    console.error(`run-suite: ${shardArgs.length} --shard arguments; one shard per run`);
    process.exit(2);
  }
  const shard = shardArgs.length === 1 ? parseShard(shardArgs[0].slice('--shard='.length)) : null;
  const t0 = Date.now();
  const { status, files } = runSuite(suite, passthrough, shard);
  const what = shard ? `${suite} shard ${shard.index}/${shard.count}` : suite;
  console.log(`${what}: ${files} file(s), ${status === 0 ? 'node exited 0' : 'FAILED'}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(status);
}
