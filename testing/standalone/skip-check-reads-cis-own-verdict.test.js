/**
 * `node scripts/skip-check.mjs <run id>` reads CI's own verdict on skipped tests, and answers 0 / 1 / 2 as `unexpected-skips` does.
 *
 * ## The question it answers, and why it reads and does not re-derive
 *
 * "Did this CI run skip a test nobody expected?" is already answered, once, by the step `No skip nobody expected`
 * (`.github/workflows/ci.yml`, the gate job): it runs `scripts/unexpected-skips.mjs` over the run's own artifacts, at the run's own
 * head, against the run's own `expected-in-ci` list. Re-deriving that from a download would be a second copy of the rule with
 * three ways to disagree with the first (another attempt's files, the local checkout's list, a job that lost its upload). So the
 * check reads that step's result and, when it failed, that step's failed log, and maps them to the same exit codes.
 *
 * ## The truth table this holds, one case per row
 *
 * | the run                                                         | exit | lines          |
 * |-----------------------------------------------------------------|------|----------------|
 * | completed, the step succeeded                                   | 0    |                |
 * | completed, the step failed, its log holds the exit-1 lines      | 1    | each skip      |
 * | completed, the step failed, its log holds the exit-2 lines      | 2    | why            |
 * | completed, the step failed, its log holds neither               | 2    | why            |
 * | completed, the step skipped, cancelled, or has no conclusion    | 2    | why            |
 * | completed, no job has the step (a partial re-run, a rename)     | 2    | why            |
 * | not completed (queued, in progress)                             | 2    | why            |
 * | a run id that is not a decimal number (the command line)        | 2    | usage          |
 *
 * The unknown wins over a finding, as in `unexpected-skips`: a log that mentions skips but whose exit code is 2 is not a list.
 *
 * ## Fixtures
 *
 * - `_fixtures/skip-check/run-success.json` is `gh run view 39812174362 -R ythril-network/Ythril --json status,conclusion,attempt,headSha,jobs`,
 *   unedited: the Full run of 2026-10-22, whose gate job `Full run / Build & Test` has the step succeeded. Every other row is that JSON
 *   edited in memory (a step's conclusion, a run's status, the step removed), so the job and step shape is the real one.
 * - the `log-*.txt` files are LITERAL, written from the lines `scripts/unexpected-skips.mjs` prints (exit 1: its lines 67-68 and the
 *   closing sentence; exit 2: its derivation-failed and usage lines) in the layout `gh run view --job <id> --log-failed` gives
 *   (`<job>\t<step>\t<timestamp> <text>`). They were not recorded from a failing run: none is at hand.
 * - the step's NAME is read from `ci.yml` here, as the step that runs `unexpected-skips.mjs`, and the fixture's step is renamed to it,
 *   so a workflow that renames the step turns the success row red until `skip-check` follows it.
 *
 * Red at base: `scripts/skip-check.mjs` does not exist, so every case that loads it fails on the import, and the command-line case
 * fails on node's own exit code 1 (module not found) where the rule says 2. Once it exists, the assertion that proves each row is the
 * one named in the case.
 *
 * Run: node --test testing/standalone/skip-check-reads-cis-own-verdict.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_sources.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

const FIXTURES = join(REPO_ROOT, 'testing', 'standalone', '_fixtures', 'skip-check');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const SCRIPT = join(REPO_ROOT, 'scripts', 'skip-check.mjs');

/** The module under test, loaded when a case runs, so each case is red at base on its own and not the whole file at once. */
async function skipVerdict() {
  const mod = await import(new URL(`file:///${SCRIPT.replace(/\\/g, '/')}`).href);
  assert.equal(typeof mod.skipVerdict, 'function', 'scripts/skip-check.mjs must export skipVerdict({ run, failedLog }) -> { code, lines }');
  return mod.skipVerdict;
}

