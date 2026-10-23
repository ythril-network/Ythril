/**
 * The one lock a recorder holds around find-plus-write, per REPOSITORY and not per checkout (Q-590, vet V6).
 *
 * ## What it prevents
 *
 * A recorder finds a record by its key and then inserts or updates it, and two recorders at once both find the key empty and
 * insert it twice. The lock made "one writer per machine" true, but it lived in `test-results/`, which belongs to ONE checkout:
 * two worktrees of one repository (this project's usual way of working) each held a lock the other never saw. The lock now lives
 * in the git COMMON dir (`git rev-parse --git-common-dir`), the one directory every worktree of a repository shares, so a
 * recorder in any of them waits for a recorder in any other. {@link recordLockPath} is that decision and nothing else; the test
 * holds the path, not a race.
 *
 * ## What it keeps
 *
 * - A recorder killed while holding the lock does not wedge the next: a dead holder's lock is broken, and an unreadable lock
 *   (a writer between create and write) is only stale after {@link LOCK_UNREADABLE_MS}.
 * - The lock is taken only around find-plus-write, AFTER all reading: a caller that reads for ten minutes (trade) does not hold
 *   every other recorder out while it does.
 * - It is released on exit and on SIGINT/SIGTERM, not only when the function ends.
 *
 * `withRecordLock` resolves `null` when the lock could not be had within the wait, never an empty answer a caller could read as
 * "done".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { holdsWithin } from '../../testing/_shared/wait-for.mjs';
import { testChildEnv } from '../../testing/_shared/test-child-env.mjs';

export const LOCK_WAIT_MS = 120_000;
export const LOCK_STALE_MS = 15 * 60_000;
export const LOCK_UNREADABLE_MS = 30_000;

/** The file name inside the git common dir. */
const LOCK_NAME = 'ythril-record.lock';

/**
 * The lock file of the repository `cwd` is in: an absolute path in its git common dir, the same from every worktree of it.
 * Throws when `cwd` is in no repository (a lock path guessed from the working directory is the per-checkout lock again).
 *
 * @param {string} [cwd]
 */
export function recordLockPath(cwd = process.cwd()) {
  let common;
  try {
    common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', env: testChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new Error(`the record lock lives in the git common dir, and git cannot find one from ${cwd}: ${String(err?.stderr || err?.message || err).split('\n')[0].trim()}`);
  }
  if (!common) throw new Error(`git printed no common dir for ${cwd}`);
  return resolve(cwd, common, LOCK_NAME);
}

function lockIsStale(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return true; } // gone while we looked
  let pid;
  try { pid = JSON.parse(text).pid; } catch { pid = undefined; }
  let ageMs = Infinity;
  try { ageMs = Date.now() - statSync(file).mtimeMs; } catch { return true; }
  if (!Number.isInteger(pid)) return ageMs > LOCK_UNREADABLE_MS; // a writer between create and write is not dead
  try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return true; }
  return ageMs > LOCK_STALE_MS;
}

/** Take the lock if it is free or its holder is dead. */
function tryLock(file) {
  try {
    const fd = openSync(file, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (lockIsStale(file)) { try { unlinkSync(file); } catch { /* a racing recorder took it first */ } }
    return false;
  }
}

/**
 * Run `fn` as the only recorder of this repository. Resolves `null` when the lock could not be had within the wait.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ cwd?: string, waitMs?: number }} [options]
 * @returns {Promise<T|null>}
 */
export async function withRecordLock(fn, { cwd = process.cwd(), waitMs = LOCK_WAIT_MS } = {}) {
  const file = recordLockPath(cwd);
  const held = await holdsWithin(() => tryLock(file), waitMs, 100, { what: 'the record lock to be free' });
  if (!held) return null;
  const release = () => { try { unlinkSync(file); } catch { /* already gone */ } };
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(1); });
  try { return await fn(); } finally { release(); process.removeListener('exit', release); }
}
