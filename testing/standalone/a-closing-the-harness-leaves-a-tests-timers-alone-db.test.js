/**
 * `closeTestMongo` lets the server's search-index poll lapse and NOTHING else: a timer a test awaits after a close keeps
 * the process alive (Q-623).
 *
 * ## The failure this prevents
 *
 * A restore leaves `pollVectorIndexReady` polling a closed client for 60 s, which held twelve files after their tests had
 * passed; `closeTestMongo` ends that by unref'ing the timers the poll creates. The first version unref'd EVERY timer made
 * after a close, and CI's Full run showed the cost: `a-failed-harness-setup-leaves-no-connection-open-db` awaits `holdsWithin`
 * (a timer) after its harness closed, the unref'd timer let the event loop end, and node:test cancelled the case with
 * "Promise resolution is still pending but the event loop has already resolved". A test cannot be made to depend on what
 * was closed before it.
 *
 * ## What is asserted
 *
 *  - after a close, a timer a test creates is ref'd, so awaiting it holds the process (and the case that awaits one
 *    runs to its end);
 *  - the stack test that scopes the unref names the server's index module and nothing else;
 *  - the server's own poll, started before a close and ticking after it (a restore, in miniature), is the timer that IS
 *    unref'd: the thing the harness change is for.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-closing-the-harness-leaves-a-tests-timers-alone-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo, isIndexPollStack } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

describe('closing the harness leaves a test\'s timers alone', { skip }, () => {
  before(async () => {
    await openTestMongo('closetimers');
    await closeTestMongo();
  });
  after(async () => { await closeTestMongo(); });

  it('a timer a test creates after the close is ref\'d, and awaiting it completes', async () => {
    const timer = setTimeout(() => {}, 20);
    assert.equal(timer.hasRef(), true, 'a timer created by test code after a close is unref\'d: awaiting it would not hold the process');
    clearTimeout(timer);
    let fired = false;
    await new Promise(resolve => setTimeout(() => { fired = true; resolve(); }, 30));
    assert.equal(fired, true);
  });

  it('the scoping test names the server\'s search-index module and nothing else', () => {
    assert.equal(isIndexPollStack('Error\n    at file:///x/server/dist/spaces/vector-index.js:451:32'), true);
    assert.equal(isIndexPollStack('Error\n    at C:\\x\\server\\dist\\spaces\\vector-index.js:451:32'), true);
    for (const other of ['Error\n    at file:///x/testing/_shared/wait-for.mjs:40:3', 'Error\n    at file:///x/server/dist/spaces/lifecycle.js:9:1', '']) {
      assert.equal(isIndexPollStack(other), false, `${JSON.stringify(other)} is read as the index poll`);
    }
  });

  it('the server\'s own poll, ticking after the close, creates the timer that is unref\'d', async () => {
    // The poll is started while the harness is open and ticks after it is closed: the restore case, in miniature.
    await openTestMongo('closetimers');
    const { pollVectorIndexReady } = await import('../../server/dist/spaces/vector-index.js');
    const poll = pollVectorIndexReady('closetimers', 'entities', 'closetimers_entities_embedding', { vectorPath: 'embedding', dims: 4 }, { timeoutMs: 3000 });
    const done = poll.catch(() => {});
    await closeTestMongo();
    const seen = [];
    const outer = globalThis.setTimeout;
    globalThis.setTimeout = (...args) => { const t = outer(...args); seen.push(t); return t; };
    try {
      // Its first tick (1 s after it started) runs against the closed client and schedules the next timer.
      const deadline = Date.now() + 3000;
      while (!seen.some(t => t._idleTimeout === 1000) && Date.now() < deadline) await new Promise(resolve => outer(resolve, 50));
      const pollTimers = seen.filter(t => t._idleTimeout === 1000);
      assert.ok(pollTimers.length >= 1, 'the poll scheduled no timer after the close: this case is not about the poll any more');
      assert.ok(pollTimers.every(t => t.hasRef() === false), 'a timer the poll created holds the process open: the 60 s wait is back');
    } finally {
      globalThis.setTimeout = outer;
    }
    await done;
  });
});
