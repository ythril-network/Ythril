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
 * and the test waits until the server reports its write ALIVE (`currentOp`) and the write bound has passed before it releases the
 * holder.
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
import { waitForLiveWrite } from './_active-operations.mjs';
import { seedClaim, jobOf } from './_media-claim.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 's2bound';
/** The write bound of this suite, ms. The holder's transaction is given twice this. */
const WRITE_BOUND_MS = 1000;

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
        const startedAt = Date.now();
        const revoking = bound.withinWriteBound(() => run(id, claim)).then(() => 'landed', (err) => err);
        assert.ok(await waitForLiveWrite(door.mongo, `${S}_media_jobs`, { startMs: 3000 }),
          `fixture: the ${name} write was never alive in the server, so the holder is not holding the job`);
        // Past the write bound: a revoker bounded as a plain write would have given up by now.
        await waitFor(() => Date.now() - startedAt > WRITE_BOUND_MS + 500, 5000, 50, 'the write bound passing');
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
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const original = proto.deleteOne;
    let carried;
    proto.deleteOne = function spy(...args) {
      if (this.collectionName === `${S}_media_jobs`) carried = bound.boundOperationMs();
      return original.apply(this, args);
    };
    try {
      await lease.writeUnderClaim(S, claim, async () => 'written');
      const holderBound = Math.max(...sessionTimeouts);
      await bound.withinWriteBound(() => queue.cancelMediaJob(S, 'pic.png'));
      assert.ok(carried !== undefined, 'fixture: the revoker\'s write carried no bound at all');
      assert.ok(carried >= holderBound,
        `the revoker's write is bounded at ${carried} ms inside a request, below the ${holderBound} ms the holder's transaction was given: it can give up before the run must`);
    } finally { proto.deleteOne = original; }
  });
});
