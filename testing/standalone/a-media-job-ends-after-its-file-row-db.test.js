/**
 * A media job is marked terminal only AFTER its file row's final status is written (`Q-434`).
 *
 * ## What goes wrong in the other order
 *
 * Ending a job is two writes: the JOB's status, and the file ROW's `embeddingStatus`. If the job goes first and anything
 * stops the second — the process is killed, the store refuses, the write times out — the job reads `complete` (or
 * `failed`) and the row reads `processing`, for ever. Nothing revisits it: stall recovery re-queues a job that stopped
 * reporting while CLAIMED, and a terminal job is not claimed. So the file shows a spinner indefinitely, Retry is not
 * offered on a file that reads as in progress, and the job collection says the work is done.
 *
 * In the safe order a failure between the writes leaves the job CLAIMED, which stall recovery re-runs — an idempotent
 * re-run over the same chunk ids. That is the whole argument for the order, and why each case below asserts the job's
 * state after the row write failed, not the row's.
 *
 * ## How the failure is made
 *
 * The file collection is turned into a view (`_write-faults.mjs :: withCollectionAsView`), so the row write fails at the
 * command level against the real store. Nothing is mocked: the error the code sees is the driver's own.
 *
 * Found by `the-media-worker-leaves-the-file-row-as-it-leaves-it-db`, which waits on the job and then reads the row, and
 * read `processing` under the load of a full -db batch — the same gap, held open by scheduling instead of by a crash.
 *
 * Run: node --test testing/standalone/a-media-job-ends-after-its-file-row-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { withCollectionAsView } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const SPACE = 'jobend';
const FILE = 'docs/report.pdf';
const NOW = new Date().toISOString();

let mongo, queue;
const jobs = () => mongo.col(`${SPACE}_media_jobs`);

/** A job this run holds, mid-flight: what `completeJob` and `failJob` are called on. */
async function claimedJob(attempts = 1) {
  await jobs().insertOne({
    _id: FILE, spaceId: SPACE, filePath: FILE, mimeType: 'application/pdf', mediaType: 'text',
    status: 'processing', attempts, maxAttempts: 3, lastError: null,
    claimedAt: NOW, progressAt: NOW, claimToken: 'this-run', createdAt: NOW, updatedAt: NOW,
  });
}

/** Run `fn` while every write to the file collection fails; answer what it threw, or null. */
async function withRowWritesFailing(fn) {
  return withCollectionAsView(mongo.getDb(), `${SPACE}_files`, `${SPACE}_media_jobs`, async () => {
    try { await fn(); return null; } catch (err) { return err; }
  });
}

describe('a media job is marked terminal only after its file row is (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('jobend');
    queue = await import('../../server/dist/files/media/job-queue.js');
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => { await jobs().deleteMany({}); });

  it('control: with the row writable, completeJob ends the job complete', async () => {
    await claimedJob();
    await queue.completeJob(SPACE, FILE, 'complete');
    assert.equal((await jobs().findOne({ _id: FILE })).status, 'complete');
  });

  it('completeJob: when the row cannot be written, the job is NOT marked complete', async () => {
    await claimedJob();
    const thrown = await withRowWritesFailing(() => queue.completeJob(SPACE, FILE, 'partial'));
    // The fault must have fired, or this case proves nothing: a write that never failed passes it trivially.
    assert.ok(thrown, 'the row write was meant to fail and completeJob returned normally — the fault did not fire');
    const job = await jobs().findOne({ _id: FILE });
    assert.notEqual(job.status, 'complete',
      'the job reads complete over a file row that never got its status: nothing will ever re-run it, and the file reads processing for ever');
    assert.equal(job.status, 'processing', 'it stays claimed, so stall recovery re-runs it');
  });

  it('failJob, out of retries: when the row cannot be written, the job is NOT marked failed', async () => {
    // The same two writes, in the branch that ends a job for good. A second copy of one order is the shape that
    // drifts, so it is held by the same assertion.
    await claimedJob(3);
    const thrown = await withRowWritesFailing(() => queue.failJob(SPACE, FILE, 3, 3, 'the converter gave up'));
    assert.ok(thrown, 'the row write was meant to fail and failJob returned normally — the fault did not fire');
    const job = await jobs().findOne({ _id: FILE });
    assert.notEqual(job.status, 'failed',
      'the job reads failed over a file row that never got its status: Retry is never offered, and the file reads processing for ever');
    assert.equal(job.status, 'processing', 'it stays claimed, so stall recovery re-runs it');
  });

  it('control: failJob with retries left writes no file row at all, so a failing row write cannot stop it', async () => {
    // Pending again is not terminal, and the row is not told anything until the job ends — so this branch must not be
    // made to depend on a row write it never needed.
    await claimedJob(1);
    const thrown = await withRowWritesFailing(() => queue.failJob(SPACE, FILE, 1, 3, 'try again'));
    assert.equal(thrown, null, `a retryable failure threw on the row write it should not make: ${thrown}`);
    assert.equal((await jobs().findOne({ _id: FILE })).status, 'pending');
  });
});
