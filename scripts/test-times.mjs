#!/usr/bin/env node
/**
 * The protocol of test runs: one `Test-Run` chrono entry per suite of a run, written to a Ythril instance you point
 * it at, so "how long does main take, and is this file slower than it was" is read from a record and not from a CI
 * log (`Q-370`). The recorder reads what the reporter wrote (`test-results/*.jsonl`); it does not run tests.
 *
 *     node scripts/test-times.mjs --record            record the local run in test-results/
 *     node scripts/test-times.mjs --record-ci         record the trusted CI runs not yet recorded
 *     node scripts/test-times.mjs --rewrite <key>     record one run again, from its own results
 *     node scripts/test-times.mjs --trend [--last N] [--flags]
 *     node scripts/test-times.mjs --summary --results <dir>   the run's page (CI's advisory job); records nothing
 *     node scripts/test-times.mjs --help
 *
 * ## What this prevents
 *
 * Six ways a recorder like this goes wrong quietly, each closed in one place:
 *
 * 1. **A stranger's numbers.** CI runs live in a public repository where anyone may open a pull request or push to
 *    a fork, and every one of them can upload an artifact called `test-results-…`. {@link trustedRuns} is the ONE
 *    function that turns the Actions API's list into the runs worth reading, from the RUN OBJECT alone; nothing an
 *    artifact says about itself is believed, and {@link parseArtifact} reads the bytes as hostile input (size caps,
 *    no `..` or absolute names, nothing written to disk). `--record-ci`, the baselines and `--trend` all start there.
 * 2. **A second record for the same run.** The identity is {@link recordKey}, `source:runId:attempt:job:suite`. The
 *    recorder FINDS by `properties.recordKey`, then updates by id or inserts: it cannot supply its own id, because
 *    `save_chrono` ignores one that names nothing. Two recorders at once would race the find and the insert, so
 *    there is one writer per machine (`test-results/.record.lock`), and every write collapses duplicates of its key
 *    to the newest.
 * 3. **A "passed" that was not.** `outcome` and `scope` are derived from what the run left: the JSONL set for a node
 *    suite (a file without its sentinel, with a wrong event count or a last line cut mid-object is `incomplete`, never
 *    `passed`), the vitest report for the client (a test still pending, a runner that stamped a failure the report does
 *    not count, `success: false` with no failure counted: `incomplete` as well). `layout` is a LABEL of the workflow's
 *    shape, derived from which jobs left results (`ci-parallel-v2` when more than one test job did, else `ci-serial-v1`;
 *    never from a job's name), and is not a key to compare records by. A baseline is drawn only from `scope: full` +
 *    `outcome: passed` + branch `main`, each suite on its own.
 * 4. **A lost record.** When the instance is unset, unreachable or refuses, the payload is kept in
 *    `test-results/unrecorded/`, one line says why, and the next `--record` that can reach the instance drains it.
 *    A recording problem is never a test failure: `--record` exits 0 whenever it could not record.
 * 5. **A leaked secret.** The token goes to the instance and nowhere else (`scripts/_shared/ythril-api.mjs` holds
 *    the guards), is never printed or stored, and a failure message is masked of token-shaped strings and home
 *    paths before it is written. Recording is refused under `GITHUB_ACTIONS` / `CI`: CI never holds the token.
 * 6. **An undocumented input.** Every flag and variable this reads is in {@link HELP}, printed by `--help`.
 *
 * ## Decisions the plan left open
 *
 * - **Backfill** (`--record-ci`) walks the completed, trusted runs newest first and stops at the FIRST run that is
 *   recorded COMPLETELY (the instance holds a record of it and of every job whose results artifact the run still lists;
 *   decided from the artifact list and the held keys, so no zip is downloaded for a job already recorded), or after
 *   {@link BACKFILL_RUNS} runs. A run recorded only partly (the instance went away between its records) is not the stop:
 *   the records it lacks are written, the ones it has are left alone, and the walk goes on to older runs. Because the
 *   walk records newest first, a partial run is always at the frontier. A recorded run whose remaining artifacts can
 *   never be read (not a zip, past the size cap) is the stop and is said without failing the pass; a download that
 *   failed is tried again. A recorded run whose artifacts have all expired is recorded, and gets no `none` row. An
 *   older run past the horizon that was never recorded is reported once and written as nothing.
 * - **The client is a suite like the others** (`suite: client`): `--record` reads `test-results/client.json` beside the node
 *   `*.jsonl`, `--record-ci` reads it from the client job's own artifact (`test-results-client-tests-<attempt>`, the entry
 *   named `client.json` and no other), both through `scripts/_shared/client-results.mjs`. Each suite is its own problem: a
 *   client report that is stale, unreadable or missing from its artifact is one line naming it and never costs the node
 *   records. The recorder is run by hand (`--record` after a local run, `--record-ci` for CI); nothing runs it for you.
 * - **A trusted run with no usable artifact** (none uploaded, or expired) is recorded once with
 *   `measurements: 'none'`, job `workflow`, suite `ci`, scope `subset` (so no baseline is drawn from it), its
 *   `ms` the run's wall time, so the walk never fetches it again.
 * - **`--rewrite <recordKey>`** re-records the run the key names: a CI key from that run's artifacts (the run must
 *   pass {@link trustedRuns}; it refuses when the artifacts are gone rather than overwrite a measured record with
 *   `none`), a local key from `test-results/`.
 *
 * Run the tests: `node --test testing/standalone/test-times-*.test.js`
 */
import { inflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createYthrilApi, assertBearerSafeUrl, YthrilApiError } from './_shared/ythril-api.mjs';
import { CI_WORKFLOW } from '../testing/_shared/ci-workflow-path.mjs';
import { readCappedBody } from './_shared/capped-body.mjs';
import { isEntryPoint } from './_shared/script-cli.mjs';
import { timingResultFiles } from './_shared/timing-results.mjs';
import { readTimingLog, TIMING_RESULTS_FOLDER } from '../testing/_shared/timing-reporter.mjs';
import { maskText } from './_shared/mask-text.mjs';
import { holdsWithin } from '../testing/_shared/wait-for.mjs';
import { ciSignal } from '../testing/_shared/running-under-ci.mjs';
import { isExpectedInCiSkip } from '../testing/_shared/expected-in-ci.mjs';
import { CLIENT_RESULTS, parseClientReport, readClientReport } from './_shared/client-results.mjs';
import { isCount, storedPath, measurementsText } from './_shared/measurements.mjs';
import { renderRunSummary, seconds } from './_shared/run-summary.mjs';

// ---- what is recorded, and where ----------------------------------------------------------------------------------

// The recorder's mask is `scripts/_shared/mask-text.mjs`'s; it stays importable from here for the callers that took it from the recorder.
export { maskText };

export const REPO = 'ythril-network/Ythril';
export const WORKFLOW_PATH = CI_WORKFLOW;
export const SPACE = 'y-proj-ythril';
export const CHRONO_TYPE = 'Test-Run';
export const FORMAT_VERSION = 1;

/** Runs `--record-ci` examines in one walk. */
export const BACKFILL_RUNS = 30;

/** Relative to the working directory: the recorder reads the checkout it is run in. */
const RESULTS_DIR = TIMING_RESULTS_FOLDER;
const UNRECORDED_DIR = join(RESULTS_DIR, 'unrecorded');
const LOCK_FILE = join(RESULTS_DIR, '.record.lock');

/**
 * The properties of one `Test-Run` entry: the ONE description of a record. The recorder builds its object from this
 * list (a key outside it is a bug, not a property), and the chrono type declared on the instance is generated from
 * it, so the writer and the declaration cannot disagree about a field.
 *
 * `ms` is the sum of the files' own durations; `wallMs` is the clock time of the run or job (a node suite's span from its
 * results' sentinel, the client's from its report: its start to the end of its last file); the two differ whenever files
 * overlap. A node file's duration has its module load inside it; a CLIENT file's is vitest's own, from its start to its
 * end, and leaves out collection and setup, so a client figure is not comparable with a node one.
 */
