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

/**
 * A count or a time as the records hold one: a finite number that is not negative, and not past `max` when one is given
 * (a client report's epoch and duration are bounded by the last millisecond a four-digit ISO date holds).
 *
 * The one bounded-number predicate for a figure from outside: a count, a duration and an epoch were three spellings of it.
 */
export const isCount = (n, { max = Infinity } = {}) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;

/** A test file's path as stored: repo-relative with forward slashes; an absolute path outside the repo is masked. */
export function storedPath(file, root) {
  const rel = repoRelative(file, root);
  return rel === null ? maskText(String(file ?? '')) : rel.slice(0, MESSAGE_CAP);
}

/**
 * How much of a failure's message a cut-down record keeps, tried in this order: the first that lets every file and every
 * failure fit is the one stored. A message is the first line of an error, so its start names the cause.
 */
export const CUT_MESSAGE_STARTS = Object.freeze([200, 60]);

/** Room kept for the wrapper and the `dropped` counts of the last form, in characters. */
const WRAPPER_ROOM = 120;

/**
 * The `measurements` text of one suite: every file's figures, the slowest tests, and what failed or skipped.
 *
 * Past {@link MAX_MEASUREMENTS_CHARS} it is cut down, and the cut drops only what it must, in this order:
 * 1. the slowest list and the skips, with a failure's message cut to its first {@link CUT_MESSAGE_STARTS} characters (the first
 *    length that fits): every file's figures and every failure's file, name and message start stay; `truncated: true` says so;
 * 2. when even that does not fit, the failures stay before the figures of files that passed, and the figures of the files that
 *    passed are left out from the last on, as many as it must; `dropped: { files, failures }` counts what is not there;
 * 3. when the failures alone do not fit, the last ones are left out and counted in `dropped.failures`.
 *
 * @param {Array<{ file: string, ms: number, tests: number, skips: Array<{ test: string, reason: string }>, failures: Array<{ test: string, message: string }> }>} files
 *   raw, in the order they are to be listed; `file` is already {@link storedPath}
 * @param {Array<{ file: string, test: string, ms: number }>} timed every test with a time, in any order
 * @returns {string} JSON: `{ files, slowest }`, or `{ truncated: true, [dropped], files }` past {@link MAX_MEASUREMENTS_CHARS}
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

  // Masked once: a form below is built up to twenty times over the same failures.
  const masked = files.map(f => ({ ...f, failures: f.failures.map(k => ({ test: maskText(k.test), message: maskText(k.message) })) }));
  const figures = (f, messageStart, failures = f.failures) => ({
    file: f.file, ms: f.ms, tests: f.tests,
    ...(failures.length ? { failures: failures.map(k => ({ test: k.test, message: k.message.slice(0, messageStart) })) } : {}),
  });
  for (const messageStart of CUT_MESSAGE_STARTS) {
    const cut = JSON.stringify({ truncated: true, files: masked.map(f => figures(f, messageStart)) });
    if (cut.length <= MAX_MEASUREMENTS_CHARS) return cut;
  }
  return failuresFirst(masked, CUT_MESSAGE_STARTS.at(-1), figures);
}

/**
 * The last form: the failures first, then as many passed files' figures as fit. The count of what is kept is found by halving
 * (a form is stringified about twenty times, not once per file).
 */
function failuresFirst(files, messageStart, figures) {
  const total = files.reduce((n, f) => n + f.failures.length, 0);
  const failing = files.filter(f => f.failures.length);
  const passedFiles = files.filter(f => !f.failures.length);
  /** Every file that holds one of the first `keptFailures` failures (in the listed order) and the first `keptPassed` that passed. */
  const form = (keptFailures, keptPassed) => {
    let left = keptFailures;
    const kept = new Set(passedFiles.slice(0, keptPassed));
    const withFailures = new Map();
    for (const f of failing) {
      if (left <= 0) break;
      const take = f.failures.slice(0, left);
      left -= take.length;
      withFailures.set(f, take);
    }
    const listed = files.filter(f => kept.has(f) || withFailures.has(f)).map(f => figures(f, messageStart, withFailures.get(f) ?? []));
    return JSON.stringify({ truncated: true, dropped: { files: files.length - listed.length, failures: total - keptFailures }, files: listed });
  };
  const largest = (max, fits) => { let lo = 0; let hi = max; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; } return lo; };
  const room = MAX_MEASUREMENTS_CHARS - WRAPPER_ROOM;
  const allFailures = form(total, 0);
  if (allFailures.length <= room) return form(total, largest(passedFiles.length, (n) => form(total, n).length <= room));
  return form(largest(total, (n) => form(n, 0).length <= room), 0);
}

/**
 * One line for a record whose `measurements` the ceiling made leave something out (the `dropped` of
 * {@link measurementsText}), or null when nothing was left out. A cut that dropped nothing says so in the record and needs no line.
 */
export function measurementsCutNote(text) {
  let dropped;
  try { dropped = JSON.parse(text)?.dropped; } catch { return null; }
  if (!dropped || !(dropped.files > 0 || dropped.failures > 0)) return null;
  return `measurements cut to fit ${MAX_MEASUREMENTS_CHARS} characters: ${dropped.files} file figure(s) and ${dropped.failures} failure(s) left out, the failures kept before the file figures`;
}
