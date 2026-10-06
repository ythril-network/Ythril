/**
 * Real `node --test` child runs over the timing fixtures — the one place the two timing-reporter gates run them.
 *
 * ## Why it is a module
 *
 * `timing-reporter-lines.test.js` and `timing-reporter-flags.test.js` both have to start a child `node --test`
 * over the files in `_fixtures/*.fixture.mjs`, with or without the timing reporter, and read what it wrote. A
 * second copy of the spawn would be a second place to forget the one line that makes a child run honest here:
 * `NODE_TEST_CONTEXT` is inherited from the runner that runs THESE tests, and a child that sees it believes it
 * is a worker of that runner and speaks the runner's wire format instead of printing a report. `testChildEnv`
 * (`_shared/test-child-env.mjs`) is where that variable is dropped.
 *
 * ## The fixtures are not `*.test.js`
 *
 * `splitStandalone` maps every tracked `*.test.js` under `testing/standalone` by BASENAME, so a fixture named
 * like a test would be run by every runner as a test of its own (and a fixture that fails on purpose would
 * fail the suite). They are named `*.fixture.mjs` and reached only by the explicit paths in this file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { timingReporterFlags } from '../_shared/timing-reporter-flags.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

export { SECRETS, LONG_FIRST_LINE, READY } from './_fixtures/timing-constants.mjs';

export const ROOT = REPO_ROOT;
export const FIXTURE_DIR = 'testing/standalone/_fixtures';

/** The repo-relative path of a fixture, as the reporter must record it in `file`. */
export const fixture = (name) => `${FIXTURE_DIR}/${name}.fixture.mjs`;

/** The independent oracle: node's own pass/fail events, written raw. */
export const ORACLE = `${FIXTURE_DIR}/event-oracle.mjs`;

/** What a child run sees: this process's env minus what makes a child `node --test` misbehave. */
export function childEnv(extra = {}) {
  const env = testChildEnv({ NO_COLOR: '1', ...extra });
  for (const k of ['FORCE_COLOR', 'NODE_OPTIONS']) delete env[k];
  return env;
}

/** `node --test <args>` from `cwd`, to completion. */
export function runNodeTest(args, { cwd = ROOT, env = {}, timeout = 120_000 } = {}) {
  const r = spawnSync(process.execPath, ['--test', ...args], { cwd, env: childEnv(env), encoding: 'utf8', timeout });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A JSONL file as parsed objects. A line that is not JSON throws: the reporter writes whole lines or none. */
export function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${path} line ${i + 1} is not JSON: ${l.slice(0, 120)}`); }
  });
}

/**
 * The same files, with the timing reporter attached by the helper under test.
 *
 * `oracle: true` attaches `event-oracle.mjs` BESIDE it in the same run, so what the timing file says and what
 * node said are about the very same events; the oracle's account comes back as `oracle`.
 *
 * @returns {{ status: number|null, stdout: string, stderr: string, destination: string, flags: object, oracle: object[] }}
 */
export function runTimed(files, { suite = 'fixture', batch = 1, dir, tty = false, oracle = false, extraArgs = [], cwd = ROOT, env = {}, scope } = {}) {
  const flags = timingReporterFlags({ suite, batch, dir, stdoutIsTTY: tty, ...(scope === undefined ? {} : { scope }) });
  const oracleOut = oracle ? resolve(dir, `oracle-${suite}-${batch}.jsonl`) : null;
  const oracleArgs = oracle ? [`--test-reporter=${pathToFileURL(resolve(ROOT, ORACLE)).href}`, `--test-reporter-destination=${oracleOut}`] : [];
  const r = runNodeTest([...flags.args, ...oracleArgs, ...extraArgs, ...files], { cwd, env: { ...flags.env, ...env } });
  const events = oracle && existsSync(oracleOut) ? readJsonl(oracleOut) : [];
  if (oracle && events.length === 0) throw new Error(`the oracle saw nothing (exit ${r.status}): ${r.stderr.slice(0, 400)}`);
  return { ...r, destination: flags.destination, flags, oracle: events };
}

/** The console flavour the helper must name explicitly, run WITHOUT the timing reporter. */
export function runPlain(files, { tty = false, extraArgs = [], cwd = ROOT } = {}) {
  return runNodeTest([`--test-reporter=${tty ? 'spec' : 'tap'}`, '--test-reporter-destination=stdout', ...extraArgs, ...files], { cwd });
}

/**
 * Console text with the figures that differ between two runs of the same tests taken out: every duration, in
 * the per-test figures and the `# duration_ms` / `ℹ duration_ms` summary lines alike. Nothing else is touched,
 * so a line that is MISSING, EXTRA or reordered still shows as a difference.
 */
export function normaliseConsole(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/duration_ms:? [0-9.]+/g, 'duration_ms N')
    .replace(/\(\s*[0-9.]+ms\)/g, '(N ms)');
}

/** Spawn a run and hand back the live child, for the one test that has to kill a run mid-way. */
export function startTimed(files, { suite = 'fixture', batch = 1, dir } = {}) {
  const flags = timingReporterFlags({ suite, batch, dir, stdoutIsTTY: false });
  const child = spawn(process.execPath, ['--test', ...flags.args, ...files], {
    cwd: ROOT, env: childEnv(flags.env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, destination: flags.destination };
}
