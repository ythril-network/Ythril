/**
 * The test fixtures and helpers that were each written twice before they were written once stay defined in ONE module.
 *
 * ## What this prevents
 *
 * Bundle 56 (the test-time work) added about seventy files, and a diff pass over them found the same dozen behaviours
 * written in two or three of them each: the wait for a stalled write to become alive, the lock a pushed fork stalls
 * behind, a parse of source into a syntax tree, a scratch git repository, a GitHub run as the API returns it, the
 * ambient environment variables. Each copy was correct on the day it was written, and each was a place the rule could
 * be changed without the others — `DIVERGENT` was already two different sentences, and `isTrue` was module-private in
 * one file and retyped in its test. Extracting the second copy is the owner's rule; this is how a third does not appear.
 *
 * ## The rule, and how it is read
 *
 * Each row names a behaviour, the spelling a copy of it cannot avoid, and the ONE file that may contain that spelling.
 * The set of tracked files under `testing/` and `scripts/` whose code (comments removed) matches must be exactly that
 * file. Two directions fail: a second file with the spelling (the copy), and the home no longer having it (the
 * instrument went blind — a pattern that finds nothing proves nothing, so the home is asserted by name).
 *
 * ## What it does not claim
 *
 * Its title says "has one definition", and the body checks the rows below, not every helper in the suite. A row is
 * added when a second copy is extracted, which is exactly when the spelling is known; the older test files that still
 * define their own `sleep` are not rows because they would fail today. What IS held: `sleep` in the timing fixtures
 * (`_fixtures/`) and in every helper module (the files other tests import), and a helper's loopback server. A copy spelled so differently that no row's pattern sees it is
 * not caught — the patterns are the shape each copy had, not a proof about every possible one.
 *
 * Run: node --test testing/standalone/a-shared-test-fixture-has-one-definition.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** Every `all` pattern must match the file's code for it to count as a copy. */
