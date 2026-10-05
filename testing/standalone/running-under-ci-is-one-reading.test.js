/**
 * "Is this CI" has one reading, and no file but its module takes it from the environment.
 *
 * The reading is `testing/_shared/running-under-ci.mjs`. It exists because four files each read `CI` / `GITHUB_ACTIONS`
 * their own way and `CI=false` was CI for three of them and not for the fourth.
 *
 * Two halves:
 *  - the truth table, so the reading itself is pinned (every row is a decision somebody made);
 *  - a derived refusal: every tracked source under the places that read the environment is scanned, and a file
 *    that reads either variable itself is named. Writes (`env.CI = 'true'`) and deletes are how a test SETS the
 *    environment it wants and are not readings.
 *
 * Run: node --test testing/standalone/running-under-ci-is-one-reading.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { ciSignal, runningUnderCi, CI_ENV_NAMES } from '../_shared/running-under-ci.mjs';

const MODULE = 'testing/_shared/running-under-ci.mjs';
const THIS = 'testing/standalone/running-under-ci-is-one-reading.test.js';

describe('the reading: which environments are CI', () => {
  /** [what the environment holds, the variable that names it, or null when it is not CI] */
  const TABLE = [
    [{}, null],
    [{ CI: 'true' }, 'CI'],
    [{ CI: '1' }, 'CI'],
    [{ CI: 'yes' }, 'CI'],
    [{ CI: '' }, null],
    [{ CI: 'false' }, null],
    [{ CI: 'FALSE' }, null],
    [{ CI: ' False ' }, null],
    [{ CI: '0' }, null],
    [{ GITHUB_ACTIONS: 'true' }, 'GITHUB_ACTIONS'],
    [{ GITHUB_ACTIONS: 'false' }, null],
    [{ GITHUB_ACTIONS: '' }, null],
    // a runner that clears CI is still a runner
    [{ GITHUB_ACTIONS: 'true', CI: '' }, 'GITHUB_ACTIONS'],
    [{ GITHUB_ACTIONS: 'true', CI: 'false' }, 'GITHUB_ACTIONS'],
    // either one being real is enough; the one named is the runner's own
    [{ GITHUB_ACTIONS: 'true', CI: 'true' }, 'GITHUB_ACTIONS'],
    // one of them set to "no" does not cancel the other
    [{ GITHUB_ACTIONS: 'false', CI: 'true' }, 'CI'],
    [{ GITHUB_ACTIONS: '0', CI: '0' }, null],
    // an unrelated variable is not a signal
    [{ CIRCLECI: 'true', GITHUB_STEP_SUMMARY: 'x' }, null],
  ];

  for (const [env, named] of TABLE) {
    it(`${JSON.stringify(env)} is ${named === null ? 'not CI' : `CI, named by ${named}`}`, () => {
      assert.equal(ciSignal(env), named);
      assert.equal(runningUnderCi(env), named !== null);
    });
  }

  it('reads process.env when it is given nothing', () => {
    const saved = Object.fromEntries(CI_ENV_NAMES.map((n) => [n, process.env[n]]));
    try {
      for (const n of CI_ENV_NAMES) delete process.env[n];
      assert.equal(runningUnderCi(), false);
      process.env.CI = 'true';
      assert.equal(runningUnderCi(), true);
    } finally {
      for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    }
  });

  it('names exactly the variables the table speaks of', () => {
    assert.deepEqual([...CI_ENV_NAMES].sort(), ['CI', 'GITHUB_ACTIONS']);
  });
});

/**
 * Every place a file READS `CI` or `GITHUB_ACTIONS` from an environment object. `env.CI = x`, `delete env.CI` and a
 * computed key are how a test builds its own environment, not readings.
 *
 * @param {string} source comment-stripped source
 * @returns {string[]} the matched text of each reading
 */
function ciReadings(source) {
  const found = [];
  // The access carries its own `delete` prefix and is followed by a sticky test for `=`, so nothing here is a
  // fixed number of characters either side of the anchor.
  const access = /(\bdelete\s+)?(?:[\w$]+\s*\.\s*)*\benv\s*(?:\.\s*(?:CI|GITHUB_ACTIONS)\b|\[\s*['"`](?:CI|GITHUB_ACTIONS)['"`]\s*\])/g;
  const assignment = /\s*=(?!=)/y;
  for (const m of source.matchAll(access)) {
    assignment.lastIndex = m.index + m[0].length;
    if (!m[1] && !assignment.test(source)) found.push(m[0]);
  }
  for (const m of source.matchAll(/\{[^{}]*\b(?:CI|GITHUB_ACTIONS)\b[^{}]*\}\s*=\s*process\.env\b/g)) found.push(m[0]);
  return found;
}

describe('the gate sees a reading and only a reading', () => {
  const READS = [
    "if (process.env.CI) {}",
    "if (process.env['CI']) {}",
    'const x = env.GITHUB_ACTIONS;',
    'const x = process.env["GITHUB_ACTIONS"] === "true";',
    'const { CI } = process.env;',
    'const { CI, HOME } = process.env;',
    'ok(env.CI == null)',
    'return env.CI ? 1 : 0',
  ];
  for (const text of READS) it(`flags: ${text}`, () => assert.equal(ciReadings(text).length, 1));

  const NOT_READS = [
    "env.CI = 'true';",
    "process.env.CI = '1';",
    'delete env.CI;',
    'delete process.env.GITHUB_ACTIONS;',
    "env[variable] = 'true';",
    "const names = ['CI', 'GITHUB_ACTIONS'];",
    'const CI = true;',
  ];
  for (const text of NOT_READS) it(`leaves alone: ${text}`, () => assert.deepEqual(ciReadings(text), []));
});

describe('no file reads the CI variables except the module', () => {
  const files = trackedSources(['scripts', 'testing', 'server/src'], { ext: ['.mjs', '.js', '.cjs', '.ts'], floor: 500 })
    .filter((f) => f !== MODULE && f !== THIS);

  it('scans scripts, the test stacks and the server', () => {
    assert.ok(files.some((f) => f.startsWith('scripts/')), 'no file under scripts/ was scanned');
    assert.ok(files.some((f) => f.startsWith('testing/standalone/')), 'no standalone test was scanned');
    assert.ok(files.some((f) => f.startsWith('server/src/')), 'no server source was scanned');
  });

  it('every reading goes through running-under-ci.mjs', () => {
    const offenders = [];
    for (const file of files) {
      const found = ciReadings(stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')));
      for (const text of found) offenders.push(`${file}  reads ${text.replace(/\s+/g, ' ')}`);
    }
    assert.deepEqual(offenders, [], `use runningUnderCi() / ciSignal() from ${MODULE}:\n${offenders.join('\n')}`);
  });
});
