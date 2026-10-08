/**
 * CHARACTERIZATION (bundle-89): what the REAL media worker leaves on a file's own row, and on the rows that hang from it, for an image,
 * an audio file, a video and a document — from the dispatcher that queues the job to the terminal state of the job. Written against the
 * unmodified base 429e6d25 and green there.
 *
 * ## Why this is the test that catches a dropped write
 *
 * The derived-field writers have their own files (`a-derived-field-writers-store-exactly-what-they-store-db`, `the-media-embedders-
 * store-exactly-what-they-store-db`, `a-conversion-store-writes-exactly-what-it-writes-db`, `a-face-embedder-stores-exactly-what-it-
 * stores-db`). Each holds one writer to what it writes. What none of them can see is the COMPOSITION: the worker calls the processing
 * mark, the embedder, `updateFileMeta` for the excerpt, `setDerivedDescriptionIfUnset` for the description and the completion mark, in
 * that order, and bundle-89 moves every one of those writes behind a single module. A move that keeps each writer correct and loses one
 * CALL — the excerpt that is no longer written, the description whose source label is gone, the status that stays `processing` — is
 * invisible to every per-writer file and visible here, because here the row is read after the whole job.
 *
 * Nothing is stubbed but the model endpoints (vision, speech, embedding) and the `ffmpeg` binary, which is answered at the spawn
 * boundary exactly as `the-media-embedders-store-exactly-what-they-store-db` does. The dispatcher, the job queue, the worker's claim
 * and lease, the embedders, the conversion pipeline and every write are production's.
 *
 * ## What is pinned
 *
 * For each class: the row the dispatcher leaves before the worker runs (`pending`, the media type, no stamp), the row after the job
 * (status, description and its source, excerpt, chunk count), whether the AUTHORED half moved (`seq`/`updatedAt` move for a description,
 * not for the excerpt or the status), the rows that hang from it, and the job. Plus the three terminal shapes besides success: a
 * partial result, a permanent failure (a stored file that cannot be decoded), and a source that was deleted while queued.
 *
 * ## What is NOT pinned
 *
 * A job whose file is flagged `deletedAt` mid-run (bundle-89 changes what it writes), and what the worker does to the SPACE COUNTER when
 * its description write lands nothing (E1: today a number is taken for it; the bundle stops that).
 *
 * Run: node --test testing/standalone/the-media-worker-leaves-the-file-row-as-it-leaves-it-db.test.js
 * (requires a prior `npm run build` in server/ and the test MongoDB, which must be a replica set)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const skip = await mongoSkipReason();

const SPACE = 'worker';
const DIMS = 4;
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const REFUSED = 'REFUSE-THIS-TEXT';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89c-worker-'));
const CONFIG_PATH = path.join(scratch, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = scratch;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
delete process.env['YTHRIL_MASTER_KEY'];
delete process.env['YTHRIL_MASTER_PASSPHRASE'];

// ── ffmpeg, answered at the spawn boundary ───────────────────────────────────────────────────────────────────────
const realSpawn = cp.spawn;
const ff = { durationS: 10, silenceStderr: '' };
cp.spawn = (cmd, ...rest) => {
  if (cmd !== 'ffmpeg') return realSpawn(cmd, ...rest);
  const args = rest[0];
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const last = String(args[args.length - 1]);
  let stderr = '';
  if (args.includes('-af')) stderr = ff.silenceStderr;
  else if (last === '-') stderr = `Duration: 00:00:${String(ff.durationS).padStart(2, '0')}.00, start: 0.000000`;
  else if (last.includes('%06d')) fs.writeFileSync(last.replace('%06d', '000001'), 'jpeg');
  else fs.writeFileSync(last, 'wav');
  setImmediate(() => { if (stderr) proc.stderr.emit('data', Buffer.from(stderr)); proc.emit('close', 0); });
  return proc;
};
syncBuiltinESMExports();

let mongo, loader, stored, worker, dispatch, metaMod, sandbox, lifecycle;
let embedServer, embedLocal, visionServer, visionLocal, sttServer, sttLocal;
let caption, transcribeOf, sttCalls;

const files = () => mongo.col(`${SPACE}_files`);
const jobs = () => mongo.col(`${SPACE}_media_jobs`);
const jobOf = (id) => jobs().findOne({ _id: id });
const rowOf = (id) => files().findOne({ _id: id });
const derivedIds = async (id) => (await files().find({ parentFileId: id }).project({ _id: 1 }).sort({ _id: 1 }).toArray()).map(r => r._id);

/** The fields a worker run is allowed to have written on a file's own row, read as one object (absent keys are absent). */
const pick = (row, keys) => Object.fromEntries(keys.filter(k => k in row).map(k => [k, row[k]]));
const PROCESSING = ['embeddingStatus', 'mediaType', 'mediaJobError', 'chunkCount', 'convertedFileId', 'conversionError'];
const DERIVED = ['description', 'descriptionSource', 'excerpt'];

