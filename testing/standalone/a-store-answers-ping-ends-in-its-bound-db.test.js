/**
 * The ping a walk uses to tell "this space hung" from "the store stopped answering" ends in ITS OWN bound, on a store that
 * has stopped answering and a pool that has already cleared (`Q-274`, bundle-53 G8; probe P6).
 *
 * ## The defect it prevents
 *
 * `storeAnswers` is asked from a walk's `catch`, after an operation of the walk timed out. If the question itself can hang, a
 * walk meant to stop at the first timeout spends a second bound finding out it should. A ping with no bound of its own, against
 * a frozen store, waits for server selection once the pool is cleared: 54 s was measured. `storeAnswers` settles at
 * `STORE_PING_MS` in every phase (socket read, checkout, selection): the server's deadline, a `signal`, and a race. It did so
 * with the driver's `timeoutMS` until `Q-716`; from driver 7.8.0 that option does nothing, and this file hung for 15 minutes on
 * it before the ping was given a bound of its own.
 *
 * ## What is pinned, against a store that really freezes
 *
 * The freezable relay (`_freezable-relay.mjs`) drops bytes in both directions and keeps the sockets open - what a paused
 * store does. The client's own detection is scaled down (connect 1 s, heartbeat 0.5 s) so the pool CLEARS inside the case, and
 * its server-selection timeout is left long (20 s) so the ping's own bound is the only thing that can end the wait. Then:
 * `storeAnswers()` settles at its bound and is false; and after `thaw()` the store answers again and so does `storeAnswers()`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-store-answers-ping-ends-in-its-bound-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { startFreezableRelay } from './_freezable-relay.mjs';
import { holdsWithin, waitFor } from '../_shared/wait-for.mjs';
import { createStoreAnswers, STORE_PING_MS } from '../../server/dist/db/store-answers.js';
import { createProbeCache } from '../../server/dist/util/cached-probe.js';

const skip = await mongoSkipReason();

/** What detection can add on top of the ping's bound on a loaded machine, ms. Derived from the client's own figures below. */
const CONNECT_MS = 1_000;
const HEARTBEAT_MS = 500;
const SLACK_MS = CONNECT_MS + HEARTBEAT_MS;

describe('storeAnswers against a frozen store', { skip }, () => {
  let relay; let client; let answers;
  let poolClears = 0;

  before(async () => {
    relay = await startFreezableRelay('ythril_harness_store_answers', {
      query: `&connectTimeoutMS=${CONNECT_MS}&heartbeatFrequencyMS=${HEARTBEAT_MS}&serverSelectionTimeoutMS=20000`,
    });
    client = new MongoClient(relay.uri);
    client.on('connectionPoolCleared', () => { poolClears += 1; });
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    // A fresh memo for each question: the memo is tested in the pure suite, and here it would hide the store's own answer.
    answers = () => createStoreAnswers({ client: () => client, cache: createProbeCache() })();
  });

  after(async () => {
    relay?.thaw();
    await client?.close(true).catch(() => {});
    await relay?.close();
  });

  it('answers true while the store answers', async () => {
    assert.equal(await answers(), true);
  });

  it('settles at its own bound, with the pool already cleared, and answers false', async () => {
    const clearsBefore = poolClears;
    relay.freeze();
    // Let the monitor's heartbeat notice and clear the pool: from here a ping waits for SERVER SELECTION, which is 20 s here.
    await waitFor(() => poolClears > clearsBefore, 25_000, 50, undefined, { what: 'the monitor to notice the frozen store and clear the pool' });

    const asked = Date.now();
    assert.equal(await answers(), false, 'a store that does not answer is false');
    const tookMs = Date.now() - asked;
    assert.ok(tookMs >= STORE_PING_MS - 300, `storeAnswers() answered after ${tookMs} ms, before its ${STORE_PING_MS} ms bound`);
    assert.ok(tookMs <= STORE_PING_MS + SLACK_MS, `storeAnswers() took ${tookMs} ms: its bound is ${STORE_PING_MS} ms, so something else was waited for`);
  });

  it('answers true again after thaw, within one bound', async () => {
    relay.thaw();
    const back = await holdsWithin(async () => await answers(), STORE_PING_MS * 3, 100);
    assert.ok(back, 'the store did not answer again after thaw()');
  });
});
