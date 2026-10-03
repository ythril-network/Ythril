/**
 * An embed job's finish acts only on the claim that started it — `Q-249`, 5.6.3.
 *
 * ## The defect
 *
 * A worker claims a job (`claimNextEmbedJob` stamps a fresh `claimToken`) and starts embedding the record. While it
 * works, the record is REWRITTEN: the write enqueues again, and the enqueue resets the job to `pending` with a fresh
 * budget and `claimToken: null`, so the new text is owed an embedding. Then the first worker finishes — and on 5.6.2
 * `completeEmbedJob` and `failEmbedJob` matched the job by its id alone:
 *
 *  - a late COMPLETE deleted the pending job, so the new text was never embedded and the record kept the vector of
 *    text it no longer holds (recall ranks it by the old meaning, silently);
 *  - a late FAIL wrote the old attempt's backoff, error and counters over the rewrite's fresh job.
 *
 * ## The rule
 *
 * A finish that names the claim it holds matches nothing once that claim is gone: the rewrite's pending job survives
 * exactly as the rewrite left it (`claimToken` null, `attempts` 0, no error, no backoff). A finish that names no
 * token (a test, a delete path) keeps its old behaviour, and a finish under the claim still held works as before.
 *
 * The complete half is called directly with main's signature, `completeEmbedJob(spaceId, recordType, recordId,
 * claimToken)`. The fail half is driven through the real worker (`runOneEmbedJob`), with the model unreachable so the
 * embed fails, and the rewrite made while the worker reads the record — so it holds whatever position the token takes
 * in `failEmbedJob`'s signature, as long as the worker passes it (the source half is
 * `the-embed-worker-finishes-under-its-own-claim.test.js`).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-embed-finish-under-a-taken-claim-matches-nothing-db.test.js
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-embed-claim-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
// The model is UNREACHABLE, so every embed the worker attempts fails: the fail half is what the worker can reach.
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;

let mongo, memory, queue, worker;
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const facts = () => mongo.col(`${SPACE}_facts`);
/** A rewrite of an existing fact by id: the write path that re-enqueues its job. */
const rewrite = (id, text) => memory.saveFact(SPACE, text, [], [], undefined, undefined,
  undefined, undefined, undefined, undefined, id);

/** The job exactly as an enqueue leaves it: what a stale finish must not have touched. */
function assertAsTheRewriteLeftIt(job, what) {
  assert.ok(job, `${what}: the rewrite's pending job is gone, so the new text is never embedded`);
  assert.deepEqual(
    { status: job.status, attempts: job.attempts, claimToken: job.claimToken, lastError: job.lastError,
      claimableAfter: job.claimableAfter, transientFailures: job.transientFailures },
    { status: 'pending', attempts: 0, claimToken: null, lastError: null, claimableAfter: null, transientFailures: 0 },
    `${what}: a finish under a claim the rewrite had already taken back acted on the rewrite's job`);
}

describe('an embed finish under a taken-back claim matches nothing', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('embedclaim');
    (await import('../../server/dist/config/loader.js')).loadConfig();
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
    await facts().deleteMany({});
    queue.resetEmbedPendingHint();
  });

  it('the preconditions hold: the model is unreachable, and an enqueue resets the claim', async () => {
    const { embed } = await import('../../server/dist/brain/embedding.js');
    await assert.rejects(() => embed('anything'), 'a reachable model would make the worker succeed, not fail');
    const doc = await memory.saveFact(SPACE, 'first text', [], []);
    const claimed = await queue.claimNextEmbedJob([SPACE]);
    assert.equal(claimed?.recordId, doc._id, 'the job was not claimed');
    assert.ok(claimed.claimToken, 'a claim carries no token, so there is nothing for a finish to name');
    await rewrite(doc._id, 'second text');
    assertAsTheRewriteLeftIt(await jobs().findOne({ _id: `fact:${doc._id}` }), 'the enqueue itself');
  });

  it('a complete under the old claim deletes nothing: the rewrite\'s pending job survives', async () => {
    const doc = await memory.saveFact(SPACE, 'embedding this', [], []);
    const claimed = await queue.claimNextEmbedJob([SPACE]);
    await rewrite(doc._id, 'rewritten while it embedded');
    await queue.completeEmbedJob(SPACE, 'fact', doc._id, claimed.claimToken);
    assertAsTheRewriteLeftIt(await jobs().findOne({ _id: `fact:${doc._id}` }), 'completeEmbedJob(…, oldToken)');
  });

  it('a fail the worker reports under the old claim changes nothing: the rewrite\'s job stays fresh', async () => {
    const doc = await memory.saveFact(SPACE, 'the worker reads this', [], []);
    // The rewrite lands while the worker reads the record it is about to embed: after the claim, before the finish.
    const proto = Object.getPrototypeOf(mongo.col('probe'));
    const original = proto.findOne;
    let armed = true;
    proto.findOne = async function rewriting(filter, ...rest) {
      if (armed && this.collectionName === `${SPACE}_facts` && filter?._id === doc._id) {
        armed = false;
        const job = await jobs().findOne({ _id: `fact:${doc._id}` });
        assert.equal(job?.status, 'processing', 'the hook fired outside a held claim, so the row proves nothing');
        await rewrite(doc._id, 'rewritten mid-embed');
      }
      return original.call(this, filter, ...rest);
    };
    try {
      assert.equal(await worker.runOneEmbedJob(), true, 'the worker claimed nothing');
    } finally { proto.findOne = original; }
    assert.equal(armed, false, 'the worker never read the record, so the rewrite never happened mid-embed');
    assert.equal((await facts().findOne({ _id: doc._id }))?.fact, 'rewritten mid-embed');
    assertAsTheRewriteLeftIt(await jobs().findOne({ _id: `fact:${doc._id}` }), 'the worker\'s failEmbedJob under the old claim');
  });

  it('control: a finish under the claim still held works as before', async () => {
    const doc = await memory.saveFact(SPACE, 'nobody rewrites this', [], []);
    const claimed = await queue.claimNextEmbedJob([SPACE]);
    await queue.completeEmbedJob(SPACE, 'fact', doc._id, claimed.claimToken);
    assert.equal(await jobs().findOne({ _id: `fact:${doc._id}` }), null, 'a complete under the held claim did not delete the job');

    const other = await memory.saveFact(SPACE, 'the worker fails this one', [], []);
    queue.resetEmbedPendingHint();
    assert.equal(await worker.runOneEmbedJob(), true);
    const failed = await jobs().findOne({ _id: `fact:${other._id}` });
    assert.equal(failed?.attempts, 1, 'a fail under the held claim did not record its attempt');
    assert.ok(failed?.lastError, 'a fail under the held claim did not record its error');
    assert.ok(failed?.claimableAfter, 'a fail under the held claim set no backoff');
  });

  it('control: a tokenless finish keeps its old behaviour, whatever the claim', async () => {
    const doc = await memory.saveFact(SPACE, 'a delete path retires this', [], []);
    await queue.claimNextEmbedJob([SPACE]);
    await rewrite(doc._id, 'rewritten');
    await queue.completeEmbedJob(SPACE, 'fact', doc._id);
    assert.equal(await jobs().findOne({ _id: `fact:${doc._id}` }), null, 'a tokenless complete no longer deletes by id');

    const other = await memory.saveFact(SPACE, 'failed by a tokenless caller', [], []);
    await queue.failEmbedJob(SPACE, 'fact', other._id, 1, 'a permanent failure');
    const failed = await jobs().findOne({ _id: `fact:${other._id}` });
    assert.equal(failed?.lastError, 'a permanent failure', 'a tokenless fail no longer updates by id');
  });
});
