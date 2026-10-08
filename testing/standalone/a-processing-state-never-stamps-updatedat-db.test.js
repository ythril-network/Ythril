/**
 * Recording what THIS instance did with a file's bytes never moves the file's authored half (`Q-240`, bundle-48 D7).
 *
 * ## The defect
 *
 * `updatedAt` is hashed (`FILE_HASH_PROJECTION`) and replicates. Nine writers of a file's processing state
 * (`embeddingStatus`, `mediaJobError`...) stamped it anyway: the job queue's enqueue, complete, fail, retry and
 * retry-all, the media worker's "processing" mark, and the dispatcher's skip marks. So a file that arrived from a peer
 * carried the peer's `updatedAt` for as long as it took this instance's worker to run, and then carried this
 * instance's: two instances that held identical data reported `MERKLE_DIVERGENCE` over a status mark each had made on
 * its own copy, and `a-published-file-reaches-its-subscribers` had to stop comparing `updatedAt` to stay green.
 *
 * ## What is asserted, and how it cannot pass by looking at nothing
 *
 * For EVERY writer, a top-level file row is seeded with an OLD `updatedAt` (a poison, not "now" and not zero, so a
 * stamp is visible and a write that happens to store the same instant cannot hide it) and a `seq`; the writer is
 * driven through its exported entry point against a real MongoDB; and the row must still carry both. Each case also
 * asserts the status the writer was SUPPOSED to record, so a case that drove nothing fails instead of agreeing that
 * nothing moved.
 *
 * - **The job queue**: `enqueueTextJob`, `completeJob`, `failJob` (an exhausted job, which marks the file; and one with
 *   retries left, which marks nothing and is the control), `retryJob`, `retryFailedJobs`.
 * - **The dispatcher**: the media skip marks (oversized, class off), the pending mark, the documents-off skip.
 * - **The media worker**, through the loop that claims a job (`processJob` is not exported): the "processing" mark and
 *   the completion of a document; and a document the pipeline refuses permanently, which marks the file `skipped`,
 *   then fails the job.
 * - **Coverage is derived, not asserted by count**: every function that calls `setFileProcessingState` (the one
 *   module a processing write goes through; found in the call graph, its floor the files that import it), the setter
 *   itself, and any write to a files collection that touches a processing field outside it
 *   (`_processing-state-writes.mjs`; empty on a healthy tree, the rule gate refuses one) must be reached from an entry
 *   point a case drives, so a writer added next year that no case reaches fails here.
 *
 * ## Seen red
 *
 * On 2693450b the seven writers that stamp `updatedAt` fail (`enqueueTextJob`, `completeJob`, `failJob`, `retryJob`,
 * `retryFailedJobs`, and the worker's processing mark and completion). The dispatcher's marks do not stamp today and
 * pass; they are here to hold the rule after the writers move, and
 * `a-file-row-processing-write-goes-through-one-function` is what is red for them.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-processing-state-never-stamps-updatedat-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { moduleIndex, walkFrom, callsIn } from './_call-graph.mjs';
import { recordWrites } from './_record-writes.mjs';
import { fileRowWrites, processingTouched, NOT_A_PROCESSING_MARK } from './_processing-state-writes.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const DOCS_OFF = 'docsoff';
const DIMS = 8;
/** Old enough that no clock the test runs under can produce it, and not a value any writer would compute. */
const POISON = '1999-01-01T00:00:00.000Z';
const POISON_SEQ = 4242;
const HASH = 'c'.repeat(64);
const PROCESSING_STATE = 'server/src/files/processing-state.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-procstate-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
/** Over this a document is refused by the conversion pipeline, permanently (`too_large`). */
const MAX_CONVERSION_BYTES = 400;
/** Over this a media file is skipped by the dispatcher. */
const MAX_MEDIA_BYTES = 1000;

let embedder;
let mongo;
let jobQueue;
let dispatch;
let worker;

const files = (space = SPACE) => mongo.col(`${space}_files`);
const jobs = (space = SPACE) => mongo.col(`${space}_media_jobs`);

/** A top-level file row as an arrival or an upload leaves it, with the poison on the fields that must not move. */
async function seed(id, over = {}, space = SPACE) {
  await files(space).deleteOne({ _id: id });
  const doc = {
    _id: id, spaceId: space, path: id, tags: [], description: 'written by a person', sizeBytes: 100, sha256: HASH,
    author: { instanceId: 'peer-1', instanceLabel: 'Peer' }, createdAt: POISON, updatedAt: POISON, seq: POISON_SEQ,
    embeddingStatus: 'processing', ...over,
  };
  // `undefined` means "absent": the driver would store it as null, and a status of null is not a row nothing has touched.
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  await files(space).insertOne(doc);
}

