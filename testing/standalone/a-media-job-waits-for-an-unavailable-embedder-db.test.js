/**
 * A media job whose run found the embedder UNAVAILABLE for the whole of it waits for the embedder, without spending its attempts.
 *
 * ## The defect
 *
 * A file's run that met an unreachable embedder was failed like a file that cannot be processed: the claim counts an attempt,
 * `failJob` keeps it, and three attempts (30 s, then 2 minutes) end the job `failed` in about two and a half minutes, which is
 * shorter than a container restart or an upgrade of the embedder. Every file uploaded in that window ended `failed` and stayed so.
 *
 * ## The rules held here, each through the real queue and the real run (`runOneMediaJob`, one run at a time, the back-off cleared
 * between runs), against a real embed call: a closed port, or a local endpoint answering a status
 *
 *  1. A text file, an image and an audio file whose run met an unavailable embedder for ALL of it are handed back: `pending`, the
 *     attempt refunded, `outageFailures` raised, `progress` gone, `lastError` scrubbed of the endpoint's address, `claimableAfter`
 *     from the media queue's own schedule (never more than its longest step away), the file row not `failed`, and
 *     `ythril_media_jobs_handed_back_total` moved once per hand-back.
 *  2. Past `MEDIA_OUTAGE_HAND_BACKS_MAX` hand-backs the failure path takes the job and spends the attempt.
 *  3. A whole new run (a manual retry) and a finished job drop the outage count.
 *  4. Isolation stays: one passage of several meeting a busy endpoint ends the file `partial`, the job `complete`, nothing handed
 *     back; a document whose every passage is refused (a 400) still spends an attempt.
 *  5. A run stops calling a dead embedder: after as many unavailable failures as its embed concurrency with nothing embedded, the
 *     rest are counted without a call; audio stops before its next transcription.
 *  6. Audio decides on ATTEMPTED embeds: a silent chunk is not an attempt, and a run whose every chunk failed to TRANSCRIBE spends
 *     an attempt whatever the embedder's state.
 *  7. The hand-back is under the run's claim: a lost claim writes nothing; a write that fails for another reason falls through to
 *     the failure path; the refund never goes below zero.
 *
 * Nothing is stubbed but the model endpoints and the `ffmpeg` binary (answered at the spawn boundary, as
 * `the-media-worker-leaves-the-file-row-as-it-leaves-it-db.test.js` does).
 *
 * Needs a MongoDB: `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-media-job-waits-for-an-unavailable-embedder-db.test.js
 * (requires a prior `npm run build:server`)
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
import { metricSeries } from './_metric-series.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const SPACE = 'outagewait';
const DIMS = 4;
/** The longest step of the media queue's own schedule: a waiting file is never further away than this. */
const LONGEST_STEP_MS = 5 * 60_000;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-outagewait-'));
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
  // The silencedetect pass prints the Duration line too, as the real ffmpeg does (probe P1, Q-984).
  if (args.includes('-af')) stderr = `  Duration: 00:00:${String(ff.durationS).padStart(2, '0')}.00, start: 0.000000, bitrate: 256 kb/s\n${ff.silenceStderr}`;
  else if (last === '-') stderr = `Duration: 00:00:${String(ff.durationS).padStart(2, '0')}.00, start: 0.000000`;
  else if (last.includes('%06d')) fs.writeFileSync(last.replace('%06d', '000001'), 'jpeg');
  else fs.writeFileSync(last, 'wav');
  setImmediate(() => { if (stderr) proc.stderr.emit('data', Buffer.from(stderr)); proc.emit('close', 0); });
  return proc;
};
syncBuiltinESMExports();

let mongo, loader, stored, worker, queue, dispatch, metaMod, sandbox, lifecycle, providersMod, concurrencyMod;
let embedServer, embedLocal, visionServer, visionLocal, sttServer, sttLocal, closedUrl;
/** How the live embed endpoint answers one input: a status number, or nothing for a vector. */
let embedAnswer;
/** How long the live endpoint holds a vector answer to call number `n`, ms. */
let embedDelayMs;
let embedCalls;
let transcribeOf, sttCalls;
let providers;

