/**
 * A write the bound ended is answered `503`, retryable, with a GENERIC message — on every door a caller writes
 * through: the sync push routes, the REST record route, and the MCP tool door (bundle-30 plan §A5).
 *
 * ## The rule
 *
 * A timed-out write is the store's condition, not the caller's mistake and not a server bug: the caller should
 * retry it, and a sender should hold its watermark. So it is a typed `StoreTimeout`, mapped by ONE function on
 * every door to `503` with `retryable: true` — and with a message of our own, never the driver's text, which names
 * collections and internals and differs by which side of the socket fired first. A `400` would tell a sender the
 * document is bad (it is dropped), a `500` reads as our bug, and a 200 over a write that did not land is a lie.
 *
 * ## The doors, and why the push half is the FACT routes
 *
 * The plan bounds every operation issued while a seq hold is active (§A3). On the push door the one write inside a
 * hold is a FORK (`acceptPushedPage` allocates a block for it), and only facts fork — so the push routes that can
 * time out are the single `/facts` route and `/batch-upsert` carrying facts; both are asked. The REST door is
 * `PATCH /api/brain/spaces/:spaceId/facts/:id` through the whole app (its errors reach the app's error handler,
 * so calling the route's handler alone would test a door no request reaches); the MCP door is `update_fact`
 * through `callTool`, the dispatch every MCP request goes through.
 *
 * ## The stall is REAL (`_write-faults.mjs holdDocumentLock`)
 *
 * Another session's open transaction locks the document the write targets — the fact for an update, the fork's
 * derived id for a fork — and the bound (2 s, through the plan's `setWriteBoundForTest`) is what must end it. On
 * the unchanged code nothing ends it: each door is still waiting when the test releases the lock, and that is the
 * red, together with the missing seam.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-timeout-answers-503-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { settleWithin, setWriteBoundForTest } from './_write-faults.mjs';
import { openStalledWriteDoors, seedDoorSpace, stalledWriteDoors } from './_stalled-write-doors.mjs';

const skip = await mongoSkipReason();

const S = 'timeout503';
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
const CAP_MS = BOUND.holdDeadlineMs + 2500;

/** What the driver says about a write the bound ended — none of it may reach a caller. */
const DRIVER_TEXT = /Mongo\w*Error|MaxTimeMS|maxTimeMS|exceeded time limit|Timed out during|Server reported a timeout|WriteConflict|timeout503_facts|E11000/;

/** Filled by `before`; the doors (`_stalled-write-doors.mjs`, the one table `a-write-the-bound-ended-never-lands-db` walks too) read it. */
const env = {};
const DOORS = stalledWriteDoors(env, S);

describe('a write timeout answers 503 on every door', { skip }, () => {
  let seamError = null;
  let restoreBound = () => {};
  let doors;

  before(async () => {
    doors = await openStalledWriteDoors({ suite: 'timeout503', spaces: [S] });
    Object.assign(env, doors.env);
    try { restoreBound = await setWriteBoundForTest(BOUND); } catch (err) { seamError = err; }
  });
  after(async () => {
    restoreBound();
    await doors?.close();
  });
  beforeEach(async () => { await seedDoorSpace(env.door, S); });

  it('the write bound has a test seam (db/write-bound.ts setWriteBoundForTest)', () => {
    assert.equal(seamError, null, seamError?.message);
  });

  it('control: unstalled, every door writes (so a 503 below is the stall, not the fixture)', async () => {
    for (const d of DOORS) {
      await seedDoorSpace(env.door, S);
      const r = await d.call();
      assert.equal(r.status, 200, `${d.name} answered ${r.status} with nothing stalled: ${r.text.slice(0, 300)}`);
    }
  });

  for (const d of DOORS) {
    it(`${d.name}: a timed-out write answers 503, retryable, in words of our own`, { timeout: CAP_MS + 30_000 }, async () => {
      const lock = await d.lock();
      let res;
      try {
        res = await settleWithin(d.call(), CAP_MS);
      } finally {
        await lock.release();
      }
      const late = res.settled ? null : await res.rest;
      assert.ok(res.settled,
        `${d.name} had not answered ${res.elapsedMs} ms into a write stalled behind a lock — no bound ended it `
        + `(once the lock was released it answered ${late?.ok ? late.value.status : late?.error?.message})`);
      assert.ok(res.ok, `${d.name} threw instead of answering: ${res.error?.stack ?? res.error}`);
      const { status, body, text } = res.value;
      assert.equal(status, 503, `${d.name} answered ${status} for a write the store could not take in time: ${text.slice(0, 300)}`);
      assert.equal(body?.retryable, true, `${d.name}'s 503 does not say it is retryable: ${text.slice(0, 300)}`);
      assert.doesNotMatch(text, DRIVER_TEXT, `${d.name} answered with the driver's text: ${text.slice(0, 300)}`);
    });
  }
});
