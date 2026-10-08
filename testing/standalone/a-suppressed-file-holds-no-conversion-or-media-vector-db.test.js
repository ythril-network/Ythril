/**
 * A file the operator retired from meaning-ranked search holds no vector on ANY of its passages — conversion chunks and
 * media chunks included (Q-255).
 *
 * ## The defect
 *
 * `suppressEmbeddings` is implemented AS the absence of a vector: there is no read-time filter, so a stored vector is
 * the feature failing. The brain writers and the embed queue honour it. The four writers that turn a FILE into
 * passages did not:
 *
 *  - `storeConversionResults` (`files/converters/pipeline.ts`) embedded every text chunk of a converted document;
 *  - `embedImage`, `embedAudio` and `embedVideo` (`files/media/*-embedder.ts`) embedded the caption, the transcript
 *    and the caption-prefixed transcript.
 *
 * A file suppressed at its own record, or in a space that suppresses everything, therefore kept a vector on every
 * passage its conversion or media job produced, and was found by exactly the mechanism the operator switched off. The
 * queue path repaired some of it later (`embedStoredRecord` excludes a derived record whose ancestor is suppressed),
 * but only for a chunk it was asked to re-embed, so a freshly uploaded file was findable until a reindex.
 *
 * ## What is asserted, per producer and per tier
 *
 * The four REAL functions are driven over a real replica-set MongoDB and the real `embed()` against a stub
 * OpenAI-compatible endpoint (which records every input it is asked to embed, so "no model call" is observable and
 * not inferred from the stored row). The vision and speech providers are stubs of their narrow interfaces; `ffmpeg` is
 * replaced at the `child_process.spawn` boundary, so the audio and video embedders run their real chunking, storing and
 * re-embedding code on any machine, with or without the binary.
 *
 * Tiers (a file has two: it has no type, so no type schema): the file's OWN record flag, and the SPACE setting. Plus:
 *
 *  - **Control**, nothing suppressed: the passages ARE embedded. A producer that stopped embedding altogether would
 *    otherwise pass every suppressed row.
 *  - **Record `false` over a suppressing space**: record > space, so the file is embedded. Pinned so the fix cannot
 *    overshoot into "the space said so, whatever the file says".
 *  - **A missing parent row** counts as suppressed — the same fail-closed rule the queue path applies — and is NOT an embed
 *    failure: `embedFailures` / `failed` stay 0, because the job did nothing wrong and a retry could not change it.
 *  - **An extracted image's caption chunk whose GRANDPARENT is suppressed**: the flag is on the document, the caption
 *    hangs from the extracted image.
 *
 * `matchedText` is deliberately not asserted either way: whether a suppressed passage keeps its text for the lexical
 * channel is the queue path's rule (`Q-94`) and not this test's question. The vector fields (`embedding`,
 * `embeddingModel`) and the model call are.
 *
 * Run: node --test testing/standalone/a-suppressed-file-holds-no-conversion-or-media-vector-db.test.js
 * (requires a prior `npm run build` in server/ and the test MongoDB, `npm run test:up`)
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

/** Nothing suppressed in it. */
const OPEN = 'general';
/** Suppresses every record in it (space tier). */
const QUIET = 'quiet';
const DIMS = 4;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-suppressed-file-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

// ── ffmpeg, at the process boundary ──────────────────────────────────────────────────────────────────────────────
//
// The audio and video embedders shell out to `ffmpeg` for the duration, the silence map, a wav segment, the audio track
// and the keyframes. Answering those calls here keeps everything AFTER them real: the chunk the embedder stores and
// the vector it does or does not put on it. `syncBuiltinESMExports` makes the patched `spawn` the one the dist modules'
// `import { spawn } from 'child_process'` binding sees; anything that is not `ffmpeg` goes to the real one.
const realSpawn = cp.spawn;
function fakeFfmpeg(args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const last = String(args[args.length - 1]);
  let stderr = '';
  if (args.includes('-af')) stderr = '';                                  // silencedetect: no silence, one chunk
  else if (last === '-') stderr = 'Duration: 00:00:10.00, start: 0.000000'; // the duration probe
  else if (last.includes('%06d')) fs.writeFileSync(last.replace('%06d', '000001'), 'jpeg'); // one keyframe, at 0 s
  else fs.writeFileSync(last, 'wav');                                     // an extracted segment or audio track
  setImmediate(() => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', 0);
  });
  return proc;
}
cp.spawn = (cmd, ...rest) => (cmd === 'ffmpeg' ? fakeFfmpeg(rest[0]) : realSpawn(cmd, ...rest));
syncBuiltinESMExports();