export const TEST_RUN_SCHEMA = Object.freeze({
  recordKey: { type: 'string', required: true, doc: '`source:runId:attempt:job:suite`, `:` and `%` escaped inside a part. The identity: a second recording finds this one.' },
  formatVersion: { type: 'number', required: true, doc: 'The version of this list; a reader skips a record of a version it does not know.' },
  source: { type: 'string', required: true, values: ['ci', 'local'], doc: 'Where the run happened.' },
  commit: { type: 'string', required: true, doc: 'The full commit sha the run tested.' },
  branch: { type: 'string', required: true, doc: 'The branch: the run object\'s for CI, git\'s for a local run.' },
  runId: { type: 'string', required: true, doc: 'The Actions run id as text, or `local-<start>-<commit7>`.' },
  attempt: { type: 'number', required: true, doc: 'The run attempt (1 for a local run).' },
  job: { type: 'string', required: true, doc: 'The CI job that produced the results (the id its artifact name carries), or `local`.' },
  suite: { type: 'string', required: true, doc: 'The suite the results belong to: a node suite\'s name, or `client` for the client\'s vitest run.' },
  ms: { type: 'number', required: true, doc: 'The sum of the files\' own durations, in milliseconds. A node file\'s includes its module load; a client file\'s is vitest\'s own run time for it and excludes collection and setup.' },
  wallMs: { type: 'number', required: false, doc: 'The clock time of the run or job, in milliseconds, when its own results say it: a node suite\'s sentinel span, the client report\'s start to the end of its last file. Absent when they do not.' },
  files: { type: 'number', required: true, doc: 'Test files that reported.' },
  tests: { type: 'number', required: true, doc: 'Tests, skipped suites and failures attributed to a hook or a file (for the client, a file that failed without a failed test, and a test that never reached a verdict, count here).' },
  passed: { type: 'number', required: true, doc: 'Tests that passed.' },
  failed: { type: 'number', required: true, doc: 'Failures, each counted once.' },
  cancelled: { type: 'number', required: true, doc: 'Tests cancelled by their parent.' },
  skipped: { type: 'number', required: true, doc: 'Tests and suites skipped.' },
  todo: { type: 'number', required: true, doc: 'Tests marked todo.' },
  outcome: { type: 'string', required: true, values: ['passed', 'failed', 'cancelled', 'incomplete'], doc: '`incomplete` when the results cannot be vouched for (no sentinel, wrong count, cut line; for the client a test that never reached a verdict, or a runner that failed with no failure counted).' },
  scope: { type: 'string', required: true, values: ['full', 'subset', 'files'], doc: 'What the runner covered. Baselines are drawn from `full` only.' },
  layout: { type: 'string', required: true, values: ['local', 'ci-serial-v1', 'ci-parallel-v2'], doc: 'A label for the shape of the workflow or machine: `ci-parallel-v2` when the run left results of more than one test job, `ci-serial-v1` when it left one. Not a key to compare records by: records written before the label was derived this way all say `ci-serial-v1`.' },
  dirty: { type: 'boolean', required: true, doc: 'The working tree had uncommitted changes (always false for CI).' },
  measurements: { type: 'string', required: true, doc: 'JSON: every file\'s ms, tests, skips and failures, and the slowest tests; `none` when the run had no usable artifact.' },
  measurementsChars: { type: 'number', required: false, doc: 'The length of `measurements`, so a reader can ask for it whole.' },
});

/** How long a `Test-Run` entry is kept on the instance, in days: the retention `--type-schema` declares. */
export const TEST_RUN_RETENTION_DAYS = 365;

/** The chrono types a space has before it declares its own; declaring one without them closes the space to them. */
const DEFAULT_CHRONO_TYPES = Object.freeze(['event', 'deadline', 'plan', 'prediction', 'milestone']);

/**
 * The arguments of the `schema_update` call that declares the `Test-Run` chrono type on {@link SPACE}, generated from
 * {@link TEST_RUN_SCHEMA}: the writer and the declaration cannot disagree about a field, and the retention the guide
 * promises exists only because this was sent. Printed by `--type-schema`.
 */
export function testRunTypeDeclaration() {
  const propertySchemas = {};
  for (const [key, f] of Object.entries(TEST_RUN_SCHEMA)) {
    propertySchemas[key] = { type: f.type, ...(f.values ? { enum: [...f.values] } : {}), ...(f.required ? { required: true } : {}), description: f.doc };
  }
  const chrono = Object.fromEntries(DEFAULT_CHRONO_TYPES.map(t => [t, {}]));
  chrono[CHRONO_TYPE] = {
    description: 'One suite of one test run (local or CI), written by scripts/test-times.mjs. Found by date and filter, never by meaning: embeddings are suppressed. A passed date means nothing here. Kept one year.',
    suppressEmbeddings: true,
    whenDuePasses: 'nothing',
    retention: { days: TEST_RUN_RETENTION_DAYS },
    propertySchemas,
  };
  return { space: SPACE, typeSchemas: { chrono }, typeSchemasMode: 'merge' };
}

/** `maxChars` asked of `filter` for a page that excludes `measurements`. */
const PAGE_MAX_CHARS = 1_000_000;

function assertConforms(properties) {
  for (const [key, value] of Object.entries(properties)) {
    const field = TEST_RUN_SCHEMA[key];
    if (!field) throw new Error(`test-times: ${key} is not a Test-Run property`);
    if (typeof value !== field.type) throw new Error(`test-times: ${key} must be a ${field.type}`);
    if (field.values && !field.values.includes(value)) throw new Error(`test-times: ${key} must be one of ${field.values.join(', ')}`);
  }
  for (const [key, field] of Object.entries(TEST_RUN_SCHEMA)) {
    if (field.required && properties[key] === undefined) throw new Error(`test-times: ${key} is required`);
  }
  return properties;
}

// ---- who may be read ----------------------------------------------------------------------------------------------

/**
 * The runs worth reading: a push to `main` of THIS repository, from `ci.yml`. Decided from the run object the API
 * returned and from nothing an artifact claims: a fork's push has another head repository, a pull request's run
 * reports `…ci.yml@refs/pull/N/merge`, another workflow reports its own file. A failed run is admitted: identity is
 * not outcome, and a failed main run still has timings.
 *
 * @param {object[]} runs
 * @returns {object[]}
 */
export function trustedRuns(runs) {
  if (!Array.isArray(runs)) throw new TypeError('trustedRuns: the list of runs must be an array');
  return runs.filter(r => r !== null && typeof r === 'object'
    && r.event === 'push'
    && r.head_repository?.full_name === REPO
    && r.repository?.full_name === REPO
    && r.path === WORKFLOW_PATH
    && r.head_branch === 'main');
}

// ---- reading an artifact ------------------------------------------------------------------------------------------

const ENTRY_CAP = 20_000_000;
const TOTAL_CAP = 200_000_000;
const ENTRY_COUNT_CAP = 1000;

/**
 * The entries of a ZIP artifact, read as hostile input and returned as buffers; nothing is written anywhere.
 * The WHOLE archive is refused (never filtered) for: a `..` segment or an absolute name (POSIX, drive letter or UNC),
 * an entry that inflates past 20 MB or a total past 200 MB (measured on what is INFLATED, never on the header), a
 * header whose size is not the entry's, encryption, zip64, an unknown method, a repeated name, a truncated archive.
 *
 * @param {Buffer} buf
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function parseArtifact(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip archive');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralStart = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) throw new Error('zip64 archives are not read');
  if (count > ENTRY_COUNT_CAP) throw new Error('archive holds too many entries');
  if (centralStart + centralSize > eocd) throw new Error('corrupt central directory');

  const out = [];
  const seen = new Set();
  let total = 0;
  let p = centralStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const declaredSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLength > eocd) throw new Error('corrupt central directory');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (name === '' || name.includes('\0')) throw new Error('refused an entry with an empty or NUL name');
    if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')) {
      throw new Error(`refused an entry name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new Error(`refused a repeated entry name: ${JSON.stringify(name)}`);
    seen.add(name);
    if (flags & 1) throw new Error('refused an encrypted entry');
    if (name.endsWith('/')) continue; // a directory holds nothing
    if (declaredSize > ENTRY_CAP) throw new Error(`entry ${JSON.stringify(name)} is larger than ${ENTRY_CAP} bytes`);

    if (localOffset + 30 > centralStart || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('corrupt local header');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compressedSize > centralStart) throw new Error('truncated archive');
    const raw = buf.subarray(start, start + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: ENTRY_CAP }); } catch (err) { throw new Error(`entry ${JSON.stringify(name)} refused: ${err.code ?? err.message}`); }
    } else throw new Error(`entry ${JSON.stringify(name)} uses an unsupported method`);

    if (data.length > ENTRY_CAP) throw new Error(`entry ${JSON.stringify(name)} is larger than ${ENTRY_CAP} bytes`);
    if (data.length !== declaredSize) throw new Error(`entry ${JSON.stringify(name)} is not the size its header states`);
    if (typeof crc32 === 'function' && (crc32(data) >>> 0) !== crc) throw new Error(`entry ${JSON.stringify(name)} fails its checksum`);
    total += data.length;
    if (total > TOTAL_CAP) throw new Error(`archive is larger than ${TOTAL_CAP} bytes`);
    out.push({ name, data });
  }
  return out;
}

// ---- identity -----------------------------------------------------------------------------------------------------

const escapePart = (v) => String(v).replace(/%/g, '%25').replace(/:/g, '%3A');
const unescapePart = (v) => v.replace(/%3A/g, ':').replace(/%25/g, '%');

/**
 * `source:runId:attempt:job:suite`, the same string whether a number arrives as the API's number or as text, and
 * never the same for two runs: a `:` or `%` inside a part is escaped, so no two cuts of the parts meet.
 */
export function recordKey({ source, runId, attempt, job, suite } = {}) {
  if (source !== 'ci' && source !== 'local') throw new Error('recordKey: source must be ci or local');
  const parts = { runId, attempt, job, suite };
  for (const [name, value] of Object.entries(parts)) {
    if (value === undefined || value === null || String(value) === '' || /[\r\n\0]/.test(String(value))) throw new Error(`recordKey: ${name} is missing or not a plain value`);
  }
  return [source, runId, attempt, job, suite].map(escapePart).join(':');
}

/** The parts of a key, or null when it is not one. */
function parseRecordKey(key) {
  const parts = String(key).split(':');
  if (parts.length !== 5 || (parts[0] !== 'ci' && parts[0] !== 'local')) return null;
  const [source, runId, attempt, job, suite] = parts.map(unescapePart);
  return { source, runId, attempt, job, suite };
}

// ---- reading results ----------------------------------------------------------------------------------------------

const SUITE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const isoOrNull = (s) => (typeof s === 'string' && ISO.test(s) && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null);

/** The suite a results file belongs to: what its lines say, else the part of its name before the first `-`. */
export function suiteOf(text, fileName) {
  const { lines, end } = readTimingLog(text);
  const said = lines.find(l => typeof l?.suite === 'string' && SUITE_NAME.test(l.suite))?.suite ?? end?.suite;
  if (typeof said === 'string' && SUITE_NAME.test(said)) return said;
  const named = fileName.replace(/\.jsonl$/, '').split('-')[0];
  return SUITE_NAME.test(named) ? named : null;
}

