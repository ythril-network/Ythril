/**
 * Run one of the repo's scripts to completion, the way a gate over a script needs it run.
 *
 * ## Why it is a module
 *
 * `every-tracked-test-file-reaches-a-ci-job-and-runs` and `unexpected-skips-fail-the-ci-gate` each wrote the same
 * helper: assert the script exists, build a child environment, `spawnSync(process.execPath, [script, ...args])`,
 * return the status and the two streams together. The part a copy drops is the first and the second. A script that
 * does not exist makes node exit 1 with a message, which a test that expects a failure reads as the failure it
 * wanted; and an environment built by hand inherits whatever the runner left in it (`NODE_TEST_CONTEXT`, the
 * recorder's credentials) — both are done here, so a caller cannot reach the spawn without them.
 *
 * Child environments come from `testChildEnv`; `env` is what the caller deliberately adds on top.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_sources.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

/**
 * @param {string} scriptPath absolute path of the script
 * @param {string[]} [args]
 * @param {{ cwd?: string, timeout?: number, env?: Record<string,string> }} [opts]
 * @returns {{ status: number|null, out: string }} `status` null means it never produced one (a crash or a timeout);
 *   `out` is stdout then stderr
 */
export function runScript(scriptPath, args = [], { cwd = REPO_ROOT, timeout = 120_000, env = {} } = {}) {
  assert.ok(existsSync(scriptPath), `${scriptPath} does not exist — a missing script exits 1, which reads as the failure a gate expects`);
  const r = spawnSync(process.execPath, [scriptPath, ...args], { cwd, env: testChildEnv(env), encoding: 'utf8', timeout });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
