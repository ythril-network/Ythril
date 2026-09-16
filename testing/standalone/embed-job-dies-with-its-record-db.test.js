/**
 * Deleting a record retires its embed job — including a job that had already gone terminal `failed`.
 *
 * ## The defect
 *
 * Cleanup used to be entirely lazy and lived in the worker: it claims a job, finds the record gone, and treats `gone` as
 * success. That covers a `pending` job and **only** a `pending` job, because `claimNextEmbedJob` filters on
 * `status: 'pending'`. A job that exhausted its attempts and went terminal `failed` is never claimed again — so deleting
 * the record at that moment left the job row behind for ever.
 *
 * ## Why it lasted, and why it stopped being tolerable
 *
 * The row was invisible. Until #861 nothing exposed the brain embed queue, so an orphan cost one document and nobody
 * could see it. Now `GET /api/brain/spaces/:id/embedding-queue/records` and `list_embed_jobs` report it and
 * `getEmbedJobCounts` counts it, so an operator sees a permanent `failed` entry naming a `recordId` that returns 404 —
 * on a surface whose entire justification is that its failures are actionable.
 *
 * ## The `failed` case is the whole test
 *
 * A `pending` job was already cleaned up by the worker, so a test that only deletes a freshly written record passes
 * against the broken code. Every case below drives the job to `failed` FIRST, which is the state the old behaviour could
 * not recover from.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/embed-job-dies-with-its-record-db.test.js
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-job-orphan-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

// Unreachable model: a genuinely failed job cannot be produced against a working embedder.
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;

let mongo, memory, entities, edges, chrono, queue;

const jobs = () => mongo.col(`${SPACE}_embed_jobs`);

/** Force a record's job to the terminal state the old code could not recover from. */
const failJob = async (recordType, recordId) => {
  const _id = `${recordType}:${recordId}`;
  const r = await jobs().updateOne({ _id }, {
    $set: { status: 'failed', attempts: 5, lastError: 'model unreachable' },
  });
  assert.equal(r.matchedCount, 1, `no job was enqueued for ${_id} — the fixture is wrong, not the code`);
  return _id;
};

describe('an embed job dies with its record (real MongoDB, no reachable model)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('joborphan');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    memory = await import('../../server/dist/brain/fact.js');
    entities = await import('../../server/dist/brain/entities.js');
    edges = await import('../../server/dist/brain/edges.js');
    chrono = await import('../../server/dist/brain/chrono.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['facts', 'entities', 'edges', 'chrono', 'embed_jobs']) {
      await mongo.col(`${SPACE}_${c}`).deleteMany({});
    }
  });

  it('a fact: the FAILED job goes when the record goes', async () => {
    const doc = await memory.saveFact(SPACE, 'delete me while failed', [], []);
    const _id = await failJob('fact', doc._id);

    assert.equal(await memory.deleteFact(SPACE, doc._id), true);
    assert.equal(await jobs().findOne({ _id }), null,
      'the job outlived its record — nothing will ever claim it again, and the listing reports it for ever');
  });

  it('an entity', async () => {
    const e = await entities.upsertEntity(SPACE, `orphan entity ${Date.now()}`, 'thing');
    const _id = await failJob('entity', e.entity._id);
    assert.equal(await entities.deleteEntity(SPACE, e.entity._id), true);
    assert.equal(await jobs().findOne({ _id }), null);
  });

  it('an edge', async () => {
    const a = await entities.upsertEntity(SPACE, `edge-a ${Date.now()}`, 'thing');
    const b = await entities.upsertEntity(SPACE, `edge-b ${Date.now()}`, 'thing');
    const edge = await edges.upsertEdge(SPACE, a.entity._id, b.entity._id, 'relates_to');
    const _id = await failJob('edge', edge._id);
    assert.equal(await edges.deleteEdge(SPACE, edge._id), true);
    assert.equal(await jobs().findOne({ _id }), null);
  });

  it('a chrono entry', async () => {
    const c = await chrono.createChrono(SPACE, { title: `orphan chrono ${Date.now()}`, type: 'event' });
    const _id = await failJob('chrono', c._id);
    assert.equal(await chrono.deleteChrono(SPACE, c._id), true);
    assert.equal(await jobs().findOne({ _id }), null);
  });

  it('the counts and the listing stop reporting the phantom', async () => {
    // The user-visible symptom, asserted through the surface an operator actually reads rather than on the collection.
    const doc = await memory.saveFact(SPACE, 'phantom failure', [], []);
    await failJob('fact', doc._id);
    assert.equal((await queue.getEmbedJobCounts(SPACE)).failed, 1, 'precondition: one failure is reported');

    await memory.deleteFact(SPACE, doc._id);

    assert.equal((await queue.getEmbedJobCounts(SPACE)).failed, 0);
    assert.deepEqual(await queue.listEmbedJobs(SPACE), [],
      'the listing must not name a recordId that now 404s — that is what makes its failures actionable');
  });

  it('deleting a record with NO job is not an error', async () => {
    // The common case by far: a successfully embedded record has no job, because a completed job is deleted. The retire
    // must be a no-op rather than throwing on a missing row.
    const doc = await memory.saveFact(SPACE, 'no job here', [], []);
    await jobs().deleteMany({});
    assert.equal(await memory.deleteFact(SPACE, doc._id), true);
  });

  it('a delete that matches NOTHING does not retire a job', async () => {
    // The guard: retirement must sit after the `deletedCount === 0` check, or deleting a nonexistent id would drop the
    // job of a record that is still there. Constructed by writing a record, then deleting a DIFFERENT id.
    const doc = await memory.saveFact(SPACE, 'keep my job', [], []);
    const _id = await failJob('fact', doc._id);

    assert.equal(await memory.deleteFact(SPACE, 'no-such-record-id'), false);
    assert.ok(await jobs().findOne({ _id }),
      'a failed delete must not retire anything — the record and its job are both still there');
  });

  it('a PENDING job is retired too, not only a failed one', async () => {
    // The worker would have got to this one, but not for an unbounded time. Retiring both keeps one rule instead of
    // "eagerly for failed, lazily for pending", which is the kind of split nobody remembers.
    const doc = await memory.saveFact(SPACE, 'pending then deleted', [], []);
    const _id = `fact:${doc._id}`;
    assert.equal((await jobs().findOne({ _id })).status, 'pending');
    await memory.deleteFact(SPACE, doc._id);
    assert.equal(await jobs().findOne({ _id }), null);
  });
});