/**
 * One suite's results (one text per batch) as the figures of a record.
 *
 * Counting rules, each from probe P1 of the plan: a skip is a PASS line with `skip` truthy, a skipped SUITE included
 * (it counts as one skipped test); a failure is a failed `test` line, and a failed `suite` or `file` line only when no
 * test in that file failed (node reports the wrapper as failed too, so counting it would count one cause twice) -
 * and then the deepest failed suites only, so a hook failing in a nested describe is one red; the counts partition
 * `tests`.
 *
 * @param {{ texts: string[], root: string }} input
 */
export function summariseSuite({ texts, root }) {
  const logs = texts.map(text => readTimingLog(text));
  let malformed = 0;
  const byFile = new Map();
  for (const log of logs) {
    for (const l of log.lines) {
      const ok = l !== null && typeof l === 'object' && ['test', 'suite', 'file'].includes(l.type) && typeof l.file === 'string' && l.file !== '' && isCount(l.ms);
      if (!ok) { malformed++; continue; }
      const file = storedPath(l.file, root);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(l);
    }
  }

  const c = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  const files = [];
  const slowest = [];
  let ms = 0;
  for (const [file, lines] of byFile) {
    const entry = { file, ms: 0, tests: 0, skips: [], failures: [] };
    for (const l of lines) if (l.type === 'file') entry.ms += l.ms;
    for (const l of lines) {
      if (l.type === 'test') {
        entry.tests++; c.tests++;
        if (l.skip) { c.skipped++; entry.skips.push({ test: l.test, reason: l.reason }); }
        else if (l.todo) c.todo++;
        else if (l.status === 'fail') { c.failed++; entry.failures.push({ test: l.test, message: l.message }); }
        else if (l.status === 'cancelled') c.cancelled++;
        else c.passed++;
        slowest.push({ file, test: l.test, ms: l.ms });
      } else if (l.type === 'suite' && l.skip) {
        entry.tests++; c.tests++; c.skipped++;
        entry.skips.push({ test: l.test, reason: l.reason });
      }
    }
    const testFailed = lines.some(l => l.type === 'test' && l.status === 'fail' && !l.skip);
    if (!testFailed) {
      const failedSuites = lines.filter(l => l.type === 'suite' && l.status === 'fail');
      const deepest = Math.max(0, ...failedSuites.map(l => l.nesting ?? 0));
      let own = failedSuites.filter(l => (l.nesting ?? 0) === deepest);
      if (!own.length) own = lines.filter(l => l.type === 'file' && l.status === 'fail');
      for (const l of own) {
        entry.tests++; c.tests++; c.failed++;
        entry.failures.push({ test: l.test || file, message: l.message });
      }
    }
    ms += entry.ms;
    files.push(entry);
  }

  const complete = logs.length > 0 && logs.every(l => l.complete) && malformed === 0;
  const outcome = c.failed ? 'failed' : c.cancelled ? 'cancelled' : complete ? 'passed' : 'incomplete';
  const scopes = logs.map(l => l.end?.scope);
  const scope = scopes.length && scopes.every(s => s === 'full') ? 'full' : scopes.includes('files') ? 'files' : 'subset';
  const starts = logs.map(l => isoOrNull(l.end?.startedAt)).filter(Boolean).sort();
  const ends = logs.map(l => isoOrNull(l.end?.endedAt)).filter(Boolean).sort();

  const measurements = measurementsText(files, slowest);
  return { outcome, scope, ms: Math.round(ms), fileCount: files.length, ...c, startedAt: starts[0] ?? null, endedAt: ends.at(-1) ?? null, measurements };
}

/**
 * The client's vitest run as the figures of a record, `summariseSuite`'s counterpart for the other kind of results.
 *
 * Counting rules are the reader's (`parseClientReport`): a skip is a `skipped` test, a file that failed without a failed test
 * is one failure, a test that reached no verdict is counted a test and not a pass. What this adds is the verdict about the RUN:
 * `failed` when any failure is counted; `incomplete` when a test never reached a verdict, when the runner's own stamp
 * (`runnerOutcome`) says the test command did not succeed with no failure counted to explain it, or when the report says
 * `success: false` with none; else `passed`. A report from before the stamp existed is read by the rule without it: that is
 * the stated limit, and a test command that died outside the assertions leaves such a report looking clean.
 *
 * Both doors call this, so masking (inside `measurementsText`), the stored path of a file and the ceiling on `measurements`
 * are the same whichever door the report came through. The report is read with `strictTimes`, so the figures here are
 * finite and non-negative and the span is a span `Date` can hold.
 *
 * @param {{ report: ReturnType<typeof parseClientReport>, root: string, trackedSpecs?: string[]|null }} input
 *   `trackedSpecs` is the `.spec.ts` files tracked at the commit a LOCAL run is recorded against: the run is `full` when every
 *   one of them is an entry of the report (one that failed to collect is an entry: the claim is about what was run, not what
 *   passed). `null` is CI, whose client job always runs the whole suite and cannot be narrowed by a filter: `full`.
 */
export function summariseClient({ report, root, trackedSpecs = null }) {
  const files = [];
  const timed = [];
  for (const f of report.files) {
    const file = storedPath(f.file, root);
    const entry = { file, ms: f.ms, tests: f.tests.length, skips: [], failures: [] };
    for (const t of f.tests) {
      const name = t.whole ? file : t.name;
      if (t.kind === 'skipped') entry.skips.push({ test: name, reason: `vitest status ${t.status}` });
      else if (t.kind === 'failed') entry.failures.push({ test: name, message: t.message });
      if (!t.whole) timed.push({ file, test: name, ms: t.ms });
    }
    files.push(entry);
  }
  const ran = new Set(files.map(f => f.file));
  const scope = trackedSpecs === null || (trackedSpecs.length > 0 && trackedSpecs.every(s => ran.has(s))) ? 'full' : 'subset';
  const runnerFailed = report.runnerOutcome !== null && report.runnerOutcome !== 'success';
  const outcome = report.failed ? 'failed' : report.pending || runnerFailed || report.success === false ? 'incomplete' : 'passed';
  const iso = (ms) => (ms === undefined ? null : new Date(ms).toISOString());
  return {
    outcome, scope, ms: Math.round(files.reduce((sum, f) => sum + f.ms, 0)), fileCount: files.length,
    tests: report.tests, passed: report.passed, failed: report.failed, cancelled: 0, skipped: report.skipped, todo: report.todo,
    startedAt: iso(report.startMs), endedAt: iso(report.endMs), measurements: measurementsText(files, timed),
  };
}

/** The milliseconds from `start` to `end` (ISO texts), or `undefined` when either is missing: a span nobody recorded is not a span. */
function wallBetween(start, end) {
  const ms = start && end ? Date.parse(end) - Date.parse(start) : Number.NaN;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** A suite's own span, from its own results (a node suite's sentinel, the client report's start and last file end). */
const wallOf = (summary) => wallBetween(summary.startedAt, summary.endedAt);

/**
 * One `save_chrono` payload from a suite's figures and the identity of the run.
 * `startsAt`/`endsAt` default to the results' own; the caller supplies the run object's for CI. `wallMs` is the caller's
 * to give, from the results' own span ({@link wallOf}): it is never derived here from `startsAt`/`endsAt`, which for CI are
 * the RUN's and would give every job the run's wall.
 */
function buildPayload({ source, runId, attempt, job, suite, summary, commit, branch, layout, dirty, startsAt, endsAt, wallMs }) {
  const start = startsAt ?? summary.startedAt;
  const end = endsAt ?? summary.endedAt ?? start;
  const properties = assertConforms({
    recordKey: recordKey({ source, runId, attempt, job, suite }),
    formatVersion: FORMAT_VERSION, source, commit, branch, runId: String(runId), attempt: Number(attempt), job, suite,
    ms: summary.ms, ...(Number.isFinite(wallMs) ? { wallMs: Math.round(wallMs) } : {}),
    files: summary.fileCount, tests: summary.tests, passed: summary.passed, failed: summary.failed, cancelled: summary.cancelled,
    skipped: summary.skipped, todo: summary.todo, outcome: summary.outcome, scope: summary.scope, layout, dirty,
    measurements: summary.measurements, measurementsChars: summary.measurements.length,
  });
  return { space: SPACE, type: CHRONO_TYPE, title: `${job}: ${suite} (${source}) ${commit.slice(0, 7)}`, status: 'completed', startsAt: start, endsAt: end, properties };
}

// ---- writing to the instance --------------------------------------------------------------------------------------

/**
 * A comparator that puts the larger value of `field` first (ISO times compare as text). The one newest-first order of this
 * script's rows: a record's `createdAt`, a run summary's `startsAt`. Its ascending twin is the same comparator with its
 * arguments swapped, never a second spelling of the comparison.
 */
const newestBy = (field) => (a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0);

const newestFirst = newestBy('createdAt');
const newestStartFirst = newestBy('startsAt');

/** The entries holding `key`, newest first. The server's predicate is not trusted: a row that lacks the key is not one. */
async function findByKey(api, key) {
  const answer = await api.call('filter', {
    space: SPACE, collection: 'chrono', filter: { type: CHRONO_TYPE, 'properties.recordKey': key },
    projection: { 'properties.measurements': 0 }, sort: 'createdAt', dir: 'desc', limit: 100, maxChars: PAGE_MAX_CHARS,
  });
  const rows = answer?.data?.results;
  if (!Array.isArray(rows)) throw new YthrilApiError('filter: the answer carried no results', { tool: 'filter' });
  return rows.filter(r => r?.type === CHRONO_TYPE && r?.properties?.recordKey === key && typeof r._id === 'string').sort(newestFirst);
}

/**
 * Write one record: find by key, collapse duplicates to the newest, update it by id; insert when there is none.
 * Embedding is suppressed on the write itself as well as by the type: a run is found by date and filter, never by
 * meaning, and a 100 KB string is never sent to the embedder even before the type is declared.
 */
async function recordPayload(api, payload) {
  const rows = await findByKey(api, payload.properties.recordKey);
  if (!rows.length) return api.call('save_chrono', { ...payload, suppressEmbeddings: true, checkDuplicates: false });
  const [keep, ...duplicates] = rows;
  for (const d of duplicates) await api.call('delete_chrono', { space: SPACE, id: d._id });
  const { space, type: _type, ...rest } = payload;
  return api.call('update_chrono', { space, id: keep._id, ...rest, suppressEmbeddings: true });
}

/**
 * The record keys the instance already holds for one CI run. The question the stop rule asks is "is this run recorded
 * COMPLETELY", and that is answered by comparing these with the keys the run's artifacts would produce: one record of
 * the run is not enough (a recorder that died after the first job's record left the rest unrecorded for good, because
 * any record of the run read as "recorded" and the walk stopped there).
 */
async function recordedKeysOfRun(api, runId) {
  const answer = await api.call('filter', {
    space: SPACE, collection: 'chrono', filter: { type: CHRONO_TYPE, 'properties.source': 'ci', 'properties.runId': String(runId) },
    projection: { 'properties.measurements': 0 }, limit: 100, maxChars: PAGE_MAX_CHARS,
  });
  const rows = answer?.data?.results;
  if (!Array.isArray(rows)) throw new YthrilApiError('filter: the answer carried no results', { tool: 'filter' });
  return new Set(rows.filter(r => r?.properties?.source === 'ci' && r?.properties?.runId === String(runId)
    && typeof r?.properties?.recordKey === 'string').map(r => r.properties.recordKey));
}

// ---- one writer per machine ---------------------------------------------------------------------------------------

const LOCK_WAIT_MS = 120_000;
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_UNREADABLE_MS = 30_000;

function lockIsStale() {
  let text;
  try { text = readFileSync(LOCK_FILE, 'utf8'); } catch { return true; } // gone while we looked
  let pid;
  try { pid = JSON.parse(text).pid; } catch { pid = undefined; }
  let ageMs = Infinity;
  try { ageMs = Date.now() - statSync(LOCK_FILE).mtimeMs; } catch { return true; }
  if (!Number.isInteger(pid)) return ageMs > LOCK_UNREADABLE_MS; // a writer between create and write is not dead
  try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return true; }
  return ageMs > LOCK_STALE_MS;
}

