/**
 * The embed queue's state can be READ and one record's job can be RETRIED — against a real MongoDB.
 *
 * ## What was actually wrong
 *
 * The canary operator read our 2.5.1 note and concluded a brain record written while the embedder was unreachable is
 * silently dropped. `embed-queue-db.test.js` already proves that is not what happens: the record is stored, a job is
 * enqueued, it retries with backoff, and it ends `failed` with its `lastError` after the attempt budget.
 *
 * **Their report was wrong about the mechanism and right about the consequence.** All of that state was invisible from
 * outside — no endpoint, no tool — so *"which of my records have no vector"* could not be answered, which from a
 * caller's seat is indistinguishable from the loss they described. This file pins the reading and the retrying.
 *
 * ## Why the ordering and the clamp are asserted, and not just "it returns rows"
 *
 * A listing that answers with the OLDEST hundred jobs is worse than useless during an incident: the failures an
 * operator is triaging are the ones that just broke, and a queue drains from the front, so the oldest pending are the
 * least interesting rows in the collection. And an uncapped `limit` on a collection with one row per record is a way to
 * ask the server for the whole space in one response.
 *
 * ## The `processing` case is the one worth a test
 *
 * A retry that resets a job a worker is holding takes the work away from a run in progress — the record then embeds
 * twice, or not at all if the second claim also fails. `retryEmbedJob` reports `processing` and changes nothing, and
 * that is asserted on the STORED job rather than on the return value, because a function can return the right word and
 * still have written.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/embed-jobs-are-visible-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-embed-jobs-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

// Unreachable, not merely absent — the same precondition as embed-queue-db.test.js, so a machine that happens to hold
// the weights cannot turn this suite into a measurement of its own model cache.
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;

let mongo, memory, queue, worker;

const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const memories = () => mongo.col(`${SPACE}_facts`);

/** Write a record and return its job id, so a test reads as the situation it is about. */
const writeRecord = async (fact) => {
  const doc = await memory.saveFact(SPACE, fact, [], []);
  return { id: doc._id, jobId: `fact:${doc._id}` };
};

