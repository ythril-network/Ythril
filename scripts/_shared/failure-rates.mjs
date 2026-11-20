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
 *
 * ## The two more lists (slice S5, the answer to `check-i-never-failed-slow-tests-examined`)
 *
 * {@link failureLists}: "which of the slowest test files never failed, and which tests only ever failed together?", over the
 * same runs ({@link collectRuns}), with the same exit 2 for what it cannot answer. What each prevents:
 *
 * - **A file named as never failed that failed, or was barely seen.** The slowest tenth of the files by the per-file times (the
 *   caller reads the snapshot; a missing one is exit 2, never an empty list) less every file with a failure in the span. A file
 *   that ran in fewer than two runs of the span is left out and COUNTED. A client file's time is vitest's and not comparable with
 *   a node file's, so the client files are ranked among themselves and have their own tenth.
 * - **A group of tests that did not fail together.** Tests that each failed at least twice and failed in exactly the same runs,
 *   compared over the runs that ran both tests' files: a test whose file did not run in a shard is not counted as passing there,
 *   and one that passed beside the other's failure breaks the group. A group is built only of tests that pair with every other.
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

/** The words of exit 2 when too few runs hold results; one text for every list. */
const tooFewRuns = (n) => `${n} run(s) in the span hold results per test; at least 2 are needed to compare`;

/**
 * The runs the records of a span hold, and what the answer rests on: every list reads its runs here, so no list can count a record
 * another leaves out.
 *
 * @returns {{ runs: Map<string, object>, coverage: object }}
 */
function collectRuns(rows, { since, until }) {
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
  return { runs, coverage: { since, until, records, runsByKind, recordCount: inSpan.length, runCount: runs.size, leftOut, oldest: dates[0], newest: dates.at(-1) } };
}

/** Per file the runs that ran it, and per test (file and name) the runs it failed in. */
function indexRuns(runs) {
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
  return { fileRuns, failedIn };
}

/**
 * @param {object[]} rows `Test-Run` records as the server returns them, `properties.measurements` included
 * @param {{ since?: string, until?: string }} [span] ISO moments; a row dated before `since` is not read
 * @returns {{ exit: 0|1|2, why?: string, tests: object[], flaky: object[], coverage: object }}
 *   `tests`: every test with a failure, `{ file, test, failures, runs, kinds }`, highest rate first; `flaky`: those of them
 *   that failed on a commit that also passed
 */
