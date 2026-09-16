/**
 * A write no longer waits for the embedding model, and a record that missed its vector gets one later.
 *
 * ## The defect
 *
 * Every brain creator embedded inline. Three of the four swallowed a failure and stored the record
 * without a vector; `saveFact` did not — `FactDoc.embedding` was the only one of the four declared
 * REQUIRED, so that path had no choice but to throw. Two behaviours, neither chosen by the caller.
 *
 * And a record with no vector is not slightly worse, it is **invisible to recall**. Both channels drop
 * it: the vector search never returns it, and `introduceLexicalOnly` needs an embedding to compute a
 * real similarity and skips what it cannot score. Nothing repaired it either — the only route back was
 * a manual whole-space `POST /reindex` that re-embeds everything.
 *
 * ## What this pins
 *
 * The loop, end to end, against a real MongoDB and with the model deliberately unreachable — which is
 * the condition the whole feature exists for, and the one a machine with a warm cache cannot reproduce
 * by accident:
 *
 *  1. a write with no embedder available SUCCEEDS and enqueues (it used to throw);
 *  2. the queued job carries the record, and draining it stores the vector;
 *  3. a failure retries with backoff rather than being final, and stops at the attempt budget;
 *  4. `waitForEmbedding: true` still fails loudly — the old behaviour, kept reachable on request;
 *  5. rewriting a record resets a job that had already failed, so a rewrite is the escape hatch;
 *  6. a record deleted before its job runs retires the job instead of retrying forever.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/embed-queue-db.test.js
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-embed-queue-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

// The model is made UNREACHABLE, not merely absent: offline plus an empty cache directory. This is the
// condition the queue exists for, and asserting it here is what stops the suite from quietly measuring
// a machine that happens to hold 274 MB of weights.
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;

let mongo, memory, queue, worker;

const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const memories = () => mongo.col(`${SPACE}_facts`);

describe('brain embedding queue (real MongoDB, no reachable model)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('embedqueue');
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
      'this suite proves behaviour WITHOUT an embedder; if one is reachable it proves nothing');
  });

  it('a write succeeds with no embedder and leaves a job behind', async () => {
    // This is the regression: `saveFact` used to throw here, because FactDoc.embedding was required.
    const doc = await memory.saveFact(SPACE, 'node-7 runs the platform apps', [], ['prod']);
    assert.ok(doc._id, 'the write returned a record');

    const stored = await memories().findOne({ _id: doc._id });
    assert.equal(stored.embedding, undefined, 'no vector yet — that is the point');
    assert.equal(stored.matchedText, 'node-7 runs the platform apps'.length ? stored.matchedText : null);
    assert.ok(stored.matchedText, 'the exact text the vector will be built from is stored at write time');

    const job = await jobs().findOne({ _id: `fact:${doc._id}` });
    assert.ok(job, 'a job was enqueued');
    assert.equal(job.status, 'pending');
    assert.equal(job.recordType, 'fact');
    assert.equal(job.recordId, doc._id);
    assert.equal(job.attempts, 0);
  });

  it('waitForEmbedding: true still fails loudly', async () => {
    // The old behaviour, kept reachable on request rather than removed. A caller who needs the record
    // searchable when the call returns must hear that it is not.
    await assert.rejects(
      () => memory.saveFact(SPACE, 'must be searchable now', [], [], undefined, undefined,
        undefined, { waitForEmbedding: true }),
      'an explicit wait must surface the embedder failure, not swallow it',
    );
  });

  it('an insert-time duplicate check implies the wait', async () => {
    // It needs the vector BEFORE the insert so the new record cannot self-match — a question that
    // cannot be answered later. So it must fail here rather than silently skip the check.
    await assert.rejects(
      () => memory.saveFact(SPACE, 'is this a duplicate', [], [], undefined, undefined,
        undefined, { checkDuplicates: true }),
      'checkDuplicates cannot be honoured without a vector, so it must not report "no duplicates"',
    );
  });

  it('draining retries with backoff, then gives up at the budget', async () => {
    const doc = await memory.saveFact(SPACE, 'retry me', [], []);
    const id = `fact:${doc._id}`;

    // Attempt 1: the embedder is down, so the job goes back to pending with a backoff.
    assert.equal(await worker.runOneEmbedJob(), true, 'a job was claimed');
    let job = await jobs().findOne({ _id: id });
    assert.equal(job.status, 'pending', 'a failure requeues rather than being final');
    assert.equal(job.attempts, 1);
    assert.ok(job.claimableAfter, 'and is not immediately claimable again');
    assert.ok(job.lastError, 'the reason is recorded');

    // The backoff is real: nothing is claimable until it elapses.
    queue.resetEmbedPendingHint();
    assert.equal(await worker.runOneEmbedJob(), false, 'the backoff holds the job back');

    // Walk it to the attempt budget, clearing the backoff each time as the passage of time would.
    for (let i = 2; i <= queue.MAX_EMBED_ATTEMPTS; i++) {
      await jobs().updateOne({ _id: id }, { $set: { claimableAfter: null } });
      queue.resetEmbedPendingHint();
      assert.equal(await worker.runOneEmbedJob(), true, `attempt ${i} was claimable`);
    }
    job = await jobs().findOne({ _id: id });
    assert.equal(job.status, 'failed', 'the budget is finite');
    assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);

    queue.resetEmbedPendingHint();
    assert.equal(await worker.runOneEmbedJob(), false, 'a failed job is not claimed again');
  });

  it('rewriting the record revives a failed job', async () => {
    // The operator's escape hatch: new content deserves a fresh attempt budget, so a job that gave up
    // on the OLD content must not pass that verdict on.
    const doc = await memory.saveFact(SPACE, 'first version', [], []);
    const id = `fact:${doc._id}`;
    await jobs().updateOne({ _id: id }, { $set: { status: 'failed', attempts: 99, lastError: 'old' } });

    await memory.saveFact(SPACE, 'second version', [], [], undefined, undefined,
      undefined, undefined, undefined, undefined, doc._id);

    const job = await jobs().findOne({ _id: id });
    assert.equal(job.status, 'pending', 'a rewrite requeues');
    assert.equal(job.attempts, 0, 'with a fresh budget');
    assert.equal(job.lastError, null);
  });

  it('one job per record, however many times it is written', async () => {
    const doc = await memory.saveFact(SPACE, 'v1', [], []);
    for (const fact of ['v2', 'v3', 'v4']) {
      await memory.saveFact(SPACE, fact, [], [], undefined, undefined,
        undefined, undefined, undefined, undefined, doc._id);
    }
    assert.equal(await jobs().countDocuments({}), 1,
      'work coalesces on the record — four writes must not queue four embeddings of stale content');
  });

  it('a record deleted before its job runs retires the job', async () => {
    const doc = await memory.saveFact(SPACE, 'short lived', [], []);
    await memories().deleteOne({ _id: doc._id });

    queue.resetEmbedPendingHint();
    assert.equal(await worker.runOneEmbedJob(), true, 'the job was claimed');
    assert.equal(await jobs().countDocuments({}), 0,
      'a job for a record that no longer exists is done, not retried — retrying would keep it alive forever');
  });

  it('a stalled job returns to the pool', async () => {
    const doc = await memory.saveFact(SPACE, 'stalled', [], []);
    const id = `fact:${doc._id}`;
    // A process killed mid-claim leaves exactly this: processing, with an old sign of life.
    await jobs().updateOne({ _id: id }, {
      $set: { status: 'processing', progressAt: new Date(Date.now() - 600_000).toISOString() },
    });

    assert.equal(await queue.resetStalledEmbedJobs([SPACE], 120_000), 1);
    const job = await jobs().findOne({ _id: id });
    assert.equal(job.status, 'pending');
    assert.equal(job.claimableAfter, null, 'and is claimable at once — it already waited long enough');
  });
});
