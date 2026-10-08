/**
 * CHARACTERIZATION (bundle-89): what the image, audio and video embedders produce today for an image, an audio file and a video —
 * the chunk ids, the exact row shapes, the vectors' presence, the captions, what each reports, and what each asks of `ffmpeg`.
 * Written against the unmodified base 429e6d25 and green there.
 *
 * ## Why this is pinned, and what moves under it
 *
 * Bundle-89 changes how the media read path is shaped: `readStored` stops being the worker's whole-file buffer, the embedders stop
 * taking a `Buffer`, the two near-identical `ffmpeg` wrappers (`audio-embedder.ts:35`, `video-embedder.ts:31`) become one that gains a
 * timeout, a kill and a segment cap, and every write of a chunk row moves into `files/derived-fields.ts`. A refactor of that size can
 * keep every type signature happy and still change what lands in the collection — a field dropped from a chunk row, an overlap
 * window that quietly changes, a transcript joined differently. These cases hold the OUTPUT, which is what the bundle must not change
 * by accident. The INPUT (a `Buffer`) is bundle-89's to change on purpose, so every call goes through the three adapters at the top
 * of the driver section: the one place a changed signature is edited.
 *
 * ## What is NOT pinned, on purpose
 *
 *  - A job that outlives its file's flag (bundle-89 makes the embedders write nothing then).
 *  - How long a silence-free recording becomes a single segment (the bundle caps it).
 *  - The exact `ffmpeg` argument list. The bundle adds `-nostdin` and `-protocol_whitelist`, so what is pinned is the OPERATION each
 *    call performs and the arguments that carry its meaning (`-ss`, `-t`, the codec, the rate, the `fps` filter), never the whole vector.
 *
 * `ffmpeg` is answered at the `child_process.spawn` boundary (as `a-suppressed-file-holds-no-conversion-or-media-vector-db` does), so
 * the embedders' chunking, storing and re-embedding code is the real code and runs with or without the binary. Nothing else is
 * faked but the three model endpoints, which are stubs of the narrow provider interfaces and the real `embed()` over a stub endpoint.
 * The face path has its own file (`a-face-embedder-stores-exactly-what-it-stores-db`).
 *
 * Run: node --test testing/standalone/the-media-embedders-store-exactly-what-they-store-db.test.js
 * (requires a prior `npm run build` in server/ and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const OPEN = 'general';
const QUIET = 'quiet';
const DIMS = 4;
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const REFUSED = 'REFUSE-THIS-TEXT';

// A scratch tmp directory of this process's own, so "the embedder left nothing behind" is a listing and not a guess about what
// other test files running beside this one have in the shared one. `os.tmpdir()` reads the environment on every call.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89c-media-'));
const tmpRoot = path.join(scratch, 'tmp');
fs.mkdirSync(tmpRoot);
const CONFIG_PATH = path.join(scratch, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = scratch;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['TMPDIR'] = tmpRoot;
process.env['TMP'] = tmpRoot;
process.env['TEMP'] = tmpRoot;

// ── ffmpeg, at the process boundary ──────────────────────────────────────────────────────────────────────────────

const realSpawn = cp.spawn;

/** What the fake answers. Reset before every case. */
const ff = {
  durationS: 10, silenceStderr: '', frames: 1, noDuration: false,
  /** `(call) => stderr | null`: a string makes that call exit 1 with it. */
  fail: () => null,
  calls: [],
};
const resetFfmpeg = () => { Object.assign(ff, { durationS: 10, silenceStderr: '', frames: 1, noDuration: false, fail: () => null, calls: [] }); };

const hhmmss = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;

/** Which operation a call is, from the arguments that carry its meaning (never from position). */
function kindOf(args) {
  const last = String(args[args.length - 1]);
  if (args.includes('-af')) return 'silence';
  if (last === '-') return 'probe';
  if (last.includes('%06d')) return 'keyframes';
  if (args.includes('-vn')) return 'audioTrack';
  if (args.includes('-ss')) return 'segment';
  return 'other';
}

function fakeFfmpeg(args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const inIdx = args.indexOf('-i');
  const inputPath = inIdx >= 0 ? args[inIdx + 1] : undefined;
  let input = null;
  try { if (inputPath && fs.existsSync(inputPath)) input = fs.readFileSync(inputPath); } catch { /* gone */ }
  const call = { args, kind: kindOf(args), inputPath, input, last: String(args[args.length - 1]) };
  ff.calls.push(call);

  let stderr = '';
  let code = 0;
  const failure = ff.fail(call);
  if (failure !== null) { stderr = failure; code = 1; }
  else if (call.kind === 'silence') stderr = ff.silenceStderr;
  else if (call.kind === 'probe') stderr = ff.noDuration ? 'no duration to be found' : `Duration: ${hhmmss(ff.durationS)}, start: 0.000000`;
  else if (call.kind === 'keyframes') {
    for (let i = 1; i <= ff.frames; i++) fs.writeFileSync(call.last.replace('%06d', String(i).padStart(6, '0')), `jpeg-${i}`);
  } else fs.writeFileSync(call.last, `wav:${path.basename(call.last)}`);   // an extracted segment or the audio track

  setImmediate(() => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  });
  return proc;
}
cp.spawn = (cmd, ...rest) => (cmd === 'ffmpeg' ? fakeFfmpeg(rest[0]) : realSpawn(cmd, ...rest));
syncBuiltinESMExports();