/** The name of the ci.yml step that runs the skip rule: the step whose `run:` holds `unexpected-skips.mjs`, found, not spelled. */
function gateStepName() {
  const lines = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    if (!/^\s*run:.*scripts\/unexpected-skips\.mjs/.test(line)) return;
    for (let j = i - 1; j >= 0; j--) {
      const m = /^\s*-\s+name:\s*(.+?)\s*$/.exec(lines[j]);
      if (m) { found.push(m[1].replace(/^['"]|['"]$/g, '')); break; }
    }
  });
  assert.equal(found.length, 1, `ci.yml must have exactly one step running unexpected-skips.mjs, found ${found.length}`);
  return found[0];
}

/** The recorded run, with its gate step carrying the name ci.yml gives it today. Returns a fresh copy each call. */
function recordedRun() {
  const run = JSON.parse(fixture('run-success.json'));
  const recorded = 'No skip nobody expected';
  const holders = run.jobs.flatMap(j => j.steps.filter(s => s.name === recorded));
  assert.equal(holders.length, 1, `the recorded run must hold exactly one step '${recorded}'`);
  holders[0].name = gateStepName();
  return run;
}
const gateStepOf = (run) => run.jobs.flatMap(j => j.steps).find(s => s.name === gateStepName());
const gateJobOf = (run) => run.jobs.find(j => j.steps.some(s => s.name === gateStepName()));

describe('the recorded run (the fixture is what gh gives)', () => {
  it('is completed and its gate step succeeded, under the name ci.yml gives the step', () => {
    const run = recordedRun();
    assert.equal(run.status, 'completed');
    assert.equal(gateStepOf(run)?.conclusion, 'success');
    assert.ok(run.jobs.length >= 5, 'the fixture is a whole run, not a trimmed one');
  });
});

describe('skipVerdict: one case per row of the truth table', () => {
  it('exit 0: the run completed and the gate step succeeded', async () => {
    const v = (await skipVerdict())({ run: recordedRun(), failedLog: '' });
    assert.equal(v.code, 0, `the step succeeded, so no skip was unexpected: ${JSON.stringify(v)}`);
  });

  it('exit 0 does not depend on the gate job\'s name (a PR run calls it "Build & Test", the Full run "Full run / Build & Test")', async () => {
    const run = recordedRun();
    gateJobOf(run).name = 'Build & Test';
    assert.equal((await skipVerdict())({ run, failedLog: '' }).code, 0);
  });

  it('exit 0 reads the step, not the whole run: another job failing does not change the answer about skips', async () => {
    const run = recordedRun();
    run.conclusion = 'failure';
    const other = run.jobs.find(j => j !== gateJobOf(run));
    other.conclusion = 'failure';
    assert.equal((await skipVerdict())({ run, failedLog: '' }).code, 0);
  });

  it('exit 1: the step failed and its log lists the unexpected skips, each of which is returned', async () => {
    const run = recordedRun();
    gateStepOf(run).conclusion = 'failure';
    gateJobOf(run).conclusion = 'failure';
    run.conclusion = 'failure';
    const v = (await skipVerdict())({ run, failedLog: fixture('log-unexpected-skips.txt') });
    assert.equal(v.code, 1, JSON.stringify(v));
    const text = v.lines.join('\n');
    for (const entry of [
      'testing/standalone/an-example-gate.test.js  "reads the sidecar\'s answer"  "the sidecar never came up"',
      'client/src/app/example/example.component.spec.ts  "renders the empty state"  (no reason given)',
    ]) assert.ok(text.includes(entry), `the skip ${JSON.stringify(entry)} is not in the lines:\n${text}`);
    assert.ok(text.includes('2 skipped test(s) CI did not expect'), `the count line is not in the lines:\n${text}`);
  });

  it('exit 1 hands back the lines as the check prints them, not the runner\'s log prefix', async () => {
    const run = recordedRun();
    gateStepOf(run).conclusion = 'failure';
    const v = (await skipVerdict())({ run, failedLog: fixture('log-unexpected-skips.txt') });
    assert.equal(v.code, 1);
    for (const l of v.lines) {
      assert.ok(!/^\S.*\t\S.*\t\d{4}-\d\d-\d\dT/.test(l), `a line still carries the gh log prefix: ${JSON.stringify(l)}`);
      assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/.test(l), `a line still carries a timestamp: ${JSON.stringify(l)}`);
    }
  });

  for (const [name, log] of [
    ['the derivation failed (exit 2 of unexpected-skips)', 'log-derivation-failed.txt'],
    ['the command line was refused (usage, exit 2)', 'log-usage.txt'],
    ['the step failed for a reason that is none of the skip rule\'s (a lost runner)', 'log-step-failed-otherwise.txt'],
  ]) {
    it(`exit 2: the step failed and ${name}`, async () => {
      const run = recordedRun();
      gateStepOf(run).conclusion = 'failure';
      const v = (await skipVerdict())({ run, failedLog: fixture(log) });
      assert.equal(v.code, 2, `a failed step that names no unexpected skip is unknown, not a finding: ${JSON.stringify(v)}`);
      assert.ok(v.lines.length > 0, 'an exit of 2 says why');
    });
  }

  it('exit 2: the step failed and no failed log could be read (empty, or absent)', async () => {
    for (const failedLog of ['', undefined, null]) {
      const run = recordedRun();
      gateStepOf(run).conclusion = 'failure';
      assert.equal((await skipVerdict())({ run, failedLog }).code, 2, `failedLog ${JSON.stringify(failedLog)}`);
    }
  });

  it('exit 2: the unknown wins over a finding (exit-1 lines in a log do not outvote an exit-2 line)', async () => {
    const run = recordedRun();
    gateStepOf(run).conclusion = 'failure';
    const both = `${fixture('log-unexpected-skips.txt')}${fixture('log-derivation-failed.txt')}`;
    assert.equal((await skipVerdict())({ run, failedLog: both }).code, 2);
  });

  for (const conclusion of ['skipped', 'cancelled', null, undefined, 'neutral', 'timed_out']) {
    it(`exit 2: the gate step's conclusion is ${JSON.stringify(conclusion)}, so the run says nothing about skips`, async () => {
      const run = recordedRun();
      const step = gateStepOf(run);
      if (conclusion === undefined) delete step.conclusion; else step.conclusion = conclusion;
      const v = (await skipVerdict())({ run, failedLog: fixture('log-unexpected-skips.txt') });
      assert.equal(v.code, 2, JSON.stringify(v));
    });
  }

  it('exit 2: no job holds the step (a partial re-run that never reached it, or the step was renamed)', async () => {
    const run = recordedRun();
    for (const j of run.jobs) j.steps = j.steps.filter(s => s.name !== gateStepName());
    assert.equal((await skipVerdict())({ run, failedLog: '' }).code, 2);
  });

  it('exit 2: a step renamed in ci.yml is not found under the old name (the fixture follows ci.yml, so the check must too)', async () => {
    const run = recordedRun();
    gateStepOf(run).name = `${gateStepName()} (renamed)`;
    assert.equal((await skipVerdict())({ run, failedLog: '' }).code, 2);
  });

  for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
    it(`exit 2: the run is ${status}, even with the step already green`, async () => {
      const run = recordedRun();
      run.status = status;
      run.conclusion = '';
      assert.equal(gateStepOf(run).conclusion, 'success');
      assert.equal((await skipVerdict())({ run, failedLog: '' }).code, 2);
    });
  }

  it('exit 2: a run with no jobs, or none read at all', async () => {
    const skip = await skipVerdict();
    const run = recordedRun();
    run.jobs = [];
    assert.equal(skip({ run, failedLog: '' }).code, 2);
    assert.equal(skip({ run: {}, failedLog: '' }).code, 2);
  });
});

describe('the command line', () => {
  const ask = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, env: testChildEnv({ PATH: '' }),
  });

  for (const id of ['abc', '12x', 'x12', '1 2', '-1', '1.5', '../1', '0x1F', '1;2', '$(id)', '']) {
    it(`refuses the run id ${JSON.stringify(id)} with exit 2 and says how to call it`, () => {
      const r = ask(id);
      assert.equal(r.status, 2, `status ${r.status}; stderr: ${r.stderr}`);
      assert.match(`${r.stderr}${r.stdout}`, /usage|run id/i, 'the refusal names the usage');
    });
  }

  it('refuses no run id, and more than one', () => {
    assert.equal(ask().status, 2);
    assert.equal(ask('123', '456').status, 2);
  });
});
