/**
 * A reindex rebuild job does not run the insert-time duplicate check; a local write's job does.
 *
 * ## Why (Q-99 part 2, design item 12)
 *
 * The worker evaluates every record it embeds against its neighbours, because a stored record has no vector until
 * its job gives it one, so the insert rule cannot fire at the write. That is right for a record that was just
 * written. A reindex rebuild re-embeds a whole space whose records were each evaluated when they were written: firing
 * the rule again for every one of them is a full duplicate scan nobody asked for, run through the insert path,
 * on the instance's busiest day.
 *
 * So the skip is keyed on the job, `rebuild && priority === 2`, and a priority-0 job — a local write — still runs it.
 *
 * ## How "it ran" is observed without a vector index
 *
 * `evaluateRecordForDuplicates` is fire-and-forget, so its effect cannot be awaited. Its first act is to read
 * `dupeRulesOnInsert` from the space's config, and nothing else on the worker's path reads that field (the two
 * writers that do are not called here). A counting getter on that one property is therefore exact: a read means the
 * evaluation started. The job is seeded straight into the collection rather than through the queue's writer, so a
 * case does not depend on that writer accepting the new fields.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-rebuild-job-runs-no-duplicate-check-db.test.js
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
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const DIMS = 8;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rebuild-dupe-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let server, local, mongo, worker, queue;
let dupeReads = 0;

/** A pending job as the queue writes one, with the lane fields the case needs. */
async function seedJob(recordId, lane) {
  const now = new Date().toISOString();
  await mongo.col(`${SPACE}_embed_jobs`).insertOne({
    _id: `entity:${recordId}`, spaceId: SPACE, recordType: 'entity', recordId,
    status: 'pending', attempts: 0, transientFailures: 0, lostChildFailures: 0, maxAttempts: 5,
    lastError: null, claimedAt: null, progressAt: null, claimableAfter: null, claimToken: null,
    createdAt: now, updatedAt: now, ...lane,
  });
}

async function seedEntity(id) {
  await mongo.col(`${SPACE}_entities`).insertOne({
    _id: id, spaceId: SPACE, name: `thing ${id}`, type: 'concept', tags: [], properties: {}, seq: 1,
  });
}

describe('a rebuild job skips the insert-time duplicate check', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, () => 0.5) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('rebuilddupe');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    const space = loader.getConfig().spaces.find(s => s.id === SPACE);
    Object.defineProperty(space, 'dupeRulesOnInsert', {
      configurable: true, enumerable: true,
      get() { dupeReads++; return false; },
    });
    worker = await import('../../server/dist/brain/embed-worker.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await mongo.col(`${SPACE}_embed_jobs`).deleteMany({});
    await mongo.col(`${SPACE}_entities`).deleteMany({});
    queue.resetEmbedPendingHint();
    dupeReads = 0;
  });

  /** Run the one job, then give the fire-and-forget evaluation time to start. */
  async function runAndSettle() {
    assert.equal(await worker.runOneEmbedJob(), true, 'the seeded job was claimed');
    for (let i = 0; i < 20 && dupeReads === 0; i++) await sleep(25);
  }

  it('a priority-0 job (a local write) runs the duplicate check', async () => {
    // The control: without it, "not called" below could mean the counter sees nothing at all.
    await seedEntity('e-write');
    await seedJob('e-write', { priority: 0 });
    await runAndSettle();
    assert.ok(dupeReads > 0, 'a freshly written record must still be evaluated against its neighbours');
  });

  it('a rebuild job at priority 2 (a reindex) does not', async () => {
    await seedEntity('e-rebuild');
    await seedJob('e-rebuild', { priority: 2, rebuild: true });
    await runAndSettle();
    assert.ok(Array.isArray((await mongo.col(`${SPACE}_entities`).findOne({ _id: 'e-rebuild' })).embedding),
      'precondition: the rebuild job did embed the record');
    assert.equal(dupeReads, 0,
      'a reindex re-embeds records that were each evaluated when written — re-running the insert rule for every one is a full scan nobody asked for');
  });
});