/** A media job row in a given state, for the writers that act on one. */
async function seedJob(id, status, space = SPACE) {
  const now = new Date().toISOString();
  await jobs(space).deleteOne({ _id: id });
  await jobs(space).insertOne({
    _id: id, spaceId: space, filePath: id, mimeType: 'text/markdown', mediaType: 'text', resolvedFormat: 'md',
    status, attempts: status === 'failed' ? 3 : 1, maxAttempts: 3, lastError: status === 'failed' ? 'boom' : null,
    claimedAt: status === 'processing' ? now : null, claimableAfter: null, createdAt: now, updatedAt: now,
  });
}

/** What the writer must leave alone: the authored half of the row, read back. */
async function authoredHalf(id, space = SPACE) {
  const r = await files(space).findOne({ _id: id });
  assert.ok(r, `the file row ${id} is gone`);
  return { row: r, updatedAt: r.updatedAt, seq: r.seq, description: r.description, tags: r.tags, author: r.author?.instanceId };
}

/**
 * The writers of a file's processing state, each driven through the entry point it is reached by.
 *
 * `entry` is the function key the coverage test walks from; `status` is what the writer must have recorded.
 */
const CASES = [
  { name: 'enqueueTextJob', entries: ['server/src/files/media/job-queue.ts:enqueueTextJob'], status: 'pending',
    run: async (id) => { await seed(id); await jobQueue.enqueueTextJob(SPACE, id, 'md'); } },
  { name: 'completeJob (complete)', entries: ['server/src/files/media/job-queue.ts:completeJob'], status: 'complete',
    run: async (id) => { await seed(id); await seedJob(id, 'processing'); await jobQueue.completeJob(SPACE, id, 'complete'); } },
  { name: 'completeJob (partial)', entries: ['server/src/files/media/job-queue.ts:completeJob'], status: 'partial',
    run: async (id) => { await seed(id); await seedJob(id, 'processing'); await jobQueue.completeJob(SPACE, id, 'partial'); } },
  { name: 'failJob (retries exhausted: the file is marked failed)', entries: ['server/src/files/media/job-queue.ts:failJob'], status: 'failed',
    run: async (id) => { await seed(id); await seedJob(id, 'processing'); await jobQueue.failJob(SPACE, id, 3, 3, 'boom'); } },
  { name: 'failJob (retries left: the control, the file row is not touched)', entries: ['server/src/files/media/job-queue.ts:failJob'], status: 'processing',
    run: async (id) => { await seed(id); await seedJob(id, 'processing'); await jobQueue.failJob(SPACE, id, 1, 3, 'transient'); } },
  { name: 'retryJob', entries: ['server/src/files/media/job-queue.ts:retryJob'], status: 'pending',
    run: async (id) => {
      await seed(id, { embeddingStatus: 'failed', mediaJobError: 'boom' }); await seedJob(id, 'failed');
      assert.equal(await jobQueue.retryJob(SPACE, id), 'ok');
    } },
  { name: 'retryFailedJobs', entries: ['server/src/files/media/job-queue.ts:retryFailedJobs'], status: 'pending',
    run: async (id) => {
      await seed(id, { embeddingStatus: 'failed', mediaJobError: 'boom' }); await seedJob(id, 'failed');
      assert.equal(await jobQueue.retryFailedJobs(SPACE), 1);
    } },
  { name: 'dispatch: an oversized media file is skipped', ext: 'png', entries: ['server/src/files/dispatch.ts:dispatchFileProcessing'], status: 'skipped',
    run: async (id) => {
      await seed(id, { embeddingStatus: undefined, sha256: 'd'.repeat(64) });
      const r = await dispatch.dispatchFileProcessing(SPACE, id, { bytes: MAX_MEDIA_BYTES + 1, sha256: HASH });
      assert.equal(r.embeddingStatus, 'skipped');
    } },
  { name: 'dispatch: a media file is queued (pending, and its job)', ext: 'png', entries: ['server/src/files/dispatch.ts:dispatchFileProcessing'], status: 'pending',
    run: async (id) => {
      await seed(id, { embeddingStatus: undefined, sha256: 'd'.repeat(64) });
      const r = await dispatch.dispatchFileProcessing(SPACE, id, { bytes: 500, sha256: HASH });
      assert.equal(r.embeddingStatus, 'pending');
    } },
  { name: 'dispatch: a document is queued', entries: ['server/src/files/dispatch.ts:dispatchFileProcessing'], status: 'pending',
    run: async (id) => {
      await seed(id, { embeddingStatus: undefined, sha256: 'd'.repeat(64) });
      const r = await dispatch.dispatchFileProcessing(SPACE, id, { bytes: 50, sha256: HASH });
      assert.equal(r.embeddingStatus, 'pending');
    } },
];

