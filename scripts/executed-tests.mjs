#!/usr/bin/env node
/**
 * `node scripts/executed-tests.mjs [--root <dir>] --results <dir>` — which tracked test file produced no test event?
 *
 * ## The failure this prevents
 *
 * `scripts/unrun-tests.mjs` answers whether a CI command SELECTS a file. It cannot see a file a glob does match that
 * then loads and registers nothing: a top-level `return`, a `describe` whose callback throws before an `it`, a rename
 * that lost its `it`. `node --test` counts such a file as one that ran, and "all tests pass" is no evidence about a test
 * that was never registered. This reads what actually happened: the timing reporter's JSONL files
 * (`testing/_shared/timing-reporter.mjs`), one per `node --test` invocation, and subtracts the files that reported at
 * least one test from the files the repository tracks.
 *
 * ## What counts as executed
 *
 * A line `{ type: 'test', file }` — a test that ran, of any outcome. A failed test did run: a failure is the run's to
 * report, and this check must not turn one red into two. A skipped test counts too: it registered, and what skips is
 * `scripts/` and the aggregator's other check. A `{ type: 'file' }` or `{ type: 'suite' }` line alone does not count: that
 * is a file that loaded (or a suite that opened) and registered no test beneath it, which is the case this exists for.
 *
 * ## Incomplete results are refused, not read
 *
 * Every JSONL ends with the reporter's sentinel (`readTimingLog`). A file without it was cut off, and the files it lacks
 * are not "unexecuted" — nobody knows. So an incomplete file, an empty results directory and a results directory with no
 * test event at all each EXIT 2 with the cause, never 0. Exit 1 means files were named; exit 0 means none.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedTestFiles } from '../testing/standalone/_sources.mjs';
import { readTimingResults } from './_shared/timing-results.mjs';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';
import { slashPath } from './_shared/repo-path.mjs';

/**
 * The files that reported at least one test, across every `*.jsonl` in `dir`.
 *
 * @param {string} dir
 * @returns {{ executed: Set<string>, logs: number, events: number }}
 * @throws when `dir` holds no results, or any of them is incomplete
 */
export function executedFiles(dir) {
  // The reading, and the refusals that make it whole-or-nothing, are `readTimingResults` (shared with unexpected-skips).
  const { lines, logs, events } = readTimingResults(dir);
  const executed = new Set(lines
    .filter(l => l.type === 'test' && typeof l.file === 'string' && l.file !== '')
    .map(l => slashPath(l.file)));
  return { executed, logs, events };
}

/** @returns {{ missing: string[], total: number, logs: number }} */
export function unexecutedTests(root, resultsDir) {
  const files = trackedTestFiles({ root });
  const { executed, logs } = executedFiles(resultsDir);
  return { missing: files.filter(f => !executed.has(f)), total: files.length, logs };
}

if (isEntryPoint(import.meta.url)) {
  const { values, stray } = readFlags(process.argv.slice(2), ['--root', '--results']);
  if (!values['--results'] || stray.length > 0) {
    console.error('usage: node scripts/executed-tests.mjs [--root <dir>] --results <dir>');
    process.exit(2);
  }
  const root = values['--root'] ? resolve(values['--root']) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const { missing, total, logs } = unexecutedTests(root, resolve(values['--results']));
    if (missing.length > 0) {
      console.error(`executed-tests: ${missing.length} of ${total} tracked test file(s) produced no test event in ${logs} results file(s):`);
      for (const f of missing) console.error(`  ${f}`);
      console.error('Each was selected by a CI command and loaded, but registered no test — or never started. Fix the file, or the selection.');
      process.exit(1);
    }
    console.log(`executed-tests: all ${total} tracked test files reported at least one test (${logs} results files)`);
  } catch (e) {
    console.error(`executed-tests: the derivation failed — ${e.message}`);
    process.exit(2);
  }
}