const ROWS = [
  {
    behaviour: 'wait for a stalled write to be alive (or to have been alive) in the server',
    home: 'testing/standalone/_active-operations.mjs',
    all: [/activeOperations\([^)]*\)\)\.length\s*>\s*0/],
  },
  {
    behaviour: 'the lock a pushed fork stalls behind',
    home: 'testing/standalone/_stalled-write-doors.mjs',
    all: [/\bforkIdFor\(/, /\bholdDocumentLock\(/],
  },
  {
    behaviour: 'the text that makes a push fork a fact',
    home: 'testing/standalone/_stalled-write-doors.mjs',
    all: [/\bconst\s+DIVERGENT\s*=/],
  },
  {
    behaviour: 'parse source into a syntax tree',
    home: 'testing/_shared/syntax-tree.mjs',
    all: [/\bcreateSourceFile\(/],
  },
  {
    behaviour: 'a workflow flag is on (the boolean or the string)',
    home: 'testing/_shared/ci-workflow.mjs',
    all: [/\bisTrue\s*=|===\s*true\s*\|\|\s*\S+\s*===\s*'true'/],
  },
  {
    behaviour: 'which environment variables are the machine\'s',
    home: 'testing/_shared/env-var-reads.mjs',
    all: [/\bAMBIENT\s*=\s*new Set\(/],
  },
  {
    behaviour: 'a scratch git repository',
    home: 'testing/_shared/scratch-git-repo.mjs',
    all: [/['"]init['"]\s*,\s*['"]-q['"]/],
  },
  {
    behaviour: 'wait for a state and keep the last reading of it',
    home: 'testing/_shared/wait-for.mjs',
    all: [/\b(?:waitFor|holdsWithin)\(\s*async\s*\(\)\s*=>\s*\{\s*last\s*=\s*await/],
  },
  {
    behaviour: 'a workflow run as GitHub\'s API returns it',
    home: 'testing/_shared/test-times-harness.mjs',
    all: [/\brun_attempt:\s*1\b/],
  },
];

/** This file holds the spellings it looks for (in its self-test), so it is the one file the scan leaves out. */
const THIS_FILE = 'testing/standalone/a-shared-test-fixture-has-one-definition.test.js';

const sources = readTrackedSources(['testing', 'scripts'], { ext: ['.js', '.mjs'], floor: 500 })
  .filter(s => s.file !== THIS_FILE)
  .map(s => ({ file: s.file, code: stripComments(s.text) }));

/** The files whose code matches every pattern of a row. */
const copiesOf = (row, files = sources) => files.filter(s => row.all.every(re => re.test(s.code))).map(s => s.file);

describe('a shared fixture or helper is defined in one module', () => {
  for (const row of ROWS) {
    it(`${row.behaviour}: only ${row.home} spells it`, () => {
      assert.deepEqual(copiesOf(row), [row.home],
        `${row.behaviour} is spelled outside ${row.home} (or the home no longer spells it): import it from the module, `
        + 'or — if the module has to change — change it there');
    });
  }

  it('the timing fixtures take their sleep from the one export instead of defining it', () => {
    const fixtures = sources.filter(s => s.file.startsWith('testing/standalone/_fixtures/'));
    const sleepers = fixtures.filter(s => /\bsleep\(/.test(s.code));
    assert.ok(sleepers.length >= 3, `only ${sleepers.length} fixture(s) sleep — the scan is not looking at the fixtures`);
    const defining = sleepers.filter(s => /\b(?:const|function)\s+sleep\b/.test(s.code)).map(s => s.file);
    assert.deepEqual(defining, [], 'these fixtures define their own sleep: import it from testing/_shared/sleep.mjs');
    const notImporting = sleepers.filter(s => !/from\s+'[^']*_shared\/sleep\.mjs'/.test(s.code)).map(s => s.file);
    assert.deepEqual(notImporting, [], 'these fixtures call sleep and do not import it from testing/_shared/sleep.mjs');
  });

  it('a helper module (not a test) delays through the one sleep, never an inline timer promise', () => {
    // The helpers are the modules other tests IMPORT: a copy in one is a copy for every file that uses it. The one other
    // home is the wait's own poll interval, which is clamped to the deadline and is not a fixed delay.
    const HOMES = ['testing/_shared/sleep.mjs', 'testing/_shared/wait-for.mjs'];
    const helpers = sources.filter(s => /^(?:testing\/_shared\/|testing\/standalone\/_|scripts\/)/.test(s.file) && !s.file.endsWith('.test.js'));
    assert.ok(helpers.length >= 40, `only ${helpers.length} helper module(s) scanned — the scan is not looking at the helpers`);
    const inlineSleep = (code) => /new Promise\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\(/.test(code);
    const spelling = helpers.filter(s => inlineSleep(s.code)).map(s => s.file).sort();
    assert.deepEqual(spelling, HOMES, 'a helper module types `new Promise(r => setTimeout(r, ms))` itself: import `sleep` from testing/_shared/sleep.mjs');
    assert.ok(inlineSleep('await new Promise(r => setTimeout(r, 50));') && inlineSleep('new Promise((resolve) => setTimeout(resolve, ms))'), 'the pattern does not see its own subject');
    assert.ok(!inlineSleep('await sleep(50);'), 'the pattern fires on the import it is meant to allow');
  });

  it('the timing helpers and the skips reader take the repository root from _sources.mjs', () => {
    // Not a row over the whole tree: older files re-derive it from `import.meta.url` and would fail today. These two were
    // each handed the root by the module that owns it and re-derived it anyway, which is the copy this holds out. The skips
    // reader's client-report half (the part that needs the root) moved to `scripts/_shared/client-results.mjs`, shared with
    // the executed-files check; the row follows it there.
    for (const file of ['scripts/_shared/client-results.mjs', 'testing/standalone/_timing-runs.mjs']) {
      const code = sources.find(s => s.file === file)?.code;
      assert.ok(code, `${file} is not among the scanned sources`);
      assert.match(code, /\bREPO_ROOT\b[^;]*from\s+'[^']*_sources\.mjs'/, `${file} does not import REPO_ROOT from _sources.mjs`);
      assert.doesNotMatch(code, /dirname\(fileURLToPath\(import\.meta\.url\)\)/, `${file} derives the repository root from its own location again`);
    }
  });

  it('a helper that starts a server on loopback ends it through listenOnLoopback, not its own listen-and-close', () => {
    const helpers = sources.filter(s => /^(?:testing\/_shared\/|testing\/standalone\/_)/.test(s.file) && !s.file.endsWith('.test.js'));
    const HOME = 'testing/_shared/local-server.mjs';
    // `app.listen(0, '127.0.0.1')` / `server.listen(0, ...)`: a port picked by the OS, which a fixture then has to close.
    const binds = (code) => /\.listen\(\s*0\s*,\s*['"]127\.0\.0\.1['"]/.test(code);
    const spelling = helpers.filter(s => binds(s.code)).map(s => s.file).sort();
    assert.deepEqual(spelling, [HOME], 'a helper binds a loopback port itself: hand its server to listenOnLoopback (it ends the sockets a client left open)');
    assert.ok(binds("server = createApp().listen(0, '127.0.0.1');") && !binds('server.listen(port)'), 'the pattern does not see its own subject');
  });

  it('the patterns see a copy: each row finds a file it was written for, and ignores one that is not a copy', () => {
    // The instrument is exercised before it is trusted: a made-up file with the spelling is a copy, one with only half of it is not.
    const copy = { file: 'testing/zz-copy.mjs', code: 'await holdDocumentLock(m, c, { insert: { _id: plan.forkIdFor(F, 3, T) } });' };
    const half = { file: 'testing/zz-half.mjs', code: 'const id = plan.forkIdFor(F, 3, T);' };
    const fork = ROWS.find(r => r.behaviour.startsWith('the lock a pushed fork'));
    assert.deepEqual(copiesOf(fork, [copy, half]), ['testing/zz-copy.mjs']);
    const alive = ROWS.find(r => r.behaviour.startsWith('wait for a stalled write'));
    assert.deepEqual(copiesOf(alive, [{ file: 'x', code: 'eventually(async () => (await activeOperations(mongo, coll)).length > 0, 5000)' }]), ['x']);
    assert.deepEqual(copiesOf(alive, [{ file: 'y', code: 'const ops = await activeOperations(mongo, coll); assert.deepEqual(ops, [])' }]), []);
    assert.ok(ROWS.length >= 5, 'the table has been emptied');
  });
});
