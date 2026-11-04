/**
 * A text embed job becomes claimable only AFTER its file row reads `pending` (release 6.3.2, PR #1578's CI flake).
 *
 * ## What goes wrong in the other order
 *
 * `enqueueTextJob` used to make the job claimable, wake the worker, and only then write `embeddingStatus: 'pending'` on the
 * file row. A worker fast enough to claim the job, mark the row `processing` and finish (or fail) inside that gap was
 * overwritten by the late `pending`: on a healthy embedder a FINISHED file read `pending` for ever, because the job was
 * `complete` and nothing revisits a terminal job. `retryJob` and `retryFailedJobs` had the same order. The media branch has it
 * right already (`dispatch.ts` marks the row, then enqueues).
 *
 * (bundle-236, Q-698) `enqueueTextJob` was folded into `replaceContent`, the write door's call for media and documents, which writes
 * the JOB first and the row after it; the job is then not claimable for `REPLACE_SETTLE_MS`, and that wait, not the order of the two
 * writes, is what keeps a worker out of the gap (`retryJob` does the same). The worker of these cases therefore claims once the wait is
 * over (`workerRun` makes the job claimable, as the passing of the settle delay does); a claim made INSIDE the gap finds nothing.
 *
 * ## How the gap is made a thing a test waits for
 *
 * The gap is a fact of ORDER, so the row's `pending` write is PARKED, before it reaches the store, on a latch the test holds
 * (`_parked-driver-call.mjs`), and the test reads what the worker could see while it is parked. Nothing is slept on and the
 * real store answers every other write:
 *
 *  1. **Nothing is announced while the row's mark is outstanding.** With the mark parked, the work-signal epoch must not have
 *     moved (the worker is not woken), and no claim finds the job. On the old order the job is pending and the wake has fired
 *     before the row write is even reached. This holds for each of the three writers.
 *  2. **The late mark cannot overwrite a finished job** (`replaceContent`, once `enqueueTextJob`): when the worker did get in (old order) it claims,
 *     marks `processing` and completes inside the gap; when it did not (new order) it does so after the enqueue settles. Either
 *     way, once the enqueue has returned, the row reads what the worker left, `complete`, not `pending`.
 *  3. **The same, with a retryable failure**: the worker claims, marks `processing` and fails with retries left; once the
 *     enqueue has settled the row reads `processing`, which is what a worker that is mid-retry leaves it as.
 *
 * ## Seen red
 *
 * On 213dac05d cases 1 (all three writers) and 2 and 3 fail deterministically: the park holds the row write while the job is
 * already claimable. (The unparked race itself is timing-dependent and only sometimes fails; the park makes it a certainty.)
 *
 * Run: node --test testing/standalone/a-text-job-is-claimable-only-after-its-file-row-reads-pending-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { parkDriverCall } from './_parked-driver-call.mjs';

const skip = await mongoSkipReason();

const SPACE = 'pendingfirst';
const FILE = 'docs/note.md';
const NOW = new Date().toISOString();
const MAX = 3;

let mongo, queue, derived, park;
const jobs = () => mongo.col(`${SPACE}_media_jobs`);
const files = () => mongo.col(`${SPACE}_files`);
const rowStatus = async () => (await files().findOne({ _id: FILE }))?.embeddingStatus;

/** A file row at rest: what a text file reads before it is (re)queued. */
async function seedRow(embeddingStatus) {
  await files().insertOne({ _id: FILE, path: FILE, type: 'file', name: 'note.md', embeddingStatus, createdAt: NOW, updatedAt: NOW, seq: 1 });
}

/** A job that ended `failed`: what `retryJob` and `retryFailedJobs` reset. */
async function failedJob() {
  await jobs().insertOne({
    _id: FILE, spaceId: SPACE, filePath: FILE, mimeType: 'text/markdown', mediaType: 'text', resolvedFormat: 'markdown',
    status: 'failed', attempts: MAX, maxAttempts: MAX, lastError: 'gave up', claimedAt: null, createdAt: NOW, updatedAt: NOW,
  });
}

/** The write door's call for new document bytes at the path (what `enqueueTextJob` was). */
const replaceTheText = () => queue.replaceContent(SPACE, FILE, {
  mimeType: 'text/markdown', mediaType: 'text', resolvedFormat: 'markdown', sha256: 'a'.repeat(64), arrival: false,
});

