/**
 * The spool of record payloads that could not be written to the instance yet: `test-results/unrecorded/<key>.json`.
 *
 * ## What it prevents
 *
 * A recording problem must lose nothing and fail nothing. `scripts/test-times.mjs` keeps a payload here when the instance is
 * unset, unreachable or refusing and drains it with the next recorder that can reach the instance; the preflight's own record
 * (`preflight-run-record.mjs`) is spooled FIRST and drained after, so a recorder that is killed at its time bound has already
 * left the payload on disk. One spelling of the file's name and of the write, so the drain finds what either writer kept.
 *
 * The folder is made through `makeResultsFolder`, which refuses a test child asking for the checkout's own results folder.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeResultsFolder } from '../../testing/_shared/results-folder.mjs';

/** The file name of a payload: its record key with every character a file name should not hold replaced. */
export const unrecordedName = (payload) => `${payload.properties.recordKey.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

/**
 * Write `payload` into `dir` (made when missing) and return the file's path. The same key written twice is one file.
 *
 * @param {string} dir
 * @param {{ properties: { recordKey: string } }} payload
 * @returns {string}
 */
export function spoolPayload(dir, payload) {
  makeResultsFolder(dir);
  const file = join(dir, unrecordedName(payload));
  writeFileSync(file, JSON.stringify(payload));
  return file;
}
