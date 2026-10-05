/**
 * A throw-away directory that is a git repository, and the one way to run git in it — for a test whose subject reads
 * "the repository it runs in" and must be shown a repository of its own making, never the checkout it is run from.
 *
 * ## Why a module
 *
 * Three fixtures built one (`makeWorkdir` for the test-times recorder, `makeCiRoot` for the unrun/executed-tests
 * scripts, and an inline `git init` for an empty root), each with its own idea of what git needs to be told. The parts a
 * copy forgets are the ones that only fail on someone else's machine:
 *
 * - **who commits.** A machine with no `user.name`, or one that signs every commit, fails a scratch commit the test never
 *   meant to make interesting. Every call here carries the identity and `commit.gpgsign=false` itself.
 * - **line endings.** `core.autocrlf` on a developer's Windows checkout rewrites a scratch file at `git add` and the
 *   test then reads a repository that differs from the one it wrote. Every call carries `core.autocrlf=false`.
 * - **the cleanup.** Windows holds a directory open a moment after the process that used it exits; a bare `rmSync`
 *   then throws from an `after` hook and fails a file whose tests all passed. `cleanup` retries.
 *
 * One question: *"give me an empty repository I can write into and throw away"*. What goes in it (copied files, a
 * commit, a dirty tree) is the caller's, through `git` and `dir`; this module does not grow an option per fixture.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Settings every call carries, so a scratch repository behaves the same on every machine. */
const ALWAYS = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

/**
 * @param {{ prefix?: string, branch?: string }} [o]  `prefix` names the temporary directory; `branch` is the initial branch
 * @returns {{ dir: string, git: (...args: string[]) => string, cleanup: () => void }}
 *   `git(...)` runs in `dir` and answers its stdout, untrimmed (a `-z` listing must not lose a byte); it throws when git fails.
 */
export function makeScratchRepo({ prefix = 'scratch-repo-', branch = 'main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync('git', [...ALWAYS, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  try {
    git('init', '-q', '-b', branch);
  } catch (error) {
    cleanup();
    throw error;
  }
  return { dir, git, cleanup };
}
