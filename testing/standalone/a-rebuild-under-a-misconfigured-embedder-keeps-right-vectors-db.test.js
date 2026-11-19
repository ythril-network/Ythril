/**
 * A rebuild against an embedder that refuses every call unsets a stored vector only where the vector is not right (Q-930, bundle-351),
 * against a real MongoDB, through the real worker and a local stub endpoint that answers 401 (a wrong API key).
 *
 * ## The rule, end to end (`failureLeavesStoredVectorRight`, the table in `a-rebuild-keeps-a-stored-vector-only-while-it-is-right`)
 *
 *  - a vector made by the CURRENT model for the same text is kept until the job's last try. It would be kept however the job ends if the
 *    space's configuration (vector width, prefix scheme) could be told at that point, and it cannot: nothing records what a space's vectors
 *    were built with while a run is in progress (the run's `target` is what it rebuilds FOR), so every rebuild takes the fourth row;
 *  - a vector of ANOTHER model is kept while the job will be tried again, and unset on its last try: nothing else could be served correctly;
 *  - a 413 unsets at the first try (the record itself is refused);
 *  - a record whose text changed is unset at the first try;
 *  - outside a rebuild nothing changes: the first failed embed unsets the vector of a record whose model changed;
 *  - a third lost inference process is a last try, whatever the attempts are, and unsets a vector that is of another model.
 *
 * Run: `npm run test:up`, then node --test testing/standalone/a-rebuild-under-a-misconfigured-embedder-keeps-right-vectors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { createScriptedHost } from './_scripted-inference-host.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';
const DIMS = 4;
const OLD_VECTOR = [0.25, 0.25, 0.25, 0.25];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b351-rebuild-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let answer = { status: 401, body: '{"error":"invalid api key"}' };
let server, local, mongo, queue, worker, embedRecord, errors, loader, localInference;
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const entities = () => mongo.col(`${SPACE}_entities`);

/** A record as a reindex finds it: a vector, the stamp of the model that made it, and the text it was made from (or another). */
async function seed(id, { model, text } = {}) {
  const doc = { _id: id, spaceId: SPACE, name: 'vault', type: 'service', description: 'rotates credentials', tags: [], properties: {}, seq: 1, createdAt: '2026-08-01T00:00:00.000Z' };
  const current = await embedRecord.buildEmbedText(SPACE, 'entity', doc);
  await entities().insertOne({ ...doc, embedding: OLD_VECTOR, embeddingModel: model ?? loader.getEmbeddingConfig().model, matchedText: text ?? current });
  return current;
}
const enqueue = (id, rebuild) => queue.enqueueEmbedJobs(SPACE, 'entity', [id], rebuild
  ? { priority: queue.EMBED_PRIORITY.rebuild, rebuild: true } : { priority: queue.EMBED_PRIORITY.write });
async function runOnce() {
  await jobs().updateMany({ status: 'pending' }, { $set: { claimableAfter: null } });
  queue.resetEmbedPendingHint();
  assert.equal(await worker.runOneEmbedJob(), true, 'a job was claimed');
}
const job = async () => (await jobs().find({}).toArray())[0];

describe('a rebuild under an embedder that answers 401 (real MongoDB, real worker, a local stub endpoint)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => { res.writeHead(answer.status, { 'Content-Type': 'application/json' }); res.end(answer.body); });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('b351rebuild');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    errors = await import('../../server/dist/brain/embed-errors.js');
    localInference = await import('../../server/dist/brain/local-inference.js');
  });

  after(async () => {
    localInference?._setLocalInferenceForTests?.(null);
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await jobs().deleteMany({});
    await entities().deleteMany({});
    queue.resetEmbedPendingHint();
    answer = { status: 401, body: '{"error":"invalid api key"}' };
    process.env['EMBEDDING_URL'] = local.url;
  });

  for (const [name, model] of [['the current model', undefined], ['another model', 'the-previous-model']]) {
    it(`a vector of ${name} with the same text is kept through every try but the last, and unset on it`, async () => {
      const text = await seed('e-kept', { model });
      await enqueue('e-kept', true);

      for (let run = 1; run < queue.MAX_EMBED_ATTEMPTS; run++) {
        await runOnce();
        const doc = await entities().findOne({ _id: 'e-kept' });
        assert.deepEqual(doc.embedding, OLD_VECTOR, `run ${run}: a wrong key stripped a vector that is still right`);
        assert.equal(doc.matchedText, text);
        assert.equal(doc.embeddingModel, model ?? loader.getEmbeddingConfig().model, 'the stamp is not touched');
        assert.equal((await job()).status, 'pending');
      }

      await runOnce();
      const last = await entities().findOne({ _id: 'e-kept' });
      assert.equal(last.embedding, undefined, 'on the job\'s last try nothing else could be served correctly');
      assert.equal(last.matchedText, text, 'and the lexical channel matches the text it has');
      assert.equal((await job()).status, 'failed');
    });
  }

  it('a 413 unsets the vector at the first try: the record itself is refused', async () => {
    answer = { status: 413, body: 'too large' };
    const text = await seed('e-big');
    await enqueue('e-big', true);

    await runOnce();

    const doc = await entities().findOne({ _id: 'e-big' });
    assert.equal(doc.embedding, undefined);
    assert.equal(doc.matchedText, text);
    assert.equal((await job()).status, 'failed');
  });

  it('a record whose text changed is unset at the first try, as outside a rebuild: text that was removed must stop matching', async () => {
    const text = await seed('e-edited', { text: 'what it used to say' });
    await enqueue('e-edited', true);

    await runOnce();

    const doc = await entities().findOne({ _id: 'e-edited' });
    assert.equal(doc.embedding, undefined, 'a vector of text the record no longer has was kept');
    assert.equal(doc.matchedText, text, 'the lexical channel matches what the record says now');
    assert.equal((await job()).status, 'pending');
  });

  it('outside a rebuild nothing changes: the first failed embed unsets the vector of a record whose model changed', async () => {
    await seed('e-write', { model: 'the-previous-model' });
    await enqueue('e-write', false);

    await runOnce();

    assert.equal((await entities().findOne({ _id: 'e-write' })).embedding, undefined);
  });

  it('a third lost inference process is a last try: it unsets a vector of another model, and the first two keep it', async () => {
    delete process.env['EMBEDDING_URL'];
    const host = createScriptedHost();
    host.behaviour = async () => { throw new errors.LostChildError('code=139 signal=null'); };
    localInference._setLocalInferenceForTests(host);
    await seed('e-lost', { model: 'the-previous-model' });

    for (const [prior, stays] of [[0, true], [queue.MAX_LOST_CHILD_FAILURES - 2, true], [queue.MAX_LOST_CHILD_FAILURES - 1, false]]) {
      await entities().updateOne({ _id: 'e-lost' }, { $set: { embedding: OLD_VECTOR } });
      await assert.rejects(embedRecord.embedStoredRecord(SPACE, 'entity', 'e-lost', { rebuild: true, job: { attempts: 1, lostChildFailures: prior } }), /embedding process lost/);
      const doc = await entities().findOne({ _id: 'e-lost' });
      assert.equal(doc.embedding !== undefined, stays, `after ${prior} earlier lost processes the vector ${stays ? 'was stripped' : 'was kept'}`);
    }
  });
});
