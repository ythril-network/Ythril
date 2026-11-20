/**
 * Each test's failures over the runs that ran it, from `Test-Run` records, and the tests that failed on a commit that also
 * passed (bundle-356, Q-948: the answer to `check-i-test-failure-rates-read`). Pure: rows in, an answer out; the reading is
 * `test-run-reads.mjs`, the command line `scripts/test-failure-rates.mjs`.
 *
 * ## The question it answers
 *
 * "Which tests failed on code that also passed, and how often do they fail over the runs that ran them?"
 *
 * ## What it prevents
 *
 * A reader that says "none" is believed, so every way to a false "none" or a false name is closed here, where no caller
 * can leave it out:
 *
 * - **A pass from nothing.** Fewer than two runs that hold results per test answer exit 2 (`cannot answer`), never 0. A
 *   record of `measurements: none`, one that does not parse, the old cut-down form on a red record (`truncated: true` with no
 *   failure names), one of a format version this module does not know, and one whose results cannot be vouched for
 *   (`incomplete`, `cancelled`) are left out, each COUNTED and said.
 * - **Pairs that did not test the same code.** A test is named only when its file ran without it failing in another attempt
 *   of the same run, or in another run of the same commit and the same kind. A run holding a record from uncommitted changes
 *   (`dirty`) never pairs; a pull request run pairs only within its own run (it tested the merge with its base, and its
 *   `commit` is the head); a local run never pairs with a CI run.
 * - **A wrong count.** A test is its file and its name: one name in two files is two tests. A run is one attempt of one
 *   recorded run, `(source, runId, attempt)`, and attempts are never merged. A file reported by several records of one run
 *   (shards, batches) is one run of that file, and the test failed in that run when any of them names it.
 * - **An answer over less than it says.** The lines say the span, the records and runs read, the kinds of run present and
 *   absent, and what was left out. A record without a kind field is a push to main when its source is CI and local otherwise.
 *
 * A test's runs are the runs whose records list its FILE (node's results name failing and slowest tests, not every passing
 * one), so a test added late is credited with its file's earlier runs; two tests of one name in one file count as one. The
 * lines say so.
 */

/** Every kind of run a record may say it is, in the order the lines name them. */
export const RUN_KINDS = Object.freeze(['push-main', 'pull-request', 'full-run', 'preflight', 'local']);

/** The `formatVersion` this module reads. */
const FORMAT_VERSION = 1;

/** A record's kind of run: its `runKind`, or a push to main for a CI record without one, local otherwise. */
export function runKindOf(properties) {
  if (typeof properties?.runKind === 'string' && properties.runKind) return properties.runKind;
  return properties?.source === 'ci' ? 'push-main' : 'local';
}

/** Why a record is left out, as the lines name it. */
const LEFT_OUT = Object.freeze({
  noFiles: 'without a file list',
  cut: 'cut down without names',
  version: 'of an unknown format version',
  unvouched: 'not vouched for (incomplete or cancelled)',
});

/** One record's files, each with the names of its failing tests, or `{ leftOut }` naming why it holds no result per test. */
function resultsOf(p) {
  if (p.formatVersion !== FORMAT_VERSION) return { leftOut: 'version' };
  if (p.outcome === 'incomplete' || p.outcome === 'cancelled') return { leftOut: 'unvouched' };
  let m;
  try { m = JSON.parse(String(p.measurements)); } catch { return { leftOut: 'noFiles' }; }
  if (!m || typeof m !== 'object' || !Array.isArray(m.files)) return { leftOut: 'noFiles' };
  const named = m.files.some(f => Array.isArray(f?.failures));
  if (m.truncated === true && Number(p.failed) > 0 && !named) return { leftOut: 'cut' };
  const files = new Map();
  for (const f of m.files) {
    if (typeof f?.file !== 'string' || !f.file) continue;
    const failing = files.get(f.file) ?? new Set();
    for (const k of Array.isArray(f.failures) ? f.failures : []) if (typeof k?.test === 'string') failing.add(k.test);
    files.set(f.file, failing);
  }
  return { files };
}

/** Two runs that tested the same code: another attempt of one run, or the same commit and kind; never a dirty run, never two pull request runs. */
function samecode(a, b) {
  if (a === b || a.dirty || b.dirty) return false;
  if (a.source === b.source && a.runId === b.runId) return true;
  if (a.kind !== b.kind || a.kind === 'pull-request') return false;
  return Boolean(a.commit) && a.commit === b.commit;
}

const byRate = (x, y) => (y.failures / y.runs - x.failures / x.runs) || (y.failures - x.failures)
  || (x.file < y.file ? -1 : x.file > y.file ? 1 : 0) || (x.test < y.test ? -1 : x.test > y.test ? 1 : 0);

/**
 * @param {object[]} rows `Test-Run` records as the server returns them, `properties.measurements` included
 * @param {{ since?: string, until?: string }} [span] ISO moments; a row dated before `since` is not read
 * @returns {{ exit: 0|1|2, why?: string, tests: object[], flaky: object[], coverage: object }}
 *   `tests`: every test with a failure, `{ file, test, failures, runs, kinds }`, highest rate first; `flaky`: those of them
 *   that failed on a commit that also passed
 */
