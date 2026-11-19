/**
 * An embedder that cannot be reached costs a queued embed job WAITING, never its attempts (Q-924).
 *
 * ## What happened
 *
 * During an embedder outage on 18 Nov 2026 every queued job spent its five attempts and ended `failed`, and every record behind them was left
 * out of semantic search. The embed call threw `Could not reach embedding endpoint at <url>`, and the queue read an outage from the WORDS of a
 * failure (`isTransientEmbedError`: "fetch failed", "econnrefused", ...), none of which that sentence holds. A job whose embed call could not
 * reach its endpoint is the embedder's failure, not the record's: the error OBJECT now says so (`EmbedUnreachableError`, thrown where the
 * connection failure is known), and the queue hands the attempt back, with back-off, as it does for a 503.
 *
 * ## The rule, end to end (the real `embed()` against a closed loopback port, through `runOneEmbedJob`)
 *
 *  - six runs, each taking the job (its `claimableAfter` cleared between runs): the job stays `pending`, `attempts` stays 0, `transientFailures` is 6,
 *    `ythril_embed_jobs_failed_total{reason="budget"}` does not move and `ythril_embed_jobs_handed_back_total` moves by 6;
 *  - the warning is said once for the six calls (per endpoint and kind, per window);
 *  - a rebuild job in the same state keeps the record's stored vector (an outage must not strip a space of its vectors);
 *  - a write that needs the vector (`waitForEmbedding`) is still answered `400` on the tool door, in today's sentence;
 *  - what is NOT an outage keeps its budget: a header value the runtime refuses and the address guard's refusal end `failed` on `budget`;
 *  - the caught value reaches `failEmbedJob`, but the text rules still read the message: an `EmbeddingHttpError` of status 413 ends the job at once
 *    (`refused_413`) and its `lastError` is the endpoint's own text, never prefixed with a class name;
 *  - the running worker's loop claims nothing for a pause after one unreachable failure.
 *
 * Run: `npm run test:up`, then node --test testing/standalone/an-unreachable-embedder-costs-an-embed-job-no-attempt-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { closedLoopbackPort } from '../_shared/closed-port.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const SPACE = 'general';
const DIMS = 4;
const RUNS = 6;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q924-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
delete process.env['EMBEDDING_PROVIDER'];
delete process.env['EMBEDDING_API_KEY'];

let port, mongo, fact, queue, worker, embedding, embedRecord, registry, callTool, rightsShape, logs, stopLog;
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);

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

/** One claim and one run of the worker over the queued job, with its backoff cleared so the run may claim it. */
async function runOnce() {
  await jobs().updateMany({ status: 'pending' }, { $set: { claimableAfter: null } });
  assert.equal(await worker.runOneEmbedJob(), true, 'a job was claimed');
}
const only = async () => {
  const rows = await jobs().find({}).toArray();
  assert.equal(rows.length, 1, `expected the one job, found ${rows.length}`);
  return rows[0];
};
const SENTENCE = () => `Could not reach embedding endpoint at http://127.0.0.1:${port}. Make sure an embedding server (e.g. Ollama) is running and configured.`;
const unreachableLines = () => logs.filter(l => l.includes('Embedding endpoint unreachable') && l.includes(`:${port})`));

