/**
 * An embed job the embedder refuses as too large ends at once; a 400 and a busy endpoint do not (Q-699, bundle-237), and every writer of
 * `failed` is counted.
 *
 * ## The rule, end to end
 *
 * The queue's worker claims a job, builds the record's text, asks the real `embed()` (over a real local stub endpoint standing in for
 * the operator's HTTP embedder), and on a throw hands the message to `failEmbedJob`:
 *
 *  - HTTP 413 (payload too large): the job is `failed` AT ONCE with `attempts` at the maximum and the endpoint's message in `lastError`,
 *    where it used to go pending five times over twelve minutes;
 *  - HTTP 400: unchanged, the attempt budget. A misconfigured embedder answers 400 for every record, and ending each at once would end
 *    the whole backlog on the first claim;
 *  - HTTP 503, even one whose body quotes `(HTTP 413)`: transient, the attempt is handed back and the job stays pending.
 *
 * ## The signal
 *
 * Every writer of `status: 'failed'` in the queue counts `ythril_embed_jobs_failed_total{reason}`: `refused_413`, `budget` (the attempts
 * ran out), `lost_child` (the inference process was lost too often), `over_ceiling` (a stored passage is over the ceiling; see
 * `a-stored-passage-over-the-ceiling-is-never-cut-on-rebuild-db`). One helper writes them, so no writer can drop the count.
 *
 * Run: `npm run test:up`, then node --test testing/standalone/a-413-from-the-embedder-ends-the-embed-job-at-once-db.test.js
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b237-413-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

/** What the stub answers: a status, and the body it says. */
let answer = { status: 200, body: '' };
let requests = 0;
let server, local, mongo, fact, queue, worker, errors, registry;

const jobs = () => mongo.col(`${SPACE}_embed_jobs`);

async function failedCount(reason) {
  const text = await registry.register.metrics();
  let total = 0;
  for (const m of text.matchAll(/^ythril_embed_jobs_failed_total(\{[^}]*\})?\s+([0-9.eE+-]+)$/gm)) {
    if ((m[1] ?? '').includes(`reason="${reason}"`)) total += Number(m[2]);
  }
  return total;
}

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

describe('the embed queue and an embedder that refuses a request (real MongoDB, real embed() over a stub endpoint)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        requests++;
        if (answer.status === 200) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => (i + 1) / 10) }] }));
          return;
        }
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(answer.body);
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('b237refused');
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
    requests = 0;
  });

  it('a 413 fails the job at once: failed, attempts at the maximum, the endpoint\'s own message, claim released', async () => {
    answer = { status: 413, body: '{"error":"input is too large for this model"}' };
    await fact.saveFact(SPACE, 'a fact the embedder will call too large', [], []);

    await runOnce();

    const job = await only();
    assert.equal(job.status, 'failed', `after one refusal the job is ${job.status} with ${job.attempts} attempt(s): the budget was spent instead of the job ended`);
    assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
    assert.match(job.lastError, /Embedding request failed \(HTTP 413\)/);
    assert.match(job.lastError, /too large/);
    assert.equal(job.claimToken ?? null, null);
    assert.equal(requests, 1, 'a refusal is not retried in the request either');
  });

  it('a 413 is counted once as refused_413', async () => {
    const before = await failedCount('refused_413');
    answer = { status: 413, body: 'too large' };
    await fact.saveFact(SPACE, 'counted refusal', [], []);
    await runOnce();
    assert.equal(await failedCount('refused_413'), before + 1);
  });

  it('a 400 keeps the budget: pending after the first, failed with all attempts after the fifth, counted as budget', async () => {
    const before = await failedCount('budget');
    answer = { status: 400, body: '{"error":"model not found"}' };
    await fact.saveFact(SPACE, 'a fact for a misconfigured embedder', [], []);

    await runOnce();
    let job = await only();
    assert.equal(job.status, 'pending', 'a 400 ended the job on its first claim: a wrong model name would end the whole backlog');
    assert.equal(job.attempts, 1);

    for (let i = 1; i < queue.MAX_EMBED_ATTEMPTS; i++) await runOnce();
    job = await only();
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, queue.MAX_EMBED_ATTEMPTS);
    assert.match(job.lastError, /HTTP 400/);
    assert.equal(await failedCount('budget'), before + 1);
  });

  it('a 503 whose body quotes (HTTP 413) is a busy endpoint: pending, the attempt handed back', async () => {
    answer = { status: 503, body: 'upstream: Embedding request failed (HTTP 413)' };
    await fact.saveFact(SPACE, 'a fact while the gateway is busy', [], []);

    await runOnce();

    const job = await only();
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0, 'a transient failure hands its attempt back');
    assert.equal(job.transientFailures, 1);
  });

  it('a lost inference process ended too often is counted as lost_child', async () => {
    const before = await failedCount('lost_child');
    const doc = await fact.saveFact(SPACE, 'a fact that kills the runtime', [], []);
    await queue.failEmbedJob(SPACE, 'fact', doc._id, 1, `${errors.LOST_MARKER} (code=139 signal=null)`, 0,
      { lostChildFailures: queue.MAX_LOST_CHILD_FAILURES - 1 });
    assert.equal((await only()).status, 'failed');
    assert.equal(await failedCount('lost_child'), before + 1);
  });

  it('every writer of status failed in the queue goes through the one counting helper (the source holds no bare writer)', async () => {
    const { stripComments } = await import('./_strip-comments.mjs');
    const src = stripComments(fs.readFileSync('server/src/brain/embed-queue.ts', 'utf8'));
    const writers = [...src.matchAll(/status:\s*'failed'/g)].length;
    const counted = [...src.matchAll(/\bembedJobsFailedTotal\b|ythril_embed_jobs_failed_total/g)].length;
    assert.ok(counted >= 1, 'embed-queue.ts never names the failed-jobs counter');
    // A writer written next to a counter call is the habit this removes: the count lives in ONE helper that also writes the status.
    const sets = [...src.matchAll(/\$set:\s*\{[^}]*status:\s*'failed'[^}]*\}/g)].length;
    assert.ok(sets <= 1, `${sets} places write status 'failed' beside their own $set: the writers must share one helper that counts (found ${writers} mentions)`);
  });
});