/** Take the lock if it is free or its holder is dead. */
function tryLock() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  try {
    const fd = openSync(LOCK_FILE, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (lockIsStale()) { try { unlinkSync(LOCK_FILE); } catch { /* a racing recorder took it first */ } }
    return false;
  }
}

/**
 * Run `fn` as the only recorder on this machine. A recorder killed while holding the lock does not wedge the next:
 * a dead holder's lock is broken. Resolves `null` when the lock could not be had within the wait.
 */
async function withRecordLock(fn) {
  const held = await holdsWithin(tryLock, LOCK_WAIT_MS, 100, { what: 'the record lock to be free' });
  if (!held) return null;
  const release = () => { try { unlinkSync(LOCK_FILE); } catch { /* already gone */ } };
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(1); });
  try { return await fn(); } finally { release(); process.removeListener('exit', release); }
}

// ---- --record -----------------------------------------------------------------------------------------------------

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Under CI no recording is done: CI never holds the write token, and a token found there is a leak to refuse. */
function refuseUnderCi(flag) {
  const named = ciSignal();
  if (!named) return null;
  console.error(`test-times: ${flag} is refused when ${named} is set: CI never holds the token that writes records, so nothing is sent`);
  return 2;
}

/** The destination, or the reason there is none. */
function destination() {
  const url = process.env.YTHRIL_TEST_RUNS_URL;
  const token = process.env.YTHRIL_TEST_RUNS_TOKEN;
  if (!url) return { why: 'YTHRIL_TEST_RUNS_URL unset' };
  if (!token) return { why: 'YTHRIL_TEST_RUNS_TOKEN unset' };
  try { return { api: createYthrilApi({ url, token }), shownUrl: url.replace(/\/+$/, '') }; } catch (err) { return { why: err.message }; }
}

/**
 * The first line of what a thrown value says (or of a string): the one way this script puts a failure on a line. Not the
 * timing reporter's `firstLine`, which takes a test's message and masks and caps it; this one reads a caught `err`, and its
 * callers hand it errors this script built or a library's, never a test's text.
 */
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/** The one-line reason a call failed, naming the status and the instance, never a secret. */
const whyOf = (err, shownUrl) => (err instanceof YthrilApiError && err.status !== undefined ? `${err.status} from ${shownUrl}` : firstLine(err));

/** A failure that every later call would repeat: the instance is not there, or it refuses this token. */
const stopsEverything = (err) => !(err instanceof YthrilApiError) || err.status === undefined || err.status === 401 || err.status === 403;

const unrecordedName = (payload) => `${payload.properties.recordKey.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

function keepPayload(payload, why) {
  mkdirSync(UNRECORDED_DIR, { recursive: true });
  const name = unrecordedName(payload);
  writeFileSync(join(UNRECORDED_DIR, name), JSON.stringify(payload));
  console.log(`test-times: not recorded: ${why}; kept test-results/unrecorded/${name}`);
}

/** Write the kept payloads that can now be written; whatever cannot stays where it is. */
async function drainUnrecorded(api, shownUrl) {
  if (!existsSync(UNRECORDED_DIR)) return;
  let drained = 0;
  for (const name of readdirSync(UNRECORDED_DIR).filter(n => n.endsWith('.json')).sort()) {
    const file = join(UNRECORDED_DIR, name);
    let payload;
    try {
      payload = JSON.parse(readFileSync(file, 'utf8'));
      if (payload?.type !== CHRONO_TYPE || payload?.space !== SPACE) throw new Error('not a Test-Run payload');
      assertConforms(payload.properties);
    } catch (err) { console.log(`test-times: left test-results/unrecorded/${name}: ${err.message}`); continue; }
    try { await recordPayload(api, payload); unlinkSync(file); drained++; } catch (err) {
      console.log(`test-times: left test-results/unrecorded/${name}: ${whyOf(err, shownUrl)}`);
      if (stopsEverything(err)) break;
    }
  }
  if (drained) console.log(`test-times: drained ${drained} unrecorded record(s)`);
}

/** The `.spec.ts` files tracked at `commit`: what "the client's whole suite" is for a local run recorded against it. */
function specsTrackedAt(commit) {
  const NUL = String.fromCharCode(0);
  const listed = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return listed.split(NUL).filter(f => f.endsWith('.spec.ts'));
}

/**
 * The client's report in `test-results/` as one payload, or the reason there is none. A report written before the commit being
 * recorded is not that commit's run (the file outlives the run that wrote it), so it is a reason and not a record.
 */
function localClientPayload({ root, commit, branch, dirty }) {
  const report = readClientReport(RESULTS_DIR, { strictTimes: true });
  const committedAtMs = Number(git('log', '-1', '--format=%ct', commit)) * 1000;
  if (report.startMs < committedAtMs) throw new Error('client report older than this commit: it is not this commit\'s run');
  const summary = summariseClient({ report, root, trackedSpecs: specsTrackedAt(commit) });
  const runId = `local-${summary.startedAt.replace(/[-:.]/g, '')}-${commit.slice(0, 7)}`;
  return buildPayload({ source: 'local', runId, attempt: 1, job: 'local', suite: 'client', summary, commit, branch, layout: 'local', dirty, wallMs: wallOf(summary) });
}

/**
 * The local run in `test-results/`, one payload per suite (the node suites' JSONL, and the client's `client.json`), and one
 * problem per suite that could not be made into one: a suite's trouble is only that suite's.
 *
 * @returns {{ payloads: object[], problems: string[] }}
 */
function localPayloads() {
  const root = process.cwd();
  const results = timingResultFiles(RESULTS_DIR);
  const hasClient = existsSync(join(RESULTS_DIR, CLIENT_RESULTS));
  if (!results.length && !hasClient) return { payloads: [], problems: [] };
  const commit = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const dirty = git('status', '--porcelain').length > 0;
  const problems = [];

  const bySuite = new Map();
  for (const { name, path, text } of results) {
    const suite = suiteOf(text, name);
    if (!suite) { console.log(`test-times: skipped ${path}: no suite name`); continue; }
    if (!bySuite.has(suite)) bySuite.set(suite, []);
    bySuite.get(suite).push({ text, mtime: statSync(path).mtime });
  }

  const payloads = [];
  for (const [suite, items] of bySuite) {
    try {
      const summary = summariseSuite({ texts: items.map(i => i.text), root });
      // A killed run has no sentinel; its files' own times stand in, so recording it twice names one run.
      const mtimes = items.map(i => i.mtime.toISOString()).sort();
      const start = summary.startedAt ?? mtimes[0];
      const end = summary.endedAt ?? mtimes.at(-1);
      const runId = `local-${start.replace(/[-:.]/g, '')}-${commit.slice(0, 7)}`;
      payloads.push(buildPayload({ source: 'local', runId, attempt: 1, job: 'local', suite, summary, commit, branch, layout: 'local', dirty, startsAt: start, endsAt: end, wallMs: wallBetween(start, end) }));
    } catch (err) { problems.push(`${suite}: ${firstLine(err)}`); }
  }
  if (hasClient) {
    try { payloads.push(localClientPayload({ root, commit, branch, dirty })); } catch (err) { problems.push(`client (${CLIENT_RESULTS}): ${firstLine(err)}`); }
  }
  return { payloads, problems };
}

/** Say each suite that could not be recorded, in one line each; a recording problem is never a failure. */
const sayProblems = (problems) => { for (const p of problems) console.log(`test-times: not recorded: ${p}`); };

async function recordLocal() {
  const refused = refuseUnderCi('--record');
  if (refused) return refused;
  let found;
  try { found = localPayloads(); } catch (err) { console.log(`test-times: not recorded: ${firstLine(err)}`); return 0; }
  sayProblems(found.problems);
  if (!found.payloads.length && !found.problems.length) console.log(`test-times: nothing to record: no test-results/*.jsonl or ${CLIENT_RESULTS}`);
  return recordPayloads(found.payloads);
}

/** Record payloads under the lock (or keep them); a recording problem is never a failure. */
async function recordPayloads(payloads) {
  const dest = destination();
  let locked;
  try { locked = await recordUnderLock(payloads, dest); } catch (err) {
    console.log(`test-times: not recorded: ${firstLine(err)}`);
    return 0;
  }
  if (locked === null) for (const p of payloads) keepPayload(p, 'another recorder holds test-results/.record.lock');
  return 0;
}

