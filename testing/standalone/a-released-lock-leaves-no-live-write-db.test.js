/**
 * A lock handed back from `_write-faults.mjs` leaves NO LIVE WRITE on its collection (`Q-372`) — and a drain that
 * cannot finish says so instead of returning quietly.
 *
 * ## The defect
 *
 * `holdDocumentLock` and `holdCounterLock` return a handle whose `release()` aborted the lock's transaction and
 * returned. A write that was waiting behind the lock does not end at that moment: a plain write blocked by another
 * session's uncommitted change retries inside the server, sleeping between attempts, and finishes up to ~100 ms
 * after the lock is gone. A test that "released the lock and moved on" then raced that write — in main's CI run
 * 37231507558 the late write inserted a fork AFTER the next case had wiped the space, and the case after that
 * failed with `E11000` on its own lock. The test said the stall was over when only the lock was.
 *
 * ## The rule this file holds
 *
 * **`release()` resolves only once the server has no active operation on the collection it locked** — read from the
 * server's own account (`_active-operations.mjs`), not from any client promise — **and it THROWS when the server does
 * not go quiet in time**, naming the collection, rather than returning with a write still alive. The lock itself is
 * released either way: a throwing drain must not leave the transaction holding.
 *
 * ## The three locks, and what is stalled behind each
 *
 * A plain `insertOne` of the id a locked INSERT holds, a plain `updateOne` of the document a FILTER lock holds, and a
 * plain `$inc` of the counter row `holdCounterLock` holds — the three shapes the doors and holders produce. Each is
 * held for longer than a second before the release, so the server-side retry is sleeping at its ceiling when the lock
 * goes: the state in which a release that does not wait leaves the write alive. Every shape is repeated, because
 * "alive a few milliseconds after" is a race, and a rule held by one lucky run is not held.
 *
 * ## What it does not do
 *
 * It does not test the write bound (`a-write-the-bound-ended-never-lands-db` does) and does not say how long the
 * drain may take: only that it ends, and that it does not end quietly while something is alive.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-released-lock-leaves-no-live-write-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import { holdDocumentLock, holdCounterLock, settleWithin } from './_write-faults.mjs';
import { activeOperations, describeOperations, waitForLiveWrite } from './_active-operations.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const COLL = 'releaselive_items';
const SPACE = 'releaselive';
/** How many times each shape is run. */
const REPS = 8;
/** How long a write is stalled before its lock is released: past the point where the server's retry sleeps are at their longest. */
const STALLED_FOR_MS = 1500;
/** The drain's own limit for the case that must time out, so that case does not wait for the default. */
const SHORT_DRAIN_MS = 1500;

let mongo, items;

/** Each shape of lock, with the plain write that waits behind it. */
const SHAPES = [
  {
    name: 'an insert lock (holdDocumentLock { insert })',
    coll: COLL,
    seed: async () => {},
    lock: () => holdDocumentLock(mongo, COLL, { insert: { _id: 'locked-id', v: 'lock' } }),
    write: () => items.insertOne({ _id: 'locked-id', v: 'the write that waited' }),
  },
  {
    name: 'a filter lock (holdDocumentLock { filter })',
    coll: COLL,
    seed: async () => { await items.insertOne({ _id: 'locked-id', v: 'seed' }); },
    lock: () => holdDocumentLock(mongo, COLL, { filter: { _id: 'locked-id' } }),
    write: () => items.updateOne({ _id: 'locked-id' }, { $set: { v: 'the write that waited' } }),
  },
  {
    name: 'a counter lock (holdCounterLock)',
    coll: 'ythril_counters',
    seed: async () => { await mongo.col('ythril_counters').deleteMany({ _id: SPACE }); },
    lock: () => holdCounterLock(mongo, SPACE),
    write: () => mongo.col('ythril_counters').updateOne({ _id: SPACE }, { $inc: { seq: 1 } }),
  },
];

