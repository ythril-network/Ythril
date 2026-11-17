/**
 * A database-backed standalone file runs in a CAPPED batch, whichever runner runs it (bundle-30 I9).
 *
 * ## The failure
 *
 * Every `-db` file shares one MongoDB (`ythril-mongo-a`, 2.5 GiB, one CPU). They ran inside the offline half at node's
 * default width, wherever the alphabet put them; one batch came to hold 38 of them, up to 23 at once, and in a run
 * on a Mongo already carrying other suites the container was OOM-killed mid-batch. Every later `-db` file then
 * skipped itself for want of a database, and its batch counted as passing. At full width the same files also fail
 * on time against that one CPU. The plan is `offlineRuns` in `testing/_shared/standalone-split.mjs`: pure files at
 * full width, database-backed files at `DB_TEST_CONCURRENCY`, with the measurement beside it.
 *
 * ## What is asserted, and how the subject is found
 *
 *  - every file that opens the test database runs in a capped run, and in no other. The database files are found
 *    here by what they CALL (`openTestMongo(`, `openPushDoor(`, `mongoSkipReason(`), independently of the split's own
 *    import scan, so a file the scan misses fails this gate instead of running uncapped;
 *  - the plan runs every offline file exactly once, so the split cannot drop one while capping the rest;
 *  - every runner that imports the split runs the plan rather than building its own command lines — derived from the
 *    importers, so a third runner is in scope the day it is written.
 *
 * Run: node --test testing/standalone/a-db-file-runs-in-a-capped-batch.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { splitStandalone, offlineRuns, DB_TEST_CONCURRENCY } from '../_shared/standalone-split.mjs';
import { stripComments } from './_strip-comments.mjs';

const split = splitStandalone();
const runs = offlineRuns(split);
const name = (p) => p.split('/').pop();

/** Opens the test database: found by the calls, not by the split's import scan. */
const opensTheDatabase = split.offline.filter(f =>
  /\b(openTestMongo|openPushDoor|mongoSkipReason)\s*\(/.test(stripComments(readFileSync(`testing/standalone/${f}`, 'utf8'))));

describe('a db file runs in a capped batch', () => {
  it('finds the database-backed files, so an empty set cannot pass', () => {
    assert.ok(opensTheDatabase.length >= 30, `only ${opensTheDatabase.length} file(s) open the test database — the scan is broken`);
  });

  it('the cap is a real cap', () => {
    assert.ok(Number.isInteger(DB_TEST_CONCURRENCY) && DB_TEST_CONCURRENCY >= 1 && DB_TEST_CONCURRENCY <= 8,
      `DB_TEST_CONCURRENCY is ${DB_TEST_CONCURRENCY}: measured at 4, 8 and full width, the -db files fail on time and `
      + 'peak highest at full width — see the table beside the constant before widening it');
  });

  it('every file that opens the database runs capped, and only there', () => {
    const capped = new Set(runs.filter(r => r.args.includes(`--test-concurrency=${DB_TEST_CONCURRENCY}`)).flatMap(r => r.files.map(name)));
    const uncapped = new Set(runs.filter(r => !r.args.includes(`--test-concurrency=${DB_TEST_CONCURRENCY}`)).flatMap(r => r.files.map(name)));
    assert.deepEqual(opensTheDatabase.filter(f => !capped.has(f)), [],
      'these open the test database and do not run in a capped batch — they would run at full width against one Mongo');
    assert.deepEqual(opensTheDatabase.filter(f => uncapped.has(f)), [], 'these run uncapped as well');
  });

  it('the plan runs every offline file exactly once', () => {
    const planned = runs.flatMap(r => r.files.map(name)).sort();
    assert.deepEqual(planned, [...split.offline].sort());
  });

  it('every runner of the split runs the plan, not its own command lines', () => {
    const importers = execFileSync('git', ['grep', '-l', 'standalone-split.mjs', '--', 'scripts', 'testing/_init'], { encoding: 'utf8' })
      .split('\n').filter(f => f.endsWith('.mjs'));
    assert.ok(importers.length >= 2, `only ${importers.length} runner(s) found — preflight and test:standalone both import the split`);
    for (const f of importers) {
      const src = stripComments(readFileSync(f, 'utf8'));
      assert.match(src, /\bofflineRuns\(/, `${f} imports the split and does not run its plan`);
      assert.doesNotMatch(src, /batched\(\s*(offline|pure)\b/, `${f} batches the offline half itself — a second copy of the plan`);
    }
  });

  it('a runner that cuts the plan\'s pure runs into slow-first units (slowFirstUnits) still runs the plan, and hands the step runs, never files it picked itself', () => {
    // `slowFirstUnits(runs, times, ...)` (scripts/_shared/slow-first-units.mjs) takes the plan's pure runs and answers units: a runner that
    // calls it must have got `runs` from `offlineRuns` (the plan, db files capped), and must not cut the offline half by hand beside it.
    // `git grep` exits 1 when nothing matches: that is "no caller yet", answered by the assertion below, not a crash of the listing.
    const listed = spawnSync('git', ['grep', '-l', 'slowFirstUnits(', '--', 'scripts', 'testing/_init'], { encoding: 'utf8' });
    assert.ok(listed.status === 0 || listed.status === 1, `git grep failed: ${listed.stderr}`);
    const callers = listed.stdout.split('\n').filter(f => f.endsWith('.mjs') && f !== 'scripts/_shared/slow-first-units.mjs');
    assert.ok(callers.includes('scripts/preflight.mjs'), `no runner calls slowFirstUnits (found: ${callers.join(', ') || 'none'}): preflight cuts its pure units through it`);
    for (const f of callers) {
      const src = stripComments(readFileSync(f, 'utf8'));
      assert.match(src, /\bofflineRuns\(/, `${f} calls slowFirstUnits and does not run the shared plan to get its runs`);
      assert.match(src, /import\s*\{[^}]*\bslowFirstUnits\b[^}]*\}\s*from\s*['"][^'"]*slow-first-units\.mjs['"]/, `${f} calls slowFirstUnits without importing it from the shared module`);
      assert.doesNotMatch(src, /batched\(/, `${f} batches files itself beside the slow-first step — a second copy of the plan`);
    }
  });
});