function recordUnderLock(payloads, dest) {
  return withRecordLock(async () => {
    if (!dest.api) { for (const p of payloads) keepPayload(p, dest.why); return; }
    await drainUnrecorded(dest.api, dest.shownUrl);
    let stopped = null;
    for (const p of payloads) {
      if (stopped) { keepPayload(p, stopped); continue; }
      try {
        await recordPayload(dest.api, p);
        console.log(`test-times: recorded ${p.properties.recordKey}`);
      } catch (err) {
        const why = whyOf(err, dest.shownUrl);
        keepPayload(p, why);
        if (stopsEverything(err)) stopped = why;
      }
    }
  });
}

// ---- --record-ci --------------------------------------------------------------------------------------------------

/** Pages of 100 runs read from the listing; a run past them is older than its artifacts' retention. */
const LISTING_PAGES = 5;
const GITHUB_TIMEOUT_MS = 30_000;
const GITHUB_JSON_CAP = 20_000_000;
const GITHUB_ZIP_CAP = 100_000_000;
const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The id, in `ci.yml`, of the job that runs the client's tests: the one whose results artifact holds `client.json`. */
const CLIENT_JOB = 'client-tests';

/** The GitHub Actions API, for this repository only, with the guards the Ythril client has. */
function githubClient() {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set (a token that can read this repository\'s Actions runs and artifacts)');
  const root = assertBearerSafeUrl(process.env.GITHUB_API_URL || 'https://api.github.com', 'GITHUB_API_URL');

  async function fetchCapped(url, init, cap, what) {
    let res;
    try { res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) }); } catch (err) {
      throw new Error(`${what}: request ${err?.name === 'TimeoutError' ? 'timed out' : `failed (${err?.cause?.code ?? err?.name})`}`);
    }
    if (res.status >= 300 && res.status < 400) return { res, bytes: null };
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`${what}: GitHub answered ${res.status}`); }
    return { res, bytes: await readCappedBody(res, cap, { refuse: (limit) => new Error(`${what}: answer larger than ${limit} bytes`) }) };
  }

  const authorised = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' };
  const assertRepo = (path) => { if (!path.startsWith(`/repos/${REPO}/`)) throw new Error(`refused to read ${path}: only ${REPO} is read`); };

  return {
    async json(path) {
      assertRepo(path);
      const { res, bytes } = await fetchCapped(`${root}${path}`, { headers: authorised }, GITHUB_JSON_CAP, path);
      if (bytes === null) throw new Error(`${path}: GitHub answered a redirect (${res.status})`);
      return JSON.parse(bytes.toString('utf8'));
    },
    /** An artifact's bytes. GitHub answers with a redirect to storage; that address gets no token. */
    async zip(path) {
      assertRepo(path);
      const first = await fetchCapped(`${root}${path}`, { headers: authorised }, GITHUB_ZIP_CAP, path);
      if (first.bytes) return first.bytes;
      const target = new URL(first.res.headers.get('location') ?? '', `${root}${path}`);
      if (target.username || target.password) throw new Error(`${path}: the download address carries credentials`);
      assertBearerSafeUrl(target.origin, 'the artifact download address');
      const second = await fetchCapped(target.href, { headers: {} }, GITHUB_ZIP_CAP, 'artifact download');
      if (!second.bytes) throw new Error('artifact download: a second redirect is refused');
      return second.bytes;
    },
  };
}

const outcomeOfConclusion = (c) => (c === 'success' ? 'passed' : c === 'failure' || c === 'timed_out' ? 'failed' : c === 'cancelled' ? 'cancelled' : 'incomplete');
const runIdOf = (run) => (Number.isSafeInteger(run.id) && run.id > 0 ? run.id : null);
const startedOf = (run) => isoOrNull(run.run_started_at) ?? isoOrNull(run.created_at);

/**
 * The client's report among the entries of the client job's artifact, or undefined. Found by its exact entry name and
 * nowhere else: a `client.json` in another job's artifact (a merged folder, a stranger's upload) is not a client run, and
 * neither is one under a folder. The caller asks it of the client job's artifact only.
 */
const clientReportIn = (entries) => entries.find(e => e.name === CLIENT_RESULTS);

/** Workflow runs, newest start first; two starting together, the higher run id first. */
const newestRunFirst = (a, b) => (startedOf(b) ?? '').localeCompare(startedOf(a) ?? '') || Number(b.id) - Number(a.id);
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

/**
 * The latest attempt's results artifact per job (`test-results-<job>-<attempt>`), by job name. An artifact of an attempt
 * later than the run's own, an expired one, or one whose job name is not a plain name is not believed. Read by the
 * recorder and by the summary's baseline: the one place that says which artifact of a run counts.
 *
 * @returns {Map<string, { attempt: number, id: number, size: number }>}
 */
function latestResultArtifacts(artifacts, run) {
  const latest = new Map();
  for (const { job, attempt, artifact: a } of resultArtifacts(artifacts, run)) {
    if (a.expired || !Number.isSafeInteger(a.id)) continue;
    if (!latest.has(job) || latest.get(job).attempt < attempt) latest.set(job, { attempt, id: a.id, size: a.size_in_bytes });
  }
  return latest;
}

/** Every artifact of a run that is named as a job's results (`test-results-<job>-<attempt>`, the attempt not later than the run's), expired or not: the ONE reading of that name. */
function resultArtifacts(artifacts, run) {
  const named = [];
  for (const a of artifacts) {
    const m = /^test-results-(.+)-(\d+)$/.exec(a?.name ?? '');
    if (!m || !JOB_NAME.test(m[1])) continue;
    const attempt = Number(m[2]);
    if (attempt >= 1 && attempt <= run.run_attempt) named.push({ job: m[1], attempt, artifact: a });
  }
  return named;
}

/**
 * The label of a CI run's shape: `ci-parallel-v2` when results of more than one job exist, else `ci-serial-v1`. Read from the
 * artifact names, which carry the job ids, and never from the Actions API's job list: that names a job by its DISPLAY name
 * (`Prepare`, `Client tests`), so a comparison with a job id never matches. An expired artifact still names its job. A label,
 * not a key: records written before this was derived this way all say `ci-serial-v1`.
 */
const layoutOfRun = (artifacts, run) => (new Set(resultArtifacts(artifacts, run).map(r => r.job)).size > 1 ? 'ci-parallel-v2' : 'ci-serial-v1');

/** The `attempt` and `job` of each key of one run that the instance holds, as one string each: what "this job is recorded" compares. */
const recordedJobsOf = (have) => new Set([...have].map(parseRecordKey).filter(Boolean).map(p => JSON.stringify([p.attempt, p.job])));

/**
 * The payloads of one trusted, completed run. Identity (`runId`, `attempt`, `commit`, `branch`, `source`, `dirty`,
 * `layout`) is the run object's and the artifact LIST's (which jobs left results, never a job's name) - the artifact supplies
 * figures, a suite name and the span of its own run, nothing else.
 *
 * `have` is the record keys the instance already holds for this run. A job whose artifact the run still lists and that
 * has a record in `have` is NOT downloaded: the question this answers for the walk is "is the run recorded", decided from
 * the artifact LIST and those keys (the zip of a job already recorded proves nothing the record does not). A run whose
 * artifacts are all expired but which has records is recorded, so it yields no `none` row either.
 *
 * `problems` are artifacts that could not be read, each `{ text, persistent }`: persistent is a file that is not what it
 * says (not a zip, past the size cap, no suite), which the next pass will find the same way; a download that failed is
 * not, and is tried again.
 */
