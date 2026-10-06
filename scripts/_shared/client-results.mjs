/**
 * The client's vitest JSON report in a results folder, read once for every check that needs it.
 *
 * ## The question it answers
 *
 * "What did the client's unit tests do in this run?" — which tests did not run to a verdict (`scripts/unexpected-skips.mjs`)
 * and which spec files ran at least one test (`scripts/executed-tests.mjs`). The node suites write the timing reporter's
 * JSONL (`timing-results.mjs`); the client job writes this one report, `client.json`, and neither reader may treat the other's
 * format as the whole run.
 *
 * ## What it prevents
 *
 * `executed-tests.mjs` read only the node JSONL, and the node JSONL holds no client spec — so the first CI run that reached
 * the gate would have named every one of the client's 146 spec files as never run. Its own test wrote the client specs into
 * the JSONL, a shape no run produces, so it passed. One reader, used by both checks, is the shape a real run writes.
 *
 * A missing report, one that does not parse, or one with no test THROWS: the client's results are part of the run, and a
 * set without them cannot say whether the client ran or skipped.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { repoRelative, slashPath } from './repo-path.mjs';

/** The client's report inside the results folder: written by ci.yml's client job, downloaded beside the node results. */
export const CLIENT_RESULTS = 'client.json';

// A vitest report names absolute paths (or repo-relative ones once `mask-client-report.mjs` has rewritten it), and a reader
// wants repo-relative ones: REPO_ROOT is the repository the script lives in.
/** Forward-slash path, relative to the repository when it lies inside it (one outside it is kept as it came). */
const repoPath = (file) => repoRelative(file, REPO_ROOT) ?? slashPath(file);

/**
 * The client's report: the tests that did not run to a verdict, and the spec files that ran at least one test.
 *
 * @param {string} dir  the results folder
 * @returns {{ tests: number, passed: number, failed: number, unexpected: Array<{ file: string, test: string, reason: string }>, executed: Set<string> }}
 * @throws when the report is missing, does not parse, or holds no test
 */
export function readClientResults(dir) {
  const path = join(dir, CLIENT_RESULTS);
  if (!existsSync(path)) {
    throw new Error(`${CLIENT_RESULTS} is not in ${dir}: the client job's results are part of the run, and a set without them cannot say whether the client ran or skipped`);
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
  const executed = new Set();
  for (const file of report.testResults) {
    for (const t of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      tests++;
      if (typeof file.name === 'string' && file.name !== '') executed.add(repoPath(file.name));
      if (t.status === 'passed') passed++;
      else if (t.status === 'failed') failed++;
      else {
        unexpected.push({ file: repoPath(file.name ?? '(unnamed spec)'), test: String(t.fullName ?? t.title ?? '(unnamed test)'), reason: `vitest status ${t.status}` });
      }
    }
  }
  if (tests === 0) throw new Error(`${path} holds no test: an empty client run is not a clean one`);
  return { tests, passed, failed, unexpected, executed };
}