describe('the embed queue is readable and retryable (real MongoDB, no reachable model)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('embedjobsvisible');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    memory = await import('../../server/dist/brain/fact.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await jobs().deleteMany({});
    await memories().deleteMany({});
    queue.resetEmbedPendingHint();
  });

  it('the model really is unreachable (the precondition, not an assumption)', async () => {
    const { embed } = await import('../../server/dist/brain/embedding.js');
    await assert.rejects(() => embed('anything'),
      'this suite is about records that could NOT be embedded; a reachable embedder proves nothing');
  });

  it('lists the job a vectorless record left behind — the state that was invisible', async () => {
    const { id } = await writeRecord('node-7 runs the platform apps');

    const listed = await queue.listEmbedJobs(SPACE);
    assert.equal(listed.length, 1, 'the one queued job is reported');
    assert.equal(listed[0].recordType, 'fact');
    assert.equal(listed[0].recordId, id, 'the row names the record, which is what makes it actionable');
    assert.equal(listed[0].status, 'pending');
    assert.equal(listed[0].attempts, 0);
    assert.ok(listed[0].maxAttempts >= 1, 'the budget is reported, so "attempt 3" means something to a reader');
  });

  it('reports counts by status, and the counts agree with the rows', async () => {
    await writeRecord('one');
    await writeRecord('two');

    const counts = await queue.getEmbedJobCounts(SPACE);
    assert.deepEqual(
      { pending: counts.pending, processing: counts.processing, failed: counts.failed },
      { pending: 2, processing: 0, failed: 0 },
    );
    assert.equal((await queue.listEmbedJobs(SPACE)).length, 2);
  });

  it('filters by status — and `failed` finds the record that gave up', async () => {
    const { id } = await writeRecord('exhaust me');

    // Drain until the job stops coming back. Each pass is one failed attempt against an unreachable model, so this
    // walks the job to its terminal state the same way the worker would over minutes of backoff.
    await jobs().updateOne({ _id: `fact:${id}` }, { $set: { attempts: 4, claimableAfter: null } });
    let guard = 0;
    while (await worker.runOneEmbedJob() && guard++ < 10) {
      await jobs().updateOne({ _id: `fact:${id}` }, { $set: { claimableAfter: null } });
    }

    const stored = await jobs().findOne({ _id: `fact:${id}` });
    assert.equal(stored.status, 'failed', `precondition: the job must be terminal, got ${stored.status}`);
    assert.ok(stored.lastError, 'and it must carry why');

    const failed = await queue.listEmbedJobs(SPACE, { status: 'failed' });
    assert.equal(failed.length, 1, 'the failed filter finds it');
    assert.equal(failed[0].recordId, id);
    assert.ok(failed[0].lastError, 'the error reaches the caller — otherwise the listing cannot be acted on');

    assert.equal((await queue.listEmbedJobs(SPACE, { status: 'pending' })).length, 0,
      'and it is no longer pending, so a status filter that means nothing would be caught here');

    // The record itself is still there. This is the half of their report that was wrong, asserted rather than argued.
    assert.ok(await memories().findOne({ _id: id }), 'the record is STORED — it is vectorless, not dropped');
  });

  it('orders newest-first, because an operator is triaging what just broke', async () => {
    const first = await writeRecord('oldest');
    // `updatedAt` is an ISO string written at enqueue; two writes in the same millisecond would make the order
    // arbitrary and the assertion meaningless, so the timestamps are set apart explicitly.
    await jobs().updateOne({ _id: first.jobId }, { $set: { updatedAt: '2020-01-01T00:00:00.000Z' } });
    const second = await writeRecord('newest');
    await jobs().updateOne({ _id: second.jobId }, { $set: { updatedAt: '2030-01-01T00:00:00.000Z' } });

    const listed = await queue.listEmbedJobs(SPACE);
    assert.equal(listed[0].recordId, second.id, 'the most recently touched job comes first');
    assert.equal(listed[1].recordId, first.id);
  });

  it('clamps the page size instead of trusting it', async () => {
    for (let i = 0; i < 3; i++) await writeRecord(`record ${i}`);

    assert.equal((await queue.listEmbedJobs(SPACE, { limit: 2 })).length, 2, 'a limit is honoured');
    assert.equal((await queue.listEmbedJobs(SPACE, { limit: 0 })).length, 3,
      'a zero limit must not mean "no rows" — it is clamped up, or a caller sending 0 sees an empty queue and believes it');
    assert.equal((await queue.listEmbedJobs(SPACE, { limit: 100000 })).length, 3,
      'an absurd limit is clamped rather than refused');
  });

  it('never returns the claim token', async () => {
    // A lease secret. A caller holding it could steal a job from the worker running it, so it is projected out at the
    // source rather than at each caller — the listing is the only place these documents leave the server.
    const { jobId } = await writeRecord('lease me');
    await jobs().updateOne({ _id: jobId }, { $set: { claimToken: 'super-secret-lease' } });

    const listed = await queue.listEmbedJobs(SPACE);
    assert.equal(listed.length, 1);
    assert.ok(!('claimToken' in listed[0]), 'claimToken must never leave the server');
    assert.ok(!JSON.stringify(listed).includes('super-secret-lease'));
  });

  it('pages past the 200-row cap, so a reported failure is always reachable', async () => {
    // `getEmbedJobCounts` aggregates EVERY job while the listing returns a page. Without `skip` a caller was told
    // `failed: 250` and could never reach failure #201 — an accurate total beside an unreachable tail, on the one surface
    // whose justification is that its failures are actionable.
    //
    // 250 rows, because the cap is 200: a fixture inside the cap cannot see this, which is exactly how the same defect
    // shipped on `/query` behind tests that paged 12 and 25 rows.
    const N = 250;
    for (let i = 0; i < N; i++) await writeRecord(`bulk ${String(i).padStart(3, '0')}`);
    assert.equal((await queue.getEmbedJobCounts(SPACE)).pending, N, 'precondition: the counts see all of them');

    const seen = [];
    for (let skip = 0; skip < N; skip += 100) {
      const rows = await queue.listEmbedJobs(SPACE, { limit: 100, skip });
      seen.push(...rows.map(r => r.recordId));
    }
    assert.equal(seen.length, N, `expected every job across the pages, got ${seen.length}`);
    assert.equal(new Set(seen).size, N, 'and each exactly once — no repeats, no gaps across the cap boundary');
  });

  it('a page past the END is empty rather than the tail', async () => {
    await writeRecord('only one');
    assert.deepEqual(await queue.listEmbedJobs(SPACE, { limit: 10, skip: 5 }), [],
      'returning the tail here would make a draining loop run for ever');
  });

  it('a retry re-queues a failed job and clears what it failed with', async () => {
    const { id, jobId } = await writeRecord('retry me');
    await jobs().updateOne({ _id: jobId }, {
      $set: { status: 'failed', attempts: 5, lastError: 'model unreachable', claimedAt: '2026-01-01T00:00:00.000Z' },
    });

    assert.equal(await queue.retryEmbedJob(SPACE, 'fact', id), 'ok');

    const after = await jobs().findOne({ _id: jobId });
    assert.equal(after.status, 'pending', 'the worker will pick it up again');
    assert.equal(after.attempts, 0, 'the budget is restored, or one retry attempt is all it gets');
    assert.equal(after.lastError, null);
    assert.equal(after.claimedAt, null);
    assert.equal(after.claimableAfter, null, 'and it is claimable NOW, not after the old backoff window');
  });

  it('a retry is not a rewrite — it leaves the text the vector will be built from alone', async () => {
    // The reason this calls `retryEmbedJob` and not `enqueueEmbedJob`: the latter exists for a NEW WRITE and resets the
    // content-derived fields with it. Reusing it here would claim the record had changed when only the operator's
    // patience had, and the job would then embed whatever the second caller passed rather than the stored record.
    const { id, jobId } = await writeRecord('the exact text that will be embedded');
    const before = await jobs().findOne({ _id: jobId });
    await jobs().updateOne({ _id: jobId }, { $set: { status: 'failed', lastError: 'boom' } });

    await queue.retryEmbedJob(SPACE, 'fact', id);

    const after = await jobs().findOne({ _id: jobId });
    assert.equal(after.recordType, before.recordType);
    assert.equal(after.recordId, before.recordId);
    assert.equal(after.createdAt, before.createdAt, 'the job is the same job, not a new one');
  });

  it('refuses to reset a job a worker is HOLDING, and reports that plainly', async () => {
    const { id, jobId } = await writeRecord('in flight');
    await jobs().updateOne({ _id: jobId }, {
      $set: {
        status: 'processing', attempts: 2, lastError: 'a previous attempt',
        claimedAt: '2026-01-01T00:00:00.000Z', claimToken: 'held-by-a-worker',
      },
    });

    assert.equal(await queue.retryEmbedJob(SPACE, 'fact', id), 'processing');

    // Asserted on the STORED job, not on the return value: a function can return the right word and still have written.
    const after = await jobs().findOne({ _id: jobId });
    assert.equal(after.status, 'processing', 'the run in progress keeps its job');
    assert.equal(after.attempts, 2, 'and its attempt count — a reset here would give a failing job infinite retries');
    assert.equal(after.claimToken, 'held-by-a-worker', 'the lease is untouched');
  });

  it('reports not_found for a record with no job, rather than inventing one', async () => {
    assert.equal(await queue.retryEmbedJob(SPACE, 'fact', 'no-such-record'), 'not_found');
    assert.equal(await jobs().countDocuments({}), 0,
      'a retry of an unknown record must not CREATE a job — nothing would ever satisfy it');
  });

  it('a retry of one record leaves every other job alone', async () => {
    const a = await writeRecord('first');
    const b = await writeRecord('second');
    await jobs().updateMany({}, { $set: { status: 'failed', attempts: 5, lastError: 'both failed' } });

    await queue.retryEmbedJob(SPACE, 'fact', a.id);

    assert.equal((await jobs().findOne({ _id: a.jobId })).status, 'pending');
    const untouched = await jobs().findOne({ _id: b.jobId });
    assert.equal(untouched.status, 'failed', 'per-record means per-record');
    assert.equal(untouched.attempts, 5);
    assert.equal(untouched.lastError, 'both failed');
  });
});
