/**
 * A test is declared in the test file that runs it — never in a helper module the test file imports.
 *
 * ## What this prevents
 *
 * Node records a test against the file that CALLS `it`, not the file it ran. `_write-landing-experiment.mjs` declared its
 * suite itself, so the 49 cases two test files ran were recorded under the helper: the gate that proves every test file ran
 * (`scripts/executed-tests.mjs`) named both test files as never run, and the timing record put their minutes on a helper
 * nobody runs. A helper that wants to share cases returns them as data and lets the test file declare them.
 *
 * ## The rule, derived
 *
 * Every tracked non-test module under `testing/` (a floor of them) imports none of `describe`, `it`, `test`, `suite` from
 * `node:test`. The fixtures under `_fixtures/` are excepted: they ARE test files, run by the reporter's own tests as such.
 *
 * Run: node --test testing/standalone/a-test-is-declared-where-it-runs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { trackedSources, isTestFile, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** An import of a declaring function from `node:test` (hooks such as `before` are not declarations, and are allowed). */
const declaresATest = (text) => {
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:test['"]/g)) {
    const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]);
    if (names.some(n => ['describe', 'it', 'test', 'suite'].includes(n))) return true;
  }
  return false;
};

describe('a test is declared where it runs', () => {
  it('no helper module under testing/ declares a test', () => {
    const helpers = trackedSources(['testing'], { ext: ['.mjs', '.js'], floor: 100 })
      .filter(f => !isTestFile(f) && !f.includes('/_fixtures/'));
    assert.ok(helpers.length >= 40, `only ${helpers.length} helper module(s) under testing/ — the scan has stopped reading`);
    const declaring = helpers.filter(f => declaresATest(stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(declaring, [],
      'these helpers declare tests, which node then records under the HELPER, not the test file that ran them: return the cases as data and declare them in the test file');
  });

  it('the rule reads a declaring import and lets a hook-only import through', () => {
    assert.ok(declaresATest("import { describe, it, before } from 'node:test';"));
    assert.ok(declaresATest("import { test as t } from 'node:test';"));
    assert.ok(!declaresATest("import { before, after } from 'node:test';"));
    assert.ok(!declaresATest("import assert from 'node:assert/strict';"));
  });
});