/** Every input the stub endpoint was asked to embed. */
let seen = [];

let server, local, mongo, pipeline, imageMod, audioMod, videoMod;

const files = (space) => mongo.col(`${space}_files`);
const jobs = (space) => mongo.col(`${space}_media_jobs`);

const stt = { transcribe: async () => ({ text: 'welcome to the quarterly call', segments: [] }) };
const vision = { caption: async () => 'a man at a whiteboard' };

const BASE = {
  tags: [], createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', seq: 1,
};

/** A file row, as an upload leaves it. `over` carries the flag or the parent link a case needs. */
async function seedFile(space, id, over = {}) {
  await files(space).insertOne({ _id: id, spaceId: space, path: id, sizeBytes: 100, ...BASE, ...over });
}

/** The claim a conversion commits under. */
async function claimFor(space, fileId) {
  const claimToken = `run-${fileId}`;
  await jobs(space).insertOne({
    _id: fileId, spaceId: space, filePath: fileId, mimeType: 'text/plain', mediaType: 'text', resolvedFormat: 'txt',
    status: 'processing', attempts: 1, maxAttempts: 3, lastError: null, claimedAt: new Date().toISOString(),
    progressAt: new Date().toISOString(), claimToken, claimableAfter: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return { jobId: fileId, claimToken };
}

/**
 * The four producers, driven as the worker drives them. `fileId` is the file the job was claimed for; `chunkIds` are the
 * rows it writes; `failures` is how the producer reports an embed it could not do; `controlText` is what a control run
 * must have embedded last.
 */
const PRODUCERS = {
  conversion: {
    fileId: 'docs/report.txt',
    chunkIds: ['docs/report.txt#chunk0', 'docs/report.txt#chunk1'],
    run: async (space, fileId) => {
      const claim = await claimFor(space, fileId);
      const r = await pipeline.storeConversionResults(space, fileId, [
        { chunkIndex: 0, content: 'revenue grew in every region', headingText: 'Results' },
        { chunkIndex: 1, content: 'costs fell in the second half', headingText: '' },
      ], null, [], { claim });
      return r.embedFailures;
    },
  },
  image: {
    fileId: 'photos/whiteboard.png',
    chunkIds: ['photos/whiteboard.png#media-chunk0'],
    run: async (space, fileId) => {
      await imageMod.embedImage(space, fileId, Buffer.from('png'), 'image/png', vision);
      return 0;
    },
  },
  audio: {
    fileId: 'calls/q3.wav',
    chunkIds: ['calls/q3.wav#media-chunk0'],
    run: async (space, fileId) => (await audioMod.embedAudio(space, fileId, Buffer.from('wav'), 'audio/wav', stt)).failed,
  },
  video: {
    fileId: 'calls/q3.mp4',
    chunkIds: ['calls/q3.mp4#media-chunk0'],
    // Keyframes ON: the caption-prefixed re-embed is the second place a video stores a vector.
    run: async (space, fileId) => (await videoMod.embedVideo(space, fileId, Buffer.from('mp4'), 'video/mp4', vision, stt, true)).audioFailed,
  },
};

/**
 * The tiers. `parent` is the row the producer's file has (`null` = none), `space` where it lives, `embedded` whether its
 * passages are owed a vector.
 */
const TIERS = {
  'nothing suppressed (control)': { space: OPEN, parent: {}, embedded: true },
  'record tier: the file itself is suppressed': { space: OPEN, parent: { suppressEmbeddings: true }, embedded: false },
  'space tier: the space suppresses everything': { space: QUIET, parent: {}, embedded: false },
  // `false` means "not stated" and falls through to the tier below (04f-write-semantics.md, `recordSuppression`), so a
  // suppressing space still wins over it: the record cannot re-embed what its space withholds.
  'record false over a suppressing space (false is not stated)': { space: QUIET, parent: { suppressEmbeddings: false }, embedded: false },
  'the parent row is missing (fail closed)': { space: OPEN, parent: null, embedded: false },
};

describe('a suppressed file holds no vector on its conversion or media passages (real MongoDB, real embed() over a stub endpoint)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        seen.push(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: [
        { id: OPEN, label: 'General' },
        { id: QUIET, label: 'Quiet', meta: { suppressEmbeddings: true } },
      ],
      networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('suppressedfilechunks');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    pipeline = await import('../../server/dist/files/converters/pipeline.js');
    imageMod = await import('../../server/dist/files/media/image-embedder.js');
    audioMod = await import('../../server/dist/files/media/audio-embedder.js');
    videoMod = await import('../../server/dist/files/media/video-embedder.js');
  });

  after(async () => {
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [OPEN, QUIET]) {
      await files(space).deleteMany({});
      await jobs(space).deleteMany({});
    }
    seen = [];
  });

  it('the table is derived from what is driven: four producers, five tiers, and the stubs answer', () => {
    assert.deepEqual(Object.keys(PRODUCERS).sort(), ['audio', 'conversion', 'image', 'video']);
    assert.ok(Object.keys(TIERS).length >= 5, 'a tier was dropped');
    assert.ok(Object.values(TIERS).some(t => t.embedded) && Object.values(TIERS).some(t => !t.embedded),
      'the table needs rows on both sides of the rule, or it asserts nothing');
    // The fake `ffmpeg` must be the one the dist modules call, or the audio and video cases fail for the wrong reason.
    assert.notEqual(cp.spawn, realSpawn, 'spawn is not patched');
  });

  for (const [producerName, producer] of Object.entries(PRODUCERS)) {
    for (const [tierName, tier] of Object.entries(TIERS)) {
      it(`${producerName}, ${tierName}: ${tier.embedded ? 'the passages are embedded' : 'the passages hold no vector and nothing was embedded'}`, async () => {
        if (tier.parent !== null) await seedFile(tier.space, producer.fileId, tier.parent);

        const failures = await producer.run(tier.space, producer.fileId);

        const rows = await files(tier.space).find({ _id: { $in: producer.chunkIds } }).toArray();
        if (tier.embedded) {
          assert.deepEqual(rows.map(r => r._id).sort(), [...producer.chunkIds].sort(), 'precondition: every passage was stored');
          for (const row of rows) {
            assert.ok(Array.isArray(row.embedding) && row.embedding.length === DIMS,
              `${row._id}: a file nobody suppressed must have its passages embedded`);
            assert.equal(typeof row.embeddingModel, 'string', `${row._id}: the vector's model is stamped with it`);
          }
          assert.ok(seen.length > 0, 'and the model was asked');
          if (producerName === 'video') {
            assert.ok(rows[0].content.includes('[visual at 0s]'), 'precondition: the video re-embed ran, so its store is the one tested');
          }
          return;
        }

        if (tier.parent !== null) {
          // A suppressed passage is still STORED — its text is the file's, and search by words still reaches it. Only the
          // vector is withheld. (A missing parent is allowed to store nothing at all, so no row is demanded there.)
          assert.deepEqual(rows.map(r => r._id).sort(), [...producer.chunkIds].sort(),
            'precondition: a suppressed file\'s passages are stored, without a vector');
        }
        const holding = rows.filter(r => 'embedding' in r || 'embeddingModel' in r).map(r => r._id);
        assert.deepEqual(holding, [], `these passages hold a vector the operator's setting forbids`);
        assert.deepEqual(seen, [], 'the model was asked to embed text of a suppressed file — for an external endpoint that is the egress the flag exists to stop');
        assert.equal(failures, 0, 'a refusal to embed is not an embed failure: the job would be recorded partial, and retried for ever');
      });
    }
  }

  it('an extracted image whose DOCUMENT is suppressed: the caption chunk holds no vector (the flag is two levels up)', async () => {
    await seedFile(OPEN, 'docs/secret.pdf', { suppressEmbeddings: true });
    const imageId = '_extracted/docs/secret.pdf/image-0.png';
    await seedFile(OPEN, imageId, { parentFileId: 'docs/secret.pdf' });

    await imageMod.embedImage(OPEN, imageId, Buffer.from('png'), 'image/png', vision);

    const caption = await files(OPEN).findOne({ _id: `${imageId}#media-chunk0` });
    assert.ok(caption, 'precondition: the caption chunk was stored');
    assert.equal(caption.embedding, undefined, 'the caption of a suppressed document\'s image holds a vector');
    assert.equal(caption.embeddingModel, undefined);
    assert.deepEqual(seen, [], 'and the caption was not sent to the embedder');
  });

  it('an extracted image whose document is NOT suppressed: the caption chunk is embedded (the walk does not exclude everything)', async () => {
    await seedFile(OPEN, 'docs/open.pdf');
    const imageId = '_extracted/docs/open.pdf/image-0.png';
    await seedFile(OPEN, imageId, { parentFileId: 'docs/open.pdf' });

    await imageMod.embedImage(OPEN, imageId, Buffer.from('png'), 'image/png', vision);

    const caption = await files(OPEN).findOne({ _id: `${imageId}#media-chunk0` });
    assert.ok(Array.isArray(caption.embedding) && caption.embedding.length === DIMS);
  });
});