async function ciPayloads(gh, run, have = new Set()) {
  const runId = runIdOf(run);
  const startsAt = startedOf(run);
  const endsAt = isoOrNull(run.updated_at) ?? startsAt;
  if (!runId || !startsAt || !isSha(run.head_sha) || !Number.isInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error(`run ${String(run.id)}: the run object lacks an id, a start, a commit or an attempt`);
  }
  const base = `/repos/${REPO}/actions/runs/${runId}`;
  const artifacts = (await gh.json(`${base}/artifacts?per_page=100`)).artifacts ?? [];
  const common = { source: 'ci', runId, commit: run.head_sha, branch: run.head_branch, layout: layoutOfRun(artifacts, run), dirty: false, startsAt, endsAt };

  const latest = latestResultArtifacts(artifacts, run);

  const payloads = [];
  const problems = [];
  const recordedJobs = recordedJobsOf(have);
  for (const [job, found] of latest) {
    if (recordedJobs.has(JSON.stringify([String(found.attempt), job]))) continue;
    if (Number.isFinite(found.size) && found.size > GITHUB_ZIP_CAP) { problems.push({ text: `${job}: the artifact is larger than ${GITHUB_ZIP_CAP} bytes`, persistent: true }); continue; }
    let bytes;
    try { bytes = await gh.zip(`/repos/${REPO}/actions/artifacts/${found.id}/zip`); } catch (err) { problems.push({ text: `${job}: ${err.message}`, persistent: false }); continue; }
    let entries;
    try { entries = parseArtifact(bytes); } catch (err) { problems.push({ text: `${job}: ${err.message}`, persistent: true }); continue; }
    const bySuite = new Map();
    for (const e of entries.filter(e => e.name.endsWith('.jsonl'))) {
      const text = e.data.toString('utf8');
      const suite = suiteOf(text, e.name.split('/').at(-1));
      if (!suite) { problems.push({ text: `${job}: ${e.name} names no suite`, persistent: true }); continue; }
      if (!bySuite.has(suite)) bySuite.set(suite, []);
      bySuite.get(suite).push(text);
    }
    // A job's wall is the span ITS OWN results recorded (a node suite's sentinel); a job whose results record none has no wall,
    // never the run's and never another job's.
    for (const [suite, texts] of bySuite) {
      const summary = summariseSuite({ texts, root: process.cwd() });
      payloads.push(buildPayload({ ...common, attempt: found.attempt, job, suite, summary, wallMs: wallOf(summary) }));
    }
    if (job === CLIENT_JOB) {
      const entry = clientReportIn(entries);
      if (!entry) { problems.push({ text: `${job}: ${CLIENT_RESULTS} is not in the artifact, so the client's run is not recorded`, persistent: true }); continue; }
      try {
        const summary = summariseClient({ report: parseClientReport(entry.data.toString('utf8'), { strictTimes: true }), root: process.cwd() });
        payloads.push(buildPayload({ ...common, attempt: found.attempt, job, suite: 'client', summary, wallMs: wallOf(summary) }));
      } catch (err) { problems.push({ text: `${job}: ${CLIENT_RESULTS} cannot be read (${firstLine(err)}), so the client's run is not recorded`, persistent: true }); }
    }
  }

  // A run that left nothing measurable is recorded once as that, so it is not fetched again — unless the instance already
  // holds records of it: a run whose artifacts have since expired is recorded, and a row of "nothing" beside its real ones
  // would say it was never read.
  if (!latest.size && have.size === 0) {
    const summary = { outcome: outcomeOfConclusion(run.conclusion), scope: 'subset', ms: 0, fileCount: 0, tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, measurements: 'none' };
    const wall = wallBetween(startsAt, endsAt) ?? 0;
    payloads.push(buildPayload({ ...common, attempt: run.run_attempt, job: 'workflow', suite: 'ci', summary: { ...summary, ms: wall }, wallMs: wall }));
  }
  return { payloads, problems };
}

/** Walk the trusted completed runs newest first; with `rewriteKey`, only the run that key names, and without the stop rule. */
async function recordCi({ rewriteKey } = {}) {
  const refused = refuseUnderCi(rewriteKey ? '--rewrite' : '--record-ci');
  if (refused) return refused;
  let gh;
  try { gh = githubClient(); } catch (err) { console.error(`test-times: ${err.message}`); return 1; }
  const dest = destination();
  if (!dest.api) { console.error(`test-times: cannot record: ${dest.why}`); return 1; }

  let exit = 0;
  const locked = await withRecordLock(async () => {
    // Both modes read the same listing, filtered by the API and by trustedRuns(): a run that is not in it is not
    // trusted. A rewrite looks for its run in it (a run older than the listing's pages has no artifacts left anyway).
    const parts = rewriteKey ? parseRecordKey(rewriteKey) : null;
    if (rewriteKey && (!parts || parts.source !== 'ci' || !/^\d+$/.test(parts.runId))) { console.error('test-times: --rewrite needs a ci record key (ci:<runId>:<attempt>:<job>:<suite>)'); exit = 1; return; }
    const collected = [];
    for (let page = 1; page <= LISTING_PAGES; page++) {
      const listed = await gh.json(`/repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100&page=${page}`);
      const batch = trustedRuns(listed?.workflow_runs ?? []).filter(r => r.status === 'completed');
      if (!(listed?.workflow_runs ?? []).length) break;
      collected.push(...batch);
      if (rewriteKey ? collected.some(r => String(r.id) === parts.runId) : collected.length >= BACKFILL_RUNS) break;
    }
    const newest = collected.sort(newestRunFirst);
    const runs = rewriteKey ? newest.filter(r => String(r.id) === parts.runId) : newest.slice(0, BACKFILL_RUNS);
    if (rewriteKey && !runs.length) { console.error(`test-times: run ${parts.runId} is not among the completed pushes to main of ${REPO} from ci.yml; nothing rewritten`); exit = 1; return; }

    let recorded = 0;
    let stoppedAtRecorded = false;
    for (const run of runs) {
      try {
        const have = rewriteKey ? new Set() : await recordedKeysOfRun(dest.api, run.id);
        const built = await ciPayloads(gh, run, have);
        const { problems } = built;
        // A recorded run is the stop: the instance holds records of it and nothing the run still lists is missing one. A run
        // with SOME is completed: only the missing ones are written (a record the run already has is left as it is;
        // `--rewrite <recordKey>` replaces one on purpose). What cannot be read for good (a file that is not a zip) does
        // not keep a recorded run from being the stop, and is said without failing the pass: it would fail every pass.
        const payloads = built.payloads.filter(p => !have.has(p.properties.recordKey));
        if (!rewriteKey && have.size > 0 && payloads.length === 0 && problems.every(p => p.persistent)) {
          for (const p of problems) console.log(`test-times: run ${run.id}: ${p.text} (recorded without it; nothing to read there)`);
          stoppedAtRecorded = true;
          break;
        }
        for (const p of problems) { console.log(`test-times: run ${run.id}: ${p.text}`); exit = 1; }
        if (rewriteKey && payloads.every(p => p.properties.measurements === 'none')) {
          console.error(`test-times: run ${run.id} has no artifacts left; the record is not overwritten with nothing`); exit = 1; continue;
        }
        for (const p of payloads) { await recordPayload(dest.api, p); recorded++; console.log(`test-times: recorded ${p.properties.recordKey}`); }
      } catch (err) {
        console.error(`test-times: run ${run.id}: ${whyOf(err, dest.shownUrl)}`);
        exit = 1;
        if (stopsEverything(err) && err instanceof YthrilApiError) break;
      }
    }
    if (!rewriteKey && !stoppedAtRecorded && runs.length >= BACKFILL_RUNS) {
      console.log(`test-times: walked ${BACKFILL_RUNS} runs without meeting one recorded completely (a run recorded but missing a job's record is not complete: its missing records were written and the walk went on); older runs are not backfilled`);
    }
    console.log(`test-times: recorded ${recorded} record(s) from ${runs.length} run(s)`);
  });
  if (locked === null) { console.error('test-times: another recorder holds test-results/.record.lock'); return 1; }
  return exit;
}

async function rewriteLocal(key) {
  const wanted = parseRecordKey(key);
  if (!wanted) { console.error('test-times: --rewrite needs a record key'); return 1; }
  if (wanted.source === 'ci') return recordCi({ rewriteKey: key });
  const refused = refuseUnderCi('--rewrite');
  if (refused) return refused;
  let found;
  try { found = localPayloads(); } catch (err) { console.error(`test-times: ${firstLine(err)}`); return 1; }
  sayProblems(found.problems);
  const mine = found.payloads.filter(p => p.properties.recordKey === key);
  if (!mine.length) { console.error('test-times: no result in test-results/ has that record key'); return 1; }
  return recordPayloads(mine);
}

// ---- flags --------------------------------------------------------------------------------------------------------

const BASELINE_RUNS = 10;
/**
 * A record or run summary is baseline material: branch main, scope full, outcome passed. Asked of a SUITE of a run summary
 * (`suites[suite]` carrying its own `scope` and `outcome`) it is that suite's own scope and outcome that count, so the client
 * covering a subset in one run does not take the node suites' baselines with it, nor the reverse.
 */
const qualifies = (r, suite) => {
  const own = suite === undefined ? undefined : r?.suites?.[suite];
  return r?.branch === 'main' && (own?.scope ?? r?.scope) === 'full' && (own?.outcome ?? r?.outcome) === 'passed';
};

/** The newest {@link BASELINE_RUNS} runs that qualify for `suite`, the judged run left out of its own baseline. */
function baselineOf(judged, history, suite) {
  return history.filter(r => qualifies(r, suite)).filter(r => r.runId !== judged.runId)
    .sort(newestStartFirst).slice(0, BASELINE_RUNS);
}

