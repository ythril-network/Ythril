/**
 * The REAL vitest JSON reports under `testing/standalone/_fixtures/client-reports/`, rebased to the checkout and the clock a
 * test stands up.
 *
 * ## The question it answers
 *
 * "Give me what vitest really writes for a run of this shape, as if it had just run in THIS directory." A report names its
 * spec files by the absolute path of the checkout that produced it and stamps every file with the clock of that run; a test
 * that read one verbatim would find its files outside its own root and its run older than its own commit.
 *
 * ## What it prevents
 *
 * Two ways a fixture goes quietly wrong. A report written by hand proves the reader against its author's reading of the
 * format: the status of a file whose `beforeAll` threw, the empty `assertionResults` of a file that never collected and the
 * `message: ""` of a failed hook are only known from a run. And a real report rebased by a caller that forgot half of it
 * (the paths but not the clock, the forward-slash spelling but not the backslash one inside a stack) reads as a different
 * run in each test. Both rebasings are taken here and are not optional: {@link clientReport} refuses a call without a root
 * and a start, and refuses a report that still names the producing checkout afterwards.
 *
 * The fixtures are never edited; `README.md` beside them says how each was made.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CLIENT_REPORTS_DIR = resolve(import.meta.dirname, '..', 'standalone', '_fixtures', 'client-reports');

/** The checkout the fixtures were produced in: the one place that path is written. */
export const PRODUCED_UNDER = 'C:/ythril-wt/b73-tA';

/** Every fixture's name (file name without `.json`), read from the folder. */
export function clientReportNames() {
  const names = readdirSync(CLIENT_REPORTS_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).sort();
  if (names.length < 8) throw new Error(`client-report-fixtures: ${CLIENT_REPORTS_DIR} holds ${names.length} reports; expected the real ones (see its README.md)`);
  return names;
}

/** The report exactly as vitest wrote it, parsed. */
export function rawClientReport(name) {
  return JSON.parse(readFileSync(join(CLIENT_REPORTS_DIR, `${name}.json`), 'utf8'));
}

const asSlashes = (p) => String(p).replaceAll('\\', '/');
const asBackslashes = (p) => String(p).replaceAll('/', '\\');

/**
 * A copy of fixture `name` whose spec files lie under `root` and whose run started at `startMs` (every file's own start and end
 * move with it, so the offsets inside the run are the real ones).
 *
 * @param {string} name
 * @param {{ root: string, startMs: number }} where
 */
export function clientReport(name, { root, startMs } = {}) {
  if (typeof root !== 'string' || root === '') throw new Error('clientReport: a root is required (the checkout the specs lie under)');
  if (!Number.isFinite(startMs)) throw new Error('clientReport: a start in epoch milliseconds is required');
  const raw = rawClientReport(name);
  const delta = startMs - raw.startTime;
  const swap = (s) => s.replaceAll(PRODUCED_UNDER, asSlashes(root)).replaceAll(asBackslashes(PRODUCED_UNDER), asBackslashes(root));
  const walk = (value, key) => {
    if (typeof value === 'string') return swap(value);
    if (Array.isArray(value)) return value.map(v => walk(v, undefined));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    if (typeof value === 'number' && (key === 'startTime' || key === 'endTime')) return value + delta;
    return value;
  };
  const report = walk(raw, undefined);
  for (const f of report.testResults) {
    if (!asSlashes(f.name).startsWith(asSlashes(root))) throw new Error(`clientReport: ${name} still names a file outside ${root} (${f.name}); update PRODUCED_UNDER`);
  }
  return report;
}

/**
 * What a recorder must make of each fixture that FAILED, as the record's own words: `[name, counts, failures]`, where each failure is
 * the spec file (the tail of its path), a pattern for its test name and its first-line reason. Both doors (a local run and a CI
 * artifact) are held to this one table, so the way a file that never collected is counted cannot differ between them. These are
 * expectations about the fixtures above; they are literal on purpose and are not read out of the code under test.
 */
export const FAILURE_FIXTURES = [
  ['failed', { files: 1, tests: 2, passed: 1, failed: 1, skipped: 0 }, [{ file: 'fail.spec.ts', test: /fails an assertion/, message: 'AssertionError: expected 2 to be 3 // Object.is equality' }]],
  ['collection-failure', { files: 2, tests: 2, passed: 1, failed: 1, skipped: 0 }, [{ file: 'collection-failure.spec.ts', test: /./, message: /Failed to resolve import/ }]],
  ['beforeall-failure', { files: 1, tests: 3, passed: 0, failed: 1, skipped: 2 }, [{ file: 'beforeall-failure.spec.ts', test: /./, message: '(no message)' }]],
  ['all-collection-failure', { files: 2, tests: 2, passed: 0, failed: 2, skipped: 0 }, [
    { file: 'collection-failure.spec.ts', test: /./, message: /Failed to resolve import/ },
    { file: 'collection-failure-two.spec.ts', test: /./, message: 'this file throws while it is being collected' },
  ]],
];

/** A report's own span, as the plan defines it: its start to the end of its last file. */
export function reportSpan(report) {
  const ends = report.testResults.map(f => f.endTime).filter(Number.isFinite);
  return { startMs: report.startTime, endMs: Math.max(report.startTime, ...ends) };
}

/** What a report says its spec files are, in the order it lists them. */
export const specNames = (report) => report.testResults.map(f => f.name);

/** The spec files fixture `name` ran, repo-relative (what the checkout that produced it tracked): to be committed into a scratch repository. */
export const specPaths = (name) => rawClientReport(name).testResults.map(f => {
  const slashed = asSlashes(f.name);
  if (!slashed.startsWith(`${PRODUCED_UNDER}/`)) throw new Error(`specPaths: ${name} names ${f.name}, outside ${PRODUCED_UNDER}; update PRODUCED_UNDER`);
  return slashed.slice(PRODUCED_UNDER.length + 1);
});