describe('an unreachable embedder and the embed queue (real MongoDB, real embed() against a closed loopback port)', { skip }, () => {
  before(async () => {
    port = await closedLoopbackPort();
    process.env['EMBEDDING_URL'] = `http://127.0.0.1:${port}`;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('q924unreachable');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    embedding = await import('../../server/dist/brain/embedding.js');
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    registry = await import('../../server/dist/metrics/registry.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    rightsShape = await import('../../server/dist/config/rights-shape.js');
    const log = await import('../../server/dist/util/log.js');
    logs = [];
    stopLog = log.subscribeLogLines(l => logs.push(l));
  });

  after(async () => {
    stopLog?.();
    worker?.stopBrainEmbeddingWorker();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    worker.stopBrainEmbeddingWorker();
    await jobs().deleteMany({});
    await mongo.col(`${SPACE}_facts`).deleteMany({});
    await mongo.col(`${SPACE}_entities`).deleteMany({});
    queue.resetEmbedPendingHint();
    process.env['EMBEDDING_URL'] = `http://127.0.0.1:${port}`;
    delete process.env['EMBEDDING_PROVIDER'];
    delete process.env['EMBEDDING_API_KEY'];
    logs.length = 0;
  });

  it(`${RUNS} runs against a closed port: pending, attempts 0, transientFailures ${RUNS}, the budget counter still, the hand-back counter by ${RUNS}, one warning`, async () => {
    const budgetBefore = await failedCount('budget');
    const handedBefore = await handedBack();
    await fact.saveFact(SPACE, 'a fact the embedder cannot be reached for', [], []);

    for (let run = 1; run <= RUNS; run++) {
      await runOnce();
      const job = await only();
      assert.equal(job.status, 'pending', `after run ${run} the job is ${job.status} with ${job.attempts} attempt(s): an unreachable embedder spent the record's budget`);
      assert.equal(job.attempts, 0, `after run ${run} the attempt was not handed back`);
      assert.equal(job.transientFailures, run);
      assert.equal(job.claimToken ?? null, null, 'the claim is released');
      assert.equal(job.lastError, SENTENCE(), 'lastError keeps the sentence, unprefixed');
    }

    assert.equal(await failedCount('budget'), budgetBefore, 'a waiting job was counted as a failed one');
    assert.equal(await handedBack() - handedBefore, RUNS, 'each hand-back is counted once');
    assert.equal(unreachableLines().length, 1, `the warning was said ${unreachableLines().length} times for ${RUNS} calls to one endpoint`);
  });

  it('a rebuild job in the same state keeps the stored vector, its model stamp and its text', async () => {
    const c = mongo.col(`${SPACE}_entities`);
    const doc = { _id: 'e-outage', spaceId: SPACE, name: 'vault', type: 'service', description: 'rotates credentials', tags: [], properties: {}, seq: 1, createdAt: '2026-08-01T00:00:00.000Z' };
    const text = await embedRecord.buildEmbedText(SPACE, 'entity', doc);
    const oldVector = [0.25, 0.25, 0.25, 0.25];
    await c.insertOne({ ...doc, embedding: oldVector, embeddingModel: 'the-previous-model', matchedText: text });
    await queue.enqueueEmbedJobs(SPACE, 'entity', ['e-outage'], { priority: queue.EMBED_PRIORITY.rebuild, rebuild: true });

    await runOnce();

    const after = await c.findOne({ _id: 'e-outage' });
    assert.deepEqual(after.embedding, oldVector, 'an embedder outage during a reindex stripped the record\'s vector');
    assert.equal(after.embeddingModel, 'the-previous-model');
    assert.equal(after.matchedText, text);
    const job = await only();
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.equal(job.transientFailures, 1);
  });

  it('a write that needs the vector (waitForEmbedding) is still answered 400 on the tool door, in the same sentence', async () => {
    const rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(rightsShape.SPACE_AREAS.map(a => [a, 'admin'])) };
    const out = await callTool({ name: 'save_fact', args: { space: SPACE, fact: 'a fact that must be searchable at once', waitForEmbedding: true },
      caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
    assert.equal(out.result.isError, true, `the write was taken: ${JSON.stringify(out.result).slice(0, 240)}`);
    assert.equal(out.status, 400, `the write answered ${out.status}: ${JSON.stringify(out.result).slice(0, 240)}`);
    assert.match(JSON.stringify(out.result), /Could not reach embedding endpoint at /);
  });

  it('a header value the runtime refuses is not an outage: five runs end it failed on budget', async () => {
    process.env['EMBEDDING_API_KEY'] = 'a-key\nwith-a-line-break';
    const budgetBefore = await failedCount('budget');
    const handedBefore = await handedBack();
    await fact.saveFact(SPACE, 'a fact for a misconfigured key', [], []);
    for (let i = 0; i < queue.MAX_EMBED_ATTEMPTS; i++) await runOnce();
    const job = await only();
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
    assert.equal(await failedCount('budget'), budgetBefore + 1);
    assert.equal(await handedBack(), handedBefore, 'a failure that waiting does not cure was handed back');
  });

  it('the address guard\'s refusal is not an outage either: five runs end it failed on budget', async () => {
    process.env['EMBEDDING_PROVIDER'] = 'external';
    process.env['EMBEDDING_URL'] = 'http://127.0.0.1:9';
    const budgetBefore = await failedCount('budget');
    await fact.saveFact(SPACE, 'a fact for an endpoint on a blocked address', [], []);
    for (let i = 0; i < queue.MAX_EMBED_ATTEMPTS; i++) await runOnce();
    const job = await only();
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
    assert.equal(await failedCount('budget'), budgetBefore + 1);
  });

  it('failEmbedJob given an EmbeddingHttpError of status 413 still ends the job at once, and lastError is the endpoint\'s own text', async () => {
    const before = await failedCount('refused_413');
    const doc = await fact.saveFact(SPACE, 'a fact the embedder calls too large', [], []);
    await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, new embedding.EmbeddingHttpError(413, 'input is too large for this model', null), 0);
    const job = await only();
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
    assert.equal(job.lastError, 'Embedding request failed (HTTP 413): input is too large for this model', 'the object was rendered with its class name, which unanchors the 413 rule');
    assert.equal(await failedCount('refused_413'), before + 1);
  });

  it('failEmbedJob given the typed error hands the attempt back; given the same sentence as a plain Error or a string it does not', async () => {
    const errors = await import('../../server/dist/brain/embed-errors.js');
    const doc = await fact.saveFact(SPACE, 'a fact for the typed error', [], []);
    const handedBefore = await handedBack();
    await queue.failEmbedJob(SPACE, 'fact', doc._id, 3, new errors.EmbedUnreachableError(SENTENCE()), 0);
    let job = await only();
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 2, 'the attempt spent at the claim is handed back');
    assert.equal(job.transientFailures, 1);
    assert.equal(await handedBack(), handedBefore + 1);

    await jobs().updateOne({ _id: job._id }, { $set: { attempts: 3, transientFailures: 0 } });
    for (const forged of [new Error(SENTENCE()), SENTENCE()]) {
      await queue.failEmbedJob(SPACE, 'fact', doc._id, 3, forged, 0);
      job = await only();
      assert.equal(job.transientFailures ?? 0, 0, 'the sentence alone made a failure the embedder\'s');
    }
    assert.equal(await handedBack(), handedBefore + 1);
  });

  it('a hand-back under a claim another worker took over writes nothing and is not counted', async () => {
    const errors = await import('../../server/dist/brain/embed-errors.js');
    const doc = await fact.saveFact(SPACE, 'a fact whose claim was taken over', [], []);
    const before = await only();
    const handedBefore = await handedBack();
    await queue.failEmbedJob(SPACE, 'fact', doc._id, 3, new errors.EmbedUnreachableError(SENTENCE()), 0, { claimToken: 'a-claim-nobody-holds' });
    const job = await only();
    assert.equal(job.transientFailures ?? 0, before.transientFailures ?? 0, 'a stale claim wrote the job');
    assert.equal(await handedBack(), handedBefore, 'a hand-back that matched no job was counted');
  });

  it('the running worker claims nothing for a pause after one unreachable failure', async () => {
    for (const text of ['one', 'two', 'three']) await fact.saveFact(SPACE, `a fact written ${text}`, [], []);
    // Tried: a job a worker took and failed, whether it handed the attempt back (`transientFailures`) or spent it (`attempts`).
    const tried = async () => (await jobs().find({ $or: [{ transientFailures: { $gte: 1 } }, { attempts: { $gte: 1 } }] }).toArray()).length;
    worker.startBrainEmbeddingWorker();
    try {
      await waitFor(async () => (await tried()) >= 1, 20_000, 100, 'a job to be tried against the closed port', { what: 'the first unreachable failure of the running worker' });
      // The absence window: with no pause the loop claims the next job at once, and the other two are tried within it.
      await elapse(1_500, 'absence window: the other two jobs would be claimed here if the worker kept going');
      assert.equal(await tried(), 1, `${await tried()} jobs were tried: the worker kept claiming while the embedder was unreachable`);
      const untouched = await jobs().find({ attempts: 0, transientFailures: { $not: { $gte: 1 } } }).toArray();
      assert.equal(untouched.length, 2);
      assert.ok(untouched.every(j => j.status === 'pending' && j.attempts === 0), 'a job the pause held back was claimed or spent');
    } finally {
      worker.stopBrainEmbeddingWorker();
    }
  });
});