const p90 = (values) => { const s = [...values].sort((a, b) => a - b); return s[Math.ceil(0.9 * s.length) - 1]; };
const median = (values) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * Files slower than `max(p90 x 1.25, p90 + 30 s)` of their last 10 qualifying runs. The second term keeps a 2 s file
 * from flagging at 2.6 s, the first a 200 s file from flagging at 231 s. A file the history never saw is new, not slow.
 * Each suite is judged against its own history. The client's files take a few seconds each, so a client FILE can never
 * reach the 30 s term and its per-file flag cannot fire; the client SUITE's flag (`flagSuites`) can.
 *
 * @param {{ runId: string, suites: Record<string, { ms: number, files?: Record<string, number> }> }} judged
 * @param {object[]} history run summaries: `{runId, startsAt, branch, scope, outcome, suites}`
 * @returns {Array<{ suite: string, file: string, ms: number, limit: number }>}
 */
export function flagFiles(judged, history) {
  const out = [];
  for (const [suite, s] of Object.entries(judged.suites ?? {})) {
    const baseline = baselineOf(judged, history, suite);
    for (const [file, ms] of Object.entries(s.files ?? {})) {
      const seen = baseline.map(r => r.suites?.[suite]?.files?.[file]).filter(v => typeof v === 'number');
      if (!seen.length) continue;
      const usual = p90(seen);
      const limit = Math.max(usual * 1.25, usual + 30_000);
      if (ms > limit) out.push({ suite, file, ms, limit });
    }
  }
  return out;
}

/** Suites over the max of their last 10 qualifying runs AND at least 20 % above the usual (their median). */
export function flagSuites(judged, history) {
  const out = [];
  for (const [suite, s] of Object.entries(judged.suites ?? {})) {
    const baseline = baselineOf(judged, history, suite);
    const seen = baseline.map(r => r.suites?.[suite]?.ms).filter(v => typeof v === 'number');
    if (!seen.length) continue;
    const limit = Math.max(Math.max(...seen), median(seen) * 1.2);
    if (s.ms > Math.max(...seen) && s.ms >= median(seen) * 1.2) out.push({ suite, ms: s.ms, limit });
  }
  return out;
}

// ---- --trend ------------------------------------------------------------------------------------------------------

const TREND_RUNS = 30;

/** Entries of the trend population only: the predicate is asked of the server and checked again here. */
const trendPredicate = { type: CHRONO_TYPE, 'properties.branch': 'main', 'properties.scope': 'full', 'properties.outcome': 'passed' };
const isTrendRow = (r) => r?.type === CHRONO_TYPE && qualifies(r.properties) && r.properties.formatVersion === FORMAT_VERSION
  && typeof r.properties.commit === 'string' && typeof r.properties.suite === 'string' && typeof r.startsAt === 'string' && typeof r.properties.ms === 'number';

/** `suite` narrows to one suite, `except` leaves suites out; both are asked of the server and checked again here. */
async function trendRows(api, { dir, limit, suite, except = [] }) {
  const bySuite = suite !== undefined ? { 'properties.suite': suite } : except.length ? { 'properties.suite': { $nin: except } } : {};
  const answer = await api.call('filter', {
    space: SPACE, collection: 'chrono', filter: { ...trendPredicate, ...bySuite }, projection: { 'properties.measurements': 0 },
    sort: 'startsAt', dir, limit, maxChars: PAGE_MAX_CHARS,
  });
  const rows = answer?.data?.results;
  if (!Array.isArray(rows)) throw new YthrilApiError('filter: the answer carried no results', { tool: 'filter' });
  // The server's order and page size are asked for and checked again, like its predicate.
  const order = dir === 'asc' ? (a, b) => newestStartFirst(b, a) : newestStartFirst;
  return rows.filter(isTrendRow).filter(r => (suite === undefined || r.properties.suite === suite) && !except.includes(r.properties.suite))
    .sort(order).slice(0, limit);
}

/** The most suites one `--trend` will discover: a bound on a walk whose server may ignore what it is asked. */
const TREND_SUITES_CAP = 50;

/**
 * The newest `limit` rows of EACH suite, newest first within a suite. A limit over all rows would let the suite recorded most
 * recently push the others off the page, so the suites are discovered (the newest row of any suite not yet seen) and each is
 * asked for on its own.
 */
async function trendRowsPerSuite(api, limit) {
  const seen = [];
  const rows = [];
  while (seen.length < TREND_SUITES_CAP) {
    const [next] = await trendRows(api, { dir: 'desc', limit, except: seen });
    if (!next) break;
    seen.push(next.properties.suite);
    rows.push(...await trendRows(api, { dir: 'desc', limit, suite: next.properties.suite }));
  }
  return rows.sort(newestStartFirst);
}

/** A record's per-file times, fetched on their own (the listing never carries `measurements`). */
async function filesOf(api, row) {
  const chars = Number(row.properties.measurementsChars);
  const answer = await api.call('filter', {
    space: SPACE, collection: 'chrono', filter: { _id: row._id }, projection: { 'properties.measurements': 1 }, limit: 1,
    maxChars: Math.min(5_000_000, (Number.isFinite(chars) ? chars : 1_000_000) + 5000),
  });
  const text = answer?.data?.results?.[0]?.properties?.measurements;
  if (typeof text !== 'string') return null;
  try { return Object.fromEntries((JSON.parse(text).files ?? []).map(f => [f.file, f.ms])); } catch { return null; }
}