export function failureRates(rows, { since, until = new Date().toISOString() } = {}) {
  const { runs, coverage } = collectRuns(rows, { since, until });
  if (runs.size < 2) return { exit: 2, why: tooFewRuns(runs.size), tests: [], flaky: [], coverage };

  const { fileRuns, failedIn } = indexRuns(runs);
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

/** What every answer says it rests on: the span, the records and runs read, the kinds of run present and absent, what was left out. */
function restsOnLines(c) {
  const present = RUN_KINDS.filter(k => c.records[k]).concat(Object.keys(c.records).filter(k => !RUN_KINDS.includes(k) && c.records[k]));
  const absent = RUN_KINDS.filter(k => !c.records[k]);
  return [
    `test-failure-rates: span ${c.since ?? 'every record'} to ${c.until}; read ${c.recordCount} records of ${c.runCount} runs`
      + (c.oldest ? ` (oldest ${c.oldest}, newest ${c.newest})` : ''),
    `kinds: ${present.length ? present.map(k => `${k} ${c.records[k]} records / ${c.runsByKind[k] ?? 0} runs`).join(', ') : 'none'}; absent: ${absent.join(', ') || 'none'}`,
    `left out: ${Object.entries(LEFT_OUT).map(([k, words]) => `${c.leftOut[k]} ${words}`).join(', ')}`,
  ];
}

/** The lines a person reads: what the answer rests on, every test that failed with its rate, the named tests, then the verdict. */
export function failureRateLines({ exit, why, tests, flaky, coverage: c }) {
  const lines = [
    ...restsOnLines(c),
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

/** Every list the reader can print, in the order they print. */
export const LISTS = Object.freeze(['rates', 'never-failed', 'together']);

/** The slowest tenth of a ranking group, rounded up so a group of fewer than ten still holds its slowest file. */
const TENTH = 10;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A client file's time is vitest's and not comparable with a node file's: each ranks in its own group. */
const rankingGroupOf = (file) => (file.startsWith('client/') ? 'client' : 'node');

/**
 * The slowest tenth of each ranking group of `files` (path to milliseconds), less the files in `failedFiles`; a file that ran in
 * fewer than two runs is left out and counted.
 */
function neverFailedSlowest(files, fileRuns, failedFiles) {
  const groups = new Map();
  for (const [file, ms] of Object.entries(files)) {
    if (file === '__proto__' || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) continue;
    const group = rankingGroupOf(file);
    groups.set(group, [...(groups.get(group) ?? []), { file, ms }]);
  }
  const listed = [];
  let tooFew = 0;
  for (const ranked of groups.values()) {
    ranked.sort((a, b) => (b.ms - a.ms) || byText(a.file, b.file));
    for (const { file, ms } of ranked.slice(0, Math.ceil(ranked.length / TENTH))) {
      if (failedFiles.has(file)) continue;
      const runs = fileRuns.get(file)?.length ?? 0;
      if (runs < 2) { tooFew++; continue; }
      listed.push({ file, ms, runs });
    }
  }
  listed.sort((a, b) => (b.ms - a.ms) || byText(a.file, b.file));
  return { listed, tooFew };
}

/** The runs both sets hold. */
const common = (a, b) => new Set([...a].filter(run => b.has(run)));

/**
 * Whether `members` (tests with `ran`, the set of runs that ran their file, and `failed`, the set of runs they failed in) failed
 * in exactly the same runs, at least two, over the runs that ran all of their files.
 */
function failedAlike(members) {
  const both = members.map(m => m.ran).reduce(common);
  const sets = members.map(m => common(m.failed, both));
  return sets[0].size >= 2 && sets.every(s => s.size === sets[0].size && [...s].every(run => sets[0].has(run)));
}

/**
 * Groups of tests that each failed at least twice and failed in exactly the same runs every time. A test joins a group only when
 * it pairs with every member over the runs that ran both their files and the whole group still agrees over the runs that ran
 * every file, so no pair of a group has a run where one failed beside the other passing.
 */
function failedTogether(failedIn, fileRuns) {
  const candidates = [...failedIn.values()].filter(t => t.runs.length >= 2).sort((a, b) => byText(a.file, b.file) || byText(a.test, b.test))
    .map(t => ({ file: t.file, test: t.test, failed: new Set(t.runs), ran: new Set(fileRuns.get(t.file)) }));
  const groups = [];
  for (const cand of candidates) {
    const home = groups.find(g => g.every(m => failedAlike([m, cand])) && failedAlike([...g, cand]));
    if (home) home.push(cand); else groups.push([cand]);
  }
  return groups.filter(g => g.length >= 2).map((members) => {
    const both = members.map(m => m.ran).reduce(common);
    return { tests: members.map(({ file, test }) => ({ file, test })), failures: common(members[0].failed, both).size, runs: both.size };
  }).sort((a, b) => (b.failures / b.runs - a.failures / a.runs) || (b.tests.length - a.tests.length)
    || byText(a.tests[0].file, b.tests[0].file) || byText(a.tests[0].test, b.tests[0].test));
}

/**
 * The slowest tenth of the test files with no failure in the span, and the tests that only ever failed together.
 *
 * @param {object[]} rows `Test-Run` records as the server returns them, `properties.measurements` included
 * @param {{ since?: string, until?: string, fileTimes?: { files: Record<string, number> } | null, fileTimesWhy?: string, lists?: string[] }} [options]
 *   `fileTimes`: the per-file times snapshot (null when it cannot be read, `fileTimesWhy` saying why); `lists`: which of
 *   `never-failed` and `together` are asked (both by default); the times are needed only for `never-failed`
 * @returns {{ exit: 0|1|2, why?: string, neverFailed: Array<{ file: string, ms: number, runs: number }>, tooFew: number,
 *   together: Array<{ tests: Array<{ file: string, test: string }>, failures: number, runs: number }>, coverage: object }}
 *   exit 0: both asked lists are empty; 1: one holds an entry; 2: no answer (never a pass)
 */
export function failureLists(rows, { since, until = new Date().toISOString(), fileTimes = null, fileTimesWhy, lists = ['never-failed', 'together'] } = {}) {
  const { runs, coverage } = collectRuns(rows, { since, until });
  const none = { neverFailed: [], tooFew: 0, together: [], coverage };
  if (runs.size < 2) return { exit: 2, why: tooFewRuns(runs.size), ...none };
  const wantsNeverFailed = lists.includes('never-failed');
  if (wantsNeverFailed && !(fileTimes && typeof fileTimes.files === 'object' && fileTimes.files !== null)) {
    return { exit: 2, why: `the per-file times cannot be read: ${fileTimesWhy ?? 'no snapshot given'}`, ...none };
  }
  const { fileRuns, failedIn } = indexRuns(runs);
  const slow = wantsNeverFailed ? neverFailedSlowest(fileTimes.files, fileRuns, new Set([...failedIn.values()].map(t => t.file))) : { listed: [], tooFew: 0 };
  const together = lists.includes('together') ? failedTogether(failedIn, fileRuns) : [];
  return { exit: slow.listed.length || together.length ? 1 : 0, neverFailed: slow.listed, tooFew: slow.tooFew, together, coverage };
}

/**
 * The lines of the two more lists: what the answer rests on (unless the caller printed it already), each asked list, the verdict.
 *
 * @param {ReturnType<typeof failureLists>} answer
 * @param {{ lists?: string[], withHeader?: boolean }} [options]
 */
export function failureListLines({ exit, why, neverFailed, tooFew, together, coverage: c }, { lists = ['never-failed', 'together'], withHeader = true } = {}) {
  const lines = withHeader ? restsOnLines(c) : [];
  if (exit === 2) return [...lines, `test-failure-rates: cannot answer: ${why}`];
  if (lists.includes('never-failed')) {
    lines.push(`the slowest tenth of the test files by recorded time with no failure in the span (${neverFailed.length}; ${tooFew} left out: ran in fewer than two runs of the span, so never listed as never failed):`,
      ...neverFailed.map(e => `  ${Math.round(e.ms)} ms  ${e.runs} runs  ${e.file}`));
  }
  if (lists.includes('together')) {
    lines.push(`tests that each failed at least twice and failed in exactly the same runs, over the runs that ran their files (${together.length} groups):`);
    for (const g of together) lines.push(`  ${g.failures} of ${g.runs}  (${g.tests.length} tests)`, ...g.tests.map(t => `    ${t.file}  ${t.test}`));
  }
  const held = [neverFailed.length && `${neverFailed.length} slow file(s) never failed`, together.length && `${together.length} group(s) only ever failed together`].filter(Boolean);
  const asked = [lists.includes('never-failed') && 'slow file never failed', lists.includes('together') && 'tests only ever failed together'].filter(Boolean);
  lines.push(held.length ? `test-failure-rates: ${held.join('; ')}` : `test-failure-rates: no ${asked.join(' and no ')}`);
  return lines;
}
