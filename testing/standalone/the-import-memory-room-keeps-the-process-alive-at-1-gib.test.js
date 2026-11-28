/**
 * The room one import is given keeps the process alive at its bound in a container of 1 GiB: the rule and the measurement are in
 * `_import-memory-alive.mjs`, which holds one file per container size (bundle-385: the three sizes in one file ran 89 s). This file also holds
 * that every size of the probe has its own file.
 *
 * Run: node --test testing/standalone/the-import-memory-room-keeps-the-process-alive-at-1-gib.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { assertAliveAtBound, aliveFileOf, ALIVE_SIZES, ALIVE_CHILD_MS } from './_import-memory-alive.mjs';

describe('every holder at its bound, in a container of 1 GiB', { timeout: ALIVE_CHILD_MS + 10_000 }, () => {
  it('1 GiB: the process lives through the door\'s inference, the act\'s first phase and second phase at the room, each refused just past it', async () => {
    await assertAliveAtBound(1);
  });

  it('every container size of the probe has its own file', () => {
    const tracked = new Set(execFileSync('git', ['ls-files', 'testing/standalone'], { encoding: 'utf8' }).split('\n').map(f => f.trim().split('/').pop()));
    assert.deepEqual(ALIVE_SIZES.filter(n => !tracked.has(aliveFileOf(n))), [], 'a size of the probe has no test file');
  });
});
