/**
 * The client's Vitest report is MASKED before the CI job uploads it (bundle-56 pre-ship, privacy finding 1).
 *
 * ## What it prevents
 *
 * The client job writes `test-results/client.json` (`vitest --reporter=json`) and uploads the whole `test-results/`
 * folder as a 30-day artifact on a public repository. Vitest's report carries, for a failing test, every failure
 * message in full (stack, diff, absolute runner paths) and `failureDetails`; the node suites' reporter keeps one
 * masked, capped line (`docs/testing-guide.md`). So the same failure was masked in one half of the run's artifacts and
 * raw in the other, and a token a failing client test printed would have been published.
 *
 * ## What is held, and which of the two ways it was done
 *
 * `scripts/mask-client-report.mjs` rewrites the report IN PLACE, in its own step after the tests and before the upload
 * (the job has no other copy; a "masked copy" beside the raw file would be uploaded with it). It passes every string
 * through the recorder's `maskText` (the one list of token shapes, `testing/_shared/secret-masking.mjs`, plus home
 * paths, first line, 300 characters) for messages and `maskSecrets` for names, drops `failureDetails`, and keeps
 * everything `readClientResults` reads. A report it cannot read is REMOVED, never left raw: the aggregator then fails
 * on the missing report, which is the loud version.
 *
 * Gates: the function (rows), the script (in place, missing, unreadable), and the workflow (the step exists, runs
 * `if: always()`, and sits between the tests and the upload) — the third derived from `ci.yml`, not typed here.
 *
 * Run: node --test testing/standalone/a-client-report-is-masked-before-upload.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { runScript } from './_run-script.mjs';
import { loadCi, stepsOf, shellOf, usesOf } from '../_shared/ci-workflow.mjs';
import { readClientResults } from '../../scripts/unexpected-skips.mjs';
import { maskClientReport } from '../../scripts/mask-client-report.mjs';

const SCRIPT = join(REPO_ROOT, 'scripts', 'mask-client-report.mjs');
const TOKEN = 'ythril_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7kL9m';
const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const CONN = 'mongodb://ythril:s3cret-pw@127.0.0.1:27017/db';

/** A vitest JSON report with one passing and one failing test whose failure says everything a real one does. */
const report = () => ({
  numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, success: false, startTime: 1,
  testResults: [{
    name: join(REPO_ROOT, 'client', 'src', 'app', 'a.spec.ts'), // vitest writes the absolute path of the spec on the runner
    status: 'failed', startTime: 1, endTime: 2,
    message: `Error: suite failed with ${TOKEN}\n    at /home/runner/work/Ythril/Ythril/client/src/app/a.spec.ts:10:5`,
    assertionResults: [
      { ancestorTitles: ['a'], fullName: 'a passes', title: 'passes', status: 'passed', duration: 3, failureMessages: [] },
      {
        ancestorTitles: ['a'], fullName: `a fails with ${GH}`, title: 'fails', status: 'failed', duration: 4,
        failureMessages: [`AssertionError: expected Authorization: Bearer ${TOKEN}\n    at /home/runner/work/Ythril/Ythril/client/src/app/a.spec.ts:11:7\n    at ${CONN}`],
        failureDetails: [{ message: `detail ${TOKEN}`, stack: `stack ${CONN}` }],
      },
    ],
  }],
});