// ── the model endpoints ──────────────────────────────────────────────────────────────────────────────────────────

let server, local, mongo, imageMod, audioMod, videoMod, progressMod;
/** Every input the stub embed endpoint was asked for. */
let seen = [];
/** Every call the stub providers got. */
let visionCalls = [];
let sttCalls = [];
/** What the stub vision provider answers; reset per case. */
let captionOf, transcribeOf;

const vision = { caption: async (bytes, mime) => { visionCalls.push({ bytes, mime }); return captionOf(bytes, mime, visionCalls.length); } };
const stt = { transcribe: async (bytes, mime) => { sttCalls.push({ bytes, mime }); return transcribeOf(bytes, mime, sttCalls.length); } };
const resetProviders = () => {
  seen = []; visionCalls = []; sttCalls = [];
  captionOf = () => 'a man at a whiteboard';
  transcribeOf = () => ({ text: 'welcome to the quarterly call', segments: [] });
};

const files = (space = OPEN) => mongo.col(`${space}_files`);
const T0 = '2026-08-01T00:00:00.000Z';
const parentRow = (id, over = {}) => ({ _id: id, spaceId: OPEN, path: id, tags: ['t'], description: 'mine', createdAt: T0, updatedAt: T0, sizeBytes: 100, author: LOCAL, seq: 5, ...over });
const seedParent = async (id, over = {}, space = OPEN) => { const doc = parentRow(id, { spaceId: space, ...over }); await files(space).insertOne(doc); return doc; };
const tmpLeft = () => fs.readdirSync(tmpRoot).filter(n => n.startsWith('ythril-audio-') || n.startsWith('ythril-video-'));
const kinds = () => ff.calls.map(c => c.kind);
const flagOf = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// ── the drivers: where a changed signature is edited (bundle-89 changes what an embedder is handed) ─────────────────

const runImage = (space, id, bytes = Buffer.from('png-bytes'), mime = 'image/png', opts) => imageMod.embedImage(space, id, bytes, mime, vision, opts);
const runAudio = (space, id, bytes = Buffer.from('wav-bytes'), mime = 'audio/wav', overlapMs, opts) => audioMod.embedAudio(space, id, bytes, mime, stt, overlapMs, opts);
const runVideo = (space, id, bytes = Buffer.from('mp4-bytes'), mime = 'video/mp4', { keyframes = true, overlapMs, intervalS, opts } = {}) =>
  videoMod.embedVideo(space, id, bytes, mime, vision, stt, keyframes, overlapMs, intervalS, opts);

/** The keys a chunk row of each kind carries, exactly: a key added or dropped by a move into another writer is a finding. */
const VECTOR = ['embedding', 'embeddingModel'];
const IMAGE_KEYS = ['_id', 'spaceId', 'path', 'tags', 'createdAt', 'updatedAt', 'sizeBytes', 'author', 'parentFileId', 'chunkIndex', 'content', 'matchedText'];
const AUDIO_KEYS = [...IMAGE_KEYS, 'chunkOffsetMs', 'chunkDurationMs'];
const keysOf = (doc) => Object.keys(doc).sort();
const expectKeys = (doc, base, withVector = true) => assert.deepEqual(keysOf(doc), [...base, ...(withVector ? VECTOR : [])].sort(), `${doc._id}: the row's keys`);

