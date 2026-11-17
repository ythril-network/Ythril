/**
 * A rerun requested for a network that is deleted before the rerun runs ends quietly, and every other rerun still does its work.
 *
 * ## The defect
 *
 * A trigger that arrives while a network's cycle runs schedules exactly one follow-up (`sync/coalescing-runner.ts`), and the
 * follow-up's promise is started and let go: nobody awaits it. When the network is deleted between the request and the rerun,
 * the cycle's first line throws `Network <id> not found`, and with no one holding the promise that is an unhandled rejection.
 * Full run 44163324512's sync job showed it in `ythril-a`'s log at 20:04:10, right after `Rerun requested for network ...`:
 * a test had deleted the network during a rerun. The scheduled door answers the same gone network quietly (`sync/scheduler.ts`);
 * the rerun path did not.
 *
 * ## The rule
 *
 * A rerun whose network no longer exists ends with one log line and no rejection. A rerun of a network that exists runs a
 * cycle, and any OTHER failure of a rerun is still raised, not swallowed: only the gone network is expected.
 *
 * ## What each case drives
 *
 * `_rerun-scenario.mjs`, in a process of its own (the test runner would take a rejection nobody holds for this test's failure): the
 * real engine (`runSyncForNetwork`) against a scratch config. The first call starts a cycle for a network with no members, a second
 * call joins it and queues the rerun, and the network is then taken out of the live config (or kept). The last case drives the runner
 * with a cycle that fails on its second run.
 *
 * Run: node --test testing/standalone/a-rerun-of-a-deleted-network-ends-quietly.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './_run-script.mjs';

const SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), '_rerun-scenario.mjs');
let tmpDir;

before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rerun-gone-')); });
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Run a scenario and read its answer: the last line of its output is the JSON. */
function run(scenario) {
  const { status, out } = runScript(SCENARIO, [scenario], { env: { CONFIG_PATH: path.join(tmpDir, `${scenario}.json`) } });
  const last = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
  assert.ok(last, `the scenario ${scenario} answered nothing (exit ${status}): ${out.slice(-600)}`);
  return JSON.parse(last);
}

describe('a rerun requested for a network deleted before the rerun runs', () => {
  it('ends with one log line and no unhandled rejection', () => {
    const { unhandled, lines } = run('gone');
    assert.deepEqual(unhandled, [], 'the rerun of a deleted network is a rejection nobody holds');
    // The first cycle says its own start and end for the network; what is left about the network is what the rerun said.
    const about = lines.filter(l => /gone-network/.test(l) && !/^debug: /.test(l) && !/Starting sync cycle|Sync cycle complete/.test(l));
    assert.equal(about.length, 1, `expected one line saying the rerun was dropped; got ${JSON.stringify(about)}`);
    assert.match(about[0], /^(info|warn): /, 'a network deleted on purpose is not an error');
  });

  it('a rerun of a network that still exists runs its cycle', () => {
    const { unhandled, lines } = run('live');
    const started = lines.filter(l => /^info: Starting sync cycle for network 'Rerun live-network'/.test(l));
    assert.equal(started.length, 2, `the first cycle and its rerun both start; got ${JSON.stringify(lines)}`);
    assert.deepEqual(unhandled, [], 'a rerun of a live network raised a rejection');
  });

  it('a rerun that fails for any other reason is still raised, not swallowed', () => {
    const { unhandled, calls } = run('other-failure');
    assert.equal(calls, 2, 'fixture: the rerun did not run');
    assert.deepEqual(unhandled, ['Error: rerun-store-down'], 'a rerun that failed for another reason was swallowed');
  });
});