describe('recording a file\'s processing state never stamps its authored half (real MongoDB)', { skip }, () => {
  before(async () => {
    embedder = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    const local = await listenOnLoopback(embedder);
    process.env['EMBEDDING_URL'] = local.url;
    embedder.closeLocal = local.close;

    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: [{ id: SPACE, label: 'General' }, { id: DOCS_OFF, label: 'Documents off', documentExtraction: 'off' }],
      networks: [], tokens: [],
      maxDocumentConversionBytes: MAX_CONVERSION_BYTES,
      mediaEmbedding: { maxFileSizeBytes: MAX_MEDIA_BYTES, workerPollIntervalMs: 100, workerMaxPollIntervalMs: 200 },
    }, null, 2));
    mongo = await openTestMongo('procstate');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    jobQueue = await import('../../server/dist/files/media/job-queue.js');
    dispatch = await import('../../server/dist/files/dispatch.js');
    worker = await import('../../server/dist/files/media/worker.js');
  });

  after(async () => {
    try { worker?.stopMediaEmbeddingWorker(); } catch { /* never started */ }
    await closeTestMongo();
    await embedder?.closeLocal?.();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  for (const c of CASES) {
    it(`${c.name}: updatedAt and seq are exactly what they were`, async () => {
      const id = `${c.name.replace(/[^a-z0-9]+/gi, '-')}.${c.ext ?? 'md'}`;
      // A case starts from an empty queue: `retryFailedJobs` resets EVERY failed job of the space, so a job an earlier
      // case left behind would be counted, and a running worker would claim it.
      await jobs().deleteMany({});
      await c.run(id);
      const after = await authoredHalf(id);
      assert.equal(after.row.embeddingStatus, c.status,
        `the writer was meant to leave '${c.status}'; it left '${after.row.embeddingStatus}' — the case drove nothing, so it proves nothing`);
      assert.equal(after.updatedAt, POISON,
        `${c.name} stamped updatedAt (${after.updatedAt}). It is hashed and replicates: a status mark that moves it makes two `
        + 'instances holding the same data disagree');
      assert.equal(after.seq, POISON_SEQ, `${c.name} moved seq: a status mark is not an authored write`);
      assert.equal(after.description, 'written by a person');
      assert.deepEqual(after.tags, []);
      assert.equal(after.author, 'peer-1');
    });
  }

  it('dispatch: a document in a space with document extraction off is skipped', async () => {
    const id = 'off.md';
    await seed(id, { embeddingStatus: undefined, sha256: 'd'.repeat(64) }, DOCS_OFF);
    const r = await dispatch.dispatchFileProcessing(DOCS_OFF, id, { bytes: 50, sha256: HASH });
    assert.equal(r.embeddingStatus, 'skipped');
    const after = await authoredHalf(id, DOCS_OFF);
    assert.equal(after.row.embeddingStatus, 'skipped');
    assert.equal(after.updatedAt, POISON, 'the documents-off skip stamped updatedAt');
    assert.equal(after.seq, POISON_SEQ);
  });

  describe('the media worker, through the loop that claims a job', () => {
    /** Run the worker until the job for `id` is terminal (or retrying), then stop it. */
    async function runWorkerOn(id, bytes) {
      const dir = path.join(process.env['DATA_ROOT'], 'files', SPACE);
      fs.mkdirSync(path.dirname(path.join(dir, id)), { recursive: true });
      fs.writeFileSync(path.join(dir, id), bytes);
      // Only this file's job may be in the queue: the worker claims whatever is there, and the cases above left jobs for
      // files that have no bytes (the worker reconciles those by deleting their rows).
      await jobs().deleteMany({});
      await seed(id, { embeddingStatus: undefined, sizeBytes: bytes.length });
      // Enqueueing stamps the row today; the poison goes back AFTER it, so what is measured is the worker.
      await jobQueue.enqueueTextJob(SPACE, id, 'md');
      await files().updateOne({ _id: id }, { $set: { updatedAt: POISON, seq: POISON_SEQ, embeddingStatus: 'pending' } });
      worker.startMediaEmbeddingWorker();
      try {
        // Terminal on BOTH rows: the job's status and the file's are two writes, the job's first, so a read between them sees a
        // finished job and a file still `processing` (it failed that way when the machine was busy).
        await waitFor(async () => ['complete', 'failed'].includes((await jobs().findOne({ _id: id }))?.status)
          && !['pending', 'processing'].includes((await files().findOne({ _id: id }))?.embeddingStatus),
          30_000, 100, async () => `the worker never finished the job for ${id}: ${JSON.stringify(await jobs().findOne({ _id: id }))} `
            + `/ file ${JSON.stringify(await files().findOne({ _id: id }, { projection: { embeddingStatus: 1 } }))}`);
      } finally {
        worker.stopMediaEmbeddingWorker();
      }
    }

    it('processing and completing a document leave updatedAt and seq alone', async () => {
      const id = 'worker-ok.md';
      await runWorkerOn(id, Buffer.from('# Title\n\nA short document the pipeline converts and embeds.\n'));
      const after = await authoredHalf(id);
      assert.equal(after.row.embeddingStatus, 'complete', `the document did not complete: ${JSON.stringify(after.row)}`);
      assert.equal(after.updatedAt, POISON,
        'the worker (its processing mark, the completion, or the conversion result) stamped updatedAt');
      assert.equal(after.seq, POISON_SEQ);
      assert.equal(after.description, 'written by a person', 'the derived description replaced a person\'s');
    });

    it('a document the pipeline refuses permanently is marked skipped, and nothing authored moves', async () => {
      const id = 'worker-too-large.md';
      await runWorkerOn(id, Buffer.from(`# Big\n\n${'x'.repeat(MAX_CONVERSION_BYTES * 2)}\n`));
      const after = await authoredHalf(id);
      // `skipped` by the permanent-failure mark, then the job fails: failJob marks the file `failed` last.
      assert.ok(['skipped', 'failed'].includes(after.row.embeddingStatus), `unexpected status ${after.row.embeddingStatus}`);
      assert.equal(after.updatedAt, POISON, 'the permanent-failure mark or failJob stamped updatedAt');
      assert.equal(after.seq, POISON_SEQ);
    });
  });
});

