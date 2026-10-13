/**
 * A transaction is ended by the write bound, holds no seq horizon of its own, and ends its session — whoever starts it
 * (bundle-44 plan rev 3, D2: `db/bounded-transaction.ts`, `inBoundedTransaction`).
 *
 * ## The defect
 *
 * Two places started a MongoDB session by hand, and a third was about to. `brain/held-transaction.ts` did it correctly,
 * under a seq hold, with a bound (bundle-30, `Q-213`). `files/media/lease.ts` `writeUnderClaim` did it with NO bound
 * (`getMongo().startSession()`, then `withTransaction`): a document lock held elsewhere (the job row being fenced, a
 * record the writes touch) makes `withTransaction` retry the write conflict for the driver's default 120 s, and the
 * media worker, the move and every other caller of the fence waits that long. The bound, the read-back of a commit
 * whose reply was lost, the `endSession` in a `finally` and the one-batch read are the forgettable half of a
 * transaction, and each hand-written start dropped a different one of them.
 *
 * ## The rule this file holds
 *
 * **A transaction started through `inBoundedTransaction` (`db/bounded-transaction.ts`) —**
 *
 *  - **holds NO seq horizon.** The bound and the horizon are two questions. `inHeldTransaction` is the horizon hold put
 *    around it (`withSeqHorizonHeld(() => inBoundedTransaction(…))`); a transaction that writes no seq-carrying
 *    document (the lease fence) must not stall every seq-paged reader of a space for as long as it runs;
 *  - **is ended by the write bound** when a document lock is held elsewhere — within the bound, never after the
 *    driver's 120 s — and nothing it wrote lands;
 *  - **answers a lost commit reply as landed** when `landed` says so, and as the error it came as when it does not;
 *  - **ends its session even when the callback throws**;
 *  - **reads past one batch** inside the transaction (`db/write-bound.ts` asks a timed transaction's cursor for all of
 *    its rows in the first batch, the driver refusing `maxTimeMS` on a `getMore` otherwise).
 *
 * **and `writeUnderClaim` (`files/media/lease.ts`) is such a transaction**: the same bound rows, asked of it. A lock
 * held on its job row ends it within the write bound, and what it would have written does not land.
 *
 * ## Which rows are red today, and why
 *
 * The `inBoundedTransaction` rows fail on the module that does not exist yet (`server/dist/db/bounded-transaction.js`):
 * each reports that, so the design's D2 is the reason, not a typo in a fixture. The `writeUnderClaim` rows that ask for
 * the bound fail on UNCHANGED code for the reason the plan gives (F12): the call waits for the lock for as long as the
 * lock lives. The rows marked "control" pass today and must keep passing — they are what shows the red ones are red
 * for the bound and not for the fixture.
 *
 * ## The stall is REAL (`_write-faults.mjs`)
 *
 * `holdDocumentLock` leaves another session's transaction open on a document; a write inside a transaction then fails
 * with `WriteConflict` and is retried by `withTransaction` for as long as ITS budget lasts — the only stall a driver
 * bound can end (a parked promise never reaches the driver).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-bounded-transaction-ends-and-holds-no-horizon-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { holdDocumentLock, settleWithin, setWriteBoundForTest, loseNextCommitReply } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bounded-txn-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const S = 'boundedtxn';
const FACTS = `${S}_facts`;
const JOBS = `${S}_media_jobs`;
/** The write bound a stalled case waits out, and how long past it a bounded call may take to be reported ended (generous: the rule is 2 s against the driver's 120 s). */
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
const SLACK_MS = 3000;
const CAP_MS = BOUND.holdDeadlineMs + SLACK_MS;
/** Comfortably past the default first batch (101), far below 16 MB. */
const ROWS = 1_200;
const JOB = 'job-1';
const CLAIM = { jobId: JOB, claimToken: 'token-1' };

let mongo, seq, writeBound, lease, held;
/** The module the design creates — loaded in `before`, so a missing one fails EACH row with its own message. */
let bounded = null;
let boundedError = null;

/** The entry point, or a failure that says why every `inBoundedTransaction` row is red. */
function inBounded() {
  if (bounded) return bounded.inBoundedTransaction;
  throw new Error('server/dist/db/bounded-transaction.js exports no inBoundedTransaction — the bounded transaction (plan rev 3, D2) '
    + `does not exist yet (${boundedError?.message ?? 'no export'}), so nothing can be asked of it`);
}

const facts = () => mongo.col(FACTS);

