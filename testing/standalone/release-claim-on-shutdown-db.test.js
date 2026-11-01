/**
 * Database-level test: a planned shutdown hands its claims back instead of waiting out the stall timer.
 *
 * ## The finding (lens 7, Reliability & Resilience)
 *
 * `stopMediaEmbeddingWorker()` exists, and its own doc comment promises it "completes the in-flight batch".
 * The shutdown path never called it. Three consequences, all from one missing call:
 *
 *   1. the worker kept CLAIMING new jobs while the process drained — a job picked up in the last second of
 *      life is abandoned instantly;
 *   2. whatever it held died with `status: processing` and a live claim token, so recovery had to wait out the
 *      full `stalledJobTimeoutMs` (five minutes by default) on the next boot before re-queuing it. A rolling
 *      restart pays that per in-flight job, per pod;
 *   3. `closeMongo()` ran while the worker might be mid-write, so its writes failed with connection errors
 *      that look like real failures and can spend a retry attempt.
 *
 * Stall recovery is for when nobody can say what happened. A planned shutdown CAN say, and saying so is worth
 * one write.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/release-claim-on-shutdown-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const NOW = new Date().toISOString();

let mongo, jobs, releaseClaimedJob, claimNextJob;

async function insertProcessing(id, claimToken, attempts = 1) {
  await jobs.insertOne({
    _id: id, spaceId: SPACE, filePath: id, mimeType: 'application/pdf', mediaType: 'text',
    status: 'processing', attempts, maxAttempts: 3, lastError: null,
    claimedAt: NOW, progressAt: NOW, claimToken,
    // A backoff left over from an earlier failure: releasing must clear it, or the recovered job is invisible
    // to the claim walk until that timestamp passes.
    claimableAfter: new Date(Date.now() + 600_000).toISOString(),
    createdAt: NOW, updatedAt: NOW,
  });
}

describe('releaseClaimedJob — against a real MongoDB', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('releaseclaim');
    ({ releaseClaimedJob, claimNextJob } = await import('../../server/dist/files/media/job-queue.js'));
    jobs = mongo.col(`${SPACE}_media_jobs`);
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => { await jobs.deleteMany({}); });

  it('makes the job pending again, immediately claimable', async () => {
    await insertProcessing('doc.pdf', 'run-one');
    assert.equal(await releaseClaimedJob(SPACE, 'doc.pdf', 'run-one'), true);

    const after = await jobs.findOne({ _id: 'doc.pdf' });
    assert.equal(after.status, 'pending');
    assert.equal(after.claimToken, null);
    assert.equal(after.claimedAt, null);
    assert.equal(after.claimableAfter, null, 'a stale backoff would hide the job from the claim walk');

    // And the claim walk can actually pick it up on the next boot — the point of the whole exercise.
    const reclaimed = await claimNextJob([SPACE]);
    assert.equal(reclaimed?._id, 'doc.pdf');
  });

  it('does NOT spend a retry attempt — the attempt was interrupted, not failed', async () => {
    // Charging our own deploys against the job's retry budget is how a file ends up "failed after 3 attempts"
    // having never once produced an error.
    await insertProcessing('doc.pdf', 'run-one', 1);
    await releaseClaimedJob(SPACE, 'doc.pdf', 'run-one');
    assert.equal((await jobs.findOne({ _id: 'doc.pdf' })).attempts, 1);
  });

  it('refuses to release a job that has been re-claimed by someone else', async () => {
    // Guarded on the token: releasing here would yank the claim out from under a worker making progress.
    await insertProcessing('doc.pdf', 'run-two');
    assert.equal(await releaseClaimedJob(SPACE, 'doc.pdf', 'run-one'), false);
    assert.equal((await jobs.findOne({ _id: 'doc.pdf' })).status, 'processing');
  });

  it('leaves a job that already finished alone', async () => {
    await insertProcessing('doc.pdf', 'run-one');
    await jobs.updateOne({ _id: 'doc.pdf' }, { $set: { status: 'complete' } });
    assert.equal(await releaseClaimedJob(SPACE, 'doc.pdf', 'run-one'), false);
    assert.equal((await jobs.findOne({ _id: 'doc.pdf' })).status, 'complete');
  });

  it('never throws — it runs while the connection may already be closing', async () => {
    await assert.doesNotReject(releaseClaimedJob(SPACE, 'missing.pdf', 'run-one'));
  });

  describe('the shutdown path is wired to it', () => {
    // The suite above proves the function works. These prove something calls it — otherwise the whole finding
    // is still live and the tests pass.
    const shutdown = readFileSync('server/src/shutdown.ts', 'utf8');

    it('stops the media worker, so it cannot claim while draining', () => {
      assert.match(shutdown, /stopMediaEmbeddingWorker\(\);/,
        'the worker kept claiming new jobs during shutdown');
    });

    it('hands back held claims before the database connection closes', () => {
      const releaseAt = shutdown.indexOf('releaseHeldJobs()');
      const closeAt = shutdown.indexOf('await closeMongo()');
      assert.ok(releaseAt > 0, 'nothing releases the claims this process holds');
      assert.ok(closeAt > releaseAt, 'the release must happen BEFORE closeMongo, or it cannot write');
    });
  });
});
