/**
 * A media job can be DEFERRED: put back behind a short wait without spending one of its attempts, for a bounded time (Q-327, bundle-72).
 *
 * ## Why the queue needs it
 *
 * An image whose face gallery cannot answer yet (`GalleryIncompleteError`: the face index is rebuilding, which after a container recreate takes
 * 120 s or more) must be tried again LATER, not as a failure. The queue has only one way to give a claimed job back with a wait, `failJob`, and
 * it is a failure: `claimNextJob` increments `attempts`, `failJob` schedules by it (30 s, then 2 min) and ends the job at `maxAttempts` 3. A rebuild
 * outlasts that (about 2.5 minutes of retries), so the job would end `failed` and every face photo in the space would lose its caption with it
 * (AUDIT-VET S2, premise P11: "no such path exists"; `releaseClaimedJob` gives a claim back with no wait, for a shutdown).
 *
 * ## The rules (P11, DESIGN v3 item 9)
 *
 * `deferJob(spaceId, jobId, claimToken, reason)` in `files/media/job-queue.ts`, one guarded writer:
 *
 *  1. The job goes back to `pending`, `claimableAfter` about 60 s out, and the attempt the claim counted is refunded, so a deferral never spends
 *     the retry budget (four deferrals in a row leave `attempts` at 0, beyond `maxAttempts`). It is fenced on the claim's token, as every write
 *     a run makes: a holder that lost its claim defers nothing.
 *  2. `deferredSince` is stamped by the FIRST deferral and kept by every later one: the cap is measured from it.
 *  3. Past 30 minutes of deferral the job is not deferred again: it stays claimed, so the run goes on to the end (the face is stored unlabelled,
 *     with a warn and a counter) instead of waiting for ever on a gallery that does not come back.
 *  4. The deferred job carries `facesOnly`, so its re-run does not repeat the caption (`a-deferred-image-run-does-not-caption-again-db.test.js`).
 *
 *  5. (bundle-236, Q-698) The marks end with the job: after `completeJob` and after the LAST `failJob` the job carries neither
 *     `deferredSince` nor `facesOnly`, so a retry or a re-upload starts a whole run, caption included. CHARACTERISATION: `endJob`
 *     already unsets both, so these two cases are green on the base; they pin it while the reset moves into one spread (`RUN_RESET`,
 *     `DEFERRAL_MARKS`).
 *  6. (bundle-236, Q-698) `deferJob` answers WHY, not whether: `'deferred'`, `'past_cap'` (the 30 minutes are spent: the run goes on) or
 *     `'lost'` (the claim is no longer the job's: the run ends as abandoned, never as a failure). A boolean cannot tell a run that
 *     must stop from one that must go on, and the worker treated both as "carry on and write under a claim it no longer holds".
 *     Red on the base: it answers `true` and `false`.
 *
 * The reason a deferral is made for is the caller's; the queue stores no policy beyond the wait and the cap.
 *
 * Seen red on the base: `deferJob` is not exported (the file's own first case), so every other case fails on the same missing writer.
 *
 * Needs a MongoDB: `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-media-job-can-be-deferred-without-spending-an-attempt-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'mediadefer';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-mediadefer-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const MINUTE = 60_000;
let mongo, queue;
const jobs = () => mongo.col(`${SPACE}_media_jobs`);
const jobOf = (id) => jobs().findOne({ _id: id });
const at = (iso) => new Date(iso).getTime();

/** Enqueue the image job of `id` and claim it, as the worker does: the claimed job, `processing` with its token. */
async function claimed(id) {
  await queue.enqueueMediaJob(SPACE, id, 'image/png', 'image');
  queue.markSpaceMayHaveWork(SPACE);
  const job = await queue.claimNextJob([SPACE]);
  assert.equal(job?._id, id, `fixture check: the worker's claim returned ${JSON.stringify(job?._id)}, not ${id}`);
  return job;
}

/** Make a deferred (pending, waiting) job claimable now, as the minute passing would, and claim it again. */
async function reclaim(id) {
  await jobs().updateOne({ _id: id }, { $set: { claimableAfter: new Date(Date.now() - 1_000).toISOString() } });
  queue.markSpaceMayHaveWork(SPACE);
  const job = await queue.claimNextJob([SPACE]);
  assert.equal(job?._id, id, `fixture check: the deferred job ${id} was not claimable again`);
  return job;
}

