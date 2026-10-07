/**
 * What every test of `scripts/test-times.mjs` needs to stand a run up and read what the script did with it.
 *
 * ## What it prevents
 *
 * The recorder reads a run's results from DISK (`test-results/*.jsonl`), its commit, branch and cleanliness from
 * GIT, and its destination from the ENVIRONMENT. A test that builds those three by hand in each file builds them
 * slightly differently in each, and then a rule that holds in one file is "tested" in another against a fixture
 * that could not have produced it. So the three live here, once: a throw-away git repository (`makeWorkdir`), a
 * results file written the way the reporter writes one (`jsonlFor` / `writeResults`), and a scrubbed child
 * environment (`runTimes`).
 *
 * ## The line shape these fixtures write — the contract the recorder reads
 *
 * One JSON object per line, per the plan's reporter schema (`{suite, batch, file, test, nesting, type, ms, status,
 * skip, reason}`):
 *
 * - `type: 'test'` — one per test; `status` is `pass`, `fail` or `cancelled`; a skip is a PASS line whose `skip`
 *   is truthy and whose `reason` says why (probe P1: only a pass event shows a skipped suite or test); `todo: true`
 *   marks a todo; `message` is the FIRST LINE of a failure (never a stack).
 * - `type: 'file'` — one per test file, `test` equal to `file`, `ms` the FILE's own duration (module load inside it).
 * - `type: 'end'` — the sentinel, last: `{events: N}` where N counts every line before it, plus the run's
 *   `startedAt` / `endedAt` (ISO) and its `scope` (`full`, `subset` or `files`), which only the runner knows.
 *
 * A file without the sentinel, or one whose `events` does not match, or whose last line is cut mid-object, is an
 * INCOMPLETE file — never a passing one (a killed run leaves exactly that).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testChildEnv } from './test-child-env.mjs';
import { TIMING_RESULTS_FOLDER } from './timing-reporter.mjs';
import { makeScratchRepo } from './scratch-git-repo.mjs';
import { buildZip } from './zip-builder.mjs';
import { jobEntries, loadCi } from './ci-workflow.mjs';
import { maskClientReport } from '../../scripts/mask-client-report.mjs';

export const SCRIPT = resolve(import.meta.dirname, '..', '..', 'scripts', 'test-times.mjs');

/**
 * A scratch git repository with one commit on `main`, `test-results/` ignored, as the real tree has it.
 *
 * `tracked` names further files (repo-relative, forward slashes) committed in that one commit, each holding a line of text:
 * the client's spec files, when a test needs "every spec tracked at the record commit" to be a particular set.
 * `commitMs` is that commit's own time (git keeps seconds), for a test that places a run before or after it.
 */
