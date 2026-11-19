/**
 * Words an embedding endpoint writes in an error body cannot decide an embed job's fate (Q-931, bundle-351), against a real MongoDB.
 *
 * ## The defect
 *
 * `failEmbedJob` read the failure's MESSAGE, which for an HTTP error holds the endpoint's own body. A 400 whose body said `timeout` made the
 * job wait for ever, and one whose body said `embedding process lost` was counted as a crashed inference process and ended after three: a
 * third party's text decided a job's fate. The verdict is now decided by the class and the status of the object the server built
 * (`classifyEmbedFailure`), and this file drives it through the real worker over a local stub endpoint and through `failEmbedJob` on a
 * real job.
 *
 *  - a 400 whose body holds the lost marker, three times: the job is `pending` with three attempts spent and no lost-process count;
 *  - every status of the wait set, with such a body, hands the attempt back, and the wait written is the schedule's value for that count;
 *  - a 413 with such a body ends the job as refused, never as a lost process;
 *  - the host's own `LostChildError` ends a job on the third, and the same words as a string or a plain `Error` never do.
 *
 * Run: `npm run test:up`, then node --test testing/standalone/an-error-body-cannot-decide-an-embed-jobs-fate-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';
const DIMS = 4;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b351-verdict-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

/** What the stub answers: a status, and the body it says. */
let answer = { status: 200, body: '' };
let server, local, mongo, fact, queue, worker, errors, registry;

const jobs = () => mongo.col(`${SPACE}_embed_jobs`);
const HOSTILE_BODY = () => `timeout; timed out; service unavailable; ${errors.LOST_MARKER}; ${errors.NOT_SENT_MARKER}; status 503`;

async function counter(name, reason) {
  const text = await registry.register.metrics();
  let total = 0;
  for (const m of text.matchAll(new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, 'gm'))) {
    if (reason === undefined || (m[1] ?? '').includes(`reason="${reason}"`)) total += Number(m[2]);
  }
  return total;
}
const failedCount = (reason) => counter('ythril_embed_jobs_failed_total', reason);
const handedBack = () => counter('ythril_embed_jobs_handed_back_total');

/** One claim and one run of the worker over the one queued job, with its backoff cleared so the next run may claim it. */
async function runOnce() {
  await jobs().updateMany({ status: 'pending' }, { $set: { claimableAfter: null } });
  assert.equal(await worker.runOneEmbedJob(), true, 'a job was claimed');
}
const only = async () => {
  const rows = await jobs().find({}).toArray();
  assert.equal(rows.length, 1, `expected the one job, found ${rows.length}`);
  return rows[0];
};

