/**
 * A standalone test that drives a live instance is put where a live instance runs.
 *
 * ## What this prevents
 *
 * The standalone folder is split three ways (`testing/_shared/standalone-split.mjs`): the files that need nothing, the
 * files that need a database, and the files that drive a running instance — and CI runs the first two in jobs that start
 * no stack at all. Which side a file lands on is read from its header (`@needs-instance`), so a file that drives the
 * stack and forgets the line is sent to a job with no stack. Before the jobs were split, every standalone file ran with
 * the stack up and the missing line cost nothing; the first CI run of the split failed `config-permissions.test.js`
 * ("No config.json found for test or dev stack") in the no-services job. It skips on Windows, so no local run saw it.
 *
 * ## The rule, derived from what a file does
 *
 * A file that imports the live instance table (`INSTANCES`, the addresses of the running stack) drives a live server, so
 * the split must count it among the files that need one. The subjects are read from the tracked files, never listed,
 * with a floor: the table has many importers, and a scan that finds none has stopped reading.
 *
 * Run: node --test testing/standalone/a-test-that-drives-the-stack-runs-where-the-stack-is.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { splitStandalone } from '../_shared/standalone-split.mjs';

/** An import that binds the live instance table, whichever helper module it comes from. */
const IMPORTS_THE_INSTANCE_TABLE = /^import\s*\{[^}]*\bINSTANCES\b[^}]*\}\s*from\s*['"][^'"]+['"]/m;

describe('a standalone test that drives the stack runs where the stack is', () => {
  it('every file that imports the live instance table is split among the files that need an instance', () => {
    const files = trackedSources(['testing/standalone'], { ext: ['.js'], floor: 100 }).filter(f => f.endsWith('.test.js'));
    const drivers = files.filter(f => IMPORTS_THE_INSTANCE_TABLE.test(readFileSync(resolve(REPO_ROOT, f), 'utf8')));
    assert.ok(drivers.length >= 10, `only ${drivers.length} file(s) import the instance table — the scan has stopped reading`);

    const { needsInstance } = splitStandalone({ root: REPO_ROOT });
    // The split names files by their name inside the standalone folder (it refuses a nested one).
    const needs = new Set(needsInstance.map(f => String(f).replace(/\\/g, '/').split('/').pop()));
    assert.ok(needs.size > 0, 'the split named no file as needing an instance — it has stopped reading headers');
    const misplaced = drivers.filter(f => !needs.has(f.split('/').pop()));
    assert.deepEqual(misplaced, [],
      'these files drive a live instance but the split sends them to a job with none: add `@needs-instance` to the header');
  });

  it('the import pattern reads a real import and not a mention', () => {
    assert.ok(IMPORTS_THE_INSTANCE_TABLE.test("import { INSTANCES, post } from '../sync/helpers.js';\n"));
    assert.ok(!IMPORTS_THE_INSTANCE_TABLE.test(' * a file that imports INSTANCES drives a server\n'));
  });
});