export function makeWorkdir({ dirty = false, untracked = false, branch = 'main', tracked = [] } = {}) {
  const { dir, git, cleanup } = makeScratchRepo({ prefix: 'test-times-', branch });
  writeFileSync(join(dir, '.gitignore'), `${TIMING_RESULTS_FOLDER}/\n`);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  for (const file of tracked) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `// ${file}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  if (dirty) writeFileSync(join(dir, 'a.txt'), 'two\n');
  if (untracked) writeFileSync(join(dir, 'b.txt'), 'new\n');
  return { dir, commit: git('rev-parse', 'HEAD').trim(), commitMs: Number(git('log', '-1', '--format=%ct').trim()) * 1000, branch, cleanup };
}

/**
 * The lines of one results file.
 *
 * @param {object} o
 * @param {string} o.suite
 * @param {string} o.batch
 * @param {Array<{file: string, ms: number, tests?: Array<object>}>} o.files  each test: `{name, ms, status, skip, reason, todo, message}`
 * Per file: `fail: true` is a file that failed on its own (a load error, no test lines); a test with `suiteFail: true`
 * is written as a failed SUITE line (a hook failure � no test of its own failed).
 * @param {'ok' | 'missing' | 'miscount'} [o.sentinel]  `missing` writes none; `miscount` writes one whose `events` is wrong
 * @param {boolean} [o.truncated]  cut the last line mid-object, as a killed process leaves it
 */
export function jsonlFor({ suite, batch, files, sentinel = 'ok', truncated = false, scope = 'full',
  startedAt = '2026-10-05T10:00:00.000Z', endedAt = '2026-10-05T10:07:30.000Z', extra = [] }) {
  const lines = [];
  for (const f of files) {
    let failed = false;
    for (const t of f.tests ?? []) {
      const line = { suite, batch, file: f.file, test: t.name, nesting: 1, type: 'test', ms: t.ms ?? 1, status: t.status ?? 'pass' };
      if (t.skip) { line.skip = true; line.reason = t.reason ?? 'skipped'; }
      if (t.todo) line.todo = true;
      if (t.message !== undefined) line.message = t.message;
      if (line.status === 'fail') failed = true;
      if (t.suiteFail) { line.type = 'suite'; line.status = 'fail'; line.test = t.name; }
      lines.push(line);
    }
    // A file whose tests failed is reported failed too (node: subtestsFailed); `f.fail` is a file that failed on its own (load error).
    lines.push({ suite, batch, file: f.file, test: f.file, nesting: 0, type: 'file', ms: f.ms, status: failed || f.fail || (f.tests ?? []).some(t => t.suiteFail) ? 'fail' : 'pass' });
  }
  lines.push(...extra);
  return wholeJsonl(lines, { suite, batch, sentinel, truncated, scope, startedAt, endedAt });
}

/**
 * One data line of the reporter's JSONL with EVERY key the schema has (`TIMING_SCHEMA`), so a reader is held to the
 * real shape. The defaults are an ordinary passing test; `over` says what differs.
 */
export const timingLine = (over = {}) => ({
  suite: 'standalone', batch: '1', file: '', test: '', nesting: 0, type: 'test', ms: 1, status: 'pass',
  skip: false, todo: false, reason: null, message: null, ...over,
});

/**
 * A results file from RAW data lines, closed the way the reporter closes one — the one place that writes the sentinel.
 * {@link jsonlFor} builds its lines from per-file specs and ends here; a test that needs a line the spec cannot say
 * (a skip with no reason, a line for a file that has no `file` line) writes the lines and ends here too, so no test
 * keeps its own copy of the sentinel shape that the recorder reads.
 *
 * @param {object[]} lines
 * @param {object} [o]
 * @param {'ok' | 'missing' | 'miscount'} [o.sentinel]  `missing` writes none; `miscount` writes one whose `events` is wrong
 * @param {boolean} [o.truncated]  cut the last line mid-object, as a killed process leaves it
 * @param {'full' | 'subset' | 'files' | null} [o.scope]  `null` leaves the key out
 */
export function wholeJsonl(lines, { suite, batch, sentinel = 'ok', truncated = false, scope = 'full',
  startedAt = '2026-10-05T10:00:00.000Z', endedAt = '2026-10-05T10:07:30.000Z' } = {}) {
  const rows = lines.map(l => JSON.stringify(l));
  if (sentinel !== 'missing') {
    const events = sentinel === 'miscount' ? lines.length + 3 : lines.length;
    rows.push(JSON.stringify({ type: 'end', suite, batch, events, startedAt, endedAt, ...(scope === null ? {} : { scope }) }));
  }
  const text = `${rows.join('\n')}\n`;
  return truncated ? text.slice(0, text.lastIndexOf('{') + 12) : text; // mid-object, no closing brace, no newline
}

/** Write one results file into `<dir>/test-results/<suite>-<batch>.jsonl` and return its path. */
export function writeResults(dir, spec) {
  const out = join(dir, TIMING_RESULTS_FOLDER);
  mkdirSync(out, { recursive: true });
  const path = join(out, `${spec.suite}-${spec.batch}.jsonl`);
  writeFileSync(path, jsonlFor(spec));
  return path;
}

/**
 * What could redirect, enable or refuse a recording, beyond what every test child already loses (the recorder's own
 * family and the runner's wire: `testChildEnv` owns both, so they are not retyped here).
 */
const SCRUBBED = /^(CI|GITHUB_.*|GH_TOKEN|GH_HOST|YTHRIL_URL|YTHRIL_TOKEN|YTHRIL_METRICS_.*)$/;

export function cleanEnv(extra = {}) {
  const inherited = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUBBED.test(k)) inherited[k] = v;
  return testChildEnv(extra, inherited);
}

/**
 * Run `node scripts/test-times.mjs <args>` in `cwd` and resolve with what it printed and how it ended.
 * A child that outlives `timeoutMs` is killed and the promise rejects — a recorder that wedges is a failure,
 * not a slow pass.
 */
export function runTimes(args, { cwd, env = {}, timeoutMs = 60_000, nodeArgs = [] } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, SCRIPT, ...args], { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`test-times ${args.join(' ')} did not finish within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`)); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr, child }); });
  });
}

/**
 * `runTimes` in the condition of CI's advisory job, which runs `--summary` without an `npm ci`: no package can be imported
 * (`no-packages.mjs`), so a module the script reaches that needs one fails the run as it would there.
 */
export const runTimesWithoutPackages = (args, options = {}) => runTimes(args, { ...options, nodeArgs: ['--import', pathToFileURL(resolve(import.meta.dirname, 'no-packages.mjs')).href] });

/** Start the recorder without waiting for it — for the tests that kill it or run two at once. */
export function spawnTimes(args, { cwd, env = {} } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const done = new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
  return { child, done };
}

/** Everything the child printed, in one string, for the checks that a secret appears nowhere. */
export const everything = (r) => `${r.stdout}\n${r.stderr}`;

// ── What GitHub's API says about a run, and the results it holds ─────────────────────────────────────────────
//
// `--record-ci` and `--summary` both read a repository's workflow RUNS and their result artifacts through the fake
// Actions API (`fake-github-actions.mjs`). The run object is the thing whose identity the recorder trusts (event,
// branch, workflow path, head repository), so a fixture that differs in one field from file to file tests a different
// rule in each. One shape, here; a test overrides the field it is about.

/** The repository every fixture run belongs to — the one the recorder trusts. */
export const REPO = 'ythril-network/Ythril';

/** A full commit id made of one hex digit, for a run's `head_sha`. */
export const SHA = (c) => c.repeat(40);

/** One test as a results fixture writes it (`jsonlFor` reads `{ name, ms, status, skip, reason, todo, message }`). */
export const T = (name, ms, over = {}) => ({ name, ms, ...over });

/**
 * A workflow run as the API returns it: a trusted one (a finished, green push to `main` of {@link REPO} on the CI
 * workflow). `over` replaces the fields a test is about — an event, a branch, a head repository, a conclusion.
 */
export const githubRun = (id, over = {}) => ({
  id, run_attempt: 1, name: 'CI', event: 'push', head_branch: 'main', head_sha: SHA('a'), path: '.github/workflows/ci.yml',
  status: 'completed', conclusion: 'success', head_repository: { full_name: REPO }, repository: { full_name: REPO },
  run_started_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:20:00Z', ...over,
});

/**
 * A result artifact for the fake API: `{ id, name, zip }`, the zip holding one results file per `[fileName, spec]` pair
 * (`spec` as `jsonlFor` takes it).
 */
export const resultsArtifact = (id, name, ...files) => ({
  id, name, zip: buildZip(files.map(([file, spec]) => ({ name: file, data: jsonlFor(spec) }))),
});

/**
 * The jobs of a run as the Actions API lists them: each one's `name` is its DISPLAY name (`Prepare`, `Client tests`,
 * `Standalone (no services)`), never the workflow's job id. The API's job objects carry no id of the workflow's own, which is
 * why a recorder that looks a job up by the id it read from an artifact name finds nothing.
 *
 * `ids` are job ids of the committed `ci.yml`, their display names read from it (not written here, so a rename there is the
 * name this serves); an entry `{ name, ... }` is a job the workflow does not have (an older run's), served as given. A job's
 * own span is `startedAt` .. `completedAt`, and is deliberately different from the spans the results of its jobs record, so a
 * wall taken from the wrong place is a different number and not an equal one.
 *
 * @param {Array<string | { name: string, startedAt?: string, completedAt?: string }>} jobs
 */
export function githubJobs(...jobs) {
  const names = new Map(jobEntries(loadCi()).map(e => [e.id, e.name]));
  return jobs.map((j, i) => {
    const given = typeof j === 'string' ? { id: j } : j;
    const name = given.name ?? names.get(given.id);
    if (name === undefined) throw new Error(`githubJobs: ci.yml has no job ${given.id}`);
    return {
      id: 7_000_000 + i, name, status: 'completed', conclusion: 'success',
      started_at: given.startedAt ?? '2026-10-05T09:59:00Z', completed_at: given.completedAt ?? '2026-10-05T10:19:00Z',
    };
  });
}

/**
 * The client job's result artifact: the folder `test-results/` it uploads, whose one entry is `client.json`, produced the
 * way CI produces it — by running the real `maskClientReport` (`scripts/mask-client-report.mjs`) over the raw report, with
 * `root` the checkout the specs lie under. `masked: false` leaves the report as vitest wrote it, for a test that holds the
 * recorder to masking on its own.
 *
 * @param {number} id
 * @param {object} report  a raw vitest report (`clientReport(...)` of `client-report-fixtures.mjs`)
 * @param {{ root: string, attempt?: number, masked?: boolean, entry?: string, extra?: Array<{ name: string, data: string }> }} o
 */
export function clientArtifact(id, report, { root, attempt = 1, masked = true, entry = 'client.json', extra = [] } = {}) {
  const body = masked ? maskClientReport(report, root) : report;
  return { id, name: `test-results-client-tests-${attempt}`, zip: buildZip([{ name: entry, data: JSON.stringify(body) }, ...extra]) };
}

/** Write `<dir>/test-results/client.json`, where a local run leaves the client's report, and return its path. */
export function writeClientReport(dir, report) {
  const out = join(dir, TIMING_RESULTS_FOLDER);
  mkdirSync(out, { recursive: true });
  const path = join(out, 'client.json');
  writeFileSync(path, typeof report === 'string' ? report : JSON.stringify(report));
  return path;
}
