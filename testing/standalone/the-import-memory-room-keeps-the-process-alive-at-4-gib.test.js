/**
 * The room one import is given keeps the process alive at its bound in a container of 4 GiB: the rule and the measurement are in
 * `_import-memory-alive.mjs`, which holds one file per container size (bundle-385: the three sizes in one file ran 89 s).
 *
 * Run: node --test testing/standalone/the-import-memory-room-keeps-the-process-alive-at-4-gib.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import { assertAliveAtBound, ALIVE_CHILD_MS } from './_import-memory-alive.mjs';

describe('every holder at its bound, in a container of 4 GiB', { timeout: ALIVE_CHILD_MS + 10_000 }, () => {
  it('4 GiB: the process lives through the door\'s inference, the act\'s first phase and second phase at the room, each refused just past it', async () => {
    await assertAliveAtBound(4);
  });
});
