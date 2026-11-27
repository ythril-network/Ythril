/**
 * The result record of one benchmark run (design R10): one JSON file per engine, size and run.
 *
 * ## What this prevents
 *
 * - **A number nobody can place.** A table row with no commit, no engine digest and no seed cannot be
 *   compared with the next one. `buildRecord` refuses a record that lacks any of them.
 * - **A run silently replacing an earlier one.** The file is opened exclusively (`wx`): a rerun, or a file
 *   that was already there, ends in an error and the earlier bytes stay. There is no overwrite mode.
 * - **A truncated record read as a whole one.** The last key is `end`, with a fixed marker, and the writer
 *   checks the text it is about to write ends with it.
 * - **A run that answered something else reading as a run.** `valid` is required; a Ythril query is comparable or names
 *   one reason (`data-not-held`, `system-statements`, `rows-differ`), and `valid` is false exactly when a query is
 *   `rows-differ`, with `invalidQueries` naming each; the comparison refuses such a record.
 * - **Limits nobody wrote down.** A Ythril record carries the three SPARQL limits it ran under (`sparqlLimits`) and,
 *   when the run waited for it, the embed queue's wait and what was left (`embedQueue`).
 * - **Door overhead inside an engine's figure.** A timed Ythril query carries the door's total and the engine's own time beside the
 *   client's wall time (`door`, `engine`, `perRun`); a record without them is refused.
 * - **A failed query reading as a fast one.** A query holds timings or an `error`, never neither, so an
 *   engine that answered 404 for a query is a row saying so.
 */
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { REASONS } from './comparability.mjs';

export const END_MARKER = 'END-OF-RECORD';

const OUTCOMES = ['ok', 'partial', 'failed'];
const REQUIRED = ['outcome', 'engine', 'size', 'ythrilCommit', 'oxigraphDigest', 'bsbmSeed', 'dataset', 'queries'];

/**
 * A timed Ythril query carries the door's total (`door`) and the engine's own time (`engine`), each `{ median, p95 }`, and every measured
 * run (`perRun`: `wallMs`, `doorMs`, `engineMs`), so the engine is compared with Oxigraph's like for like. A query holding only its
 * `error` has no times to carry.
 */
function checkServerTimes(name, q) {
  if (typeof q.median !== 'number') return;
  const whole = (v) => Number.isFinite(v?.median) && Number.isFinite(v?.p95);
  if (!whole(q.door)) throw new Error(`query ${name} has no door { median, p95 }: a ythril query records the door's total time beside the client's`);
  if (!whole(q.engine)) throw new Error(`query ${name} has no engine { median, p95 }: a ythril query records the engine's own time beside the client's`);
  const ok = Array.isArray(q.perRun) && q.perRun.length === q.n
    && q.perRun.every((r) => ['wallMs', 'doorMs', 'engineMs'].every((k) => Number.isFinite(r?.[k])));
  if (!ok) throw new Error(`query ${name} has no perRun: one { wallMs, doorMs, engineMs } for each of its ${q.n} measured runs`);
}

/**
 * What only a Ythril record carries: the three SPARQL limits it was measured under, and every query's own verdict
 * (comparable, or one reason of the fixed list), with `valid` agreeing with them: false exactly when a query is `rows-differ`.
 */
function checkYthrilJudgement(input) {
  for (const key of ['timeoutMs', 'maxRecordsRead', 'maxResults']) {
    if (!Number.isInteger(input.sparqlLimits?.[key])) throw new Error(`a ythril record needs sparqlLimits.${key}, a whole number: the limits it was measured under`);
  }
  let finding = false;
  for (const [name, q] of Object.entries(input.queries)) {
    if (typeof q.comparable !== 'boolean') throw new Error(`query ${name} has no comparable: a ythril query is judged one by one`);
    checkServerTimes(name, q);
    if (q.comparable) {
      if (q.reason !== undefined) throw new Error(`query ${name} is comparable and names a reason`);
      continue;
    }
    if (!REASONS.includes(q.reason)) throw new Error(`query ${name} is not comparable and needs a reason of ${REASONS.join(', ')}, got ${JSON.stringify(q.reason)}`);
    if (q.reason === 'rows-differ') finding = true;
  }
  if (input.valid === finding) throw new Error(`valid is ${input.valid} but the queries ${finding ? 'hold a rows-differ' : 'hold none'}: valid is false exactly when a query is rows-differ`);
}

export function buildRecord(input) {
  for (const key of REQUIRED) {
    if (input[key] === undefined || input[key] === null) throw new Error(`result record is missing ${key}`);
  }
  // Both engines load one variant of the data; the record says which, and its hash, so two records can be
  // compared only when they ran on the same bytes.
  const { variant, triples, sha256 } = input.dataset;
  if (typeof variant !== 'string' || variant === '') throw new Error('result record dataset is missing its variant');
  if (!Number.isInteger(triples) || triples <= 0) throw new Error('result record dataset is missing its triples count');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('result record dataset needs the variant sha256 (64 hex digits)');
  if (!OUTCOMES.includes(input.outcome)) {
    throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}, got ${JSON.stringify(input.outcome)}`);
  }
  if (!Number.isInteger(input.size) || input.size <= 0) throw new Error('size must be a positive integer');
  for (const [name, q] of Object.entries(input.queries)) {
    const timed = typeof q.median === 'number' && typeof q.p95 === 'number';
    if (!timed && !q.error) throw new Error(`query ${name} has neither timings nor an error`);
  }
  // Whether the run answered what Oxigraph answered (validity.mjs): the Oxigraph record is the reference and is
  // valid; a Ythril record that differs names the queries, and a valid one names none.
  if (typeof input.valid !== 'boolean') throw new Error('result record needs valid: true or false (was the run judged against Oxigraph\'s row counts?)');
  const invalidQueries = input.invalidQueries;
  if (input.valid === false && (!Array.isArray(invalidQueries) || invalidQueries.length === 0)) {
    throw new Error('an invalid result record must name the differing queries in invalidQueries');
  }
  if (input.valid === true && invalidQueries !== undefined && invalidQueries.length > 0) {
    throw new Error('a valid result record has no invalidQueries');
  }
  if (input.engine === 'ythril') checkYthrilJudgement(input);
  if (input.embedQueue !== undefined) {
    const { waitedMs, pending, drained } = input.embedQueue;
    if (!Number.isInteger(waitedMs) || !Number.isInteger(pending) || typeof drained !== 'boolean') {
      throw new Error('embedQueue must be { waitedMs, pending, drained }: whole numbers and a boolean');
    }
  }
  const hasLoad = typeof input.loadMs === 'number';
  if (!hasLoad && !input.loadRefusal) {
    throw new Error('result record needs loadMs, or loadRefusal saying why the load was refused');
  }
  const { end: _ignored, ...rest } = input;
  return { ...rest, loadMs: hasLoad ? input.loadMs : null, end: END_MARKER };
}

/** `<UTC stamp>-<engine>-<size>.json`, the stamp to the second. */
export function recordFileName(when, engine, size) {
  const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${engine}-${size}.json`;
}

/** Writes the record to a new file in `dir`; throws, touching nothing, when the file already exists. */
export function writeRecord(dir, record, when = new Date()) {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (!text.trimEnd().endsWith(`"end": "${END_MARKER}"\n}`)) {
    throw new Error('record does not end with the end marker; build it with buildRecord');
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, recordFileName(when, record.engine, record.size));
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`${path} exists; a result file is never overwritten`);
    throw err;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return path;
}