describe('an embed job\'s fate is decided by the failure\'s class and status, never by an endpoint\'s words (real MongoDB, real embed() over a stub endpoint)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(answer.status === 200 ? JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }) : answer.body);
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('b351verdict');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    errors = await import('../../server/dist/brain/embed-errors.js');
    registry = await import('../../server/dist/metrics/registry.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await jobs().deleteMany({});
    await mongo.col(`${SPACE}_facts`).deleteMany({});
    queue.resetEmbedPendingHint();
    answer = { status: 200, body: '' };
  });

  it('a 400 whose body holds the lost marker, three times: pending, three attempts spent, no lost-process count, no wait', async () => {
    answer = { status: 400, body: HOSTILE_BODY() };
    const lostBefore = await failedCount('lost_child');
    const handedBefore = await handedBack();
    await fact.saveFact(SPACE, 'a fact for an endpoint that answers 400 in hostile words', [], []);

    for (let run = 1; run <= 3; run++) {
      await runOnce();
      const job = await only();
      assert.equal(job.status, 'pending', `after run ${run} the job is ${job.status}`);
      assert.equal(job.attempts, run, `run ${run}: the endpoint's words changed what the attempt cost`);
      assert.equal(job.lostChildFailures ?? 0, 0, `run ${run}: a body's words were counted as a lost inference process`);
      assert.equal(job.transientFailures ?? 0, 0, `run ${run}: a body's words made the failure a wait`);
    }
    assert.equal(await failedCount('lost_child'), lostBefore);
    assert.equal(await handedBack(), handedBefore);
  });

  it('a 500, a 404 and a 401 with such a body spend the whole budget and end failed on budget', async () => {
    for (const status of [500, 404, 401]) {
      await jobs().deleteMany({});
      answer = { status, body: HOSTILE_BODY() };
      const budgetBefore = await failedCount('budget');
      await fact.saveFact(SPACE, `a fact for an endpoint that answers ${status}`, [], []);
      for (let i = 0; i < queue.MAX_EMBED_ATTEMPTS; i++) await runOnce();
      const job = await only();
      assert.equal(job.status, 'failed', `a ${status} waited for ever on its body's words`);
      assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
      assert.equal(await failedCount('budget'), budgetBefore + 1, `a ${status}`);
      await mongo.col(`${SPACE}_facts`).deleteMany({});
    }
  });

  for (const status of [408, 502, 503, 522, 529, 530]) {
    it(`a ${status} hands the attempt back whatever its body says: pending, attempts 0, one wait counted`, async () => {
      answer = { status, body: status === 503 ? 'nothing a needle reads' : '{"error":"x"}' };
      const handedBefore = await handedBack();
      const budgetBefore = await failedCount('budget');
      await fact.saveFact(SPACE, `a fact for an endpoint that answers ${status}`, [], []);

      await runOnce();

      const job = await only();
      assert.equal(job.status, 'pending');
      assert.equal(job.attempts, 0, `a ${status} spent the record's attempt`);
      assert.equal(job.transientFailures, 1);
      assert.equal(job.lostChildFailures ?? 0, 0);
      assert.equal(await handedBack(), handedBefore + 1);
      assert.equal(await failedCount('budget'), budgetBefore);
    });
  }

  it('the wait a 503 writes is the schedule\'s value for its count: about 5 s, then about 30 s, then about 10 minutes', async () => {
    const doc = await fact.saveFact(SPACE, 'a fact for the schedule', [], []);
    // The first count of each step, with the jitter's half-to-full window and a second of slack for the clock.
    const STEPS = [[0, 5_000], [1, 30_000], [3, 600_000]];
    for (const [priorFailures, delayMs] of STEPS) {
      await jobs().updateOne({ _id: `fact:${doc._id}` }, { $set: { status: 'processing', attempts: 1, transientFailures: priorFailures } });
      await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, new errors.EmbeddingHttpError(503, 'busy', null), priorFailures);
      const job = await only();
      assert.equal(job.transientFailures, priorFailures + 1);
      const waitMs = Date.parse(job.claimableAfter) - Date.now();
      assert.ok(waitMs <= delayMs && waitMs >= delayMs / 2 - 1_000, `after ${priorFailures} earlier failures the wait is ${waitMs} ms, expected the ${delayMs} ms step`);
    }
  });

  it('a 413 whose body holds the lost marker ends the job as refused, and is never counted as a lost process', async () => {
    answer = { status: 413, body: HOSTILE_BODY() };
    const refusedBefore = await failedCount('refused_413');
    const lostBefore = await failedCount('lost_child');
    await fact.saveFact(SPACE, 'a fact the embedder calls too large in hostile words', [], []);

    await runOnce();

    const job = await only();
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
    assert.equal(job.lostChildFailures ?? 0, 0);
    assert.equal(await failedCount('refused_413'), refusedBefore + 1);
    assert.equal(await failedCount('lost_child'), lostBefore);
  });

  it('the 413 sentence and the over-ceiling words as a string or a plain Error end nothing: the attempt budget applies', async () => {
    const doc = await fact.saveFact(SPACE, 'a fact for forged sentences', [], []);
    const forged = ['Embedding request failed (HTTP 413): too large', new Error('Embedding request failed (HTTP 413): too large'),
      new errors.OverCeilingError(9_000, 8_000).message, new Error(new errors.OverCeilingError(9_000, 8_000).message)];
    for (const failure of forged) {
      await jobs().updateOne({ _id: `fact:${doc._id}` }, { $set: { status: 'processing', attempts: 1 }, $unset: { lastError: '' } });
      await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, failure, 0);
      const job = await only();
      assert.equal(job.status, 'pending', `a sentence ended the job: ${String(failure?.message ?? failure).slice(0, 40)}`);
      assert.notEqual(job.attempts, queue.MAX_EMBED_ATTEMPTS);
    }
  });

  it('the typed errors end a job: an EmbeddingHttpError of 413 as refused_413, an OverCeilingError as over_ceiling', async () => {
    const doc = await fact.saveFact(SPACE, 'a fact for the typed endings', [], []);
    for (const [failure, reason] of [[new errors.EmbeddingHttpError(413, 'big', null), 'refused_413'], [new errors.OverCeilingError(9_000, 8_000), 'over_ceiling']]) {
      await jobs().updateOne({ _id: `fact:${doc._id}` }, { $set: { status: 'processing', attempts: 1 } });
      const before = await failedCount(reason);
      await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, failure, 0);
      const job = await only();
      assert.equal(job.status, 'failed', reason);
      assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
      assert.equal(await failedCount(reason), before + 1);
    }
  });

  it('the host\'s LostChildError ends a job on the third, and the lost marker as a string or a plain Error never counts', async () => {
    const doc = await fact.saveFact(SPACE, 'a fact for the lost-process count', [], []);
    const id = `fact:${doc._id}`;
    const lostBefore = await failedCount('lost_child');
    for (const failure of [`${errors.LOST_MARKER} (code=139 signal=null)`, new Error(`${errors.LOST_MARKER} (code=139 signal=null)`)]) {
      await jobs().updateOne({ _id: id }, { $set: { status: 'processing', attempts: 1, lostChildFailures: queue.MAX_LOST_CHILD_FAILURES - 1 } });
      await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, failure, 0, { lostChildFailures: queue.MAX_LOST_CHILD_FAILURES - 1 });
      const job = await only();
      assert.equal(job.status, 'pending', 'text alone ended a job as a lost inference process');
      assert.equal(job.lostChildFailures, queue.MAX_LOST_CHILD_FAILURES - 1, 'text alone was counted as a lost inference process');
    }
    await jobs().updateOne({ _id: id }, { $set: { status: 'processing', attempts: 1 } });
    await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, new errors.LostChildError('code=139 signal=null'), 0, { lostChildFailures: queue.MAX_LOST_CHILD_FAILURES - 1 });
    assert.equal((await only()).status, 'failed');
    assert.equal(await failedCount('lost_child'), lostBefore + 1);
  });

  it('a request the lost process was never sent hands the attempt back and is not counted', async () => {
    const doc = await fact.saveFact(SPACE, 'a fact queued behind a crash', [], []);
    await jobs().updateOne({ _id: `fact:${doc._id}` }, { $set: { status: 'processing', attempts: 1 } });
    await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, new errors.LostChildError('code=139 signal=null', { inFlight: false }), 0, { lostChildFailures: 2 });
    const job = await only();
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.equal(job.lostChildFailures ?? 0, 0, 'the bystander was charged for the crash');
  });
});