const files = () => mongo.col(`${SPACE}_files`);
const jobs = () => mongo.col(`${SPACE}_media_jobs`);
const jobOf = (id) => jobs().findOne({ _id: id });
const rowOf = (id) => files().findOne({ _id: id });
const at = (iso) => new Date(iso).getTime();

/** The embed endpoint the next runs use: the closed port, or the live one answering by `embedAnswer`. */
const useClosedEmbedder = () => { process.env['EMBEDDING_URL'] = closedUrl; };
const useLiveEmbedder = () => { process.env['EMBEDDING_URL'] = embedLocal.url; };

const handedBack = async (mediaType) =>
  (await metricSeries('ythril_media_jobs_handed_back_total', { labels: { space: SPACE, media_type: mediaType }, absent: 'null' }))?.[0]?.value ?? 0;

/** Store a file the way an upload does: bytes, the row, then the dispatcher, which queues its job. */
async function upload(rel, bytes, contentType) {
  const abs = path.join(sandbox.spaceRoot(SPACE), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await stored.writeStored(abs, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await metaMod.upsertFileMeta(SPACE, rel, bytes.length, { sha256 });
  await dispatch.dispatchFileProcessing(SPACE, rel, { bytes: bytes.length, sha256, contentType });
  assert.equal((await jobOf(rel))?.status, 'pending', `fixture check: no job was queued for ${rel}`);
}

/** One run of the job of `rel`, as the worker makes it: its back-off cleared (the minutes passing), claimed, run. The job after it. */
async function runOnce(rel) {
  await jobs().updateOne({ _id: rel }, { $set: { claimableAfter: new Date(Date.now() - 1_000).toISOString() } });
  queue.markSpaceMayHaveWork(SPACE);
  const job = await queue.claimNextJob([SPACE]);
  assert.equal(job?._id, rel, `fixture check: the claim returned ${JSON.stringify(job?._id)}, not ${rel}`);
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    await worker.runOneMediaJob(job, providers);
  } finally { Object.assign(console, saved); }
  return jobOf(rel);
}

/** A markdown document of `n` passages, each long enough to be a passage of its own; `mark(i)` adds a word to passage `i`. */
function document(n, mark = () => '') {
  const body = (i) => `${mark(i)} ${`word${i} `.repeat(120).trim()}`.trim();
  return Array.from({ length: n }, (_, i) => `# Part ${i}\n\n${body(i)}.\n`).join('\n');
}

/** Assert the shape of a job that waits: pending, no attempt spent, the count, a wait within the schedule, no step report. */
function assertWaiting(job, outageFailures, what) {
  assert.equal(job.status, 'pending', `${what}: the job is ${job.status}, not waiting`);
  assert.equal(job.attempts, 0, `${what}: an attempt was spent on an embedder that was unavailable`);
  assert.equal(job.outageFailures, outageFailures, `${what}: outageFailures is ${job.outageFailures}`);
  assert.ok(!('progress' in job), `${what}: the step report of the dead run is still on the job: ${JSON.stringify(job.progress)}`);
  assert.equal(job.claimToken ?? null, null, `${what}: the job still carries the run's claim`);
  const wait = at(job.claimableAfter) - Date.now();
  assert.ok(wait > 0 && wait <= LONGEST_STEP_MS, `${what}: claimableAfter is ${wait} ms away, not within the queue's own schedule`);
  assert.equal(typeof job.lastError, 'string', `${what}: no lastError`);
}

describe('a media job waits for an unavailable embedder (real MongoDB, model endpoints and ffmpeg stubbed)', { skip }, () => {
  before(async () => {
    embedServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        const call = ++embedCalls;
        const input = String(JSON.parse(body).input);
        const status = embedAnswer(input, call);
        if (status) { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(`status ${status}`); return; }
        const delay = embedDelayMs(call);
        if (delay > 0) await elapse(delay, 'simulated latency: a vector still in flight when the run has stopped calling a dead embedder');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((input.length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    embedLocal = await listenOnLoopback(embedServer);
    // A port that was listening and is not: the connection is refused, as for an embedder that is down.
    const gone = await listenOnLoopback(http.createServer(() => {}));
    closedUrl = gone.url;
    await gone.close();

    visionServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: 'a grey rectangle' } })); });
    });
    visionLocal = await listenOnLoopback(visionServer);
    sttServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        sttCalls++;
        const r = transcribeOf(sttCalls);
        if (r === null) { res.writeHead(500); res.end('stt down'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r));
      });
    });
    sttLocal = await listenOnLoopback(sttServer);

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'local-instance', instanceLabel: 'Local', spaces: [{ id: SPACE, label: 'Outage' }], networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('outagewait');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    const media = {
      visionProvider: 'local', vision: { baseUrl: visionLocal.url, model: 'fake' },
      stt: { baseUrl: sttLocal.url, model: 'fake' },
      levels: { images: 'caption' }, faceRecognition: { enabled: false },
    };
    loader.getConfig().mediaEmbedding = media;
    stored = await import('../../server/dist/files/stored-bytes.js');
    worker = await import('../../server/dist/files/media/worker.js');
    queue = await import('../../server/dist/files/media/job-queue.js');
    dispatch = await import('../../server/dist/files/dispatch.js');
    metaMod = await import('../../server/dist/files/file-meta.js');
    sandbox = await import('../../server/dist/files/sandbox.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    providersMod = await import('../../server/dist/files/media/providers.js');
    concurrencyMod = await import('../../server/dist/files/converters/embed-concurrency.js');
    await lifecycle.initSpace(SPACE, { waitForVectorReady: false });
    providers = providersMod.createMediaProviders(media.vision, media.stt, 'local', 'local', false);
  });

  after(async () => {
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
    await closeTestMongo();
    await embedLocal?.close(); await visionLocal?.close(); await sttLocal?.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
    await jobs().deleteMany({});
    embedAnswer = () => undefined;
    embedDelayMs = () => 0;
    embedCalls = 0;
    transcribeOf = () => ({ text: 'welcome to the call', segments: [] });
    sttCalls = 0;
    ff.durationS = 10; ff.silenceStderr = '';
    useClosedEmbedder();
  });

  it('the worker exports runOneMediaJob, and the queue handBackJob and MEDIA_OUTAGE_HAND_BACKS_MAX', () => {
    assert.equal(typeof worker.runOneMediaJob, 'function', 'files/media/worker.ts has no runOneMediaJob: there is no seam to run one media job');
    assert.equal(typeof queue.handBackJob, 'function', 'files/media/job-queue.ts has no handBackJob: a job can come back only by failJob, which spends its attempt');
    assert.equal(typeof queue.MEDIA_OUTAGE_HAND_BACKS_MAX, 'number');
  });

  describe('a text file', () => {
    it('four runs against an unreachable embedder leave it waiting: pending, no attempt spent, outageFailures 4, the file not failed, four hand-backs counted', async () => {
      const rel = 'docs/report.md';
      await upload(rel, Buffer.from(document(3)), 'text/markdown');
      const counted = await handedBack('text');
      // A step report the hand-back must remove, whether or not the run's own heartbeat wrote one.
      await jobs().updateOne({ _id: rel }, { $set: { progress: { step: 'poison', steps: ['poison'] } } });
      let job;
      for (let i = 0; i < 4; i++) job = await runOnce(rel);
      assertWaiting(job, 4, 'after four runs');
      assert.ok(!/127\.0\.0\.1|https?:\/\//.test(job.lastError), `lastError names the endpoint's address: ${job.lastError}`);
      const row = await rowOf(rel);
      assert.equal(row.embeddingStatus, 'processing', 'the file row of a waiting job reads processing, never failed');
      assert.equal(row.mediaJobError, undefined);
      assert.equal(await handedBack('text'), counted + 4, 'ythril_media_jobs_handed_back_total did not move once per hand-back');
    });

    it('past MEDIA_OUTAGE_HAND_BACKS_MAX hand-backs, the failure path takes the job and spends the attempt', async () => {
      assert.equal(typeof queue.MEDIA_OUTAGE_HAND_BACKS_MAX, 'number', 'the queue names no limit of hand-backs');
      const rel = 'docs/limit.md';
      await upload(rel, Buffer.from(document(2)), 'text/markdown');
      let job;
      for (let i = 0; i < queue.MEDIA_OUTAGE_HAND_BACKS_MAX; i++) job = await runOnce(rel);
      assertWaiting(job, queue.MEDIA_OUTAGE_HAND_BACKS_MAX, 'at the limit');
      job = await runOnce(rel);
      assert.equal(job.status, 'pending', 'a failed attempt with attempts left is a retry');
      assert.equal(job.attempts, 1, 'the run past the limit did not spend its attempt');
      assert.equal(job.outageFailures, queue.MEDIA_OUTAGE_HAND_BACKS_MAX, 'the run past the limit was counted as a hand-back');
    });

    it('a manual retry (a whole new run) drops the outage count, and so does a job that finishes', async () => {
      const rel = 'docs/back.md';
      await upload(rel, Buffer.from(document(2)), 'text/markdown');
      await runOnce(rel);
      assert.equal((await jobOf(rel)).outageFailures, 1, 'fixture check: the run was handed back');
      assert.equal(await queue.retryJob(SPACE, rel), 'ok');
      assert.ok(!('outageFailures' in await jobOf(rel)), 'a manual retry kept the outage count of the run before it');

      await runOnce(rel);
      assert.equal((await jobOf(rel)).outageFailures, 1, 'fixture check: handed back again');
      useLiveEmbedder();
      const done = await runOnce(rel);
      assert.equal(done.status, 'complete');
      assert.ok(!('outageFailures' in done), 'a finished job kept its outage count');
      assert.equal((await rowOf(rel)).embeddingStatus, 'complete');
    });

    it('one passage of several meeting a busy endpoint ends the file partial and the job complete: isolation holds, nothing is handed back', async () => {
      useLiveEmbedder();
      embedAnswer = (input) => (input.includes('BUSYMARK') ? 503 : undefined);
      const rel = 'docs/one-busy.md';
      await upload(rel, Buffer.from(document(4, i => (i === 2 ? 'BUSYMARK' : ''))), 'text/markdown');
      const counted = await handedBack('text');
      const job = await runOnce(rel);
      assert.equal(job.status, 'complete');
      assert.equal(job.attempts, 1, 'the run spent something beyond its one attempt');
      assert.ok(!('outageFailures' in job), 'a run that embedded passages was handed back');
      assert.equal((await rowOf(rel)).embeddingStatus, 'partial');
      const rows = await files().find({ parentFileId: rel }).toArray();
      const unembedded = rows.filter(r => !('embedding' in r));
      assert.ok(unembedded.length >= 1 && unembedded.every(r => r.content.includes('BUSYMARK')),
        `the passages stored without a vector are not the busy one's: ${JSON.stringify(unembedded.map(r => r._id))}`);
      assert.ok(rows.some(r => 'embedding' in r), 'no passage kept its vector');
      assert.equal(await handedBack('text'), counted);
    });

    it('a document whose every passage is refused (a 400, the record\'s own failure) still spends an attempt', async () => {
      useLiveEmbedder();
      embedAnswer = () => 400;
      const rel = 'docs/refused.md';
      await upload(rel, Buffer.from('# Only\n\nThe whole document is refused.\n'), 'text/markdown');
      const job = await runOnce(rel);
      assert.equal(job.status, 'pending');
      assert.equal(job.attempts, 1, 'a refused document waited as if the embedder were down');
      assert.equal(job.lastError, 'All 1 chunk(s) failed to embed');
      assert.ok(!('outageFailures' in job));
    });

    it('a document whose every passage meets a proxy\'s 522 waits, and stops calling after as many failures as its embed concurrency', async () => {
      useLiveEmbedder();
      embedAnswer = () => 522;
      const rel = 'docs/long.md';
      const passages = 40;
      await upload(rel, Buffer.from(document(passages)), 'text/markdown');
      const unembedded = () => metricSeries('ythril_conversion_chunks_unembedded_total').then(s => s.reduce((n, x) => n + x.value, 0));
      const countedBefore = await unembedded();
      const job = await runOnce(rel);
      assert.equal(await unembedded() - countedBefore, embedCalls,
        'ythril_conversion_chunks_unembedded_total counted passages that were never sent to the embedder: every hand-back of an outage would add them all again');
      assertWaiting(job, 1, 'a 522 for every passage');
      const stored = await files().countDocuments({ parentFileId: rel });
      const concurrency = concurrencyMod.embedConcurrency(loader.getEmbeddingConfig());
      assert.ok(stored > 2 * concurrency, `fixture check: ${stored} passage(s) is not more than twice the concurrency ${concurrency}`);
      assert.ok(embedCalls < 2 * concurrency,
        `${embedCalls} embed calls for ${stored} passages: the run kept calling a dead embedder past ${concurrency} unavailable failures`);
    });

    it('a run that stopped calling and then got a vector for a call still in flight is handed back, never completed partial with passages it never sent', async () => {
      useLiveEmbedder();
      const concurrency = concurrencyMod.embedConcurrency(loader.getEmbeddingConfig());
      // The first requests (as many as the run sends at once) meet an unavailable endpoint at once; every later one is answered with a vector,
      // slowly, so it is still in flight when the run has met as many unavailable failures as its concurrency and skips the rest.
      embedAnswer = (_input, call) => (call <= concurrency ? 522 : undefined);
      embedDelayMs = () => 300;
      const rel = 'docs/cut-short.md';
      await upload(rel, Buffer.from(document(40)), 'text/markdown');
      const counted = await handedBack('text');
      const job = await runOnce(rel);
      const stored = await files().find({ parentFileId: rel }).toArray();
      assert.ok(stored.length > 2 * concurrency, `fixture check: ${stored.length} passage(s) is not clearly more than the concurrency ${concurrency}`);
      assert.ok(stored.some(r => 'embedding' in r), 'fixture check: no call in flight came back with a vector, so the run was not cut short with something embedded');
      assert.notEqual(job.status, 'complete', `a run cut short by an unavailable embedder ended complete (file ${(await rowOf(rel)).embeddingStatus}) with ${stored.filter(r => !('embedding' in r)).length} of ${stored.length} passages never sent`);
      assertWaiting(job, 1, 'a run cut short');
      assert.equal((await rowOf(rel)).embeddingStatus, 'processing');
      assert.equal(await handedBack('text'), counted + 1);
    });

    it('a hand-back write that fails for another reason than a lost claim falls through to the failure path', async () => {
      const rel = 'docs/refuses-the-write.md';
      await upload(rel, Buffer.from(document(2)), 'text/markdown');
      // The collection refuses any job that carries an outage count: the hand-back's write fails, every other write lands.
      await mongo.getDb().command({ collMod: `${SPACE}_media_jobs`, validator: { outageFailures: { $exists: false } }, validationLevel: 'strict', validationAction: 'error' });
      let job;
      try {
        job = await runOnce(rel);
      } finally {
        await mongo.getDb().command({ collMod: `${SPACE}_media_jobs`, validator: {} });
      }
      assert.equal(job.status, 'pending', 'the run ended the job some other way');
      assert.equal(job.attempts, 1, 'a hand-back that could not be written spent no attempt: the failure path did not take it');
      assert.equal(typeof job.lastError, 'string');
      assert.ok(!('outageFailures' in job), 'the refused hand-back was counted');
    });
  });

  describe('an image', () => {
    it('whose embed is unreachable waits likewise, and its lastError names no endpoint address', async () => {
      const rel = 'photos/p.png';
      await upload(rel, Buffer.from('png-bytes'), 'image/png');
      const counted = await handedBack('image');
      await runOnce(rel);
      const job = await runOnce(rel);
      assertWaiting(job, 2, 'an image after two runs');
      assert.ok(!/127\.0\.0\.1|https?:\/\//.test(job.lastError), `lastError names the endpoint's address: ${job.lastError}`);
      assert.match(job.lastError, /embedding endpoint/i, `lastError does not name the embedder: ${job.lastError}`);
      assert.notEqual((await rowOf(rel)).embeddingStatus, 'failed');
      assert.equal(await handedBack('image'), counted + 2);
    });
  });

  describe('an audio file', () => {
    it('whose every attempted embed is unavailable waits, and its run stops before the next transcription', async () => {
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      const rel = 'calls/q3.wav';
      await upload(rel, Buffer.from('RIFF-audio'), 'audio/wav');
      const job = await runOnce(rel);
      assertWaiting(job, 1, 'audio with the embedder down');
      assert.equal(sttCalls, 1, `${sttCalls} transcriptions: the run went on paying for speech-to-text after the embedder was found unavailable`);
    });

    it('a silent chunk is not an attempt: silence, then an unreachable embedder, still waits', async () => {
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      transcribeOf = (n) => (n === 1 ? { text: '', segments: [] } : { text: 'the second chunk', segments: [] });
      const rel = 'calls/quiet.wav';
      await upload(rel, Buffer.from('RIFF-quiet'), 'audio/wav');
      const job = await runOnce(rel);
      assertWaiting(job, 1, 'a silent chunk then a dead embedder');
    });

    it('a run whose every chunk failed to TRANSCRIBE spends an attempt, even with the embedder down', async () => {
      transcribeOf = () => null;
      const rel = 'calls/mute.wav';
      await upload(rel, Buffer.from('RIFF-mute'), 'audio/wav');
      const job = await runOnce(rel);
      assert.equal(job.status, 'pending');
      assert.equal(job.attempts, 1, 'a speech-to-text failure waited as if the embedder were the cause');
      assert.ok(!('outageFailures' in job));
      assert.match(job.lastError, /transcribe/);
    });
  });

  describe('the hand-back itself', () => {
    it('under a claim that is no longer the job\'s, writes nothing and answers lost', async () => {
      const rel = 'docs/lost.md';
      await upload(rel, Buffer.from(document(1)), 'text/markdown');
      await jobs().updateOne({ _id: rel }, { $set: { claimableAfter: null } });
      queue.markSpaceMayHaveWork(SPACE);
      const job = await queue.claimNextJob([SPACE]);
      const before = await jobOf(rel);
      assert.equal(await queue.handBackJob(SPACE, { jobId: rel, claimToken: 'not-the-runs-token' }, 'down'), 'lost');
      assert.deepEqual(await jobOf(rel), before, 'a hand-back under a lost claim wrote to the job');
      assert.equal(job.status, 'processing');
    });

    it('never refunds below zero', async () => {
      const rel = 'docs/zero.md';
      await upload(rel, Buffer.from(document(1)), 'text/markdown');
      await jobs().updateOne({ _id: rel }, { $set: { claimableAfter: null } });
      queue.markSpaceMayHaveWork(SPACE);
      const job = await queue.claimNextJob([SPACE]);
      // A job claimed by a build that counted no attempt.
      await jobs().updateOne({ _id: rel }, { $set: { attempts: 0 } });
      assert.equal(await queue.handBackJob(SPACE, { jobId: rel, claimToken: job.claimToken }, 'down'), 'handed_back');
      assert.equal((await jobOf(rel)).attempts, 0);
    });
  });
});