describe('a media job can be deferred without spending an attempt (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: SPACE }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('mediadefer');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    queue = await import('../../server/dist/files/media/job-queue.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => { await jobs().deleteMany({}); });

  it('job-queue.js exports deferJob, the one writer that gives a claimed job back behind a wait and refunds its attempt', () => {
    assert.equal(typeof queue.deferJob, 'function',
      'files/media/job-queue.ts has no deferJob: the only way to put a claimed job back with a wait is failJob, which spends an attempt');
  });

  it('puts the job back to pending, about 60 s out, and refunds the attempt the claim counted', async () => {
    const job = await claimed('a.png');
    assert.equal(job.attempts, 1, 'fixture check: the claim counts the attempt');
    const before = Date.now();
    await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready');

    const after = await jobOf('a.png');
    assert.equal(after.status, 'pending', 'a deferred job is waiting, not processing and not failed');
    assert.equal(after.attempts, 0, 'a deferral spent an attempt: the claim\'s increment must be refunded');
    const wait = at(after.claimableAfter) - before;
    assert.ok(wait >= 30_000 && wait <= 90_000, `claimableAfter is ${wait} ms out, not about 60 s`);
    assert.ok(!after.claimToken, 'the deferred job still carries its claim token: the run that deferred it could still write under it');
    assert.equal(after.claimedAt ?? null, null);
    assert.ok(Math.abs(at(after.deferredSince) - before) < 10_000, `deferredSince is ${JSON.stringify(after.deferredSince)}: the first deferral stamps it with now`);
    assert.equal(after.facesOnly, true, 'the deferred job does not say its re-run is faces only, so the re-run captions again');
  });

  it('never spends the retry budget: four deferrals in a row leave the attempts at 0, past maxAttempts', async () => {
    let job = await claimed('b.png');
    for (let i = 0; i < 4; i++) {
      await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready');
      assert.equal((await jobOf('b.png')).attempts, 0, `deferral ${i + 1} left attempts at a non-zero count`);
      job = await reclaim('b.png');
    }
    assert.equal(job.attempts, 1, 'a claim after four deferrals is attempt 1 again');
    assert.equal(job.maxAttempts, 3, 'fixture check: the budget these deferrals would have exhausted');
  });

  it('keeps deferredSince from the first deferral', async () => {
    const job = await claimed('c.png');
    await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready');
    const first = new Date(Date.now() - 10 * MINUTE).toISOString();
    await jobs().updateOne({ _id: 'c.png' }, { $set: { deferredSince: first } });

    const again = await reclaim('c.png');
    await queue.deferJob(SPACE, again._id, again.claimToken, 'index_not_ready');
    const after = await jobOf('c.png');
    assert.equal(after.status, 'pending');
    assert.equal(at(after.deferredSince), at(first), `deferredSince is ${JSON.stringify(after.deferredSince)}, not the first deferral's ${first}: the 30 minute cap would restart at every deferral`);
  });

  it('defers again inside 30 minutes of deferral', async () => {
    const job = await claimed('d.png');
    await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready');
    await jobs().updateOne({ _id: 'd.png' }, { $set: { deferredSince: new Date(Date.now() - 29 * MINUTE).toISOString() } });
    const again = await reclaim('d.png');
    await queue.deferJob(SPACE, again._id, again.claimToken, 'index_not_ready');
    assert.equal((await jobOf('d.png')).status, 'pending', 'a job 29 minutes into its deferral was not deferred again');
  });

  it('past 30 minutes of deferral the job is not deferred again: it stays claimed, so the run goes on to its end', async () => {
    const job = await claimed('e.png');
    await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready');
    await jobs().updateOne({ _id: 'e.png' }, { $set: { deferredSince: new Date(Date.now() - 31 * MINUTE).toISOString() } });
    const again = await reclaim('e.png');
    const claimedState = await jobOf('e.png');

    await queue.deferJob(SPACE, again._id, again.claimToken, 'index_not_ready');
    const after = await jobOf('e.png');
    assert.equal(after.status, 'processing', 'a job 31 minutes into its deferral was deferred again: a gallery that never comes back would hold it for ever');
    assert.equal(after.claimToken, claimedState.claimToken, 'the run lost its claim to a deferral that was refused');
    assert.equal(after.attempts, claimedState.attempts);
    assert.ok(!after.claimableAfter, 'a refused deferral still set a wait');
  });

  it('is fenced on the claim token: a holder that lost its claim defers nothing', async () => {
    const job = await claimed('f.png');
    const before = await jobOf('f.png');
    await queue.deferJob(SPACE, job._id, 'not-the-token-of-this-run', 'index_not_ready');
    assert.deepEqual(await jobOf('f.png'), before, 'a deferral with a token that is not the run\'s changed the job another run holds');
  });

  // ── bundle-236 (Q-698): the marks end with the job; deferJob says why it did not defer ──────────────────────────────────────

  const marked = (job) => ['deferredSince', 'facesOnly'].filter(k => k in job);

  /** A deferred, re-claimed job and its file row (the end of a job writes both). */
  async function deferredAndReclaimed(id) {
    await mongo.col(`${SPACE}_files`).insertOne({ _id: id, spaceId: SPACE, path: id, tags: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 5, seq: 1, embeddingStatus: 'processing' });
    const job = await claimed(id);
    await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready');
    assert.deepEqual(marked(await jobOf(id)), ['deferredSince', 'facesOnly'], 'fixture check: the deferral set both marks');
    return await reclaim(id);
  }

  it('CHARACTERISATION: completeJob takes both deferral marks off the job', async () => {
    const job = await deferredAndReclaimed('g.png');
    await queue.completeJob(SPACE, { jobId: job._id, claimToken: job.claimToken }, 'complete');
    const after = await jobOf('g.png');
    assert.equal(after.status, 'complete');
    assert.deepEqual(marked(after), [], 'a finished job kept its deferral marks: a retry of it would skip the caption');
  });

  it('CHARACTERISATION: the last failJob (the attempts spent) takes both deferral marks off the job', async () => {
    const job = await deferredAndReclaimed('h.png');
    await queue.failJob(SPACE, { jobId: job._id, claimToken: job.claimToken }, job.maxAttempts, job.maxAttempts, 'the embedder gave up');
    const after = await jobOf('h.png');
    assert.equal(after.status, 'failed');
    assert.deepEqual(marked(after), [], 'a failed job kept its deferral marks: a retry of it would skip the caption');
  });

  it('answers \'deferred\' when it defers the job', async () => {
    const job = await claimed('i.png');
    assert.equal(await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready'), 'deferred');
  });

  it('answers \'lost\' for a claim that is no longer the job\'s (another token, no token, no job) and changes nothing', async () => {
    const job = await claimed('j.png');
    const before = await jobOf('j.png');
    assert.equal(await queue.deferJob(SPACE, job._id, 'not-the-token-of-this-run', 'index_not_ready'), 'lost', 'a token that is not the run\'s');
    assert.equal(await queue.deferJob(SPACE, job._id, null, 'index_not_ready'), 'lost', 'no token at all');
    assert.equal(await queue.deferJob(SPACE, 'no-such-job.png', job.claimToken, 'index_not_ready'), 'lost', 'a job that is gone');
    assert.deepEqual(await jobOf('j.png'), before);
  });

  it('answers \'past_cap\' past 30 minutes of deferral, and the job stays claimed', async () => {
    const job = await claimed('k.png');
    await queue.deferJob(SPACE, job._id, job.claimToken, 'index_not_ready');
    await jobs().updateOne({ _id: 'k.png' }, { $set: { deferredSince: new Date(Date.now() - 31 * MINUTE).toISOString() } });
    const again = await reclaim('k.png');
    const answer = await queue.deferJob(SPACE, again._id, again.claimToken, 'index_not_ready');
    assert.equal(answer, 'past_cap', `the cap's answer is ${JSON.stringify(answer)}: a run cannot tell it must go on from one that lost its claim`);
    assert.equal((await jobOf('k.png')).status, 'processing');
  });
});