async function trend({ last, flags }) {
  const dest = destination();
  if (!dest.api) { console.error(`test-times: cannot read: ${dest.why}`); return 1; }
  let newest;
  let first;
  try {
    newest = await trendRowsPerSuite(dest.api, last);
    first = (await trendRows(dest.api, { dir: 'asc', limit: 1 }))[0] ?? newest.at(-1);
  } catch (err) { console.error(`test-times: ${whyOf(err, dest.shownUrl)}`); return 1; }
  if (!newest.length) { console.log('test-times: no recorded runs (branch main, scope full, outcome passed)'); return 0; }

  console.log(`first recorded run: ${first.startsAt.slice(0, 10)} (${first.properties.commit.slice(0, 7)}); showing the newest ${last} of each suite, ${newest.length} in all (branch main, scope full, outcome passed)`);
  for (const r of [...newest].reverse()) {
    const p = r.properties;
    console.log(`${p.suite}  ${r.startsAt.slice(0, 10)}  ${p.commit.slice(0, 7)}  ${seconds(p.ms)}  [${p.source} ${p.job}]`);
  }
  if (!flags) return 0;

  // Judge the newest run of each (source, job, suite) against the others of its own kind: a laptop is not CI.
  const groups = new Map();
  for (const r of newest) {
    const k = `${r.properties.source}/${r.properties.job}/${r.properties.suite}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let flagged = 0;
  for (const [group, rows] of groups) {
    if (rows.length < 2) continue;
    const used = rows.slice(0, BASELINE_RUNS + 1);
    const summaries = [];
    for (const r of used) {
      const files = await filesOf(dest.api, r).catch(() => null);
      summaries.push({ runId: r.properties.recordKey, startsAt: r.startsAt, branch: r.properties.branch, scope: r.properties.scope, outcome: r.properties.outcome, suites: { [group]: { ms: r.properties.ms, files: files ?? {} } } });
    }
    const [judged, ...history] = summaries;
    for (const f of flagFiles(judged, history)) { flagged++; console.log(`slow file: ${f.file} in ${group} took ${seconds(f.ms)}, over ${seconds(f.limit)}`); }
    for (const s of flagSuites(judged, history)) { flagged++; console.log(`slow suite: ${group} took ${seconds(s.ms)}, over ${seconds(s.limit)}`); }
  }
  console.log(flagged ? `test-times: ${flagged} flag(s)` : 'test-times: no flags');
  return 0;
}

// ---- --summary ----------------------------------------------------------------------------------------------------

/** Trusted runs of main the baseline reads at most: the same ten `--trend --flags` judges against. */
const SUMMARY_BASELINE_RUNS = BASELINE_RUNS;
/** The baseline's whole time budget, and the largest artifact it will fetch. A summary never waits on history. */
const SUMMARY_BASELINE_BUDGET_MS = 120_000;
const SUMMARY_ARTIFACT_CAP = 20_000_000;

/**
 * The figures of one suite as the summary shows them, from the recorder's own counting: the summary `summariseSuite` or
 * `summariseClient` returned, so a suite of either kind is one row with the same columns.
 */
function figuresOf(suite, s) {
  const m = JSON.parse(s.measurements);
  const files = Array.isArray(m.files) ? m.files : [];
  return {
    suite, tests: s.tests, passed: s.passed, failed: s.failed, skipped: s.skipped, files: s.fileCount, ms: s.ms, wallMs: wallOf(s),
    outcome: s.outcome, scope: s.scope,
    fileTimes: files.map(f => ({ file: f.file, ms: f.ms })),
    slowestTests: Array.isArray(m.slowest) ? m.slowest : [],
    skips: files.flatMap(f => (f.skips ?? []).map(k => ({ file: f.file, test: k.test, reason: k.reason, expected: isExpectedInCiSkip(f.file, k.reason) }))),
    failures: files.flatMap(f => (f.failures ?? []).map(k => ({ file: f.file, test: k.test, message: k.message }))),
  };
}

/** `[{name, text}]` as one figures object per suite (the suite a file's own lines name). */
function suitesOf(results, root) {
  const bySuite = new Map();
  for (const { name, text } of results) {
    const suite = suiteOf(text, name) ?? '(unnamed)';
    if (!bySuite.has(suite)) bySuite.set(suite, []);
    bySuite.get(suite).push(text);
  }
  return [...bySuite].sort(([a], [b]) => a.localeCompare(b)).map(([suite, texts]) => figuresOf(suite, summariseSuite({ texts, root })));
}

/**
 * The client suite's figures from a report read the way a summary reads it (a timing anomaly is ignored, not a refusal: a
 * summary never goes blank for one). `root` is the one root both suites use: the working directory.
 */
const clientFigures = (report, root) => figuresOf('client', summariseClient({ report, root }));

/** A suite of a run as the baseline keeps it: its time, its files' times, and its own scope and outcome (a suite is judged on its own). */
const baselineSuite = (s) => [s.suite, { ms: s.ms, scope: s.scope, outcome: s.outcome, files: Object.fromEntries(s.fileTimes.map(f => [f.file, f.ms])) }];

/** A GitHub Actions annotation: one line of its own, so the run page shows it. */
const annotate = (what, message) => `::warning title=${what}::${firstLine(message).replace(/[\r%]/g, ' ')}`;

/**
 * Files and suites slower than the last {@link SUMMARY_BASELINE_RUNS} trusted, successful runs of main, read from their
 * `test-results-*` artifacts. Never throws: a baseline that cannot be had is a line and an annotation, and the summary
 * goes on without it. Bounded: ten runs, {@link SUMMARY_ARTIFACT_CAP} bytes an artifact, {@link SUMMARY_BASELINE_BUDGET_MS}
 * in all; the judged run is not one of them, and neither is a run `trustedRuns` does not admit (its artifacts are never
 * asked for).
 *
 * @returns {Promise<{ lines: string[], warnings: string[] }>}
 */
async function summaryBaseline(figures) {
  const warnings = [];
  if (!process.env.GH_TOKEN) return { lines: ['baseline skipped: GH_TOKEN is not set, so the last runs of main were not read'], warnings };
  const deadline = Date.now() + SUMMARY_BASELINE_BUDGET_MS;
  let gh;
  const currentId = process.env.GITHUB_RUN_ID ?? '';
  const history = [];
  try {
    gh = githubClient();
    const listed = await gh.json(`/repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100`);
    const runs = trustedRuns(listed?.workflow_runs ?? [])
      .filter(r => r.status === 'completed' && r.conclusion === 'success' && String(r.id) !== currentId && runIdOf(r) && startedOf(r))
      .sort(newestRunFirst)
      .slice(0, SUMMARY_BASELINE_RUNS);
    for (const run of runs) {
      if (Date.now() > deadline) { warnings.push(annotate('baseline', `the time budget (${seconds(SUMMARY_BASELINE_BUDGET_MS)}) ended before run ${run.id}; the remaining runs were not read`)); break; }
      try {
        const artifacts = (await gh.json(`/repos/${REPO}/actions/runs/${runIdOf(run)}/artifacts?per_page=100`)).artifacts ?? [];
        const results = [];
        let clientText = null;
        for (const [job, found] of latestResultArtifacts(artifacts, run)) {
          if (Number.isFinite(found.size) && found.size > SUMMARY_ARTIFACT_CAP) throw new Error(`${job}: the artifact is larger than ${SUMMARY_ARTIFACT_CAP} bytes`);
          const entries = parseArtifact(await gh.zip(`/repos/${REPO}/actions/artifacts/${found.id}/zip`));
          for (const e of entries) {
            if (e.name.endsWith('.jsonl')) results.push({ name: e.name.split('/').at(-1), text: e.data.toString('utf8') });
          }
          if (job === CLIENT_JOB) clientText = clientReportIn(entries)?.data.toString('utf8') ?? clientText;
        }
        const suites = suitesOf(results, process.cwd());
        // Each suite is read on its own: a run that never had a client report says nothing about it, and one whose report cannot
        // be read costs only the client of THAT run, in a line that names the run and never the report.
        if (clientText !== null) {
          try { suites.push(clientFigures(parseClientReport(clientText), process.cwd())); } catch { warnings.push(annotate('baseline', `run ${run.id}: its client report was not read, so the client is not judged against it`)); }
        }
        if (!suites.length) continue;
        history.push({ runId: String(run.id), startsAt: startedOf(run), branch: 'main', suites: Object.fromEntries(suites.map(baselineSuite)) });
      } catch (err) {
        warnings.push(annotate('baseline', `run ${run.id} was not read: ${firstLine(err)}`));
      }
    }
  } catch (err) {
    warnings.push(annotate('baseline', `the last runs of main could not be listed: ${firstLine(err)}`));
    return { lines: ['baseline not read: GitHub could not be reached (see the warning), the figures above stand alone'], warnings };
  }
  if (!history.length) return { lines: ['no baseline: none of the last runs of main left results that could be read'], warnings };

  const judged = {
    runId: currentId || 'this-run', startsAt: new Date().toISOString(), branch: 'main',
    suites: Object.fromEntries(figures.map(baselineSuite)),
  };
  const lines = [
    ...flagFiles(judged, history).map(f => `slow file: ${f.file} in ${f.suite} took ${seconds(f.ms)}, over ${seconds(f.limit)}`),
    ...flagSuites(judged, history).map(s => `slow suite: ${s.suite} took ${seconds(s.ms)}, over ${seconds(s.limit)}`),
  ];
  const compared = `compared with ${history.length} run(s) of main`;
  return { lines: lines.length ? [...lines, compared] : [`no flags: nothing is slower than the last runs of main (${compared})`], warnings };
}

/** `--summary --results <dir>`: the run's page. Markdown to $GITHUB_STEP_SUMMARY when set, and to stdout always. */
async function summarise({ results }) {
  const dir = resolve(results);
  const found = timingResultFiles(dir);
  if (!found.length) { console.error(`test-times: no results to summarise: ${dir} ${existsSync(dir) ? 'holds no *.jsonl' : 'does not exist'}`); return 1; }
  const figures = suitesOf(found, process.cwd());

  // The client is one more suite, counted by the recorder's own rule; a report that cannot be read is a line, never the page.
  let clientNote = '';
  try {
    figures.push(clientFigures(readClientReport(dir), process.cwd()));
  } catch (err) { clientNote = firstLine(err); }

  const { lines, warnings } = await summaryBaseline(figures);
  const markdown = renderRunSummary({ suites: figures, clientNote, baseline: lines });
  for (const w of warnings) console.log(w);
  console.log(markdown);
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) {
    try { appendFileSync(target, `${markdown}\n`); } catch (err) { console.log(annotate('summary', `could not write $GITHUB_STEP_SUMMARY: ${err?.code ?? err?.message}`)); }
  }
  return 0;
}

// ---- command line -------------------------------------------------------------------------------------------------

export const HELP = `usage: node scripts/test-times.mjs <command>

  --record                 record the run in test-results/ (one Test-Run entry per suite: each node suite's *.jsonl,
                           and the client's ${CLIENT_RESULTS}, which a preflight run writes); exits 0 whenever it could not
                           record, and keeps the payload in test-results/unrecorded/ for the next one. Run by hand
  --record-ci              record the completed CI runs (push to main of ${REPO}, ci.yml) not yet recorded, the client
                           job's included (its artifact's ${CLIENT_RESULTS}); walks newest first and stops at the first
                           completely recorded run or after ${BACKFILL_RUNS} runs. Run by hand
  --type-schema            print the schema_update arguments that declare the Test-Run chrono type on the instance
                           (generated from the recorder's own field list, with its one-year retention)
  --rewrite <recordKey>    record one run again from its own results (ci:<runId>:<attempt>:<job>:<suite>
                           or the key of a local suite in test-results/)
  --trend [--last N] [--flags]
                           print the recorded runs (branch main, scope full, outcome passed; default the newest ${TREND_RUNS} of
                           each suite); --flags also judges the newest run of each suite against its last ${BASELINE_RUNS}
  --summary --results <dir>
                           print the run's page from the downloaded results of every job (a folder of *.jsonl and
                           client.json): per-suite totals (the client a suite like the others), the slowest files and tests, every skip with its reason,
                           the failures, and (with GH_TOKEN) the files and suites slower than the last ${SUMMARY_BASELINE_RUNS}
                           runs of main. Markdown to $GITHUB_STEP_SUMMARY when set, and to stdout. Runs in CI's
                           advisory job; the baseline is read from artifacts, so it needs no Ythril instance

environment (read, never printed):
  YTHRIL_TEST_RUNS_URL     the Ythril instance to record to: https, or http to 127.0.0.1, localhost or [::1]
  YTHRIL_TEST_RUNS_TOKEN   a token that may write chrono entries in ${SPACE}
  GH_TOKEN                 a token that may read ${REPO}'s Actions runs and artifacts (--record-ci, --rewrite)
  GITHUB_API_URL           the Actions API base; default https://api.github.com

Recording is refused when GITHUB_ACTIONS or CI is set: CI never holds the write token.
`;

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') { console.log(HELP); return 0; }
  if (command === '--type-schema' && !rest.length) { console.log(JSON.stringify(testRunTypeDeclaration(), null, 2)); return 0; }
  if (command === '--record' && !rest.length) return recordLocal();
  if (command === '--record-ci' && !rest.length) return recordCi();
  if (command === '--rewrite' && rest.length === 1) return rewriteLocal(rest[0]);
  if (command === '--summary' && rest.length === 2 && rest[0] === '--results') return summarise({ results: rest[1] });
  if (command === '--trend') {
    let last = TREND_RUNS;
    let flags = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--flags') flags = true;
      else if (rest[i] === '--last' && /^\d+$/.test(rest[i + 1] ?? '') && Number(rest[i + 1]) > 0) last = Number(rest[++i]);
      else { console.error(HELP); return 1; }
    }
    return trend({ last, flags });
  }
  console.error(HELP);
  return 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2)).catch((err) => { console.error(`test-times: ${firstLine(err)}`); return 1; });
}
