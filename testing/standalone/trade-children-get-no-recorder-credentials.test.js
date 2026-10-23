/**
 * The `gh` and `git` children of `scripts/trade.mjs` get an environment WITHOUT the recorder's `YTHRIL_TEST_RUNS_*` family
 * (Q-590, design rev 2 item 6; the lens finding V8).
 *
 * ## What this prevents
 *
 * `--record` puts `YTHRIL_TEST_RUNS_TOKEN`, a token that writes chrono entries on a Ythril instance, into trade's own
 * environment. `execFileSync` with no `env` option hands the whole of it to every child: `gh`, which runs a user's extensions and
 * aliases, and `git`, which runs hooks and a configured credential helper or pager. Neither has any use for the token, and
 * every one of them is a program somebody else wrote. `testChildEnv` (`testing/_shared/test-child-env.mjs`) is the one place
 * that says what a child inherits; this file holds that trade's two readers go through it.
 *
 * ## What is held, at two depths
 *
 * - **The shared reader and the git helpers**, called with an injected `exec` (the seam they already have): the options they
 *   pass carry an `env`, and it holds no recorder variable of any case, while the rest of the environment (`PATH`) is still
 *   there, so the child still starts. The recorder variables are set in THIS process for the call, so a reader that passes
 *   nothing lets them through and is red.
 * - **The real CLI**, run with the recorder's variables set, over `fake-gh-and-git-preload.mjs` which logs the environment
 *   every `gh` and `git` call would get: no call inherits it, none holds a recorder name. Both a report run (`--line`) and a
 *   recording (`--record`) are held, and each must have made calls, or an empty log would pass.
 *
 * Run: node --test testing/standalone/trade-children-get-no-recorder-credentials.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeYthril } from '../_shared/fake-ythril-tool-server.mjs';
import { RECORDER_ENV_PREFIX } from '../_shared/test-child-env.mjs';
import { ghText, readFailedLog } from '../../scripts/_shared/ci-run-reader.mjs';
import { cutoverOnMain, gitIsAncestor } from '../../scripts/trade.mjs';
import { runTrade, everything, SHAS } from '../_shared/trade-record-harness.mjs';

const isRecorderName = (name) => name.toUpperCase().startsWith(RECORDER_ENV_PREFIX);

/** Run `body` with recorder variables in this process's environment (a token in the parent is what a child must not get). */
async function withRecorderVariables(body) {
  const names = ['YTHRIL_TEST_RUNS_TOKEN', 'YTHRIL_TEST_RUNS_URL', 'ythril_test_runs_lower'];
  const saved = names.map(n => [n, process.env[n]]);
  for (const n of names) process.env[n] = 'child-must-not-see-this';
  try { return await body(); } finally { for (const [n, v] of saved) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } }
}

/** An `exec` that records the options of each call and answers `printed`. */
function recordingExec(printed = '') {
  const seen = [];
  const exec = (file, args, options) => { seen.push({ file, args, options }); return printed; };
  return { exec, seen };
}

function assertCleanChildEnv({ file, args, options }, what) {
  assert.ok(options?.env && typeof options.env === 'object', `${what}: ${file} ${args.slice(0, 2).join(' ')} was started with no env option, so it inherits everything, the token included`);
  assert.deepEqual(Object.keys(options.env).filter(isRecorderName), [], `${what}: the child's environment holds a recorder variable`);
  assert.ok(Object.keys(options.env).some(n => n.toUpperCase() === 'PATH'), `${what}: the rest of the environment is still there, so the child can start`);
}

describe('the shared reader and trade\'s git helpers start their children with a clean environment', () => {
  it('ghText', async () => {
    await withRecorderVariables(() => {
      const { exec, seen } = recordingExec('[]');
      ghText(['run', 'list'], { exec });
      assert.equal(seen.length, 1);
      assertCleanChildEnv(seen[0], 'ghText');
    });
  });

  it('readFailedLog (the failed log of a job, through the same reader)', async () => {
    await withRecorderVariables(() => {
      const { exec, seen } = recordingExec('log text');
      readFailedLog(123, { exec });
      assert.equal(seen.length, 1);
      assertCleanChildEnv(seen[0], 'readFailedLog');
    });
  });

  it('cutoverOnMain (git log)', async () => {
    await withRecorderVariables(() => {
      const { exec, seen } = recordingExec(`${SHAS.cutover}\n`);
      assert.equal(cutoverOnMain({ exec }).sha, SHAS.cutover);
      assert.equal(seen.length, 1);
      assertCleanChildEnv(seen[0], 'cutoverOnMain');
    });
  });

  it('gitIsAncestor (git merge-base)', async () => {
    await withRecorderVariables(() => {
      const { exec, seen } = recordingExec('');
      assert.equal(gitIsAncestor(SHAS.cutover, SHAS.after, { exec }), true);
      assert.equal(seen.length, 1);
      assertCleanChildEnv(seen[0], 'gitIsAncestor');
    });
  });
});

describe('the real CLI: no gh or git call of a run inherits the recorder\'s variables', () => {
  const RECORDER = { YTHRIL_TEST_RUNS_TOKEN: 'child-must-not-see-this' };

  function assertEveryCallIsClean(r, what) {
    assert.ok(r.calls.some(c => c.file === 'gh'), `${what}: no gh call was logged, so nothing was held: ${everything(r).slice(0, 400)}`);
    assert.ok(r.calls.some(c => c.file === 'git'), `${what}: no git call was logged, so nothing was held`);
    for (const c of r.calls) {
      assert.equal(c.inherited, false, `${what}: ${c.file} ${c.args.slice(0, 2).join(' ')} inherits trade's environment, the token included`);
      assert.deepEqual(c.envNames.filter(isRecorderName), [], `${what}: ${c.file} ${c.args.slice(0, 2).join(' ')} holds a recorder variable`);
    }
  }

  it('a report run (--line) with the recorder\'s variables set', async () => {
    const r = await runTrade(['--line', 'full-run/bundle-130'], { env: RECORDER });
    assert.equal(r.code, 0, everything(r));
    assertEveryCallIsClean(r, '--line');
  });

  it('a recording (--record) with the destination set', async () => {
    const server = await startFakeYthril();
    try {
      const r = await runTrade(['--record', 'full-run/bundle-130'], { server });
      assert.equal(r.code, 0, everything(r));
      assertEveryCallIsClean(r, '--record');
    } finally { await server.close(); }
  });
});
