#!/usr/bin/env node
/**
 * `node scripts/unexpected-skips.mjs --results <dir>` — which skipped test did CI not expect?
 *
 * ## The failure this prevents
 *
 * A skipped test proved nothing, and a run with skips in it still ends green. An unbuilt client, a sidecar that never
 * came up and an embedder that never loaded each read as "passing" for as long as a skip may stand for a result. The
 * aggregator (`Build & Test`) runs this over every job's results after its verdict, and the run fails on a skip unless it
 * says it was expected AND sits in a file the committed list allows (`testing/_shared/expected-in-ci.mjs`).
 *
 * ## What it reads
 *
 * - **Every `*.jsonl` in the folder**: the timing reporter's lines (`testing/_shared/timing-reporter.mjs`). A line with
 *   `skip: true` is a skip of any kind (option, `t.skip()`, `describe.skip`) — suites included, which node's own
 *   `skipped` total leaves out. A todo is not a skip. The reporter's `file` is repo-relative, so it is compared with the
 *   list as it stands.
 * - **`client.json`**: the client's vitest report (`--reporter=json`). No skip is expected there, so anything that is not
 *   `passed` or `failed` (skipped, todo, pending) did not run to a verdict and is named. A failure is the client job's to
 *   report, not this check's.
 *
 * ## Exit codes — the interface the aggregator keys on
 *
 *   0  every skip is expected (or there is none)
 *   1  at least one is not; each is named by file, test and reason
 *   2  the results cannot answer: a folder that is missing, empty or holds no test event; a JSONL without its closing
 *      sentinel; no client report beside the node ones, or one that does not parse or holds no test; a bad command line.
 *      The unknown wins over a finding: a partial list is never reported as the list.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTimingResults } from './_shared/timing-results.mjs';
import { isEntryPoint, readFlags } from './_shared/script-cli.mjs';
import { repoRelative, slashPath } from './_shared/repo-path.mjs';
import { isExpectedInCiSkip } from '../testing/_shared/expected-in-ci.mjs';

/** The client's report inside the results folder: written by ci.yml's client job, downloaded beside the node results. */
export const CLIENT_RESULTS = 'client.json';

/** The repository the script lives in; a vitest report names absolute paths, and a reader wants repo-relative ones. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Forward-slash path, relative to the repository when it lies inside it (one outside it is kept as it came). */
const repoPath = (file) => repoRelative(file, REPO_ROOT) ?? slashPath(file);

/**
 * The client's vitest JSON report as the tests that did not run to a verdict.
 *
 * @returns {{ tests: number, passed: number, failed: number, unexpected: Array<{ file: string, test: string, reason: string }> }}
 * @throws when the report is missing, does not parse, or holds no test
 */
export function readClientResults(dir) {
  const path = join(dir, CLIENT_RESULTS);
  if (!existsSync(path)) {
    throw new Error(`${CLIENT_RESULTS} is not in ${dir}: the client job's results are part of the run, and a set without them cannot say whether the client skipped`);
  }
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${path} does not parse: ${e.message}`); }
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error(`${path} is not a vitest JSON report (no testResults array)`);
  }
  let tests = 0;
  let passed = 0;
  let failed = 0;
  const unexpected = [];
  for (const file of report.testResults) {
    for (const t of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      tests++;
      if (t.status === 'passed') passed++;
      else if (t.status === 'failed') failed++;
      else {
        unexpected.push({ file: repoPath(file.name ?? '(unnamed spec)'), test: String(t.fullName ?? t.title ?? '(unnamed test)'), reason: `vitest status ${t.status}` });
      }
    }
  }
  if (tests === 0) throw new Error(`${path} holds no test: an empty client run is not a clean one`);
  return { tests, passed, failed, unexpected };
}

/**
 * Every skipped test of the results in `dir` that CI did not expect.
 *
 * @param {string} dir
 * @returns {{ unexpected: Array<{ file: string, test: string, reason: string }>, skips: number, logs: number, events: number, clientTests: number }}
 * @throws when the results cannot be read whole (see {@link readTimingResults}, {@link readClientResults})
 */
export function unexpectedSkips(dir) {
  const { lines, logs, events } = readTimingResults(dir);
  const client = readClientResults(dir);
  const skipped = lines.filter(l => l.skip === true);
  const unexpected = skipped
    .filter(l => !isExpectedInCiSkip(slashPath(l.file), l.reason))
    .map(l => ({ file: String(l.file ?? ''), test: String(l.test ?? ''), reason: typeof l.reason === 'string' ? l.reason : '' }));
  return { unexpected: [...unexpected, ...client.unexpected], skips: skipped.length, logs, events, clientTests: client.tests };
}

if (isEntryPoint(import.meta.url)) {
  const { values, stray } = readFlags(process.argv.slice(2), ['--results']);
  if (!values['--results'] || stray.length > 0) {
    console.error('usage: node scripts/unexpected-skips.mjs --results <dir>');
    process.exit(2);
  }
  try {
    const { unexpected, skips, logs, events, clientTests } = unexpectedSkips(resolve(values['--results']));
    if (unexpected.length > 0) {
      console.error(`unexpected-skips: ${unexpected.length} skipped test(s) CI did not expect:`);
      for (const u of unexpected) console.error(`  ${u.file}  ${JSON.stringify(u.test)}  ${u.reason === '' ? '(no reason given)' : JSON.stringify(u.reason)}`);
      console.error('A skip proves nothing. Make the test run (or make its absent input a failure under CI); only a skip whose reason starts '
        + '`expected-in-ci:` in a file on the list in testing/_shared/expected-in-ci.mjs is allowed to stand.');
      process.exit(1);
    }
    console.log(`unexpected-skips: no skip CI did not expect (${skips} expected of ${events} node test events in ${logs} results files; ${clientTests} client tests, none skipped)`);
  } catch (e) {
    console.error(`unexpected-skips: the derivation failed — ${e.message}`);
    process.exit(2);
  }
}
