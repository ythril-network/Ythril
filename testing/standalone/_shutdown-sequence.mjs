/**
 * Where the shutdown sequence is, and its body: the one place the gates that read the sequence's text learn it.
 *
 * The sequence was the body of `const shutdown = async (signal) => { ... }` in `index.ts`'s `main()`. Bundle-39 D5 moved it to `shutdown.ts` as
 * `runShutdown`, so a test can run it (`shutdown-lets-a-running-sync-stop-at-its-page-db`); each gate that held an ORDER inside it (the stops before
 * the drain, the inference stop before `closeMongo`, `closeSpaceActs` before the flush) had its own copy of "which file, which anchor". A move of the
 * sequence is then one edit here, and a gate cannot go on reading the old file and find nothing: `shutdownSequenceOf` fails when the anchor is gone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balancedFrom } from './_structural-window.mjs';

/** The file that defines the shutdown sequence. */
export const SHUTDOWN_FILE = 'server/src/shutdown.ts';

/** What the sequence's definition looks like: the one text a gate searches a source for to find the sequence. */
export const SHUTDOWN_ANCHOR = /\bexport\s+async\s+function\s+runShutdown\b/;

/** The body of `runShutdown` in `src` (the text of {@link SHUTDOWN_FILE}, comments stripped or not), braces included. */
export function shutdownSequenceOf(src) {
  const at = src.search(SHUTDOWN_ANCHOR);
  assert.ok(at > -1, `${SHUTDOWN_FILE} no longer defines \`export async function runShutdown\`: re-anchor the gates that read the shutdown sequence (_shutdown-sequence.mjs)`);
  // The first `{` after the parameter list's `)`: the sequence takes one plain parameter, so no brace comes earlier.
  return balancedFrom(src, src.indexOf('{', src.indexOf(')', at)), 'the shutdown sequence');
}

/** The sequence as the repository has it: `{ src, body }`. */
export function readShutdownSequence(repoRoot = '.') {
  const src = readFileSync(`${repoRoot}/${SHUTDOWN_FILE}`, 'utf8');
  return { src, body: shutdownSequenceOf(src) };
}
