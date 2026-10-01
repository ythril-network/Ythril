/**
 * `enqueueEmbedJobs`: the bulk enqueue both sweeps (reindex and reembed) queue through.
 *
 * ## Why it is not `enqueueEmbedJob` in a loop
 *
 * A reindex queues every record of a space — one round trip per record is a sweep that takes as long as the
 * embedding it was meant to hand off. So the sweep writes in ordered:false batches (design v3 item 6). Batching
 * changes what happens to a job that ALREADY exists, and that is what this file pins, one state at a time:
 *
 *  - a PENDING job keeps `attempts`, `transientFailures` and `claimableAfter`. A sweep is not new content: a job
 *    backing off from an outage must keep backing off, or a reindex during an outage hammers the dead embedder
 *    with every job at once;
 *  - a FAILED job becomes pending with a fresh budget (`attempts: 0`) — the sweep is the operator asking again,
 *    exactly as reembed's one-at-a-time enqueue treated it;
 *  - a PROCESSING job becomes pending with `claimToken: null`. The in-flight worker may be embedding the OLD
 *    text; nulling the token makes its finish match nothing, so the job re-runs (with `rebuild`) instead of being
 *    deleted as done;
 *  - `rebuild: true` is written when asked, which is what forces a rebuild past the worker's "unchanged" check;
 *  - a spill path is skipped INSIDE the builder, because a sweep over files would otherwise queue a read's own
 *    output for embedding;
 *  - a write error REJECTS. `enqueueEmbedJob` swallows its error so a write is never failed by its
 *    announcement; a sweep has no such write, and a swallowed batch error is a reindex that reports done over
 *    records it never queued.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/embed-bulk-enqueue-db.test.js
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bulk-enqueue-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, queue;
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe('enqueueEmbedJobs: the bulk enqueue (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('bulkenqueue');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await mongo.getDb().collection(`${SPACE}_embed_jobs`).drop().catch(() => {});
    queue.resetEmbedPendingHint();
  });

  it('is exported', () => {
    assert.equal(typeof queue.enqueueEmbedJobs, 'function', 'brain/embed-queue.ts must export enqueueEmbedJobs');
    assert.deepEqual(queue.EMBED_PRIORITY, { write: 0, background: 1, rebuild: 2 });
  });

  it('queues a fresh job per id and reports how many', async () => {
    const res = await queue.enqueueEmbedJobs(SPACE, 'fact', ['a', 'b', 'c'], { priority: queue.EMBED_PRIORITY.rebuild });
    assert.equal(res.queued, 3);
    const docs = await jobs().find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(docs.map(d => d._id), ['fact:a', 'fact:b', 'fact:c']);
    for (const d of docs) {
      assert.equal(d.status, 'pending');
      assert.equal(d.attempts, 0);
      assert.equal(d.priority, 2);
      assert.equal(d.recordType, 'fact');
      assert.equal(d.spaceId, SPACE);
      assert.ok(d.createdAt, 'a fresh job carries createdAt, which the claim orders by');
      assert.equal(d.claimableAfter ?? null, null);
    }
  });

  it('an existing PENDING job keeps its counters and its backoff', async () => {
    const backoff = future();
    await jobs().insertOne({
      _id: 'fact:p', spaceId: SPACE, recordType: 'fact', recordId: 'p', status: 'pending',
      attempts: 2, transientFailures: 3, lostChildFailures: 0, maxAttempts: 5, lastError: 'econnrefused',
      claimableAfter: backoff, claimToken: null, priority: 0, createdAt: '2026-01-01T00:00:00.000Z',
    });
    await queue.enqueueEmbedJobs(SPACE, 'fact', ['p'], { priority: queue.EMBED_PRIORITY.rebuild, rebuild: true });
    const job = await jobs().findOne({ _id: 'fact:p' });
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 2, 'a sweep is not new content; the attempt count stays');
    assert.equal(job.transientFailures, 3, 'and so does the outage counter the backoff is computed from');
    assert.equal(job.claimableAfter, backoff, 'a job backing off from an outage keeps backing off');
    assert.equal(job.priority, 0, 'and a local write queued earlier stays a local write ($min)');
    assert.equal(job.createdAt, '2026-01-01T00:00:00.000Z', 'its place in the queue is kept');
  });

  it('an existing FAILED job becomes pending with a fresh budget', async () => {
    await jobs().insertOne({
      _id: 'fact:f', spaceId: SPACE, recordType: 'fact', recordId: 'f', status: 'failed',
      attempts: 5, transientFailures: 0, lostChildFailures: 0, maxAttempts: 5, lastError: 'bad input',
      claimableAfter: null, claimToken: null, priority: 1, createdAt: '2026-01-01T00:00:00.000Z',
    });
    await queue.enqueueEmbedJobs(SPACE, 'fact', ['f'], { priority: queue.EMBED_PRIORITY.background });
    const job = await jobs().findOne({ _id: 'fact:f' });
    assert.equal(job.status, 'pending', 'a sweep is the operator asking again; a failed job is retried');
    assert.equal(job.attempts, 0, 'with a fresh budget, or it fails on its first error and is terminal again');
  });

  it('an existing PROCESSING job becomes pending with its claim token cleared', async () => {
    await jobs().insertOne({
      _id: 'fact:w', spaceId: SPACE, recordType: 'fact', recordId: 'w', status: 'processing',
      attempts: 1, transientFailures: 0, lostChildFailures: 0, maxAttempts: 5, lastError: null,
      claimedAt: new Date().toISOString(), progressAt: new Date().toISOString(),
      claimableAfter: null, claimToken: 'in-flight-token', priority: 0, createdAt: '2026-01-01T00:00:00.000Z',
    });
    await queue.enqueueEmbedJobs(SPACE, 'fact', ['w'], { priority: queue.EMBED_PRIORITY.rebuild, rebuild: true });
    const job = await jobs().findOne({ _id: 'fact:w' });
    assert.equal(job.status, 'pending',
      'the in-flight worker may be embedding the OLD text; the job must run again after it');
    assert.equal(job.claimToken, null, 'so the in-flight finish matches nothing and cannot delete the re-run');
    assert.equal(job.rebuild, true);

    // The worker's finish under the old claim now changes nothing.
    await queue.completeEmbedJob(SPACE, 'fact', 'w', 'in-flight-token');
    assert.ok(await jobs().findOne({ _id: 'fact:w' }), 'a stale finish deleted the re-queued job');
  });

  it('rebuild: true is written when asked, and not otherwise', async () => {
    await queue.enqueueEmbedJobs(SPACE, 'fact', ['r'], { priority: queue.EMBED_PRIORITY.rebuild, rebuild: true });
    await queue.enqueueEmbedJobs(SPACE, 'fact', ['n'], { priority: queue.EMBED_PRIORITY.background });
    assert.equal((await jobs().findOne({ _id: 'fact:r' })).rebuild, true);
    assert.notEqual((await jobs().findOne({ _id: 'fact:n' })).rebuild, true,
      'a backfill is not a rebuild; forcing past "unchanged" there would re-embed what already has its vector');
  });

  it('a spill path file id is skipped', async () => {
    const res = await queue.enqueueEmbedJobs(SPACE, 'file',
      ['docs/a.md', '_tmp/graph-00000000-0000-0000-0000-000000000000.json'], { priority: queue.EMBED_PRIORITY.rebuild });
    const ids = (await jobs().find({}).toArray()).map(d => d._id);
    assert.deepEqual(ids, ['file:docs/a.md'], 'a spill is a read\'s own output and is never embedded');
    assert.equal(res.queued, 1, 'and is not counted as queued');
  });

  it('a write error REJECTS rather than being swallowed', async () => {
    // A validator no job can satisfy: every upsert in the batch fails at the server.
    await mongo.getDb().createCollection(`${SPACE}_embed_jobs`, {
      validator: { priority: { $type: 'string' } }, validationAction: 'error',
    });
    await assert.rejects(
      () => queue.enqueueEmbedJobs(SPACE, 'fact', ['x', 'y'], { priority: queue.EMBED_PRIORITY.rebuild }),
      'a sweep that swallows a failed batch reports done over records it never queued',
    );
  });
});
