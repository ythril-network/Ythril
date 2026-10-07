/**
 * How a suite's measured figures are STORED in a `Test-Run` record: a count is a count, a file is named as the repository
 * names it, and the `measurements` text ranks, masks and bounds what a person will read.
 *
 * ## The question it answers
 *
 * "What does a record say about the files and tests of one suite, once it is safe to store and small enough to keep?"
 * Asked by `summariseSuite` (the node suites' JSONL) and `summariseClient` (the client's vitest report) in
 * `scripts/test-times.mjs`, which differ in how they READ a run and in nothing about how they STORE it.
 *
 * ## What it prevents
 *
 * Two readers that each ranked their slowest tests, masked what they kept and fell back to per-file figures past the
 * ceiling would be two places for a rule to be wrong, and the weaker copy wins silently: a client test title carrying a
 * token must be masked exactly as a node test's is, and a run with a thousand failures must still record. So the
 * masking, the ranking and the ceiling are INSIDE {@link measurementsText}: a caller hands over what it read, raw, and
 * cannot store a name it did not mask. Masking comes after ranking, so only what is kept (the slowest few, every skip,
 * every failure) is masked, not every test name of a run.
 *
 * Built-ins and the shared leaf modules only: `--summary` runs in CI's advisory job, which has no `npm ci`.
 */
import { repoRelative } from './repo-path.mjs';
import { maskText } from './mask-text.mjs';
import { MESSAGE_CAP } from '../../testing/_shared/timing-reporter.mjs';

/** The ceiling on `measurements`, in characters; a run past it keeps per-file figures and drops the detail. */
export const MAX_MEASUREMENTS_CHARS = 400_000;

/** How many of a suite's slowest tests a record names. */
export const SLOWEST_KEPT = 20;

/** A count or a time as the records hold one: a finite number that is not negative. */
export const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A test file's path as stored: repo-relative with forward slashes; an absolute path outside the repo is masked. */
export function storedPath(file, root) {
  const rel = repoRelative(file, root);
  return rel === null ? maskText(String(file ?? '')) : rel.slice(0, MESSAGE_CAP);
}

/**
 * The `measurements` text of one suite: every file's figures, the slowest tests, and what failed or skipped.
 *
 * @param {Array<{ file: string, ms: number, tests: number, skips: Array<{ test: string, reason: string }>, failures: Array<{ test: string, message: string }> }>} files
 *   raw, in the order they are to be listed; `file` is already {@link storedPath}
 * @param {Array<{ file: string, test: string, ms: number }>} timed every test with a time, in any order
 * @returns {string} JSON: `{ files, slowest }`, or `{ truncated: true, files }` past {@link MAX_MEASUREMENTS_CHARS}
 */
export function measurementsText(files, timed) {
  const slowest = [...timed].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_KEPT).map(t => ({ file: t.file, test: maskText(t.test), ms: t.ms }));
  const slim = (f) => ({
    file: f.file, ms: f.ms, tests: f.tests,
    ...(f.skips.length ? { skips: f.skips.map(k => ({ test: maskText(k.test), reason: maskText(k.reason) })) } : {}),
    ...(f.failures.length ? { failures: f.failures.map(k => ({ test: maskText(k.test), message: maskText(k.message) })) } : {}),
  });
  const text = JSON.stringify({ files: files.map(slim), slowest });
  if (text.length <= MAX_MEASUREMENTS_CHARS) return text;
  return JSON.stringify({ truncated: true, files: files.map(f => ({ file: f.file, ms: f.ms, tests: f.tests })) });
}
