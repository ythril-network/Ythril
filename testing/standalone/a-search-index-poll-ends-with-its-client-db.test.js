/**
 * A search-index readiness poll ends when the database client it started on is closed or replaced (Q-625).
 *
 * ## The failure this prevents
 *
 * `pollVectorIndexReady` slept a second and asked the store again, for up to its whole window (60 s by default), whatever
 * happened to the connection in between. After a close every ask threw "Client must be connected before running operations",
 * the poll recorded it and asked again, and the process stayed open until the window ran out: twelve restore-family test
 * files spent those 60 s each after their tests had passed (Q-623). The harness hid it by unref'ing the timers the poll
 * created after a close, a workaround read off each timer's call stack. The poll now keeps the client it started on and ends
 * at its next tick once that client is no longer the store's (`isCurrentClient`, `db/mongo.ts`), so the workaround is gone.
 *
 * ## What is asserted
 *
 *  - a poll started on an open store ends, answering not-ready, within a tick of the store being closed;
 *  - a poll started on one client ends the same way when the store is closed and opened again: the store is open, but not
 *    on the client the poll started on;
 *  - closing the harness leaves `setTimeout` as it found it: a test's timers are its own again.
 *
 * Each poll is given a 30 s window, so on code that waits out the window the bound below fails long before the poll returns.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-search-index-poll-ends-with-its-client-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SUITE = 'pollclient';
const WINDOW_MS = 30_000;
/** One poll tick (1 s) and room for a loaded runner; far below WINDOW_MS. */
const ENDS_WITHIN_MS = 2500;

/** `promise`'s value, or the string 'still running' when it has not settled within `ms`. */
async function within(promise, ms) {
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve('still running'), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

async function startPoll() {
  const { pollVectorIndexReady } = await import('../../server/dist/spaces/vector-index.js');
  return pollVectorIndexReady(SUITE, 'entities', `${SUITE}_entities_embedding`, { vectorPath: 'embedding', dims: 4 }, { timeoutMs: WINDOW_MS });
}

describe('a search-index poll ends with its client', { skip }, () => {
  after(async () => { await closeTestMongo(); });

  it('a poll on a store that is then closed ends, not ready, within a tick', { timeout: 60_000 }, async () => {
    await openTestMongo(SUITE);
    const poll = startPoll();
    await closeTestMongo();
    assert.equal(await within(poll, ENDS_WITHIN_MS), false, `the poll did not end within ${ENDS_WITHIN_MS} ms of the close: it polls the closed client until its ${WINDOW_MS} ms window runs out`);
  });

  it('a poll on a client the store replaced ends the same way, while the store is open again', { timeout: 60_000 }, async () => {
    await openTestMongo(SUITE);
    const poll = startPoll();
    await closeTestMongo();
    await openTestMongo(SUITE);
    assert.equal(await within(poll, ENDS_WITHIN_MS), false, `the poll did not end within ${ENDS_WITHIN_MS} ms although the client it started on was closed and replaced`);
    await closeTestMongo();
  });

  it('closing the harness leaves setTimeout as it found it', async () => {
    const before = globalThis.setTimeout;
    await openTestMongo(SUITE);
    await closeTestMongo();
    assert.equal(globalThis.setTimeout, before, 'closeTestMongo replaced setTimeout: a test\'s timers are not its own after a close');
  });
});
