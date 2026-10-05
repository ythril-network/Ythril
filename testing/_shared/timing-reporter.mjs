/**
 * The timing reporter: a `node:test` reporter that writes ONE honest line per test, suite and file to a JSONL
 * file of its own, and says when it did not finish (bundle-56, Q-370 part 1, Q-272's counting half).
 *
 * ## What it prevents
 *
 * A measurement that is wrong in a way nobody can see. Every rule here is a way `node --test` itself gives a
 * green-looking or empty answer, found by probing it on Node 22 and 24 (bundle-56 probe P1):
 *
 *  - **node's `skipped` total misses a skipped SUITE** (`describe.skip`, `describe('x', { skip })`), and the
 *    children of one are never reported at all. A skip gate that reads node's count reads less than the truth,
 *    so skips are counted from the events: a `test:pass` whose `skip` is truthy, suites included.
 *  - **`fail 0` hides a failure.** A suite whose `before` hook throws is `cancelled` in node's tail with
 *    `fail 0` and exit status 1; a file that throws while it LOADS is one failure named after the file, with no
 *    per-file summary. Failure is read from the `test:fail` events, never from a count.
 *  - **Events arrive grouped by file, not in time order**, under concurrency. Every line takes its file from the
 *    event itself, never from the one before it.
 *  - **A run cut off looks like a short run.** The file ends with a sentinel line carrying the count of the lines
 *    before it. A file without it, with another count, or with a torn last line is INCOMPLETE
 *    ({@link readTimingLog}) and a reader must never take it for a pass.
 *  - **A failure message is the longest and most private text in a run** (a stack, a diff, an `Authorization`
 *    header). Only its first line is stored, capped at 300 characters, with token-shaped strings masked; the
 *    same masking covers a test name and a skip reason, which are free text too.
 *  - **A measurement must never become the tests' verdict.** The reporter cannot throw into node's stream: an
 *    event it cannot write, or even read, costs one warning line on stderr and nothing else. The exit status and
 *    the console are the tests'.
 *
 * ## How it is attached
 *
 * Only through `timingReporterFlags` (`timing-reporter-flags.mjs`), which names the default console reporter
 * beside this one, creates the destination directory, and returns the `env` this reporter reads its destination,
 * suite and batch from. Wired by hand it would silence the console and exit 7 on a missing directory.
 *
 * The line shape is {@link TIMING_SCHEMA}: the ONE description of it. A reader, the summariser and the docs
 * derive from it; none of them keeps a second list of the fields.
 */
