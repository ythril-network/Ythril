/**
 * The smallest tree `scripts/preflight.mjs` can run in, with two of its gates planted (a test that drives the REAL preflight).
 *
 * ## The question it answers
 *
 * "Give me a folder in which the real preflight runs for a second or two and ends at a stage I chose." The preflight reads the
 * scripts of the folder it runs in (`scripts/unregistered-local-files.mjs`, `check-changelog.mjs`, `unrun-tests.mjs`), so a folder
 * holding stubs of those, and a `package.json`, is a preflight that fails (or passes) the stage the test planted and then runs its
 * own ending: the verdict, the recording, the exit status.
 *
 * ## What it prevents
 *
 * Two test files building the same stubs by hand, each slightly differently (an exit code spelled in one, a message in another), so a
 * rule held in one file is "tested" in the other against a tree the preflight cannot meet. `unrunBody` is the one extension: the
 * `unrun-tests` stage's own script runs as a stage does, AFTER the preflight cleared the previous run's results, so what it writes
 * into `test-results/` is what a stage of this run left (a results file of the test stage, the client's report).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} dir an existing folder
 * @param {{ changelog?: number, unrunTests?: number, unrunBody?: string }} [o] the exit code each planted gate ends with; `unrunBody` is
 *   JavaScript (an ES module's text) the `unrun-tests` stage runs before it exits
 */
export function plantPreflightTree(dir, { changelog = 1, unrunTests = 0, unrunBody = '' } = {}) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/unregistered-local-files.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'scripts/check-changelog.mjs'), `console.log('planted: no [Unreleased] line'); process.exit(${changelog});\n`);
  writeFileSync(join(dir, 'scripts/unrun-tests.mjs'), `${unrunBody}\nconsole.log('planted: a test no job selects'); process.exit(${unrunTests});\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'planted', private: true, type: 'module', scripts: {} }));
}
