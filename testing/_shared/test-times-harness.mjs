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
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testChildEnv } from './test-child-env.mjs';
import { TIMING_RESULTS_FOLDER } from './timing-reporter.mjs';

export const SCRIPT = resolve(import.meta.dirname, '..', '..', 'scripts', 'test-times.mjs');

/** A scratch git repository with one commit on `main`, `test-results/` ignored, as the real tree has it. */
export function makeWorkdir({ dirty = false, untracked = false, branch = 'main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'test-times-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', branch);
  writeFileSync(join(dir, '.gitignore'), `${TIMING_RESULTS_FOLDER}/\n`);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  if (dirty) writeFileSync(join(dir, 'a.txt'), 'two\n');
  if (untracked) writeFileSync(join(dir, 'b.txt'), 'new\n');
  return { dir, commit: git('rev-parse', 'HEAD'), branch, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
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
export function runTimes(args, { cwd, env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`test-times ${args.join(' ')} did not finish within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`)); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr, child }); });
  });
}

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