/** Park the row's `pending` mark before it reaches the store; the write of any other state passes. */
const parkThePendingMark = () => parkDriverCall(mongo, SPACE, 'files', 'updateMany',
  (_filter, update) => update?.$set?.embeddingStatus === 'pending', { before: true });

/** What a worker does with one claimed job: claim it, mark the row `processing`, and `end` it. */
async function workerRun(end) {
  // The settle delay is over (the writers hold the job unclaimable for `REPLACE_SETTLE_MS` after they write it).
  await jobs().updateOne({ _id: FILE }, { $set: { claimableAfter: null } });
  queue.markSpaceMayHaveWork(SPACE);
  const job = await queue.claimNextJob([SPACE]);
  assert.ok(job, 'the worker found no claimable job');
  const claim = { jobId: job._id, claimToken: job.claimToken };
  await derived.markFileProcessing(SPACE, claim, { embeddingStatus: 'processing' });
  await end(claim, job);
}

describe('a text job is claimable only after its file row reads pending (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('pendingfirst');
    queue = await import('../../server/dist/files/media/job-queue.js');
    derived = await import('../../server/dist/files/derived-fields.js');
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => { await jobs().deleteMany({}); await files().deleteMany({}); });

  afterEach(() => { park?.restore(); park = undefined; });

  const WRITERS = {
    replaceContent: { arrange: () => seedRow('complete'), run: () => replaceTheText() },
    retryJob: { arrange: async () => { await seedRow('failed'); await failedJob(); }, run: () => queue.retryJob(SPACE, FILE) },
    retryFailedJobs: { arrange: async () => { await seedRow('failed'); await failedJob(); }, run: () => queue.retryFailedJobs(SPACE) },
  };

  for (const [name, w] of Object.entries(WRITERS)) {
    it(`${name}: while the row's pending mark is outstanding the worker is not woken and finds no job`, async () => {
      await w.arrange();
      const epoch = queue.currentWorkEpoch();
      park = parkThePendingMark();
      const done = w.run();
      await park.reached;
      const woken = await queue.waitForWork(300, epoch);
      const claimed = await queue.claimNextJob([SPACE]);
      const rowThen = await rowStatus();
      park.release();
      await done;
      assert.equal(woken, false, 'the worker was woken before the file row was marked pending: it can claim, mark the row processing and finish, and the late mark overwrites it');
      assert.equal(claimed, null, `a worker claimed the job (${claimed?._id}) before the file row was marked pending`);
      assert.notEqual(rowThen, 'pending', 'the control: the parked write really had not landed');
      assert.equal(await rowStatus(), 'pending', 'after the writer returns the row reads pending');
      assert.equal((await jobs().findOne({ _id: FILE })).status, 'pending', 'and the job is pending, claimable');
      assert.equal(await queue.waitForWork(1000, epoch), true, 'the wake did arrive, after the row');
    });
  }

  /**
   * The worker's run, placed where it falls: inside the gap when the order lets it in (it was woken), after the writer
   * returns when it does not. Answers whether it got in during the gap.
   */
  async function enqueueWithWorker(end) {
    await seedRow('complete');
    const epoch = queue.currentWorkEpoch();
    park = parkThePendingMark();
    const done = replaceTheText();
    await park.reached;
    const inGap = await queue.waitForWork(300, epoch);
    if (inGap) await workerRun(end);
    park.release();
    await done;
    if (!inGap) {
      assert.equal(await queue.waitForWork(2000, epoch), true, 'no wake arrived after the enqueue');
      await workerRun(end);
    }
    return inGap;
  }

  it('replaceContent: a worker that finishes the job right after its wake is not overwritten by a late pending', async () => {
    await enqueueWithWorker(claim => queue.completeJob(SPACE, claim, 'complete'));
    assert.equal((await jobs().findOne({ _id: FILE })).status, 'complete');
    assert.equal(await rowStatus(), 'complete', 'a finished file reads pending: the late mark overwrote the worker\'s');
  });

  it('replaceContent: a worker that fails the job with retries left leaves the row processing, not pending', async () => {
    await enqueueWithWorker((claim, job) => queue.failJob(SPACE, claim, job.attempts, MAX, 'the embedder is down'));
    assert.equal((await jobs().findOne({ _id: FILE })).status, 'pending', 'the failed job is queued for its retry');
    assert.equal(await rowStatus(), 'processing', 'a job mid-retry reads pending over a row the worker had marked processing');
  });
});