/**
 * Store a file the way an upload does (bytes, then the row, then the dispatcher), run the worker until the job ends, and hand back
 * the rows. `description` is what a PERSON wrote on upload. `before` is the row as the dispatcher left it, before any worker ran.
 */
async function run({ rel, bytes, contentType, description, until = ['complete', 'failed'] }) {
  const abs = path.join(sandbox.spaceRoot(SPACE), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await stored.writeStored(abs, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await metaMod.upsertFileMeta(SPACE, rel, bytes.length, { ...(description !== undefined ? { description } : {}), sha256 });
  await dispatch.dispatchFileProcessing(SPACE, rel, { bytes: bytes.length, sha256, contentType });
  const before = await rowOf(rel);
  worker.startMediaEmbeddingWorker();
  try {
    await waitFor(async () => (typeof until === 'function' ? until(await jobOf(rel)) : until.includes((await jobOf(rel))?.status)), 60_000, 100,
      async () => `the worker never ended the job for ${rel}: ${JSON.stringify(await jobOf(rel))}`);
  } finally {
    worker.stopMediaEmbeddingWorker();
  }
  return { before, after: await rowOf(rel), job: await jobOf(rel), abs };
}

describe('the real media worker leaves the file row as it leaves it today (real MongoDB, model endpoints and ffmpeg stubbed)', { skip }, () => {
  before(async () => {
    embedServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        if (String(input).includes(REFUSED)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'refused' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    embedLocal = await listenOnLoopback(embedServer);
    process.env['EMBEDDING_URL'] = embedLocal.url;
    visionServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: caption() } })); });
    });
    visionLocal = await listenOnLoopback(visionServer);
    sttServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        sttCalls.push(req.url);
        const r = transcribeOf(sttCalls.length);
        if (r === null) { res.writeHead(500); res.end('stt down'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r));
      });
    });
    sttLocal = await listenOnLoopback(sttServer);

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      ...LOCAL, spaces: [{ id: SPACE, label: 'Worker' }], networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('b89c_worker');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    loader.getConfig().mediaEmbedding = {
      visionProvider: 'local', vision: { baseUrl: visionLocal.url, model: 'fake' },
      stt: { baseUrl: sttLocal.url, model: 'fake' },
      levels: { images: 'caption', video: 'full' },
      workerPollIntervalMs: 100, workerMaxPollIntervalMs: 200,
      faceRecognition: { enabled: false },
    };
    stored = await import('../../server/dist/files/stored-bytes.js');
    worker = await import('../../server/dist/files/media/worker.js');
    dispatch = await import('../../server/dist/files/dispatch.js');
    metaMod = await import('../../server/dist/files/file-meta.js');
    sandbox = await import('../../server/dist/files/sandbox.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    await lifecycle.initSpace(SPACE, { waitForVectorReady: false });
  });

  after(async () => {
    try { worker?.stopMediaEmbeddingWorker(); } catch { /* never started */ }
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
    await closeTestMongo();
    await embedLocal?.close(); await visionLocal?.close(); await sttLocal?.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
    await jobs().deleteMany({});
    caption = () => 'a grey rectangle on a table';
    transcribeOf = () => ({ text: 'welcome to the call', segments: [] });
    sttCalls = [];
    ff.durationS = 10; ff.silenceStderr = '';
  });

  describe('an image', () => {
    it('the dispatcher marks it pending with its media type and stamps nothing; the worker then describes it: caption as description (source `generated`), status complete, and ONE caption chunk', async () => {
      const { before, after, job } = await run({ rel: 'photos/p.png', bytes: Buffer.from('png-bytes'), contentType: 'image/png' });

      assert.deepEqual(pick(before, PROCESSING), { embeddingStatus: 'pending', mediaType: 'image' });
      assert.ok(!('description' in before));
      assert.equal(job.status, 'complete');
      assert.deepEqual(pick(after, [...PROCESSING, ...DERIVED]), {
        embeddingStatus: 'complete', mediaType: 'image', description: 'a grey rectangle on a table', descriptionSource: 'generated',
      });
      assert.ok(after.seq > before.seq, 'a derived DESCRIPTION is an authored write: it advances the seq');
      assert.ok(after.updatedAt > before.updatedAt);
      assert.deepEqual(await derivedIds('photos/p.png'), ['photos/p.png#media-chunk0']);
      assert.equal(after.sha256, before.sha256, 'the hash of the bytes is untouched');
      assert.deepEqual(after.author, before.author);
    });

    it('a description a person wrote on upload is kept, with no source label, and the authored half does not move: the caption lives on the chunk', async () => {
      const { before, after, job } = await run({ rel: 'photos/mine.png', bytes: Buffer.from('png-bytes-2'), contentType: 'image/png', description: 'my own words' });
      assert.equal(job.status, 'complete');
      assert.equal(after.description, 'my own words');
      assert.ok(!('descriptionSource' in after));
      assert.equal(after.embeddingStatus, 'complete');
      assert.equal(after.seq, before.seq, 'processing wrote to the authored half');
      assert.equal(after.updatedAt, before.updatedAt);
      assert.equal((await rowOf('photos/mine.png#media-chunk0')).content, 'a grey rectangle on a table');
    });
  });

  describe('an audio file', () => {
    it('is transcribed into chunk rows and ends complete; the worker writes NO description for audio, and the authored half does not move', async () => {
      const { before, after, job } = await run({ rel: 'calls/q3.wav', bytes: Buffer.from('RIFF-audio'), contentType: 'audio/wav' });

      assert.deepEqual(pick(before, PROCESSING), { embeddingStatus: 'pending', mediaType: 'audio' });
      assert.equal(job.status, 'complete');
      assert.deepEqual(pick(after, [...PROCESSING, ...DERIVED]), { embeddingStatus: 'complete', mediaType: 'audio' });
      assert.equal(after.seq, before.seq);
      assert.equal(after.updatedAt, before.updatedAt);
      assert.deepEqual(await derivedIds('calls/q3.wav'), ['calls/q3.wav#media-chunk0']);
      const chunk = await rowOf('calls/q3.wav#media-chunk0');
      assert.equal(chunk.content, 'welcome to the call');
      assert.equal(chunk.embedding.length, DIMS);
    });

    it('a chunk that failed to transcribe makes the file `partial`, not complete, and the job still completes', async () => {
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      transcribeOf = (n) => (n === 1 ? null : { text: 'the second chunk', segments: [] });
      const { after, job } = await run({ rel: 'calls/partial.wav', bytes: Buffer.from('RIFF-partial'), contentType: 'audio/wav' });
      assert.equal(job.status, 'complete');
      assert.equal(after.embeddingStatus, 'partial');
      assert.deepEqual(await derivedIds('calls/partial.wav'), ['calls/partial.wav#media-chunk1']);
    });
  });

  describe('a video', () => {
    it('at the instance\'s `full` video level: audio chunks re-embedded with the keyframe caption, status complete, no description written for the file', async () => {
      const { before, after, job } = await run({ rel: 'calls/q3.mp4', bytes: Buffer.from('mp4-bytes'), contentType: 'video/mp4' });

      assert.deepEqual(pick(before, PROCESSING), { embeddingStatus: 'pending', mediaType: 'video' });
      assert.equal(job.status, 'complete');
      assert.deepEqual(pick(after, [...PROCESSING, ...DERIVED]), { embeddingStatus: 'complete', mediaType: 'video' });
      assert.equal(after.seq, before.seq);
      assert.deepEqual(await derivedIds('calls/q3.mp4'), ['calls/q3.mp4#media-chunk0']);
      assert.equal((await rowOf('calls/q3.mp4#media-chunk0')).content, '[visual at 0s]: a grey rectangle on a table\nwelcome to the call');
    });

    it('an audio chunk that failed to transcribe makes the video `partial`', async () => {
      ff.durationS = 70; ff.silenceStderr = 'silence_start: 35\nsilence_end: 40\n';
      transcribeOf = (n) => (n === 1 ? null : { text: 'second', segments: [] });
      const { after, job } = await run({ rel: 'calls/partial.mp4', bytes: Buffer.from('mp4-partial'), contentType: 'video/mp4' });
      assert.equal(job.status, 'complete');
      assert.equal(after.embeddingStatus, 'partial');
    });
  });

  describe('a document', () => {
    const MD = '# Quarterly report\n\nRevenue grew in every region this quarter.\n\n## Costs\n\nCosts fell in the second half of the year.\n';

    it('is converted into chunk rows; the file\'s row carries chunkCount, an excerpt and a description with its source, and ends complete', async () => {
      const { before, after, job } = await run({ rel: 'docs/report.md', bytes: Buffer.from(MD), contentType: 'text/markdown' });

      assert.deepEqual(pick(before, PROCESSING), { embeddingStatus: 'pending' });
      assert.equal(job.status, 'complete');
      assert.equal(after.embeddingStatus, 'complete');
      const chunks = await derivedIds('docs/report.md');
      assert.ok(chunks.length >= 1 && chunks.every(id => id.startsWith('docs/report.md#chunk')), `chunk rows: ${JSON.stringify(chunks)}`);
      assert.equal(after.chunkCount, chunks.length, 'chunkCount on the file is the number of chunk rows');
      assert.equal(typeof after.excerpt, 'string');
      assert.ok(after.excerpt.startsWith('Quarterly report Revenue grew in every region this quarter.'), `the excerpt is the document's own opening prose: ${after.excerpt}`);
      // No model is configured for the description, so it is the extractive one: the same opening prose, labelled as extracted.
      assert.equal(after.description, after.excerpt);
      assert.equal(after.descriptionSource, 'extracted');
      assert.ok(!('convertedFileId' in after), 'a markdown file has no converted copy');
      for (const id of chunks) assert.equal((await rowOf(id)).embedding.length, DIMS);
    });

    it('the EXCERPT is a local write (no seq, no updatedAt) and the DESCRIPTION is the authored one: a person\'s own description is kept and the excerpt still lands', async () => {
      const { before, after, job } = await run({ rel: 'docs/mine.md', bytes: Buffer.from(MD + '\nmine\n'), contentType: 'text/markdown', description: 'what I say it is' });
      assert.equal(job.status, 'complete');
      assert.equal(after.description, 'what I say it is');
      assert.ok(!('descriptionSource' in after));
      assert.equal(typeof after.excerpt, 'string', 'the excerpt goes in even when a person wrote the description');
      assert.equal(after.seq, before.seq, 'neither the excerpt nor the processing marks stamp a seq');
      assert.equal(after.updatedAt, before.updatedAt);
    });

    it('a chunk the embedder refuses makes the document `partial`; the refused chunk is stored without a vector', async () => {
      const body = (word) => `${word} `.repeat(120).trim();
      const md = `# One\n\n${body('alpha')}.\n\n# Two\n\n${REFUSED} ${body('beta')}.\n\n# Three\n\n${body('gamma')}.\n`;
      const { after, job } = await run({ rel: 'docs/partial.md', bytes: Buffer.from(md), contentType: 'text/markdown' });
      assert.equal(job.status, 'complete');
      assert.equal(after.embeddingStatus, 'partial');
      const rows = await files().find({ parentFileId: 'docs/partial.md' }).sort({ chunkIndex: 1 }).toArray();
      assert.ok(rows.length >= 3, `fixture: ${rows.length} chunk(s)`);
      assert.ok(rows.some(r => !('embedding' in r)), 'a refused chunk is stored without a vector');
      assert.ok(rows.some(r => 'embedding' in r), 'and the others keep theirs');
      assert.equal(after.chunkCount, rows.length);
    });

    it('when EVERY chunk is refused the job goes back to pending with the error and a retry time — and no status is written for the file', async () => {
      const { after, job } = await run({ rel: 'docs/refused.md', bytes: Buffer.from(`# Only\n\n${REFUSED} the whole document.\n`), contentType: 'text/markdown', until: (j) => j?.lastError != null || ['complete', 'failed'].includes(j?.status) });
      assert.equal(job.status, 'pending');
      assert.equal(job.attempts, 1);
      assert.equal(job.lastError, 'All 1 chunk(s) failed to embed');
      assert.equal(typeof job.claimableAfter, 'string', 'a retry is scheduled, not immediate');
      assert.equal(after.embeddingStatus, 'processing', 'the file stays at the status the worker set when it began: the job, not the row, carries the retry');
    });
  });

  describe('the terminal shapes besides success', () => {
    it('a stored file that cannot be decoded fails PERMANENTLY at once: the file reads `failed`, the job is failed with an error, and nothing is derived', async () => {
      process.env['YTHRIL_MASTER_KEY'] = crypto.randomBytes(32).toString('base64');
      stored.resetStoredKeyCacheForTests();
      const rel = 'photos/locked.png';
      const abs = path.join(sandbox.spaceRoot(SPACE), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      await stored.writeStored(abs, crypto.randomBytes(100));
      // A different key from here on: the file is present and cannot be read.
      process.env['YTHRIL_MASTER_KEY'] = crypto.randomBytes(32).toString('base64');
      stored.resetStoredKeyCacheForTests();
      await metaMod.upsertFileMeta(SPACE, rel, 100, {});
      await dispatch.dispatchFileProcessing(SPACE, rel, { bytes: 100, sha256: 'ee'.repeat(32), contentType: 'image/png' });

      worker.startMediaEmbeddingWorker();
      try {
        await waitFor(async () => ['complete', 'failed'].includes((await jobOf(rel))?.status), 60_000, 100, async () => JSON.stringify(await jobOf(rel)));
      } finally { worker.stopMediaEmbeddingWorker(); delete process.env['YTHRIL_MASTER_KEY']; stored.resetStoredKeyCacheForTests(); }

      const job = await jobOf(rel);
      const row = await rowOf(rel);
      assert.equal(job.status, 'failed');
      assert.equal(typeof job.lastError, 'string');
      assert.equal(row.embeddingStatus, 'failed');
      assert.deepEqual(await derivedIds(rel), []);
    });

    it('a source deleted while its job was queued is reconciled, never retried: the job and the orphaned row are removed', async () => {
      const rel = 'photos/gone.png';
      const bytes = Buffer.from('png-gone');
      const abs = path.join(sandbox.spaceRoot(SPACE), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      await stored.writeStored(abs, bytes);
      await metaMod.upsertFileMeta(SPACE, rel, bytes.length, {});
      await dispatch.dispatchFileProcessing(SPACE, rel, { bytes: bytes.length, sha256: 'ff'.repeat(32), contentType: 'image/png' });
      fs.rmSync(abs);

      worker.startMediaEmbeddingWorker();
      try {
        await waitFor(async () => (await jobOf(rel)) === null, 60_000, 100, async () => JSON.stringify(await jobOf(rel)));
      } finally { worker.stopMediaEmbeddingWorker(); }

      assert.equal(await jobOf(rel), null, 'the job is gone');
      assert.equal(await rowOf(rel), null, 'the orphaned row is gone');
      assert.deepEqual(await derivedIds(rel), []);
    });
  });
});