describe('every writer of a file\'s processing state is driven by a case above', () => {
  it('each function the tree writes processing state from is reached from an entry point a case drives', () => {
    const INDEX = moduleIndex('server/src');
    return import('../../server/dist/config/types.js').then(({ BRAIN_COLLECTIONS }) => {
      const records = recordWrites(INDEX, { collections: BRAIN_COLLECTIONS, floors: { space: 150 }, recordFloor: 50 });
      const writes = fileRowWrites(INDEX, records);
      // A writer is one of two things, and both must be driven:
      //  - a function that calls `setFileProcessingState` (the module every processing write goes through since D7), and
      //  - a write to a files collection that touches a processing field OUTSIDE that module. The rule gate refuses such
      //    a write, so the set is empty on a healthy tree; it is read here as well because a bypass that slipped past
      //    that gate must still be one a case reaches.
      const callers = [];
      for (const [key, entry] of INDEX.bodies) {
        if (entry.alias || entry.file === PROCESSING_STATE) continue;
        if (callsIn(entry.body, { closures: true }).has('setFileProcessingState')) callers.push(key);
      }
      // The floor: derived from the imports, not a number. Every file that imports the setter must be found to call it,
      // or the call scan is reading the wrong thing and an empty `callers` would pass every loop below.
      const importers = [...INDEX.imports].filter(([file, names]) =>
        file !== PROCESSING_STATE && [...names.values()].some(i => i.file === PROCESSING_STATE && i.exported === 'setFileProcessingState'))
        .map(([file]) => file);
      assert.ok(importers.length >= 1, 'no file imports setFileProcessingState — the derivation is broken');
      for (const file of importers) {
        assert.ok(callers.some(k => k.startsWith(`${file}:`)),
          `${file} imports setFileProcessingState and no function of it was found calling it — the call scan is broken`);
      }
      assert.ok(INDEX.bodies.has(`${PROCESSING_STATE}:setFileProcessingState`),
        'the setter is not in the call-graph index — re-anchor, or the walk cannot reach its write');
      const outside = writes
        .filter(w => w.file !== PROCESSING_STATE && processingTouched(w).fields.length > 0 && !(w.name in NOT_A_PROCESSING_MARK))
        .map(w => w.key);
      // The setter itself: reaching it proves the walk follows an import into the module that holds the one write.
      const writers = [...callers, ...outside, `${PROCESSING_STATE}:setFileProcessingState`];

      const entries = [...new Set(CASES.flatMap(c => c.entries))];
      // The worker loop reaches `processJob` through a closure it hands the slot pool.
      const roots = [...entries, 'server/src/files/media/worker.ts:startMediaEmbeddingWorker'];
      const reached = walkFrom(INDEX, roots, { closures: true }).seen;
      const missing = [...new Set(writers)].filter(k => !reached.has(k));
      assert.deepEqual(missing, [],
        'these write a file\'s processing state and no case above drives an entry point that reaches them. Add a case that '
        + 'drives the writer and asserts updatedAt is unchanged, so the writer cannot start stamping it unseen');
    });
  });
});
