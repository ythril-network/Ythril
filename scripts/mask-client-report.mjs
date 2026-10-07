#!/usr/bin/env node
/**
 * Mask the client's Vitest JSON report IN PLACE, before the CI job uploads it.
 *
 * ## The question it answers
 *
 * "Is this report safe to publish?" The client job writes `test-results/client.json` (`vitest --reporter=json`) and
 * uploads the whole folder as a 30-day artifact on a public repository. For a failing test Vitest's report holds every
 * failure message in full (stack, diff, absolute runner paths) and `failureDetails`, which the node suites' reporter
 * never stores: that reporter keeps ONE masked, capped line per failure. Left raw, a token a failing client test
 * printed would have been published by the half of the run's artifacts nobody masks.
 *
 * ## What it does
 *
 * - every failure message (`failureMessages[]`, a suite's `message`) becomes `maskText` (`scripts/_shared/mask-text.mjs`): first line,
 *   the one list of token shapes (`testing/_shared/secret-masking.mjs`), home paths, 300 characters;
 * - `failureDetails` (objects carrying the stack) is dropped;
 * - a spec's `name` becomes its repo-relative path (an absolute path outside the checkout is masked as text);
 * - every other string (test titles) goes through `maskSecrets`;
 * - numbers, booleans and structure are kept, so `readClientResults` (`scripts/unexpected-skips.mjs`) reads the same
 *   totals and statuses from the masked file.
 *
 * ## The guard a hand-written copy would drop
 *
 * **A report it cannot read is REMOVED, not left.** The step runs `if: always()` between the tests and the upload; a
 * step that failed to parse and left the raw file in place would publish exactly what it exists to stop. The aggregator
 * then fails on the missing report (`readClientResults` throws), which is the loud version. A report that is simply not
 * there (vitest never wrote one) is not an error here, for the same reason: the aggregator is the one that says so.
 *
 * `a-client-report-is-masked-before-upload.test.js` holds the function, the script and the workflow step.
 *
 * Usage: node scripts/mask-client-report.mjs <path to client.json>
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntryPoint } from './_shared/script-cli.mjs';
import { repoRelative } from './_shared/repo-path.mjs';
import { maskText } from './_shared/mask-text.mjs';
import { maskSecrets } from '../testing/_shared/secret-masking.mjs';

/** Keys whose value is a failure message: first line, masked, capped. */
const MESSAGE_KEYS = new Set(['failureMessages', 'message']);
/** Keys dropped whole: they carry stacks and objects nobody reads. */
const DROPPED_KEYS = new Set(['failureDetails']);

function maskNode(value, key, parentKey, root) {
  if (typeof value === 'string') {
    if (MESSAGE_KEYS.has(key) || (parentKey && MESSAGE_KEYS.has(parentKey))) return maskText(value);
    return maskSecrets(value);
  }
  if (Array.isArray(value)) return value.map(item => maskNode(item, undefined, key, root));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROPPED_KEYS.has(k)) continue;
      out[k] = k === 'name' && typeof v === 'string' && Array.isArray(value.assertionResults)
        ? (repoRelative(v, root) ?? maskText(v))
        : maskNode(v, k, key, root);
    }
    return out;
  }
  return value;
}

/**
 * A masked copy of a Vitest JSON report; the argument is not changed.
 *
 * @param {object} report  the parsed `client.json`
 * @param {string} [root]  the checkout the spec paths should be relative to (default: the working directory)
 */
export function maskClientReport(report, root = process.cwd()) {
  return maskNode(report, undefined, undefined, root);
}

/** What a runner can say about the run that wrote a report: a GitHub step's `outcome`, or a local exit code read as one. */
const RUNNER_OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);

/**
 * Write the runner's own verdict into a report, as its top-level `runnerOutcome`, IN PLACE.
 *
 * ## The question it answers
 *
 * "Did the process that wrote this report say it passed?" A report cannot say so itself: a run that was cut off, or whose
 * runner failed, can leave a file that counts no failure. The recorder reads the stamp to call such a run incomplete
 * instead of passed, so every producer of a client report (the CI mask step, preflight) stamps through this one function.
 *
 * ## The guard a hand-written copy would drop
 *
 * A word that is not a runner outcome throws, so a typo or an unset variable cannot become a stamp the recorder reads as
 * something else. A report that is not there or does not parse is left alone and reported as `false`: the stamp never
 * invents a report, and the aggregator is the one that says one is missing.
 *
 * @param {string} file     path of the report (`test-results/client.json`)
 * @param {string} outcome  one of `success`, `failure`, `cancelled`, `skipped`
 * @returns {boolean} whether a report was stamped
 */
export function stampRunnerOutcome(file, outcome) {
  if (!RUNNER_OUTCOMES.has(outcome)) throw new Error(`stampRunnerOutcome: "${outcome}" is not a runner outcome`);
  if (!existsSync(file)) return false;
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return false;
  writeFileSync(file, JSON.stringify({ ...report, runnerOutcome: outcome }));
  return true;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('usage: node scripts/mask-client-report.mjs <path to client.json>');
    return 2;
  }
  const file = resolve(argv[0]);
  if (!existsSync(file)) {
    console.log(`mask-client-report: ${argv[0]} is not there; nothing to mask (the aggregator fails on a missing report)`);
    return 0;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Never print the parse error: its message quotes the text around the break, which is the content being protected.
    unlinkSync(file);
    console.error(`mask-client-report: ${argv[0]} does not parse; it was removed rather than left to be uploaded unmasked`);
    return 1;
  }
  writeFileSync(file, JSON.stringify(maskClientReport(report)));
  console.log(`mask-client-report: ${argv[0]} masked in place`);
  return 0;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
