/**
 * The client's vitest JSON report, read once, in full, for every check and record that needs it.
 *
 * ## The question it answers
 *
 * "What did the client's unit tests do in this run?" Asked three ways, by one reader: which tests did not run to a verdict
 * (`scripts/unexpected-skips.mjs`), which spec files ran at least one test (`scripts/executed-tests.mjs`), and what the run
 * measured for the recorder and the run summary (`scripts/test-times.mjs`: a `Test-Run` of suite `client`). The node suites
 * write the timing reporter's JSONL (`timing-results.mjs`); the client job writes this one report, `client.json`, and neither
 * reader may treat the other's format as the whole run.
 *
 * ## What it prevents
 *
 * `executed-tests.mjs` read only the node JSONL, and the node JSONL holds no client spec, so the first CI run that reached
 * the gate would have named every client spec file as never run. Its own test wrote the client specs into the JSONL, a shape
 * no run produces, so it passed. One reader, used by every check, is the shape a real run writes: the tests in
 * `testing/standalone/_fixtures/client-reports/` are reports vitest wrote, not shapes written down for a test.
 *
 * - **A run is more than its assertions.** A spec that never collected has no assertion, and a spec whose `beforeAll` threw
 *   has skipped ones and an empty message; a reader that counted assertions alone called each a clean run. A failed FILE with
 *   no failed assertion is one test and one failure, with its message or `(no message)`. `files` holds every `testResults`
 *   entry, whatever became of it.
 * - **A test that reached no verdict is not a pass.** `skipped` (vitest also says `disabled`), `todo`, and `pending` (`run`,
 *   `queued`, `only`, or any status this reader does not know) are counted apart; a recorder reads a `pending` test as an
 *   incomplete run.
 * - **A timing is data from outside.** A missing duration or file time is 0. One that is not a finite, non-negative number
 *   (an epoch no `Date` can hold, an infinite or negative time) is IGNORED, as 0, when `strictTimes` is off, which is how the
 *   gate readers read: a timing anomaly must not turn the merge gate red. With `strictTimes` on, which is how the recorder
 *   reads, it is a refusal, because a record must not carry a figure nobody measured and a `Date` made of it would throw.
 * - **A refusal never quotes the report.** The report is text from a test run and its refusal reaches a public run summary and
 *   a warning annotation: each refusal is a fixed sentence naming the reason, never the parser's own message (which quotes
 *   the text around the break).
 * - **Names are data.** Files are an array, never an object keyed by what a report says, so a spec called `__proto__` is a
 *   file and a report that carries that key pollutes nothing.
 *
 * A missing report, one that does not parse, one that is not a vitest report, or one with no test THROWS: the client's results
 * are part of the run, and a set without them cannot say whether the client ran or skipped.
 *
 * Built-ins and the shared leaf modules only: `--summary` runs in CI's advisory job, which has no `npm ci`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { repoRelative, slashPath } from './repo-path.mjs';

/** The client's report inside the results folder: written by the client's test run (CI's client job, preflight), downloaded beside the node results. */
export const CLIENT_RESULTS = 'client.json';

// A vitest report names absolute paths (or repo-relative ones once `mask-client-report.mjs` has rewritten it), and a gate reader
// wants repo-relative ones: REPO_ROOT is the repository the script lives in.
/** Forward-slash path, relative to the repository when it lies inside it (one outside it is kept as it came). */
const repoPath = (file) => repoRelative(file, REPO_ROOT) ?? slashPath(file);

/** What a file with no usable name is called. */
const UNNAMED_SPEC = '(unnamed spec)';

/** The last millisecond of year 9999: a time a four-digit ISO date holds, which is what a record's `startsAt` is. (`Date` itself holds far more, and `Invalid time value` is what it says past that.) */
const LAST_EPOCH_MS = 253_402_300_799_999;

const isEpoch = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= LAST_EPOCH_MS;
const isDuration = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= LAST_EPOCH_MS;

/** vitest's status as the counter it moves; a status not listed here (`pending`, `run`, `queued`, `only`, an unknown one) reached no verdict. */
const KIND = new Map([['passed', 'passed'], ['failed', 'failed'], ['skipped', 'skipped'], ['disabled', 'skipped'], ['todo', 'todo']]);

/**
 * A timing field's value: `undefined` when it is missing or (not strict) unusable; a refusal naming the field when strict.
 * The sentence is fixed and holds nothing the report said.
 */
function timing(value, usable, what, strictTimes) {
  if (value === undefined || value === null) return undefined;
  if (usable(value)) return value;
  if (strictTimes) throw new Error(`the client report holds ${what} that is not a number a time can be made of`);
  return undefined;
}

const firstString = (list) => (Array.isArray(list) ? list.find(m => typeof m === 'string' && m !== '') ?? '' : '');