describe('a bounded transaction ends, holds no horizon, and ends its session', { skip }, () => {
  let restoreBound = () => {};

  before(async () => {
    mongo = await openTestMongo('boundedtxn');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'bounded-txn-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Bounded transaction', folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    seq = await import('../../server/dist/util/seq.js');
    writeBound = await import('../../server/dist/db/write-bound.js');
    lease = await import('../../server/dist/files/media/lease.js');
    held = await import('../../server/dist/brain/held-transaction.js');
    try {
      bounded = await import('../../server/dist/db/bounded-transaction.js');
      if (typeof bounded.inBoundedTransaction !== 'function') { boundedError = new Error('the module has no inBoundedTransaction export'); bounded = null; }
    } catch (err) { boundedError = err; }
    restoreBound = await setWriteBoundForTest(BOUND);
    await facts().insertMany(Array.from({ length: ROWS }, (_, i) => ({
      _id: `f-${String(i).padStart(5, '0')}`, spaceId: S, fact: `fact ${i}`, seq: i + 1,
    })));
    await mongo.col(JOBS).insertOne({ _id: JOB, spaceId: S, status: 'processing', claimToken: CLAIM.claimToken, fencedWrites: 0 });
  });
  after(async () => {
    restoreBound();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── inBoundedTransaction: no horizon ───────────────────────────────────────────────────────────────────────

  it('control: inHeldTransaction DOES hold the space\'s seq horizon while it runs (what the test below is the opposite of)', async () => {
    const inside = await held.inHeldTransaction(S, 'test.bounded-txn.control', async () => seq.lowestUncommittedSeq(S));
    assert.notEqual(inside, undefined, 'fixture: inHeldTransaction held no horizon, so "holds none" below proves nothing');
  });

  it('holds NO seq horizon: no space\'s seq-paged reader is stalled while it runs', async () => {
    const inside = await inBounded()(async (session) => {
      await facts().findOne({ _id: 'f-00000' }, { session });
      return seq.lowestUncommittedSeq(S);
    });
    assert.equal(inside, undefined,
      `a bounded transaction registered a seq hold at ${inside} on '${S}': every seq-paged reader of the space (the pull routes, `
      + 'the push loop, the tombstone pages) would be served nothing above it for as long as the transaction lives');
  });

  it('holds no horizon while it is STALLED on a lock either, and is still ended by the bound', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00001' } });
    let entered = false;
    let horizonWhileStalled = 'not read';
    let res;
    try {
      const op = Promise.resolve().then(() => run(async (session) => {
        entered = true;
        await facts().updateOne({ _id: 'f-00001' }, { $set: { stalledEdit: true } }, { session });
      }));
      const reached = Date.now() + 5000;
      while (!entered && Date.now() < reached) await new Promise(r => setTimeout(r, 10));
      horizonWhileStalled = seq.lowestUncommittedSeq(S);
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(entered, 'fixture: the transaction never started its callback');
    assert.equal(horizonWhileStalled, undefined, `the stalled transaction held the horizon of '${S}' at ${horizonWhileStalled}`);
  });

  // ── inBoundedTransaction: the bound ────────────────────────────────────────────────────────────────────────

  it('a document lock held elsewhere ends it within the write bound, and what it wrote does not land', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00002' } });
    let res;
    try {
      const op = Promise.resolve().then(() => run(
        async (session) => facts().updateOne({ _id: 'f-00002' }, { $set: { boundedEdit: true } }, { session })));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled,
      `the transaction was still waiting ${res.elapsedMs} ms after it began against a ${BOUND.writeTimeoutMs} ms write bound: `
      + 'withTransaction kept retrying the write conflict, so a document lock held elsewhere stalls its caller for the driver\'s 120 s');
    assert.equal(res.ok, false, 'a transaction the bound ended was answered as a success');
    assert.equal((await facts().findOne({ _id: 'f-00002' }))?.boundedEdit, undefined, 'a transaction the bound ended landed its write');
  });

  it('inside an enclosing bound scope it ends at that scope\'s deadline, not at the per-operation figure', { timeout: 30_000 }, async () => {
    // The scope's deadline is the shorter of the two: the transaction takes its budget from the ACTIVE bound, as a
    // hold's transaction always did, and not from a figure of its own.
    const run = inBounded();
    const restore = await setWriteBoundForTest({ writeTimeoutMs: 10_000, holdDeadlineMs: BOUND.holdDeadlineMs });
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00003' } });
    let res;
    try {
      const op = Promise.resolve().then(() => writeBound.withinWriteBound(() => run(
        async (session) => facts().updateOne({ _id: 'f-00003' }, { $set: { boundedEdit: true } }, { session }))));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
      restore();
      restoreBound = await setWriteBoundForTest(BOUND);
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled && res.ok === false,
      `inside a ${BOUND.holdDeadlineMs} ms hold deadline the transaction ${res.settled ? 'was answered as a success' : `was still waiting ${res.elapsedMs} ms later`}`);
  });

  // ── inBoundedTransaction: the commit whose reply is lost ───────────────────────────────────────────────────

  it('a commit that landed and was reported failed is answered as landed when `landed` says so', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lost = await loseNextCommitReply(mongo);
    const asked = [];
    let outcome;
    try {
      outcome = await Promise.resolve().then(() => run(
        async (session) => { await facts().updateOne({ _id: 'f-00004' }, { $set: { landedEdit: 'yes' } }, { session }); return 'the value'; },
        { landed: async (value) => { asked.push(value); return (await facts().findOne({ _id: 'f-00004' }))?.landedEdit === 'yes'; } },
      )).then(value => ({ value }), error => ({ error }));
    } finally {
      lost.restore();
    }
    assert.ok(lost.fired(), 'fixture: no commit was made, so no reply was lost');
    assert.equal((await facts().findOne({ _id: 'f-00004' }))?.landedEdit, 'yes', 'fixture: the commit did not land');
    assert.equal(outcome.error, undefined, `a transaction that LANDED was answered as failed (${outcome.error?.message})`);
    assert.equal(outcome.value, 'the value', 'the transaction\'s own value was not returned');
    assert.deepEqual(asked, ['the value'], '`landed` is asked once, with what the callback returned');
  });

  it('a commit that failed is thrown as it came when `landed` says it did not land', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lost = await loseNextCommitReply(mongo);
    let outcome;
    try {
      outcome = await Promise.resolve().then(() => run(
        async (session) => { await facts().updateOne({ _id: 'f-00005' }, { $set: { landedEdit: 'yes' } }, { session }); return 1; },
        { landed: async () => false },
      )).then(value => ({ value }), error => ({ error }));
    } finally {
      lost.restore();
    }
    assert.ok(lost.fired(), 'fixture: no commit was made, so no reply was lost');
    assert.equal(outcome.value, undefined, 'a commit the caller\'s read-back denied was answered as landed');
    assert.equal(outcome.error?.codeName, 'MaxTimeMSExpired', `the commit error was not rethrown as it came (${outcome.error?.message})`);
  });

  it('without `landed`, a failed commit is thrown as it came', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lost = await loseNextCommitReply(mongo);
    let outcome;
    try {
      outcome = await Promise.resolve().then(() => run(
        async (session) => { await facts().updateOne({ _id: 'f-00006' }, { $set: { landedEdit: 'yes' } }, { session }); return 1; },
      )).then(value => ({ value }), error => ({ error }));
    } finally {
      lost.restore();
    }
    assert.ok(lost.fired(), 'fixture: no commit was made, so no reply was lost');
    assert.equal(outcome.error?.codeName, 'MaxTimeMSExpired', `a failed commit was swallowed or reworded (${outcome.error?.message ?? 'answered ok'})`);
  });

  // ── inBoundedTransaction: the session ends ─────────────────────────────────────────────────────────────────

  it('ends its session when the callback throws, and rethrows what it threw without asking `landed`', async () => {
    const run = inBounded();
    let session;
    let landedAsked = false;
    const boom = new Error('the callback failed');
    await assert.rejects(Promise.resolve().then(() => run(
      async (s) => { session = s; throw boom; },
      { landed: async () => { landedAsked = true; return true; } },
    )), (err) => err === boom, 'the callback\'s error was replaced or swallowed');
    assert.ok(session, 'fixture: the callback was never handed a session');
    assert.equal(session.hasEnded, true, 'the session was left open after the callback threw: a leaked session holds its server resources and its locks');
    assert.equal(landedAsked, false, '`landed` is for a failed COMMIT; it was asked about a callback that threw');
  });

  it('ends its session when the transaction succeeds', async () => {
    let session;
    await inBounded()(async (s) => { session = s; await facts().findOne({ _id: 'f-00007' }, { session: s }); });
    assert.equal(session?.hasEnded, true, 'the session was left open after the transaction committed');
  });

  it('ends its session when the bound ended the transaction', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00008' } });
    let session;
    let res;
    try {
      const op = Promise.resolve().then(() => run(
        async (s) => { session = s; return facts().updateOne({ _id: 'f-00008' }, { $set: { boundedEdit: true } }, { session: s }); }));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled, `fixture: the bound did not end the transaction in ${CAP_MS} ms`);
    assert.equal(session?.hasEnded, true, 'the session was left open after the bound ended the transaction');
  });

  // ── inBoundedTransaction: reads ────────────────────────────────────────────────────────────────────────────

  it('a find of more rows than one default batch completes inside it', async () => {
    const ids = await inBounded()(async (session) =>
      (await facts().find({ spaceId: S }, { session, projection: { _id: 1 } }).toArray()).map(d => d._id));
    assert.equal(ids.length, ROWS, `the transaction read ${ids.length} of ${ROWS} rows`);
  });

  it('an aggregate of more rows than one default batch completes inside it', async () => {
    const n = await inBounded()(async (session) =>
      (await facts().aggregate([{ $match: { spaceId: S } }, { $project: { _id: 1 } }], { session }).toArray()).length);
    assert.equal(n, ROWS, `the transaction aggregated ${n} of ${ROWS} rows`);
  });

  // ── writeUnderClaim (files/media/lease.ts): the same bound ─────────────────────────────────────────────────

  it('control: writeUnderClaim fences the claim and lands its writes when nothing is locked', async () => {
    const fencedBefore = (await mongo.col(JOBS).findOne({ _id: JOB })).fencedWrites;
    const value = await lease.writeUnderClaim(S, CLAIM, async (session) => {
      await facts().insertOne({ _id: 'lease-control', spaceId: S, fact: 'written under the claim', seq: ROWS + 1 }, { session });
      return 'done';
    });
    assert.equal(value, 'done');
    assert.ok(await facts().findOne({ _id: 'lease-control' }), 'the writes under a held claim did not land');
    assert.equal((await mongo.col(JOBS).findOne({ _id: JOB })).fencedWrites, fencedBefore + 1, 'the fence was not written');
  });

  it('control: writeUnderClaim answers a claim that is gone with JobLeaseLostError and writes nothing', async () => {
    await assert.rejects(lease.writeUnderClaim(S, { jobId: JOB, claimToken: 'someone-elses' }, async (session) => {
      await facts().insertOne({ _id: 'lease-lost', spaceId: S, fact: 'must not land', seq: ROWS + 2 }, { session });
    }), (err) => lease.isLeaseLost(err));
    assert.equal(await facts().findOne({ _id: 'lease-lost' }), null, 'a run that lost its claim wrote its results');
  });

  it('writeUnderClaim: a lock held on its job row ends it within the write bound, and what it would have written does not land', { timeout: 30_000 }, async () => {
    const lock = await holdDocumentLock(mongo, JOBS, { filter: { _id: JOB } });
    let res;
    try {
      const op = Promise.resolve().then(() => lease.writeUnderClaim(S, CLAIM, async (session) => {
        await facts().insertOne({ _id: 'lease-bounded', spaceId: S, fact: 'must not land', seq: ROWS + 3 }, { session });
      }));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled,
      `writeUnderClaim was still waiting ${res.elapsedMs} ms after it began against a ${BOUND.writeTimeoutMs} ms write bound: it starts `
      + 'its session with no bound, so withTransaction retries the lock\'s write conflict for the driver\'s 120 s (plan F12)');
    assert.equal(res.ok, false, 'a fenced write the bound ended was answered as a success');
    assert.equal(await facts().findOne({ _id: 'lease-bounded' }), null, 'a fenced write the bound ended landed its results');
  });

  it('writeUnderClaim: a lock held on a record its writes touch ends it within the write bound too', { timeout: 30_000 }, async () => {
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00009' } });
    let res;
    try {
      const op = Promise.resolve().then(() => lease.writeUnderClaim(S, CLAIM, async (session) => {
        await facts().updateOne({ _id: 'f-00009' }, { $set: { claimedEdit: true } }, { session });
      }));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled, `writeUnderClaim was still waiting ${res.elapsedMs} ms after it began, on a record lock, against a ${BOUND.writeTimeoutMs} ms write bound`);
    assert.equal(res.ok, false, 'a write the bound ended was answered as a success');
    assert.equal((await facts().findOne({ _id: 'f-00009' }))?.claimedEdit, undefined, 'a write the bound ended landed');
  });

  it('writeUnderClaim: ends its session whether its writes succeed or throw', async () => {
    let ok, threw;
    await lease.writeUnderClaim(S, CLAIM, async (s) => { ok = s; });
    await assert.rejects(lease.writeUnderClaim(S, CLAIM, async (s) => { threw = s; throw new Error('writes failed'); }), /writes failed/);
    assert.equal(ok?.hasEnded, true, 'the session was left open after a fenced write committed');
    assert.equal(threw?.hasEnded, true, 'the session was left open after a fenced write threw');
  });

  it('writeUnderClaim: a read of more rows than one default batch completes inside it', async () => {
    const n = await lease.writeUnderClaim(S, CLAIM, async (session) =>
      (await facts().find({ spaceId: S }, { session, projection: { _id: 1 } }).toArray()).length);
    assert.ok(n >= ROWS, `the fenced transaction read ${n} of at least ${ROWS} rows`);
  });
});