describe('the question "mask one line" has a module of its own, and no command line is imported for it', () => {
  /*
   * `maskText` (first line, the one list of token shapes, home paths, the cap) lived in `scripts/test-times.mjs`, a
   * recorder with its own `main`, and this script imported all of it for one function: a change to the recorder's
   * imports or load-time work became this script's, in a CI step whose failure leaves the report unmasked. The subjects
   * are derived (every module this script imports by a relative path), and a module that is a COMMAND (it asks whether it
   * is the entry point) is not one it may import.
   */
  const source = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
  const importsOf = (rel) => [...source(rel).matchAll(/^import\s[^;]*?from\s+'(\.[^']+)'/gm)].map(m => m[1]);

  it('imports no module that is itself a command line', () => {
    const imports = importsOf('scripts/mask-client-report.mjs');
    assert.ok(imports.length >= 3, `the scan found ${imports.length} relative imports: the pattern is wrong`);
    const commands = imports.filter(spec => /\bif\s*\(\s*isEntryPoint\(/.test(readFileSync(join(REPO_ROOT, 'scripts', spec), 'utf8')));
    assert.deepEqual(commands, [], 'mask-client-report.mjs imports a command line for a function: give the function a module of its own');
  });

  it('`maskText` is defined in one module, and the recorder and this script both take it from there', () => {
    const defining = trackedSources(['scripts', 'testing', 'benchmarks'], { ext: ['.mjs', '.js'], floor: 100 })
      .filter(f => /^export\s+function\s+maskText\s*\(/m.test(source(f)));
    assert.equal(defining.length, 1, `maskText is defined in ${defining.length} module(s): ${defining.join(', ')}`);
    const home = defining[0];
    assert.notEqual(home, 'scripts/test-times.mjs', 'maskText is still defined in the recorder, which is a command line');
    for (const user of ['scripts/test-times.mjs', 'scripts/mask-client-report.mjs']) {
      const stem = home.split('/').at(-1);
      assert.match(source(user), new RegExp(`from\\s+'[^']*${stem.replace('.', '\\.')}'`), `${user} does not take maskText from ${home}`);
    }
  });
});

describe('maskClientReport', () => {
  it('leaves no token, credential, runner path or stack line in the report', () => {
    const out = JSON.stringify(maskClientReport(report()));
    for (const leaked of [TOKEN, GH, 's3cret-pw', '/home/runner', '    at ', 'Bearer ' + TOKEN]) {
      assert.ok(!out.includes(leaked), `the masked report still holds ${JSON.stringify(leaked)}`);
    }
  });

  it('keeps one masked first line of each failure message, and drops failureDetails', () => {
    const masked = maskClientReport(report());
    const failed = masked.testResults[0].assertionResults[1];
    assert.equal(failed.failureMessages.length, 1);
    assert.match(failed.failureMessages[0], /^AssertionError: expected Authorization: \*\*\*$/);
    assert.equal('failureDetails' in failed, false, 'failureDetails carries the stack and is not kept');
    assert.match(masked.testResults[0].message, /^Error: suite failed with \*\*\*$/);
  });

  it('caps a message at the recorder\'s length', () => {
    const r = report();
    r.testResults[0].assertionResults[1].failureMessages = ['x'.repeat(5000)];
    assert.equal(maskClientReport(r).testResults[0].assertionResults[1].failureMessages[0].length, 300);
  });

  it('keeps what the aggregator reads: counts, statuses, names, a repo-relative file', () => {
    const masked = maskClientReport(report(), REPO_ROOT);
    assert.equal(masked.numTotalTests, 2);
    assert.equal(masked.testResults[0].name, 'client/src/app/a.spec.ts');
    assert.deepEqual(masked.testResults[0].assertionResults.map(t => t.status), ['passed', 'failed']);
    assert.equal(masked.testResults[0].assertionResults[0].fullName, 'a passes');
    assert.equal(masked.testResults[0].assertionResults[1].fullName, 'a fails with ***', 'a name is masked too');
  });

  it('does not change the report it was given', () => {
    const r = report();
    const before = JSON.stringify(r);
    maskClientReport(r);
    assert.equal(JSON.stringify(r), before);
  });
});

describe('scripts/mask-client-report.mjs', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ythril-mask-client-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rewrites the report in place, and the aggregator still reads it', () => {
    const file = join(dir, 'client.json');
    writeFileSync(file, JSON.stringify(report()));
    const r = runScript(SCRIPT, [file]);
    assert.equal(r.status, 0, r.out);
    const text = readFileSync(file, 'utf8');
    for (const leaked of [TOKEN, GH, 's3cret-pw', '/home/runner']) assert.ok(!text.includes(leaked), `the file on disk still holds ${JSON.stringify(leaked)}`);
    const read = readClientResults(dir);
    assert.deepEqual({ tests: read.tests, passed: read.passed, failed: read.failed }, { tests: 2, passed: 1, failed: 1 });
  });

  it('a report that is not there is not an error here: the aggregator is the one that fails on it', () => {
    const r = runScript(SCRIPT, [join(dir, 'nothing-here.json')]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not there|no such|missing/i);
  });

  it('a report that cannot be read is REMOVED, never left raw, and the step fails', () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, `{"testResults": [ ${TOKEN} `);
    const r = runScript(SCRIPT, [file]);
    assert.notEqual(r.status, 0, 'an unreadable report must fail the step');
    assert.equal(existsSync(file), false, 'the unreadable report was left in place to be uploaded raw');
    assert.ok(!r.out.includes(TOKEN), 'the script printed the token it was masking');
  });

  it('refuses a call with no file', () => {
    assert.equal(runScript(SCRIPT, []).status, 2);
  });

  // The producer half of the runner stamp: the recorder trusts `runnerOutcome` to call a run vitest reported green
  // incomplete when its runner failed, so the step that writes it is held here, not only the reader that reads it.
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped']) {
    it(`stamps the test step's outcome it is handed (CLIENT_TEST_OUTCOME=${outcome}) into the masked report`, () => {
      const file = join(dir, `stamp-${outcome}.json`);
      writeFileSync(file, JSON.stringify(report()));
      const r = runScript(SCRIPT, [file], { env: { CLIENT_TEST_OUTCOME: outcome } });
      assert.equal(r.status, 0, r.out);
      const written = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(written.runnerOutcome, outcome, 'the report does not carry the runner\'s outcome it was handed');
      assert.ok(!JSON.stringify(written).includes(TOKEN), 'the stamped report is not masked');
    });
  }

  it('without CLIENT_TEST_OUTCOME it masks and writes no stamp', () => {
    const file = join(dir, 'unstamped.json');
    writeFileSync(file, JSON.stringify(report()));
    const r = runScript(SCRIPT, [file], { env: { CLIENT_TEST_OUTCOME: '' } });
    assert.equal(r.status, 0, r.out);
    assert.equal('runnerOutcome' in JSON.parse(readFileSync(file, 'utf8')), false, 'a stamp appeared that nobody handed the script');
  });

  it('a word that is not a runner outcome fails the step, and the report stays masked and unstamped', () => {
    const file = join(dir, 'bad-stamp.json');
    writeFileSync(file, JSON.stringify(report()));
    const r = runScript(SCRIPT, [file], { env: { CLIENT_TEST_OUTCOME: 'win' } });
    assert.notEqual(r.status, 0, 'an unknown outcome was accepted');
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal('runnerOutcome' in written, false, 'an unknown outcome became a stamp');
    assert.ok(!JSON.stringify(written).includes(TOKEN), 'the report was left unmasked');
  });
});

