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
 * - **A run that answered something else reading as a run.** `valid` is required; a Ythril run whose row counts differ
 *   from Oxigraph's is `valid: false` with `invalidQueries` naming each, and the comparison refuses it.
 * - **A failed query reading as a fast one.** A query holds timings or an `error`, never neither, so an
 *   engine that answered 404 for a query is a row saying so.
 */
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export const END_MARKER = 'END-OF-RECORD';

const OUTCOMES = ['ok', 'partial', 'failed'];
const REQUIRED = ['outcome', 'engine', 'size', 'ythrilCommit', 'oxigraphDigest', 'bsbmSeed', 'dataset', 'queries'];

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
