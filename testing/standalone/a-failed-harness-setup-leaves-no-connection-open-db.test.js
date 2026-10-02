/**
 * A database harness whose setup fails closes what it opened, so the test FAILS instead of hanging the run.
 *
 * ## Why this exists
 *
 * PR #1475's Build & Test sat in `test:standalone` for over an hour with no output: node's test runner waits for
 * every file's process to exit, and a file whose `before` threw after the harness had connected kept its Mongo
 * client open, so its process never exited and neither did the batch. Reproduced locally: the setup failed, every
 * test in the file was reported failed, and the process still held two sockets to the test Mongo after its
 * `after` hook ran. A failing setup must be a failing test, never a silent hang.
 *
 * ## The rule
 *
 * `openPushDoor` (and `openTestMongo` under it) close the connection they opened when anything after the connect
 * throws, and rethrow. Asserted over the process's live sockets to the test Mongo port, which is what kept the
 * process alive.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failed-harness-setup-leaves-no-connection-open-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();

/** Sockets this process holds to the test Mongo: what keeps a process alive after its tests. */
function mongoSockets() {
  return process._getActiveHandles().filter(h => h?.constructor?.name === 'Socket' && h.remotePort === TEST_MONGO_PORT);
}

describe('a failed harness setup leaves no connection open', { skip }, () => {
  it('openPushDoor rejects, and afterwards the process holds no socket to the test Mongo', async () => {
    // A space id Mongo cannot use in a collection name makes the space's setup throw after the harness connected.
    await assert.rejects(
      openPushDoor({ suite: 'harnessleak', spaces: [{ id: 'bad$space', label: 'Bad', folders: [], meta: {} }] }),
      'fixture check: the setup did not fail, so this case proves nothing',
    );
    // The driver releases sockets asynchronously after close; give it a moment, then look.
    for (let i = 0; i < 20 && mongoSockets().length > 0; i++) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(mongoSockets().map(s => `${s.remoteAddress}:${s.remotePort}`), [],
      'the harness left its Mongo connection open after a failed setup, so this process would never exit');
  });
});