/**
 * The client's report as figures. Pure: text in, figures out.
 *
 * @param {string} text  the report's JSON
 * @param {{ strictTimes?: boolean }} [options]  refuse an unusable timing (the recorder) instead of ignoring it (the gate readers)
 * @returns {{
 *   tests: number, passed: number, failed: number, skipped: number, todo: number, pending: number,
 *   success: boolean|null, runnerOutcome: string|null, startMs: number|undefined, endMs: number|undefined,
 *   files: Array<{ file: string, ms: number, assertions: number, tests: Array<{ name: string, kind: string, status: string, ms: number, message: string, whole: boolean }> }>
 * }}  `files[].ms` is the file's own run time (its end minus its start: collection and setup are not in it);
 *   `startMs`..`endMs` is the report's own span, its start to the end of its last file; a test with `whole: true` (its `name`
 *   empty) is the one failure of a file that failed without a failed assertion; `success` and `runnerOutcome` are what the report says of itself
 *   (`runnerOutcome` is the stamp the producer writes: the runner's own result, `success`, `failure`, `cancelled` or `skipped`)
 * @throws when it does not parse, is not a vitest report, holds no test, or (strict) holds an unusable timing
 */
export function parseClientReport(text, { strictTimes = false } = {}) {
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('the client report does not parse as JSON'); }
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error('the client report is not a vitest JSON report (no testResults array)');
  }
  const startMs = timing(report.startTime, isEpoch, 'a start time', strictTimes);
  if (strictTimes && startMs === undefined) throw new Error('the client report has no start time');

  const counts = { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, pending: 0 };
  const files = [];
  let lastEnd;
  for (const entry of report.testResults) {
    const results = Array.isArray(entry?.assertionResults) ? entry.assertionResults : [];
    const tests = results.map((t) => {
      const status = typeof t?.status === 'string' ? t.status : '';
      return {
        name: String(t?.fullName ?? t?.title ?? '(unnamed test)'), kind: KIND.get(status) ?? 'pending', status,
        ms: timing(t?.duration, isDuration, 'a test duration', strictTimes) ?? 0, message: firstString(t?.failureMessages), whole: false,
      };
    });
    // A file that failed without a failed assertion (it never collected, a hook threw) is one failure of its own, once.
    if (entry?.status === 'failed' && !tests.some(t => t.kind === 'failed')) {
      const message = typeof entry.message === 'string' && entry.message !== '' ? entry.message : '(no message)';
      tests.push({ name: '', kind: 'failed', status: 'failed', ms: 0, message, whole: true });
    }
    for (const t of tests) { counts.tests++; counts[t.kind]++; }

    const fileStart = timing(entry?.startTime, isEpoch, 'a file start time', strictTimes);
    const fileEnd = timing(entry?.endTime, isEpoch, 'a file end time', strictTimes);
    if (fileEnd !== undefined && (lastEnd === undefined || fileEnd > lastEnd)) lastEnd = fileEnd;
    files.push({
      file: typeof entry?.name === 'string' && entry.name !== '' ? entry.name : UNNAMED_SPEC,
      ms: fileStart !== undefined && fileEnd !== undefined ? Math.max(0, fileEnd - fileStart) : 0,
      assertions: results.length, tests,
    });
  }
  if (counts.tests === 0) throw new Error('the client report holds no test: an empty client run is not a clean one');
  return {
    ...counts,
    success: typeof report.success === 'boolean' ? report.success : null,
    runnerOutcome: typeof report.runnerOutcome === 'string' ? report.runnerOutcome : null,
    startMs, endMs: startMs === undefined ? undefined : Math.max(startMs, lastEnd ?? startMs), files,
  };
}

/**
 * The report in a results folder, parsed.
 *
 * @param {string} dir  the results folder
 * @param {{ strictTimes?: boolean }} [options]  see {@link parseClientReport}
 * @throws when the report is missing, or as {@link parseClientReport}
 */
export function readClientReport(dir, options) {
  const path = join(dir, CLIENT_RESULTS);
  if (!existsSync(path)) {
    throw new Error(`${CLIENT_RESULTS} is not in ${dir}: the client job's results are part of the run, and a set without them cannot say whether the client ran or skipped`);
  }
  return parseClientReport(readFileSync(path, 'utf8'), options);
}

/**
 * The client's report as the gate checks read it: the tests that did not run to a verdict, and the spec files that ran at
 * least one test. A timing anomaly is ignored here (see the header).
 *
 * @param {string} dir  the results folder
 * @returns {{ tests: number, passed: number, failed: number, unexpected: Array<{ file: string, test: string, reason: string }>, executed: Set<string> }}
 * @throws when the report is missing, does not parse, or holds no test
 */
export function readClientResults(dir) {
  const report = readClientReport(dir);
  const unexpected = [];
  const executed = new Set();
  for (const f of report.files) {
    if (f.assertions > 0 && f.file !== UNNAMED_SPEC) executed.add(repoPath(f.file));
    for (const t of f.tests) {
      if (t.kind !== 'passed' && t.kind !== 'failed') unexpected.push({ file: repoPath(f.file), test: t.name, reason: `vitest status ${t.status}` });
    }
  }
  return { tests: report.tests, passed: report.passed, failed: report.failed, unexpected, executed };
}
