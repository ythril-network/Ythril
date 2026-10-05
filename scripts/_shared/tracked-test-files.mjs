/**
 * Which test files does this repository HAVE — the one answer both "does a CI job reach it" and "did it run" start from.
 *
 * ## Why it is a module
 *
 * `scripts/unrun-tests.mjs` (is every test file selected by a CI job) and `scripts/executed-tests.mjs` (did every one of
 * them produce a test event) subtract from the same set. If each listed the files itself they could disagree about what a
 * test file IS — one counting a `.mjs` spec, the other not — and the difference is exactly the file that is checked by
 * neither. So the definition and the listing are written once.
 *
 * ## The floor is inside
 *
 * An empty listing passes every loop written over it, and "nothing unrun" computed from nothing is a success about a
 * repository that was never read. `trackedTestFiles` THROWS under its floor instead of returning a short list, so a caller
 * cannot receive the failure quietly.
 *
 * ## Why git, and why a `root`
 *
 * `git ls-files`, because a file on disk that git does not track is not a file CI has (a scratch test would "pass" locally
 * and never run on the runner). `root` is a parameter because the scripts are exercised against a copy of the tracked layout
 * with a file added to it; the working tree they are run from is never touched to prove they notice.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** A test file: `*.test.js` / `*.test.mjs` / `*.test.ts` or `*.spec.js` / `*.spec.ts` (not `tsconfig.spec.json`). */
export const TEST_FILE = /\.(?:test\.(?:[cm]?js|ts)|spec\.(?:[cm]?js|ts))$/;

/**
 * The fewest tracked test files that means the listing worked. Set far under what the repository holds so adding or
 * removing tests never trips it; it is not a statement of how many tests there are.
 */
export const TRACKED_TEST_FLOOR = 100;

const NUL = String.fromCharCode(0);

/** Every tracked file of the repository at `root`, repo-relative with forward slashes. */
export function trackedFiles(root) {
  return execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], {
    cwd: resolve(root), maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8').split(NUL).map(f => f.trim().replace(/\\/g, '/')).filter(Boolean);
}

/**
 * The tracked test files of the repository at `root`, sorted.
 *
 * @param {string} root
 * @returns {string[]}
 * @throws when fewer than `TRACKED_TEST_FLOOR` are found
 */
export function trackedTestFiles(root) {
  const files = trackedFiles(root).filter(f => TEST_FILE.test(f)).sort();
  if (files.length < TRACKED_TEST_FLOOR) {
    throw new Error(`only ${files.length} tracked test file(s) under ${resolve(root)}, under the floor of ${TRACKED_TEST_FLOOR}. `
      + 'The listing is broken (not a git checkout, or the wrong root), not the tests: an empty set minus an empty set is '
      + '"nothing missing", which reports success about a repository that was never read.');
  }
  return files;
}