export function failureRates(rows, { since, until = new Date().toISOString() } = {}) {
  const inSpan = rows.filter(r => r && (r.type === undefined || r.type === 'Test-Run') && r.properties
    && !(since && typeof r.startsAt === 'string' && r.startsAt < since));
  const records = Object.fromEntries(RUN_KINDS.map(k => [k, 0]));
  const leftOut = Object.fromEntries(Object.keys(LEFT_OUT).map(k => [k, 0]));
  const runs = new Map();
  const dates = [];
  for (const r of inSpan) {
    const p = r.properties;
    const kind = runKindOf(p);
    records[kind] = (records[kind] ?? 0) + 1;
    if (typeof r.startsAt === 'string') dates.push(r.startsAt);
    const res = resultsOf(p);
    if (res.leftOut) { leftOut[res.leftOut]++; continue; }
    const key = [p.source, p.runId, p.attempt].map(String).join('\u0000');
    let run = runs.get(key);
    if (!run) runs.set(key, run = { source: String(p.source), runId: String(p.runId), attempt: p.attempt, commit: typeof p.commit === 'string' ? p.commit : '', kind, dirty: false, files: new Map() });
    if (p.dirty !== false || run.kind !== kind || run.commit !== p.commit) run.dirty = true; // a run whose records disagree on what they tested never pairs
    for (const [file, failing] of res.files) {
      const held = run.files.get(file) ?? new Set();
      for (const t of failing) held.add(t);
      run.files.set(file, held);
    }
  }
  const runsByKind = Object.fromEntries(Object.keys(records).map(k => [k, 0]));
  for (const run of runs.values()) runsByKind[run.kind]++;
  dates.sort();
  const coverage = { since, until, records, runsByKind, recordCount: inSpan.length, runCount: runs.size, leftOut, oldest: dates[0], newest: dates.at(-1) };

  if (runs.size < 2) {
    return { exit: 2, why: `${runs.size} run(s) in the span hold results per test; at least 2 are needed to compare`, tests: [], flaky: [], coverage };
  }

  const fileRuns = new Map();
  const failedIn = new Map();
  for (const run of runs.values()) {
    for (const [file, failing] of run.files) {
      if (!fileRuns.has(file)) fileRuns.set(file, []);
      fileRuns.get(file).push(run);
      for (const test of failing) {
        const id = `${file}\u0000${test}`;
        if (!failedIn.has(id)) failedIn.set(id, { file, test, runs: [] });
        failedIn.get(id).runs.push(run);
      }
    }
  }
  const tests = [];
  for (const { file, test, runs: failing } of failedIn.values()) {
    const ran = fileRuns.get(file);
    const passedIn = ran.filter(run => !run.files.get(file).has(test));
    const flaky = failing.some(f => passedIn.some(p => samecode(f, p)));
    tests.push({ file, test, failures: failing.length, runs: ran.length, kinds: [...new Set(failing.map(f => f.kind))].sort(), flaky });
  }
  tests.sort(byRate);
  const flaky = tests.filter(t => t.flaky);
  return { exit: flaky.length ? 1 : 0, tests, flaky, coverage };
}

/** The lines a person reads: what the answer rests on, every test that failed with its rate, the named tests, then the verdict. */
export function failureRateLines({ exit, why, tests, flaky, coverage: c }) {
  const present = RUN_KINDS.filter(k => c.records[k]).concat(Object.keys(c.records).filter(k => !RUN_KINDS.includes(k) && c.records[k]));
  const absent = RUN_KINDS.filter(k => !c.records[k]);
  const lines = [
    `test-failure-rates: span ${c.since ?? 'every record'} to ${c.until}; read ${c.recordCount} records of ${c.runCount} runs`
      + (c.oldest ? ` (oldest ${c.oldest}, newest ${c.newest})` : ''),
    `kinds: ${present.length ? present.map(k => `${k} ${c.records[k]} records / ${c.runsByKind[k] ?? 0} runs`).join(', ') : 'none'}; absent: ${absent.join(', ') || 'none'}`,
    `left out: ${Object.entries(LEFT_OUT).map(([k, words]) => `${c.leftOut[k]} ${words}`).join(', ')}`,
    'a test\'s runs are the runs whose records list its file, so a test added late is credited with its file\'s earlier runs; two tests of one name in one file count as one',
  ];
  if (exit === 2) return [...lines, `test-failure-rates: cannot answer: ${why}`];
  const row = (t) => `  ${t.failures} of ${t.runs}  ${t.file}  ${t.test}  (${t.kinds.join(', ')})`;
  lines.push(`every test that failed in the span, as its failures over the runs that ran its file (${tests.length}):`, ...tests.map(row));
  lines.push(`failed on a commit that also passed (${flaky.length}):`, ...flaky.map(row));
  lines.push(flaky.length
    ? `test-failure-rates: ${flaky.length} test(s) failed on a commit that also passed (failures over the runs that ran the file, highest rate first)`
    : 'test-failure-rates: no test failed on a commit that also passed');
  return lines;
}