describe('the client job masks the report between the tests and the upload', () => {
  const job = () => loadCi().jobs['client-tests'];

  it('has a step that runs the masking script, always, after the tests and before the upload', () => {
    const steps = stepsOf(job());
    const index = (pred) => steps.findIndex(pred);
    const tests = index(s => /--outputFile(?:\.json)?[ =]\S*client\.json/.test(shellOf(s)));
    const mask = index(s => /scripts\/mask-client-report\.mjs/.test(shellOf(s)));
    const upload = index(s => usesOf(s)?.action === 'actions/upload-artifact');
    assert.ok(tests >= 0 && upload >= 0, 'the client job lost its test step or its upload step — re-anchor this gate');
    assert.ok(mask >= 0, 'no step of the client job runs scripts/mask-client-report.mjs: client.json is uploaded raw');
    assert.ok(tests < mask && mask < upload, `the masking step must come after the tests (${tests}) and before the upload (${upload}); it is at ${mask}`);
    assert.match(String(steps[mask].if ?? ''), /always\(\)/, 'the masking step must run when the tests failed — that is when the report holds a failure');
    assert.match(shellOf(steps[mask]), /test-results\/client\.json/, 'the step masks a different file from the one the tests write');
  });

  it('the masking step is handed the test step\'s own outcome, by that step\'s id', () => {
    const steps = stepsOf(job());
    const tests = steps.find(s => /--outputFile(?:\.json)?[ =]\S*client\.json/.test(shellOf(s)));
    const mask = steps.find(s => /scripts\/mask-client-report\.mjs/.test(shellOf(s)));
    assert.ok(tests && mask, 'the client job lost its test step or its masking step — re-anchor this gate');
    assert.ok(typeof tests.id === 'string' && tests.id !== '', 'the client test step has no id, so no later step can read its outcome');
    const handed = String(mask.env?.CLIENT_TEST_OUTCOME ?? '');
    assert.match(handed, new RegExp(`^\\$\\{\\{\\s*steps\\.${tests.id.replace(/[-.]/g, '\\$&')}\\.outcome\\s*\\}\\}$`),
      `the masking step must get CLIENT_TEST_OUTCOME: \${{ steps.${tests.id}.outcome }}; it gets ${JSON.stringify(handed)}`);
  });
});

describe('preflight produces the client report the way CI does, and stamps it', () => {
  const src = () => readFileSync(join(REPO_ROOT, 'scripts', 'preflight.mjs'), 'utf8');

  it('deletes the old report, runs the client tests, then stamps the outcome through the one stamper', () => {
    const text = src();
    const run = text.search(/--outputFile(?:\.json)?[ =]\.\.\/test-results\/client\.json/);
    const clear = text.search(/rmSync\(\s*CLIENT_REPORT\b/);
    const stamp = text.search(/stampRunnerOutcome\(\s*CLIENT_REPORT\b/);
    assert.ok(run >= 0, 'preflight no longer runs the client tests with the json report — re-anchor this gate');
    assert.ok(clear >= 0 && clear < run, 'preflight does not delete the old client report before the run, so a stale report could be recorded as this one');
    assert.ok(stamp > run, 'preflight does not stamp the runner\'s outcome after the client run (through stampRunnerOutcome)');
    assert.match(text, /import\s*\{[^}]*\bstampRunnerOutcome\b[^}]*\}\s*from\s*'\.\/mask-client-report\.mjs'/, 'preflight stamps through something other than the one stamper');
  });
});