import { openSync, writeSync, closeSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Env names the helper sets and this reporter reads — one place, so the two cannot drift. */
export const TIMING_ENV = Object.freeze({
  destination: 'YTHRIL_TIMING_DESTINATION',
  suite: 'YTHRIL_TIMING_SUITE',
  batch: 'YTHRIL_TIMING_BATCH',
  scope: 'YTHRIL_TIMING_SCOPE',
});

/**
 * What a run covered, said by the RUNNER (only it knows): the whole suite, a subset of it (preflight's offline
 * half, a name pattern), or named files. A run that is not told is a `subset`, never `full`: a baseline built from
 * runs that merely did not say would be built from partial ones.
 */
export const TIMING_SCOPES = Object.freeze(['full', 'subset', 'files']);
export const DEFAULT_TIMING_SCOPE = 'subset';

/** The longest failure message stored, in characters. */
export const MESSAGE_CAP = 300;

/**
 * Every field of a line, with its type: the ONE description of a timing line. Every written line has exactly
 * these keys (a value that does not apply is `null` where `nullable`, else `''`, `0` or `false`).
 */
export const TIMING_SCHEMA = Object.freeze({
  suite: { type: 'string', doc: 'The suite the runner named: standalone, integration, sync, redteam, preflight.' },
  batch: { type: 'string', doc: 'The invocation inside the suite (one `node --test` process): pure-1, db-2, 1.' },
  file: { type: 'string', doc: 'The test file, repo-relative with forward slashes, taken from the event itself.' },
  test: { type: 'string', doc: 'The test or suite name as node reports it, token-shaped strings masked; empty on a file line.' },
  nesting: { type: 'number', doc: 'How deep the test sits inside suites of its file; 0 for a top-level test and for a file line.' },
  type: { type: 'string', values: ['test', 'suite', 'file'], doc: 'What the line measures: one test, one describe block, or one whole file.' },
  ms: {
    type: 'number',
    doc: 'Node\'s own duration of the test or suite; for a file the whole file, module load included. Milliseconds, three decimals.',
  },
  status: {
    type: 'string',
    values: ['pass', 'fail', 'cancelled'],
    doc: 'What node reported: pass, fail, or cancelled (a test its parent\'s failing hook kept from running). A file is fail when any of it failed or it did not load.',
  },
  skip: { type: 'boolean', doc: 'True for a test or suite node marked skipped, in every form (option, `t.skip()`, `describe.skip`).' },
  todo: { type: 'boolean', doc: 'True for a test marked todo. A todo is not a skip.' },
  reason: { type: 'string', nullable: true, doc: 'The skip reason when `skip` was given a string, masked; else null.' },
  message: {
    type: 'string',
    nullable: true,
    doc: `First line of the failure message, at most ${MESSAGE_CAP} characters, masked; no stack, no diff. Null unless the line failed.`,
  },
});

/**
 * The last line of a timing file: the sentinel. `events` is the count of the data lines before it; the rest says
 * when the run started and ended and what it covered, so a reader needs neither the clock nor the command line.
 */
export const TIMING_END_SCHEMA = Object.freeze({
  type: { type: 'string', values: ['end'], doc: 'Marks the sentinel; always the last line, and the only one of its kind.' },
  events: { type: 'number', doc: 'How many data lines precede it. A file whose sentinel disagrees was cut or edited: incomplete.' },
  startedAt: { type: 'string', doc: 'ISO 8601 UTC time of the run\'s first event (the reporter\'s start when it saw none).' },
  endedAt: { type: 'string', doc: 'ISO 8601 UTC time the sentinel was written, i.e. when the run\'s last event had arrived.' },
  scope: { type: 'string', values: TIMING_SCOPES, doc: 'full, subset or files, as the runner declared it; subset when it did not.' },
});

/** Token shapes a failure, a test name or a skip reason may carry. Each is the unguessable run, not the prefix. */
const SECRET_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /ythril_[A-Za-z0-9]{32,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

/** `text` with every token-shaped string replaced by `***`, and nothing around it changed. Idempotent. */
export function maskSecrets(text) {
  let out = String(text);
  for (const p of SECRET_PATTERNS) out = out.replace(p, '***');
  return out;
}

/**
 * Read a timing file back, saying whether it is WHOLE.
 *
 * `complete` is true only when the file holds exactly one sentinel, as its last line, and the sentinel's `events`
 * equals the number of data lines before it. An empty file, a torn or non-JSON line, lines after the sentinel,
 * two sentinels and a count that does not match are all incomplete: a reader that gets `complete: false` must
 * treat the run as incomplete, never as passed and never as empty.
 *
 * @param {string} text the file's content
 * @returns {{ lines: object[], complete: boolean, end: object|null }} the data lines (not the sentinel), as far as
 *   they parse, and the sentinel itself (`startedAt`, `endedAt`, `scope`) when there was exactly one, else null
 */
export function readTimingLog(text) {
  const rows = String(text).split('\n');
  if (rows.at(-1) === '') rows.pop();
  const lines = [];
  let sentinels = 0;
  let complete = true;
  let end = null;
  for (const [i, row] of rows.entries()) {
    let o;
    try { o = JSON.parse(row); } catch { return { lines, complete: false, end: null }; }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return { lines, complete: false, end: null };
    if (o.type === 'end') {
      sentinels++;
      end = o;
      if (i !== rows.length - 1) complete = false;
    } else {
      lines.push(o);
    }
  }
  if (sentinels !== 1 || !end || end.events !== lines.length) complete = false;
  return { lines, complete, end: sentinels === 1 ? end : null };
}

/** First line of a failure message, masked and capped. Never throws: a message that is not text is `''`. */
function firstLine(message) {
  let s;
  try { s = typeof message === 'string' ? message : message == null ? '' : String(message); } catch { s = ''; }
  return maskSecrets(s.split(/\r?\n/)[0]).slice(0, MESSAGE_CAP);
}

/** Node reports a failed test's real error under `cause` when it wrapped it (a hook, a subtest failure). */
const failureMessage = (error) => firstLine(error?.cause?.message ?? error?.message);

const ms = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** The reporter. Yields nothing: its output is its own file, and the console belongs to the default reporter. */
export default async function* timingReporter(source) {
  const destination = process.env[TIMING_ENV.destination];
  const suite = process.env[TIMING_ENV.suite] ?? '';
  const batch = process.env[TIMING_ENV.batch] ?? '';
  const declared = process.env[TIMING_ENV.scope];
  const scope = TIMING_SCOPES.includes(declared) ? declared : DEFAULT_TIMING_SCOPE;
  let startedAt = null;

  /*
   * One descriptor for the run, opened once. A failure to open or to write disables recording for the rest of
   * the run — INCLUDING the sentinel, so a file that lost a line reads as incomplete and not as whole — and is
   * said once. It is never thrown: node opens its own destinations outside any try this reporter holds, but this
   * one is ours and a measurement must not cost the tests their verdict.
   */
  let fd = null;
  let events = 0;
  let warned = false;
  const warn = (e) => {
    if (warned) return;
    warned = true;
    const what = e?.code ? `${e.code} ${e.message ?? ''}` : String(e?.message ?? e);
    try { process.stderr.write(`timing-reporter: not recording to ${destination}: ${what.trim()}\n`); } catch { /* nothing left to tell */ }
  };
  if (!destination) {
    warn(new Error(`${TIMING_ENV.destination} is not set; attach the reporter through timingReporterFlags`));
  } else {
    try { fd = openSync(destination, 'a'); } catch (e) { warn(e); }
  }
  const write = (o) => {
    if (fd === null) return;
    try {
      writeSync(fd, `${JSON.stringify(o)}\n`);
      if (o.type !== 'end') events++;
    } catch (e) {
      warn(e);
      try { closeSync(fd); } catch { /* already unusable */ }
      fd = null;
    }
  };

  const rel = (f) => (f ? relative(ROOT, f).replaceAll('\\', '/') : '');
  const line = (o) => ({
    suite, batch, test: '', nesting: 0, ms: 0, skip: false, todo: false, reason: null, message: null, ...o,
  });
  const fileLine = (file, o) => write(line({ file: rel(file), type: 'file', ...o }));

  /** Files whose own line is written, so the second event about one (a load failure AND a summary) adds none. */
  const fileDone = new Set();
  /** Files node reported only as a passing test of its own, with no per-file summary: written at the end. */
  const filePassOnly = new Map();

  const reporterStartedAt = new Date().toISOString();
  for await (const ev of source) {
    startedAt ??= new Date().toISOString();
    try {
      const d = ev.data;
      if (ev.type === 'test:pass' || ev.type === 'test:fail') {
        const failed = ev.type === 'test:fail';
        const error = d.details?.error;
        // A file that fails to LOAD is one event named after the file, at nesting 0.
        const isFile = d.nesting === 0 && Boolean(d.file) && typeof d.name === 'string' && resolve(d.name) === resolve(d.file);
        if (isFile) {
          if (!failed) { filePassOnly.set(d.file, d.details?.duration_ms); continue; }
          if (fileDone.has(d.file)) continue;
          fileDone.add(d.file);
          fileLine(d.file, { ms: ms(d.details?.duration_ms), status: 'fail', message: failureMessage(error) });
          continue;
        }
        write(line({
          file: rel(d.file),
          test: maskSecrets(d.name),
          nesting: d.nesting,
          type: d.details?.type === 'suite' ? 'suite' : 'test',
          ms: ms(d.details?.duration_ms),
          status: !failed ? 'pass' : error?.failureType === 'cancelledByParent' ? 'cancelled' : 'fail',
          skip: Boolean(d.skip),
          todo: Boolean(d.todo),
          reason: typeof d.skip === 'string' ? maskSecrets(d.skip) : null,
          message: failed ? failureMessage(error) : null,
        }));
      } else if (ev.type === 'test:summary' && ev.data.file) {
        if (fileDone.has(ev.data.file)) continue;
        fileDone.add(ev.data.file);
        fileLine(ev.data.file, { ms: ms(ev.data.duration_ms), status: ev.data.success ? 'pass' : 'fail' });
      }
    } catch (e) {
      warn(e);
    }
  }

  for (const [file, duration] of filePassOnly) {
    if (!fileDone.has(file)) fileLine(file, { ms: ms(duration), status: 'pass' });
  }
  // `events` is read here, before the sentinel itself is written; the sentinel never counts itself.
  write({ type: 'end', events, startedAt: startedAt ?? reporterStartedAt, endedAt: new Date().toISOString(), scope });
  if (fd !== null) { try { closeSync(fd); } catch { /* the lines are already on disk */ } }
}
