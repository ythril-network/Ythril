/**
 * A path written again and again settles into ONE run, claimable only after the last write has had its settle delay, and never
 * before the hold of a move that is running at it (bundle-236, Q-698, DESIGN v3 items 1(b), C2 and C18).
 *
 * ## The defect that bought it
 *
 * `enqueueMediaJob` resets a terminal job with `claimableAfter: null`, so the worker may take the job the instant the write returns. A
 * path that is written continuously (an editor saving, a sync client re-sending) then costs a whole run, caption included, for every
 * write: a spent model call per write, each superseded by the next. And a write at a path whose move is running reset the job of
 * a file the move is carrying, with no hold, so a worker claimed it at the old path in the middle of the move (`retryJob` asks
 * `moveIsRunningAt` for this reason; the write door never did).
 *
 * ## The rules
 *
 *  1. A new-bytes write onto a terminal job leaves it `pending` and NOT claimable at once: `claimableAfter` is at or after the write
 *     plus a settle delay, so a claim made straight after the write finds nothing.
 *  2. Two new-bytes writes within the settle delay give ONE pending job (one document), and its `claimableAfter` is at or after the
 *     SECOND write, later than the first write left it.
 *  3. A new-bytes write onto a terminal job while a move is running at the path leaves the job unclaimable until the move's hold
 *     is over: `claimableAfter` is at or after the write plus `moveTiming().holdMs`.
 *
 * ## Seen red
 *
 * On abe1bde3b all three fail: the reset writes `claimableAfter: null`, so the job is claimable at once and a claim straight after the
 * write takes it.
 *
 * Run: node --test testing/standalone/a-path-written-again-within-the-settle-delay-is-one-run-and-keeps-a-moves-hold-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openReplacedBytesDoor } from './_replaced-bytes-door.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const SPACE = 'settledrun';
const FILE = 'draft.png';
const BYTES = (n) => `the bytes of version ${n} of the picture`;

let d;
const jobNow = () => d.jobs().findOne({ _id: FILE });
const claimableAt = (job) => (job?.claimableAfter ? Date.parse(job.claimableAfter) : null);

/** A first version written and its run ended: the terminal job a later write resets. */
async function finishedFirstVersion() {
  await d.put(FILE, BYTES(1));
  await d.settle(FILE, 'complete');
  assert.equal((await jobNow()).status, 'complete', 'fixture check');
}

describe('a path written again settles into one run, and a move\'s hold is kept (real MongoDB)', { skip }, () => {
  before(async () => { d = await openReplacedBytesDoor({ suite: 'settledrun', space: SPACE }); });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); });

  it('new bytes onto a finished job leave it pending and not claimable straight after the write', async () => {
    await finishedFirstVersion();
    const before = Date.now();
    await d.put(FILE, BYTES(2));

    const job = await jobNow();
    assert.equal(job.status, 'pending');
    assert.ok(claimableAt(job) !== null && claimableAt(job) > before,
      `claimableAfter is ${JSON.stringify(job.claimableAfter)}: the job is claimable at once, so every write of a rewritten path costs a whole run`);
    d.queue.markSpaceMayHaveWork(SPACE);
    assert.equal(await d.queue.claimNextJob([SPACE]), null, 'a worker claimed the job straight after the write');
  });

  it('two new-bytes writes within the delay give one pending job whose claimableAfter is after the second write', async () => {
    await finishedFirstVersion();
    await d.put(FILE, BYTES(2));
    const afterFirst = claimableAt(await jobNow());
    await elapse(25, 'timestamps differ: the second write must fall later than the first by more than the clock\'s tick');
    const secondAt = Date.now();
    await d.put(FILE, BYTES(3));

    assert.equal(await d.jobs().countDocuments({ _id: FILE }), 1, 'a write made a second job document for the path');
    const job = await jobNow();
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.ok(afterFirst !== null, 'the first write left no wait at all');
    assert.ok(claimableAt(job) !== null && claimableAt(job) >= secondAt && claimableAt(job) > afterFirst,
      `claimableAfter is ${JSON.stringify(job.claimableAfter)}, not after the second write (${new Date(secondAt).toISOString()}) and later than the first left it: the run starts inside the burst`);
  });

  it('a new-bytes write onto a finished job while a move runs at the path keeps the job unclaimable until the move\'s hold is over', async () => {
    await finishedFirstVersion();
    const hold = d.moveTiming().holdMs;
    assert.ok(hold > 0, 'fixture check: the move hold is a wait');
    let before;
    await d.moveFlight.runMoveOnce(SPACE, FILE, `moved/${FILE}`, async () => {
      assert.equal(d.moveFlight.moveIsRunningAt(SPACE, FILE), true, 'fixture check: the move is running at the path');
      before = Date.now();
      await d.put(FILE, BYTES(2));
    });

    const job = await jobNow();
    assert.equal(job.status, 'pending');
    assert.ok(claimableAt(job) !== null && claimableAt(job) >= before + hold,
      `claimableAfter is ${JSON.stringify(job.claimableAfter)}, short of the move's hold (${hold} ms): a worker claims the job at the OLD path in the middle of the move`);
  });
});