describe('the media embedders store exactly what they store today (real MongoDB, real embed() over a stub, ffmpeg at the spawn boundary)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        seen.push(input);
        if (String(input).includes(REFUSED)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'refused' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      ...LOCAL,
      spaces: [{ id: OPEN, label: 'General' }, { id: QUIET, label: 'Quiet', meta: { suppressEmbeddings: true } }],
      networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('b89c_media');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    imageMod = await import('../../server/dist/files/media/image-embedder.js');
    audioMod = await import('../../server/dist/files/media/audio-embedder.js');
    videoMod = await import('../../server/dist/files/media/video-embedder.js');
    progressMod = await import('../../server/dist/files/media/progress.js');
  });

  after(async () => {
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [OPEN, QUIET]) await files(space).deleteMany({});
    resetFfmpeg();
    resetProviders();
    for (const n of tmpLeft()) fs.rmSync(path.join(tmpRoot, n), { recursive: true, force: true });
  });

  it('the fake took: spawn is patched, and the scratch tmp directory is this process\'s own', () => {
    assert.notEqual(cp.spawn, realSpawn, 'spawn is not patched');
    assert.equal(os.tmpdir(), tmpRoot, 'os.tmpdir() did not follow the environment, so the leftover checks below look at the wrong place');
  });

  // ── image ───────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('embedImage', () => {
    it('stores ONE caption chunk with exactly these keys, returns the caption, and leaves the parent row as it was', async () => {
      const parent = await seedParent('photos/p.png');

      const caption = await runImage(OPEN, 'photos/p.png', Buffer.from('png-bytes'), 'image/png');

      assert.equal(caption, 'a man at a whiteboard');
      assert.equal(visionCalls.length, 1);
      assert.equal(visionCalls[0].bytes.toString(), 'png-bytes', 'the vision provider is handed the image bytes');
      assert.equal(visionCalls[0].mime, 'image/png');
      assert.deepEqual(seen, ['a man at a whiteboard'], 'the caption itself is embedded, not a chunk-formatted text');

      const rows = await files().find({ parentFileId: 'photos/p.png' }).toArray();
      assert.deepEqual(rows.map(r => r._id), ['photos/p.png#media-chunk0']);
      const chunk = rows[0];
      expectKeys(chunk, IMAGE_KEYS);
      assert.equal(chunk.spaceId, OPEN);
      assert.equal(chunk.path, chunk._id);
      assert.deepEqual(chunk.tags, []);
      assert.equal(chunk.createdAt, chunk.updatedAt);
      assert.equal(chunk.sizeBytes, Buffer.byteLength('a man at a whiteboard', 'utf8'));
      assert.deepEqual(chunk.author, LOCAL);
      assert.equal(chunk.chunkIndex, 0);
      assert.equal(chunk.content, 'a man at a whiteboard');
      assert.equal(chunk.matchedText, 'a man at a whiteboard');
      assert.equal(chunk.embedding.length, DIMS);
      assert.equal(typeof chunk.embeddingModel, 'string');
      assert.ok(!('seq' in chunk), 'a chunk row is not a replicated record and takes no seq');
      assert.deepEqual(await files().findOne({ _id: 'photos/p.png' }), parent, 'the embedder wrote to the parent row');
    });

    it('returns and stores the caption exactly as the provider gave it, whitespace included', async () => {
      await seedParent('photos/p.png');
      captionOf = () => '  a cat on a sofa  ';
      assert.equal(await runImage(OPEN, 'photos/p.png'), '  a cat on a sofa  ');
      const chunk = await files().findOne({ _id: 'photos/p.png#media-chunk0' });
      assert.equal(chunk.content, '  a cat on a sofa  ');
      assert.equal(chunk.sizeBytes, Buffer.byteLength('  a cat on a sofa  ', 'utf8'));
    });

    it('a second run replaces the chunk by id: one row, new content, the old row is not kept beside it', async () => {
      await seedParent('photos/p.png');
      await runImage(OPEN, 'photos/p.png');
      captionOf = () => 'a different caption';
      await runImage(OPEN, 'photos/p.png');

      const rows = await files().find({ parentFileId: 'photos/p.png' }).toArray();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, 'a different caption');
      assert.equal(rows[0].matchedText, 'a different caption');
    });

    for (const [label, value] of [['an empty caption', ''], ['a whitespace caption', '   \n'], ['a non-string caption', { vector: [1, 2] }]]) {
      it(`${label} is refused before anything is embedded or stored`, async () => {
        await seedParent('photos/p.png');
        captionOf = () => value;
        await assert.rejects(() => runImage(OPEN, 'photos/p.png'), /Vision provider returned a non-string or empty caption; refusing to embed/);
        assert.deepEqual(seen, []);
        assert.equal(await files().countDocuments({ parentFileId: 'photos/p.png' }), 0);
      });
    }

    it('a provider failure propagates as it is and stores nothing', async () => {
      await seedParent('photos/p.png');
      captionOf = () => { throw new Error('vision is down'); };
      await assert.rejects(() => runImage(OPEN, 'photos/p.png'), /vision is down/);
      assert.equal(await files().countDocuments({ parentFileId: 'photos/p.png' }), 0);
    });

    it('an embedder refusal propagates and stores nothing: a caption without its vector is not a half-stored chunk', async () => {
      await seedParent('photos/p.png');
      captionOf = () => `${REFUSED} in a frame`;
      await assert.rejects(() => runImage(OPEN, 'photos/p.png'));
      assert.equal(seen.length, 1, 'the embedder was asked once');
      assert.equal(await files().countDocuments({ parentFileId: 'photos/p.png' }), 0);
    });

    it('a suppressed file keeps the caption as TEXT (content and matchedText) and holds no vector; the embedder is not asked', async () => {
      await seedParent('photos/p.png', { suppressEmbeddings: true });
      await runImage(OPEN, 'photos/p.png');
      const chunk = await files().findOne({ _id: 'photos/p.png#media-chunk0' });
      expectKeys(chunk, IMAGE_KEYS, false);
      assert.equal(chunk.content, 'a man at a whiteboard');
      assert.equal(chunk.matchedText, 'a man at a whiteboard');
      assert.deepEqual(seen, []);
    });

    /*
     * CHANGED ON PURPOSE in bundle-89 (Q-418). The caption of a file with no row used to be stored as text (no vector,
     * because a missing file reads as suppressed). It is not stored at all now: a row is absent because the file was
     * deleted or was never recorded, and a caption under a path that holds no file is an orphan no listing shows, no
     * delete reaches and nothing ever removes. Not storing it is the outcome the delete already decided, so it is not
     * a failure either.
     */
    it('a file with NO row gets NO chunk, and that is not a failure', async () => {
      await runImage(OPEN, 'photos/gone.png');
      assert.equal(await files().findOne({ _id: 'photos/gone.png#media-chunk0' }), null,
        'a caption was stored for a file that is not there');
      assert.deepEqual(seen, [], 'the embedder was called for a file that is not there');
    });

    it('an extracted image (a child of a document) is addressed by its own id; its chunk hangs from IT, not from the document', async () => {
      await seedParent('docs/a.pdf');
      await seedParent('_extracted/docs/a.pdf/image-0.png', { parentFileId: 'docs/a.pdf' });
      await runImage(OPEN, '_extracted/docs/a.pdf/image-0.png');
      const chunk = await files().findOne({ _id: '_extracted/docs/a.pdf/image-0.png#media-chunk0' });
      assert.equal(chunk.parentFileId, '_extracted/docs/a.pdf/image-0.png');
    });
  });

  // ── audio ───────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('embedAudio', () => {
    it('one silence-free recording: one chunk with exactly these keys, the result shape, and the ffmpeg operations in order', async () => {
      await seedParent('calls/q3.wav');
      ff.durationS = 10;

      const result = await runAudio(OPEN, 'calls/q3.wav', Buffer.from('wav-bytes'), 'audio/wav');

      assert.deepEqual(result, {
        records: [{ chunkId: 'calls/q3.wav#media-chunk0', startMs: 0, endMs: 10_000, transcript: 'welcome to the quarterly call' }],
        failed: 0, total: 1,
      });
      assert.deepEqual(kinds(), ['probe', 'silence', 'segment']);

      const chunk = await files().findOne({ _id: 'calls/q3.wav#media-chunk0' });
      expectKeys(chunk, AUDIO_KEYS);
      assert.equal(chunk.parentFileId, 'calls/q3.wav');
      assert.equal(chunk.chunkIndex, 0);
      assert.equal(chunk.content, 'welcome to the quarterly call');
      assert.equal(chunk.matchedText, 'welcome to the quarterly call');
      assert.equal(chunk.chunkOffsetMs, 0);
      assert.equal(chunk.chunkDurationMs, 10_000);
      assert.equal(chunk.sizeBytes, Buffer.byteLength('welcome to the quarterly call', 'utf8'));
      assert.deepEqual(chunk.author, LOCAL);
      assert.deepEqual(chunk.tags, []);
      assert.equal(chunk.createdAt, chunk.updatedAt);
      assert.ok(!('seq' in chunk));
      assert.equal(chunk.embedding.length, DIMS);
      assert.deepEqual(seen, ['welcome to the quarterly call'], 'the transcript is what is embedded');
    });

    it('what ffmpeg is asked: the bytes handed over are the input, probed, silence-detected, then cut at 16 kHz mono 16-bit PCM', async () => {
      await seedParent('calls/q3.wav');
      await runAudio(OPEN, 'calls/q3.wav', Buffer.from('the-exact-audio-bytes'), 'audio/wav');

      const [probe, silence, segment] = ff.calls;
      for (const c of ff.calls) assert.equal(c.args[0], '-y', 'every call overwrites its output');
      assert.ok(probe.inputPath.endsWith('input.wav'), `the input is named for its MIME: ${probe.inputPath}`);
      assert.equal(probe.input.toString(), 'the-exact-audio-bytes', 'ffmpeg reads exactly the bytes the embedder was handed');
      assert.equal(silence.inputPath, probe.inputPath);
      assert.equal(flagOf(silence.args, '-af'), 'silencedetect=n=-30dB:d=0.5');
      assert.equal(segment.inputPath, probe.inputPath);
      assert.equal(flagOf(segment.args, '-ss'), '0');
      assert.equal(flagOf(segment.args, '-t'), '10');
      assert.equal(flagOf(segment.args, '-acodec'), 'pcm_s16le');
      assert.equal(flagOf(segment.args, '-ar'), '16000');
      assert.equal(flagOf(segment.args, '-ac'), '1');
      assert.equal(path.basename(segment.last), 'seg0.wav');
      assert.equal(sttCalls.length, 1);
      assert.equal(sttCalls[0].bytes.toString(), 'wav:seg0.wav', 'the transcriber is handed what ffmpeg wrote for the segment');
      assert.equal(sttCalls[0].mime, 'audio/wav');
    });

    it('the input takes its extension from the MIME type, and an unknown type is .bin', async () => {
      await seedParent('calls/a.bin');
      await runAudio(OPEN, 'calls/a.bin', Buffer.from('x'), 'audio/x-unknown-thing');
      assert.ok(ff.calls[0].inputPath.endsWith('input.bin'), ff.calls[0].inputPath);
    });

    it('silence splits the recording; each chunk is widened by half the overlap on each side and clamped to the file', async () => {
      await seedParent('calls/q3.wav');
      ff.durationS = 12;
      ff.silenceStderr = '[silencedetect] silence_start: 3\n[silencedetect] silence_end: 5 | silence_duration: 2\n';
      transcribeOf = (_b, _m, n) => ({ text: `part ${n}`, segments: [] });

      const result = await runAudio(OPEN, 'calls/q3.wav');

      assert.deepEqual(result.records.map(r => [r.chunkId, r.startMs, r.endMs, r.transcript]), [
        ['calls/q3.wav#media-chunk0', 0, 5500, 'part 1'],
        ['calls/q3.wav#media-chunk1', 2500, 12_000, 'part 2'],
      ]);
      assert.deepEqual([result.failed, result.total], [0, 2]);
      const rows = await files().find({ parentFileId: 'calls/q3.wav' }).sort({ chunkIndex: 1 }).toArray();
      assert.deepEqual(rows.map(r => [r.chunkIndex, r.chunkOffsetMs, r.chunkDurationMs]), [[0, 0, 5500], [1, 2500, 9500]]);
      const segments = ff.calls.filter(c => c.kind === 'segment');
      assert.deepEqual(segments.map(c => [flagOf(c.args, '-ss'), flagOf(c.args, '-t')]), [['0', '5.5'], ['2.5', '9.5']]);
    });

    it('an overlap of 0 gives chunks that meet at the silence and no further', async () => {
      await seedParent('calls/q3.wav');
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      const result = await runAudio(OPEN, 'calls/q3.wav', Buffer.from('x'), 'audio/wav', 0);
      assert.deepEqual(result.records.map(r => [r.startMs, r.endMs]), [[0, 3000], [5000, 12_000]]);
    });

    it('a transcript is its segments trimmed and joined by a space; with no segments it is the full text trimmed; a blank one stores nothing and is not a failure', async () => {
      await seedParent('calls/q3.wav');
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      transcribeOf = (_b, _m, n) => n === 1
        ? { text: 'ignored when segments exist', segments: [{ text: ' hello ' }, { text: '' }, { text: 'world ' }] }
        : { text: '   ', segments: [] };

      const result = await runAudio(OPEN, 'calls/q3.wav');

      assert.deepEqual(result.records.map(r => r.transcript), ['hello world']);
      assert.deepEqual([result.failed, result.total], [0, 2], 'the blank chunk counts in the total and not as a failure');
      assert.equal(await files().countDocuments({ parentFileId: 'calls/q3.wav' }), 1);

      resetProviders();
      transcribeOf = () => ({ text: '  only the text  ', segments: [] });
      const again = await runAudio(OPEN, 'calls/q3.wav');
      assert.equal(again.records[0].transcript, 'only the text');
    });

    it('a chunk that fails to transcribe is counted, the rest are stored, and the call does not throw', async () => {
      await seedParent('calls/q3.wav');
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      transcribeOf = (_b, _m, n) => { if (n === 1) throw new Error('stt exploded'); return { text: 'second chunk', segments: [] }; };

      const result = await runAudio(OPEN, 'calls/q3.wav');

      assert.deepEqual([result.failed, result.total, result.records.length], [1, 2, 1]);
      assert.deepEqual((await files().find({ parentFileId: 'calls/q3.wav' }).toArray()).map(r => r._id), ['calls/q3.wav#media-chunk1']);
    });

    it('every chunk failing throws, naming the count and the last error — including an ffmpeg exit', async () => {
      await seedParent('calls/q3.wav');
      ff.fail = (c) => (c.kind === 'segment' ? 'Invalid data found when processing input' : null);
      await assert.rejects(() => runAudio(OPEN, 'calls/q3.wav'),
        /every audio chunk failed to transcribe \(1\/1\); last error: ffmpeg exited 1: Invalid data found when processing input/);
      assert.equal(await files().countDocuments({ parentFileId: 'calls/q3.wav' }), 0);
    });

    it('an unreadable duration falls back to the byte length at 32 000 bytes a second', async () => {
      await seedParent('calls/q3.wav');
      ff.noDuration = true;
      const result = await runAudio(OPEN, 'calls/q3.wav', Buffer.alloc(64_000), 'audio/wav');
      assert.deepEqual(result.records.map(r => [r.startMs, r.endMs]), [[0, 2000]]);
    });

    it('progress: one beat before the first chunk and one after each, in the `transcribe` step and the route\'s own step list', async () => {
      await seedParent('calls/q3.wav');
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      const beats = [];
      await runAudio(OPEN, 'calls/q3.wav', Buffer.from('x'), 'audio/wav', undefined, { onProgress: (p) => beats.push(p) });
      assert.deepEqual(beats, [0, 1, 2].map(done => ({ step: 'transcribe', steps: [...progressMod.AUDIO_STEPS], done, total: 2 })));

      beats.length = 0;
      await runAudio(OPEN, 'calls/q3.wav', Buffer.from('x'), 'audio/wav', undefined, { onProgress: (p) => beats.push(p), steps: ['a', 'b'] });
      assert.deepEqual(beats[0].steps, ['a', 'b'], 'a caller\'s step list is passed through');
    });

    it('a lost lease stops BEFORE the next chunk: what was stored stays, and the call returns normally', async () => {
      await seedParent('calls/q3.wav');
      ff.durationS = 12;
      ff.silenceStderr = 'silence_start: 3\nsilence_end: 5\n';
      let asked = 0;
      const result = await runAudio(OPEN, 'calls/q3.wav', Buffer.from('x'), 'audio/wav', undefined, { shouldStop: () => ++asked > 1 });
      assert.deepEqual(result.records.map(r => r.chunkId), ['calls/q3.wav#media-chunk0']);
      assert.equal(result.total, 2);
      assert.equal(sttCalls.length, 1, 'the transcriber was asked for a chunk after the lease was lost');
    });

    it('a second run replaces the chunk rows by id', async () => {
      await seedParent('calls/q3.wav');
      await runAudio(OPEN, 'calls/q3.wav');
      transcribeOf = () => ({ text: 'a corrected transcript', segments: [] });
      await runAudio(OPEN, 'calls/q3.wav');
      const rows = await files().find({ parentFileId: 'calls/q3.wav' }).toArray();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, 'a corrected transcript');
    });

    it('a suppressed file keeps every transcript as text and holds no vector', async () => {
      await seedParent('calls/q3.wav', { suppressEmbeddings: true });
      await runAudio(OPEN, 'calls/q3.wav');
      const chunk = await files().findOne({ _id: 'calls/q3.wav#media-chunk0' });
      expectKeys(chunk, AUDIO_KEYS, false);
      assert.equal(chunk.matchedText, 'welcome to the quarterly call');
      assert.deepEqual(seen, []);
    });

    it('its scratch directory is gone afterwards, on success and on failure', async () => {
      await seedParent('calls/q3.wav');
      await runAudio(OPEN, 'calls/q3.wav');
      assert.deepEqual(tmpLeft(), [], 'a successful job left its scratch directory behind');

      ff.fail = (c) => (c.kind === 'segment' ? 'broken' : null);
      await assert.rejects(() => runAudio(OPEN, 'calls/q3.wav'));
      assert.deepEqual(tmpLeft(), [], 'a failed job left its scratch directory behind');
    });
  });

  // ── video ───────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('embedVideo', () => {
    /** A 70 s video with one silence, three keyframes at the default 30 s interval, so frames fall in BOTH audio chunks. */
    const SEVENTY = () => { ff.durationS = 70; ff.frames = 3; ff.silenceStderr = 'silence_start: 35\nsilence_end: 40\n'; };

    it('audio chunks are re-embedded with the keyframe captions that fall inside them; exact combined text, row keys and result', async () => {
      await seedParent('calls/q3.mp4');
      SEVENTY();
      captionOf = (_b, _m, n) => `scene ${n}`;
      transcribeOf = (_b, _m, n) => ({ text: `speech ${n}`, segments: [] });

      const result = await runVideo(OPEN, 'calls/q3.mp4');

      assert.deepEqual(result, { audioFailed: 0, audioTotal: 2 });
      const rows = await files().find({ parentFileId: 'calls/q3.mp4' }).sort({ chunkIndex: 1 }).toArray();
      assert.deepEqual(rows.map(r => r._id), ['calls/q3.mp4#media-chunk0', 'calls/q3.mp4#media-chunk1']);
      assert.equal(rows[0].content, '[visual at 0s]: scene 1\n[visual at 30s]: scene 2\nspeech 1');
      assert.equal(rows[1].content, '[visual at 60s]: scene 3\nspeech 2');
      for (const r of rows) {
        expectKeys(r, AUDIO_KEYS);
        assert.equal(r.matchedText, r.content, 'matchedText follows the combined text');
        assert.equal(r.embedding.length, DIMS);
        assert.equal(r.createdAt <= r.updatedAt, true);
      }
      assert.deepEqual([rows[0].chunkOffsetMs, rows[0].chunkDurationMs, rows[1].chunkOffsetMs, rows[1].chunkDurationMs], [0, 37_500, 37_500, 32_500],
        'the re-embed rewrites text and vector and keeps the audio chunk\'s window');
      assert.deepEqual(seen.slice(-2), [rows[0].content, rows[1].content], 'the combined text is what the model embeds the second time');
      assert.deepEqual(visionCalls.map(c => [c.bytes.toString(), c.mime]), [['jpeg-1', 'image/jpeg'], ['jpeg-2', 'image/jpeg'], ['jpeg-3', 'image/jpeg']]);
    });

    it('what ffmpeg is asked: the audio track first, then the audio pipeline on it, then the keyframe pass at fps=1/30', async () => {
      await seedParent('calls/q3.mp4');
      SEVENTY();
      await runVideo(OPEN, 'calls/q3.mp4', Buffer.from('the-exact-video-bytes'), 'video/mp4');

      assert.deepEqual(kinds(), ['audioTrack', 'probe', 'silence', 'segment', 'segment', 'keyframes']);
      const [track, probe, , , , keyframes] = ff.calls;
      assert.ok(track.inputPath.endsWith('input.mp4'), track.inputPath);
      assert.equal(track.input.toString(), 'the-exact-video-bytes', 'ffmpeg reads exactly the bytes the embedder was handed');
      assert.equal(flagOf(track.args, '-acodec'), 'pcm_s16le');
      assert.equal(flagOf(track.args, '-ar'), '16000');
      assert.equal(flagOf(track.args, '-ac'), '1');
      assert.equal(path.basename(track.last), 'audio.wav');
      assert.equal(path.basename(probe.inputPath), 'input.wav', 'the audio pipeline runs on the extracted track, as audio/wav');
      assert.equal(probe.input.toString(), 'wav:audio.wav');
      assert.equal(path.basename(keyframes.inputPath), 'input.mp4', 'the keyframes are cut from the video, not from the audio');
      assert.equal(flagOf(keyframes.args, '-vf'), 'fps=1/30');
      assert.equal(path.basename(keyframes.last), 'frame_%06d.jpg');
    });

    it('the keyframe interval is a parameter: it sets the fps filter and the timestamps of the frames', async () => {
      await seedParent('calls/q3.mp4');
      ff.durationS = 20; ff.frames = 2;
      await runVideo(OPEN, 'calls/q3.mp4', Buffer.from('x'), 'video/mp4', { intervalS: 10 });
      assert.equal(flagOf(ff.calls.at(-1).args, '-vf'), 'fps=1/10');
      const row = await files().findOne({ _id: 'calls/q3.mp4#media-chunk0' });
      assert.ok(row.content.startsWith('[visual at 0s]: a man at a whiteboard\n[visual at 10s]: a man at a whiteboard\n'), row.content);
    });

    it('the audio level (keyframes off): no keyframe pass, the vision model is never asked, the rows are the plain audio rows', async () => {
      await seedParent('calls/q3.mp4');
      SEVENTY();
      const result = await runVideo(OPEN, 'calls/q3.mp4', Buffer.from('x'), 'video/mp4', { keyframes: false });
      assert.deepEqual(result, { audioFailed: 0, audioTotal: 2 });
      assert.ok(!kinds().includes('keyframes'));
      assert.deepEqual(visionCalls, []);
      const rows = await files().find({ parentFileId: 'calls/q3.mp4' }).sort({ chunkIndex: 1 }).toArray();
      assert.deepEqual(rows.map(r => r.content), ['welcome to the quarterly call', 'welcome to the quarterly call']);
    });

    it('a keyframe pass that yields nothing, or fails, leaves the plain audio chunks and still returns the audio outcome', async () => {
      await seedParent('calls/none.mp4');
      ff.frames = 0;
      assert.deepEqual(await runVideo(OPEN, 'calls/none.mp4'), { audioFailed: 0, audioTotal: 1 });
      assert.equal((await files().findOne({ _id: 'calls/none.mp4#media-chunk0' })).content, 'welcome to the quarterly call');

      await seedParent('calls/broken.mp4');
      resetFfmpeg();
      ff.fail = (c) => (c.kind === 'keyframes' ? 'Output file is empty' : null);
      assert.deepEqual(await runVideo(OPEN, 'calls/broken.mp4'), { audioFailed: 0, audioTotal: 1 }, 'a keyframe failure is a warning, not a failed job');
      assert.equal((await files().findOne({ _id: 'calls/broken.mp4#media-chunk0' })).content, 'welcome to the quarterly call');
    });

    it('a frame whose caption is blank or throws is left out; the others are still used', async () => {
      await seedParent('calls/q3.mp4');
      ff.durationS = 70; ff.frames = 3;
      captionOf = (_b, _m, n) => { if (n === 1) throw new Error('vision fell over'); if (n === 2) return '   '; return ' scene 3 '; };
      await runVideo(OPEN, 'calls/q3.mp4');
      const row = await files().findOne({ _id: 'calls/q3.mp4#media-chunk0' });
      assert.equal(row.content, '[visual at 60s]: scene 3\nwelcome to the quarterly call', 'the caption is trimmed and only the captioned frame appears');
    });

    it('a re-embed the model refuses keeps the audio chunk as the audio pass stored it', async () => {
      await seedParent('calls/q3.mp4');
      captionOf = () => `${REFUSED} on screen`;
      const result = await runVideo(OPEN, 'calls/q3.mp4');
      assert.deepEqual(result, { audioFailed: 0, audioTotal: 1 }, 'a refused re-embed is not a failure of the job');
      const row = await files().findOne({ _id: 'calls/q3.mp4#media-chunk0' });
      assert.equal(row.content, 'welcome to the quarterly call');
      assert.equal(row.matchedText, 'welcome to the quarterly call');
      assert.equal(row.embedding.length, DIMS);
    });

    it('a frame that falls in no chunk is not used; a chunk with no frame is left as the audio pass stored it', async () => {
      await seedParent('calls/q3.mp4');
      ff.durationS = 70; ff.frames = 1;
      ff.silenceStderr = 'silence_start: 35\nsilence_end: 40\n';
      await runVideo(OPEN, 'calls/q3.mp4');
      const rows = await files().find({ parentFileId: 'calls/q3.mp4' }).sort({ chunkIndex: 1 }).toArray();
      assert.equal(rows[0].content, '[visual at 0s]: a man at a whiteboard\nwelcome to the quarterly call');
      assert.equal(rows[1].content, 'welcome to the quarterly call');
    });

    it('failed audio chunks are counted and carried up for the worker to mark the job partial', async () => {
      await seedParent('calls/q3.mp4');
      ff.durationS = 70; ff.silenceStderr = 'silence_start: 35\nsilence_end: 40\n';
      transcribeOf = (_b, _m, n) => { if (n === 1) throw new Error('stt exploded'); return { text: 'second', segments: [] }; };
      assert.deepEqual(await runVideo(OPEN, 'calls/q3.mp4', Buffer.from('x'), 'video/mp4', { keyframes: false }), { audioFailed: 1, audioTotal: 2 });
    });

    it('an audio track that cannot be extracted fails the job; nothing is stored and the scratch directory is gone', async () => {
      await seedParent('calls/q3.mp4');
      ff.fail = (c) => (c.kind === 'audioTrack' ? 'Output file does not contain any stream' : null);
      await assert.rejects(() => runVideo(OPEN, 'calls/q3.mp4'), /ffmpeg exited 1: Output file does not contain any stream/);
      assert.equal(await files().countDocuments({ parentFileId: 'calls/q3.mp4' }), 0);
      assert.deepEqual(tmpLeft(), []);
    });

    it('progress: the audio stage beats under the VIDEO step list, then one beat before the first caption and one after each', async () => {
      await seedParent('calls/q3.mp4');
      ff.durationS = 70; ff.frames = 2;
      const beats = [];
      await runVideo(OPEN, 'calls/q3.mp4', Buffer.from('x'), 'video/mp4', { opts: { onProgress: (p) => beats.push(p) } });
      const steps = [...progressMod.VIDEO_STEPS];
      assert.deepEqual(beats, [
        { step: 'transcribe', steps, done: 0, total: 1 },
        { step: 'transcribe', steps, done: 1, total: 1 },
        { step: 'caption', steps, done: 0, total: 2 },
        { step: 'caption', steps, done: 1, total: 2 },
        { step: 'caption', steps, done: 2, total: 2 },
      ]);
    });

    it('a lease lost before the keyframe loop captions nothing: the chunks stay as the audio pass stored them', async () => {
      await seedParent('calls/q3.mp4');
      ff.frames = 2;
      // The audio stage asks once per chunk (one chunk here); the next question is the first keyframe's.
      let asked = 0;
      await runVideo(OPEN, 'calls/q3.mp4', Buffer.from('x'), 'video/mp4', { opts: { shouldStop: () => ++asked > 1 } });
      assert.deepEqual(visionCalls, []);
      assert.equal((await files().findOne({ _id: 'calls/q3.mp4#media-chunk0' })).content, 'welcome to the quarterly call');
    });

    it('a suppressed file: the audio chunks and the combined text are kept as text, with no vector anywhere and the embedder never asked', async () => {
      await seedParent('calls/q3.mp4', { suppressEmbeddings: true });
      await runVideo(OPEN, 'calls/q3.mp4');
      const row = await files().findOne({ _id: 'calls/q3.mp4#media-chunk0' });
      expectKeys(row, AUDIO_KEYS, false);
      assert.equal(row.content, '[visual at 0s]: a man at a whiteboard\nwelcome to the quarterly call');
      assert.equal(row.matchedText, row.content);
      assert.deepEqual(seen, []);
    });

    it('its scratch directory is gone afterwards', async () => {
      await seedParent('calls/q3.mp4');
      await runVideo(OPEN, 'calls/q3.mp4');
      assert.deepEqual(tmpLeft(), []);
    });
  });

  // ── what a chunk row looks like to the rest of the system ────────────────────────────────────────────────────────

  describe('the chunk rows the embedders leave are the shape the rest of the pipeline reads', () => {
    it('a media chunk is embedded from its own content by the queue path, exactly as a conversion chunk is', async () => {
      await seedParent('photos/p.png');
      await runImage(OPEN, 'photos/p.png');
      const embedRecord = await import('../../server/dist/brain/embed-record.js');
      const chunk = await files().findOne({ _id: 'photos/p.png#media-chunk0' });
      assert.equal(embedRecord.isDerived(chunk), true);
      assert.equal(await embedRecord.buildEmbedText(OPEN, 'file', chunk), 'a man at a whiteboard',
        'a rebuild of a caption chunk must embed the caption, which is what the embedder embedded');
      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', chunk._id), 'unchanged', 'so the queue finds the stored vector current');
    });

    it('the parent\'s own row is untouched by an audio or video job: its description and status are the WORKER\'s to write, not the embedder\'s', async () => {
      const parent = await seedParent('calls/q3.mp4');
      await runVideo(OPEN, 'calls/q3.mp4');
      assert.deepEqual(await files().findOne({ _id: 'calls/q3.mp4' }), parent);
    });
  });
});
