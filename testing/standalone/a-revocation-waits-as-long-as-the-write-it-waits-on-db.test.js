/**
 * A write that takes a claim away, or waits on one, is bounded no tighter than the write that holds it (bundle-44 D-29, Q-436,
 * ruling 13).
 *
 * ## The defect the fence would have introduced
 *
 * A run's write is a TRANSACTION that writes its job document (`writeUnderClaim`), and the transaction is bounded at the leased
 * figure: twice the write bound, because a conversion's write is the whole set of its rows. Everything that takes a claim away — a
 * delete's job cancel, a move's hold, a space wipe — writes that same document, so it waits for the transaction. Those writes run
 * inside a request's bound, which is the write bound itself: half the holder's. A revocation that arrives while a run is
 * committing therefore gave up before the run had to, and a delete, a move or a wipe failed with a store timeout for a write
 * that was merely slow.
 *
 * ## The rule
 *
 * Every write that revokes or waits on a claim (`cancelMediaJob`, `cancelJobsOwnedBy`, `cancelEveryJobOfSpace`, `holdJobsForMove`,
 * `extendMoveHold`, `releaseMoveHold`, `touchJobProgress`) is bounded as the holder is, INSIDE the module that revokes — and a
 * request's own, tighter scope does not lower it:
 *
 *  - with the holder's transaction parked inside its fence for longer than the write bound, each revoker waits and then LANDS once
 *    the holder commits: it is not a `StoreTimeout`;
 *  - the bound a revoker's write carries, read off the driver call, is never below the bound the holder's transaction was given,
 *    even when the revoker is called from inside a `withinWriteBound` scope with a small write bound.
 *
 * ## How
 *
 * The holder is `writeUnderClaim` with a latch the test holds, so its transaction has written the job document and not committed.
 * The write bound is set to a second (`setWriteBoundForTest`), so the holder's is two seconds and the time a plain write would give
 * up at is observable without a fixture of a minute. The revoker is started inside a `withinWriteBound`, as a request starts it,
 * and the test waits until the server reports its write ALIVE (`currentOp`) carrying a `maxTimeMS` above the write bound, which is the
 * proof the write waits past the figure a plain write would give up at, and only then releases the holder. No wall-clock threshold
 * decides the release (Q-873: a release at a wall-clock 1500 ms left the revoker about 400 ms of its own 2000 ms for the holder's
 * commit and the acknowledgement, and the case failed in CI's Full run 44163324512 at 2308.9 ms).
 *
 * A revoker's budget is the holder's PLUS `SERVER_FIRST_MARGIN_MS` (Q-873): a holder may end at its bound with its commit still racing
 * the server's deadline, and a revoker waiting on its row must outlive that whole transaction, not meet its end at the same instant.
 *
 * ## Seen red
 *
 * On e82caa5e the revoker carries the write bound (half the holder's) and a plain write gives up at it: every case that waits past it
 * is a `StoreTimeout` and the bound read off the driver is half the holder's.
 *
 * Run: node --test testing/standalone/a-revocation-waits-as-long-as-the-write-it-waits-on-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { activeOperations, waitForLiveWrite } from './_active-operations.mjs';
import { seedClaim, jobOf } from './_media-claim.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 's2bound';
/** The write bound of this suite, ms. The holder's transaction is given twice this. */
const WRITE_BOUND_MS = 1000;
/** The figure the holder's transaction is given (`leasedWriteBoundMs`: twice the write bound), ms. */
const HOLDER_BOUND_MS = 2 * WRITE_BOUND_MS;

let door, lease, queue, bound, client, realStart, sessionTimeouts;

/** Park a leased write INSIDE its transaction: the job document is written and held, the transaction has not committed. */
function holdInsideFence(claim) {
  let release;
  const gate = new Promise(r => { release = r; });
  let reachedResolve;
  const reached = new Promise(r => { reachedResolve = r; });
  const done = lease.writeUnderClaim(S, claim, async () => { reachedResolve(); await gate; return 'written'; });
  return { reached, release, done };
}

