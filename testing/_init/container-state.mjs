/**
 * Print why a standalone run's containers stopped (Q-792 part 6): `docker inspect`'s OOMKilled, ExitCode and Error, the fields
 * CI's failure dump prints, for the compose projects a run used.
 *
 * ## What it answers
 *
 * One question: *what state did these containers end in?* Which containers a run used and when to ask are the runner's
 * (`run-standalone.mjs`); this only asks Docker and prints.
 *
 * ## What it prevents
 *
 *  - **A killed Mongo read as dozens of unrelated failures.** An OOM-killed test Mongo made every database file fail with
 *    ECONNREFUSED, and a sharded run then removed the container with its volume, so nothing was left to look at. The state is
 *    printed on a failing run, and `reportThenStop` prints each shard's BEFORE `compose down --volumes` runs.
 *  - **A second definition of the fields.** The format is read from `.github/actions/dump-test-stack-logs/action.yml`, the
 *    line CI runs, so the two cannot drift. A format that names anything but the container's name and those three state
 *    fields is refused: a container's environment holds the Mongo password, and this prints to a log.
 *  - **Diagnostics that cost the run its cleanup.** Every ask has a timeout, an argument array and no shell; nothing here
 *    throws, and `reportThenStop` stops the containers in a `finally`. A Docker that does not answer (a container runner
 *    has none) prints `docker not reachable`.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'actions', 'dump-test-stack-logs', 'action.yml');

/** The compose project of the test stack: the harness Mongo, the instances, the sidecars. A shard's is `dbShardProject`. */
export const TEST_STACK_PROJECT = 'ythril-test';

/** Milliseconds one docker call has before it is given up on. */
const ASK_TIMEOUT_MS = 10_000;

/** The only placeholders a format may carry: nothing that reads a container's environment, mounts or command. */
const ALLOWED_PLACEHOLDERS = ['.Name', '.State.OOMKilled', '.State.ExitCode', '.State.Error'];

/**
 * The `-f` format of the action's `docker inspect` line, comment lines dropped. Throws when the line is gone or its format
 * reads anything but the name and the three state fields.
 */
export function ciInspectFormat(action = ACTION) {
  const script = readFileSync(action, 'utf8').split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
  const m = /docker inspect -f '([^']+)'/.exec(script);
  if (!m) throw new Error(`${action} has no docker inspect -f '<format>' line`);
  assertStateFieldsOnly(m[1]);
  return m[1];
}

function assertStateFieldsOnly(format) {
  const names = [...format.matchAll(/\{\{([^}]*)\}\}/g)].map(x => x[1].trim());
  const stray = names.filter(n => !ALLOWED_PLACEHOLDERS.includes(n));
  if (stray.length > 0) throw new Error(`inspect format reads ${stray.join(', ')}; only ${ALLOWED_PLACEHOLDERS.join(', ')} may be printed`);
}

/** `docker <argv>` with an argument array and a timeout; resolves with stdout, rejects when docker did not run or printed nothing. */
function dockerAsk(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('docker', argv, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      // `inspect` of ids of which one is gone exits non-zero and still prints the others.
      if (err && !String(stdout).trim()) reject(err); else resolve(String(stdout));
    });
  });
}

/** `promise`, or a rejection after `ms`: an injected or real ask that never answers cannot hold the run. */
function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); timer.unref?.(); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Print each project's containers' state, exited ones included. Never throws and never prints anything beyond the header
 * and what `docker inspect` answers in the CI action's format.
 *
 * @param {object} o
 * @param {string[]} o.projects compose project names
 * @param {(argv: string[], timeoutMs: number) => Promise<string>} [o.ask] docker, injectable
 * @param {(line: string) => void} [o.print] default: stderr
 * @param {number} [o.timeoutMs]
 * @param {string} [o.format] default: the CI action's
 */
export async function reportContainerState({ projects, ask = dockerAsk, print = (l) => console.error(l), timeoutMs = ASK_TIMEOUT_MS, format } = {}) {
  try {
    const fmt = format ?? ciInspectFormat();
    assertStateFieldsOnly(fmt);
    const blocks = await Promise.all(projects.map(async (project) => {
      try {
        const ids = (await within(ask(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], timeoutMs), timeoutMs))
          .split(/\s+/).filter(Boolean);
        if (ids.length === 0) return [`standalone: container state of ${project}: no containers left`];
        const answer = await within(ask(['inspect', '-f', fmt, ...ids], timeoutMs), timeoutMs);
        return [`standalone: container state of ${project} (OOMKilled, ExitCode, Error):`, ...answer.split(/\r?\n/).filter(l => l.trim())];
      } catch {
        return [`standalone: container state of ${project}: docker not reachable`];
      }
    }));
    for (const line of blocks.flat()) print(line);
  } catch (e) {
    try { print(`standalone: container state not printed: ${e.message}`); } catch { /* the log is gone; the run's own result still stands */ }
  }
}

/**
 * Stop the run's containers, after printing their state when the run failed. The stop is in a `finally`: whatever the
 * printing does, the containers are removed, and a failing stop is the caller's to see.
 */
export async function reportThenStop({ failed, stop, ...report }) {
  try {
    if (failed) await reportContainerState(report);
  } finally {
    await stop();
  }
}