describe('a released lock leaves no live write', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('releaselive');
    items = mongo.col(COLL);
  });
  after(async () => { await closeTestMongo(); });
  beforeEach(async () => {
    await items.deleteMany({});
    await mongo.col('ythril_counters').deleteMany({ _id: SPACE });
  });

  it('the shapes are derived from one table and floored, so an empty table cannot pass', () => {
    assert.ok(SHAPES.length >= 3, `only ${SHAPES.length} lock shape(s) — the table is broken`);
    assert.ok(REPS >= 5 && STALLED_FOR_MS >= 1000, 'the repetition and the stall are what the rule is held at');
  });

  for (const shape of SHAPES) {
    it(`${shape.name}: release() resolves only once the server has no active operation on the collection`, { timeout: REPS * (STALLED_FOR_MS + 15_000) }, async () => {
      const aliveAfterRelease = [];
      for (let rep = 0; rep < REPS; rep++) {
        await items.deleteMany({});
        await shape.seed();
        const lock = await shape.lock();
        const waiting = shape.write().then(() => null, err => err);
        try {
          const stalled = await waitForLiveWrite(mongo, shape.coll);
          assert.ok(stalled, `fixture: the write behind the lock was never active on ${shape.coll} — the stall is not real, or currentOp does not see it`);
          await sleep(STALLED_FOR_MS);
        } finally {
          await lock.release();
        }
        const alive = await activeOperations(mongo, shape.coll);
        if (alive.length > 0) aliveAfterRelease.push(`#${rep}: ${describeOperations(alive)}`);
        const ended = await waiting;
        assert.equal(ended, null, `fixture: the write that waited behind the lock failed instead of landing: ${ended?.message}`);
      }
      assert.deepEqual(aliveAfterRelease, [],
        `release() resolved with a write still alive on ${shape.coll} in ${aliveAfterRelease.length} of ${REPS} repetitions — `
        + 'a caller that moves on then races it, and the write lands after the caller\'s next step');
    });
  }

  it('an insert lock holds the write behind it even when the collection does not exist yet', { timeout: REPS * 10_000 }, async () => {
    /*
     * A transaction that inserts into a collection that is not there creates it INSIDE the transaction, and what a
     * transaction created is invisible to every other session until it commits. The plain insert of the same id then
     * creates the collection itself and lands at once: the lock held nothing, and the case above that "proved" the stall by
     * seeing the write alive passed on how long that insert happened to take (found as `the write behind the lock was never
     * active` in a full -db batch: its first repetition runs in a database that was dropped on entry). The helper has to
     * make the collection exist before it locks.
     */
    const landedEarly = [];
    for (let rep = 0; rep < REPS; rep++) {
      await mongo.getDb().collection(COLL).drop().catch(() => {});
      const lock = await holdDocumentLock(mongo, COLL, { insert: { _id: 'locked-id', v: 'lock' } });
      const waiting = items.insertOne({ _id: 'locked-id', v: 'the write that waited' }).then(() => null, err => err);
      try {
        const early = await settleWithin(waiting, 700);
        if (early.settled) landedEarly.push(`#${rep}: answered after ${early.elapsedMs} ms with ${early.value ? early.value.message : 'a landed insert'}`);
      } finally {
        await lock.release();
      }
      assert.equal(await waiting, null, 'fixture: the write that waited behind the lock failed instead of landing');
    }
    assert.deepEqual(landedEarly, [],
      `the write behind an insert lock was answered while the lock was still held in ${landedEarly.length} of ${REPS} repetitions — `
      + 'the lock stalled nothing, so every case built on it that goes on to "release" it is checking a stall that was not there');
  });

  it('a release with nothing alive resolves at once, and releasing twice is safe', async () => {
    const lock = await holdDocumentLock(mongo, COLL, { insert: { _id: 'quiet', v: 'lock' } });
    const started = Date.now();
    await lock.release();
    await lock.release();
    assert.ok(Date.now() - started < 1000, `a release over a quiet collection took ${Date.now() - started} ms — the drain is a wait, not a check`);
    assert.deepEqual(await activeOperations(mongo, COLL), []);
  });

  it('a release that cannot drain THROWS, names the collection, and still lets the lock go', { timeout: 60_000 }, async () => {
    const a = await holdDocumentLock(mongo, COLL, { insert: { _id: 'lock-a', v: 'a' } });
    const b = await holdDocumentLock(mongo, COLL, { insert: { _id: 'lock-b', v: 'b' } });
    // A write that waits behind lock B and stays alive while A is released: the collection never goes quiet.
    const stuck = items.insertOne({ _id: 'lock-b', v: 'stuck' }).then(() => null, err => err);
    try {
      assert.ok(await waitForLiveWrite(mongo, COLL), 'fixture: the write behind lock B was never active');
      await assert.rejects(() => a.release({ drainMs: SHORT_DRAIN_MS }),
        err => err instanceof Error && err.message.includes(COLL),
        'release() returned while a write was still alive on the collection, instead of throwing — a caller cannot tell the stall ended');
      const free = await settleWithin(items.insertOne({ _id: 'lock-a', v: 'after the release' }), 5000);
      assert.ok(free.settled && free.ok, 'the lock was still held after release() threw — a throwing drain must release first, then complain');
    } finally {
      await b.release({ drainMs: 30_000 }).catch(() => {});
      await stuck;
    }
  });
});