describe('a revocation waits as long as the write it waits on (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 's2bound', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    lease = await import('../../server/dist/files/media/lease.js');
    queue = await import('../../server/dist/files/media/job-queue.js');
    bound = await import('../../server/dist/db/write-bound.js');
    client = door.mongo.getMongo();
    // The figure the holder's transaction is given, read where it opens: what a waiter must not be bounded below.
    realStart = client.startSession;
    client.startSession = function startSession(opts, ...rest) {
      if (opts?.defaultTimeoutMS !== undefined) sessionTimeouts.push(opts.defaultTimeoutMS);
      return realStart.call(this, opts, ...rest);
    };
  });
  after(async () => {
    if (client && realStart) client.startSession = realStart;
    await door?.close();
  });
  beforeEach(async () => {
    sessionTimeouts = [];
    await door.coll(S, 'media_jobs').deleteMany({});
    bound.setWriteBoundForTest({ writeTimeoutMs: WRITE_BOUND_MS, holdDeadlineMs: 4 * WRITE_BOUND_MS });
  });
  afterEach(() => { bound.setWriteBoundForTest(null); });

  /**
   * Each revoker, as a request calls it (inside `withinWriteBound`), with what must be true after it landed.
   * `id` is the file the job belongs to.
   */
  const REVOKERS = {
    cancelMediaJob: { run: (id) => queue.cancelMediaJob(S, id), landed: async (id) => assert.equal(await jobOf(S, id), null, 'the job is still there') },
    cancelJobsOwnedBy: { run: (id) => queue.cancelJobsOwnedBy(S, `dir`, 'directory'), landed: async (id) => assert.equal(await jobOf(S, id), null, 'the job under the folder is still there'), file: 'dir/pic.png' },
    cancelEveryJobOfSpace: { run: () => queue.cancelEveryJobOfSpace(S), landed: async (id) => assert.equal(await jobOf(S, id), null, 'the space\'s job is still there') },
    holdJobsForMove: { run: (id) => queue.holdJobsForMove(S, id, 'file'), landed: async (id) => assert.equal((await jobOf(S, id))?.status, 'pending', 'the job was not held (handed back pending)') },
    touchJobProgress: { run: (id, claim) => queue.touchJobProgress(S, id, { step: 'caption', steps: ['caption'] }, claim.claimToken), landed: async (id) => assert.equal((await jobOf(S, id))?.progress?.step, 'caption', 'the heartbeat did not land') },
  };

  for (const [name, { run, landed, file }] of Object.entries(REVOKERS)) {
    it(`${name} waits for a holder parked past the write bound, then lands: it is not a store timeout`, async () => {
      const id = file ?? 'pic.png';
      const claim = await seedClaim(S, id);
      const holder = holdInsideFence(claim);
      // A holder left parked by a failed assertion would keep the job locked for the server's transaction lifetime: always let it go.
      try {
        await holder.reached;
        const revoking = bound.withinWriteBound(() => run(id, claim)).then(() => 'landed', (err) => err);
        assert.ok(await waitForLiveWrite(door.mongo, `${S}_media_jobs`, { startMs: 3000 }),
          `fixture: the ${name} write was never alive in the server, so the holder is not holding the job`);
        // The server's own account of the revoker's write: still alive after running longer than the write bound, so it is not bounded as
        // a plain write. This (`microsecs_running`, measured by the server; `currentOp` does not report an update's `maxTimeMS`), and no
        // wall-clock threshold of the test's, is when the holder is let go. The figure the write carries is asserted by the cases below.
        let lastSeen = [];
        await waitFor(async () => {
          const ops = await activeOperations(door.mongo, `${S}_media_jobs`);
          if (ops.length > 0) lastSeen = ops;
          return ops.some(o => o.microsecs_running > WRITE_BOUND_MS * 1000);
        }, 5000, 10, () => `the server last reported: ${JSON.stringify(lastSeen)}`,
        { what: `the ${name} write still alive in the server after running past the write bound of ${WRITE_BOUND_MS} ms` });
        holder.release();
        assert.equal(await holder.done, 'written');
        const outcome = await revoking;
        assert.equal(outcome, 'landed', `${name} gave up while the holder was still inside its bound: ${outcome?.name ?? outcome}`);
      } finally {
        holder.release();
        await holder.done.catch(() => {});
      }
      await landed(id);
    });
  }

  it('the bound a revoker\'s write carries is never below the one the holder\'s transaction was given, even inside a request\'s own scope', async () => {
    const claim = await seedClaim(S, 'pic.png');
    // What the driver is handed for the revoker's write: read where it is issued, from the scope the call runs in.
    // Both delete verbs: the cancel is one `$in` delete over its ids (`cancelMediaJobs`), and a revoker may issue either.
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const original = { deleteOne: proto.deleteOne, deleteMany: proto.deleteMany };
    let carried;
    for (const verb of ['deleteOne', 'deleteMany']) {
      proto[verb] = function spy(...args) {
        if (this.collectionName === `${S}_media_jobs`) carried = bound.boundOperationMs();
        return original[verb].apply(this, args);
      };
    }
    try {
      await lease.writeUnderClaim(S, claim, async () => 'written');
      const holderBound = Math.max(...sessionTimeouts);
      await bound.withinWriteBound(() => queue.cancelMediaJob(S, 'pic.png'));
      assert.ok(carried !== undefined, 'fixture: the revoker\'s write carried no bound at all');
      assert.ok(carried >= holderBound,
        `the revoker's write is bounded at ${carried} ms inside a request, below the ${holderBound} ms the holder's transaction was given: it can give up before the run must`);
    } finally { Object.assign(proto, original); }
  });

  /**
   * The budget each revoker's write carries, read where the driver is handed it (no clock). A holder may end at its bound with its commit
   * still racing the server's deadline (`SERVER_FIRST_MARGIN_MS`), so a revoker waiting on its row is given the holder's whole bound and
   * the margin: it outlives the holder's transaction instead of meeting its end.
   */
  for (const [name, { run, file }] of Object.entries(REVOKERS)) {
    it(`${name}'s write carries a budget of at least the holder's bound plus the server-first margin`, async () => {
      const id = file ?? 'pic.png';
      const claim = await seedClaim(S, id);
      const proto = Object.getPrototypeOf(door.mongo.col('probe'));
      const original = { updateOne: proto.updateOne, updateMany: proto.updateMany, deleteMany: proto.deleteMany };
      /** Where each verb takes its options: an update after the filter and the update, a delete after the filter. */
      const optionsAt = { updateOne: 2, updateMany: 2, deleteMany: 1 };
      const carried = [];
      for (const verb of Object.keys(optionsAt)) {
        proto[verb] = function spy(...args) {
          if (this.collectionName === `${S}_media_jobs`) carried.push({ verb, scopeMs: bound.boundOperationMs(), maxTimeMS: args[optionsAt[verb]]?.maxTimeMS });
          return original[verb].apply(this, args);
        };
      }
      try { await bound.withinWriteBound(() => run(id, claim)); } finally { Object.assign(proto, original); }
      assert.ok(carried.length > 0, `fixture: the ${name} issued no write on the job collection the spy watches`);
      const floor = HOLDER_BOUND_MS + bound.SERVER_FIRST_MARGIN_MS;
      for (const c of carried) {
        assert.ok(c.scopeMs >= floor, `${name}'s ${c.verb} is allowed ${c.scopeMs} ms, below the holder's ${HOLDER_BOUND_MS} ms plus the ${bound.SERVER_FIRST_MARGIN_MS} ms margin: it can give up while the holder's commit is still racing its deadline`);
        assert.ok(c.maxTimeMS > HOLDER_BOUND_MS, `${name}'s ${c.verb} carries maxTimeMS ${c.maxTimeMS}, not above the ${HOLDER_BOUND_MS} ms the holder's transaction is given`);
      }
    });
  }

  it('a write that applied and whose acknowledgement the server cut at its deadline (write concern, code 50) is a StoreTimeout with that error as its cause, and the job landed', async () => {
    const { MongoWriteConcernError } = await import('mongodb');
    const claim = await seedClaim(S, 'pic.png');
    const thrown = new MongoWriteConcernError({ writeConcernError: { code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'operation exceeded time limit' } });
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const original = proto.updateMany;
    // The write is applied, and only then answered as the acknowledgement's deadline: what a majority wait cut at maxTimeMS looks like.
    proto.updateMany = async function appliedThenCut(...args) {
      const result = await original.apply(this, args);
      if (this.collectionName === `${S}_media_jobs`) throw thrown;
      return result;
    };
    let outcome;
    try {
      outcome = await bound.withinWriteBound(() => queue.holdJobsForMove(S, claim.jobId, 'file')).then(() => 'landed', (err) => err);
    } finally { proto.updateMany = original; }
    assert.equal(outcome?.name, 'StoreTimeout', `the cut acknowledgement was answered ${outcome?.name ?? outcome}, not StoreTimeout`);
    assert.equal(outcome.cause, thrown, 'the StoreTimeout does not carry the driver\'s write-concern error as its cause');
    const job = await jobOf(S, claim.jobId);
    assert.equal(job?.status, 'pending', 'the write applied, so the job is handed back pending although the caller was told it timed out');
    assert.equal(job?.claimToken, null, 'the claim was not taken away');
  });
});
