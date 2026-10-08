/**
 * A job in flight never writes for a file that was flagged deleted while it ran (bundle-89, E2 / Q-418, plan rev 3 item 5:
 * ONE WRITER for a file row's derived fields).
 *
 * ## The defect
 *
 * A media job reads a file, spends a long step on it (a vision call, a transcription, an embedding) and then writes. A delete that
 * lands inside that step flags the FILE's row (`softDeleteFileMeta`) and removes the chunk rows it can see; the job then writes
 * the rest. Every one of those writes filters on the row it writes and asks nothing of the file the row belongs to:
 *
 *  - the four media writers filter on the CHUNK's own `_id` (`image-embedder.ts` and `face-embedder.ts` and `audio-embedder.ts`
 *    `replaceOne(upsert)`, `video-embedder.ts` `updateOne`). A chunk row never carries `deletedAt`: the flag sits on the PARENT.
 *    A predicate on the chunk would ask the wrong row's question, so the question has to be the parent's;
 *  - `embedStoredRecord` has four guarded writes, filtered on the seq it read (`atReadSeq`). A flag stamps no seq, so the version
 *    the job read is still the version stored, and the SUCCESS write puts a vector, its model and the text it was made from onto a
 *    flagged row;
 *  - `setDerivedDescriptionIfUnset` writes a description AND stamps a seq on a flagged row, and `setFileProcessingState` writes a
 *    processing mark onto one.
 *
 * ## The rule, asserted per writer (each its own `it`, each seen red alone)
 *
 * After the parent is flagged mid-run, no row derived from it exists (asserted as the IDENTITIES of the rows whose `parentFileId` is
 * the file, expecting none), and no derived field was written onto the flagged row itself.
 *
 * The slow step is the hook: the vision, speech and embedding stand-ins flag the parent inside the call the job is awaiting, so
 * "between the read and the write" is a fact of the run and not a timing guess. `ffmpeg` is answered at the `spawn` boundary
 * (`_fake-ffmpeg.mjs`); the embedder is a stub OpenAI-compatible endpoint.
 *
 * Seams that have no await between the read and the write (`embedStoredRecord`'s derived `$unset` and suppressed branch) cannot be
 * hooked: those cases flag the row BEFORE the call and assert the job did not treat it as live.
 *
 * Run: node --test testing/standalone/a-job-in-flight-never-writes-for-a-flagged-parent-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { installFakeFfmpeg } from './_fake-ffmpeg.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'general';
/** A space that suppresses every record: the suppressed branch of the embed job. */
const QUIET = 'quiet';
const DIMS = 4;
const FACE_DIMS = 128;
const T0 = '2026-09-01T00:00:00.000Z';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89e2b-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let mongo, embedServer, embedLocal, faceServer, restoreSpawn;
let imageMod, audioMod, videoMod, faceMod, embedRecord, fileMeta, processingState;
/** What the stub embedding endpoint does before it answers: set per case. `status` makes it refuse. */
let onEmbed = null;
let embedStatus = 200;
/** What the stub face provider does before it answers. */
let onFaces = null;

const files = (space = S) => mongo.col(`${space}_files`);
const counter = async (space = S) => (await mongo.col('ythril_counters').findOne({ _id: space }))?.seq ?? 0;

/** A live file row, as an upload leaves it. */
async function seedFile(id, { space = S, ...over } = {}) {
  await files(space).insertOne({ _id: id, spaceId: space, path: id, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0, seq: 1, ...over });
}
/** The delete's flag, applied by hand so the case does not depend on the primitive under test. */
const flag = (id, space = S) => files(space).updateOne({ _id: id }, { $set: { deletedAt: '2026-09-02T00:00:00.000Z' } });
/** The identities of every row derived from `parent`, at any depth one: expected to be none after a flag mid-run. */
const derivedOf = async (parent, space = S) => (await files(space).find({ parentFileId: parent }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();

describe('a job in flight never writes for a parent flagged deleted mid-run (E2, Q-418)', { skip }, () => {
  before(async () => {
    embedServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        const input = JSON.parse(body).input;
        if (onEmbed) await onEmbed(input);
        if (embedStatus !== 200) { res.writeHead(embedStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'refused' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    embedLocal = await listenOnLoopback(embedServer);
    process.env['EMBEDDING_URL'] = embedLocal.url;

    // The external face provider, on the host's private address (the SSRF guards refuse loopback), consented to by host.
    const host = privateHostAddress();
    faceServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', async () => {
        if (onFaces) await onFaces();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ faces: [{ embedding: Array.from({ length: FACE_DIMS }, (_, i) => (i + 1) / 200) }] }));
      });
    });
    // own-listener: binds the host's private address, because the SSRF guard refuses loopback and the face provider
    // is fetched through it
    await new Promise(r => faceServer.listen(0, host, r));
    const faceUrl = `http://${host}:${faceServer.address().port}/faces`;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'b89e2b', instanceLabel: 'b89e2b',
      spaces: [{ id: S, label: 'General' }, { id: QUIET, label: 'Quiet', meta: { suppressEmbeddings: true } }],
      networks: [], tokens: [],
      allowPrivateModelEndpointsBySlot: { faceExternal: true },
      mediaEmbedding: { levels: { images: 'recognition' }, faceRecognition: { externalModel: { baseUrl: faceUrl, acknowledgedHost: new URL(faceUrl).host } } },
    }, null, 2));
    mongo = await openTestMongo('b89e2b');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    restoreSpawn = installFakeFfmpeg();
    imageMod = await import('../../server/dist/files/media/image-embedder.js');
    audioMod = await import('../../server/dist/files/media/audio-embedder.js');
    videoMod = await import('../../server/dist/files/media/video-embedder.js');
    faceMod = await import('../../server/dist/files/media/face-embedder.js');
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    fileMeta = await import('../../server/dist/files/file-meta.js');
    processingState = await import('../../server/dist/files/derived-fields.js');
  });

  after(async () => {
    restoreSpawn?.();
    await closeTestMongo();
    await embedLocal?.close();
    await new Promise(r => (faceServer ? faceServer.close(r) : r()));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [S, QUIET]) await files(space).deleteMany({});
    await mongo.col('ythril_counters').deleteMany({});
    onEmbed = null; onFaces = null; embedStatus = 200;
  });

  it('the stand-ins answer: a job over a live parent writes its rows (control)', async () => {
    await seedFile('photos/live.png');
    await imageMod.embedImage(S, 'photos/live.png', Buffer.from('png'), 'image/png', { caption: async () => 'a man at a whiteboard' });
    assert.deepEqual(await derivedOf('photos/live.png'), ['photos/live.png#media-chunk0'],
      'control: with nothing flagged the caption chunk must be stored, or every case below proves nothing');
  });

  describe('the four media writers filter on the chunk, and the flag is on the parent', () => {
    it('image caption: no caption chunk exists for the flagged parent', async () => {
      const parent = 'photos/caption.png';
      await seedFile(parent);
      const vision = { caption: async () => { await flag(parent); return 'a man at a whiteboard'; } };
      await imageMod.embedImage(S, parent, Buffer.from('png'), 'image/png', vision);
      assert.deepEqual(await derivedOf(parent), [], `the caption job wrote a chunk for ${parent}, which was flagged deleted while it ran`);
    });

    it('audio chunks: no transcript chunk exists for the flagged parent', async () => {
      const parent = 'calls/q3.wav';
      await seedFile(parent);
      const stt = { transcribe: async () => { await flag(parent); return { text: 'welcome to the quarterly call', segments: [] }; } };
      await audioMod.embedAudio(S, parent, Buffer.from('wav'), 'audio/wav', stt);
      assert.deepEqual(await derivedOf(parent), [], `the audio job wrote a chunk for ${parent}, which was flagged deleted while it ran`);
    });

    it('video re-embed of an audio chunk: the chunk is not rewritten with the keyframe captions of a flagged parent', async () => {
      const parent = 'calls/q3.mp4';
      await seedFile(parent);
      const stt = { transcribe: async () => ({ text: 'welcome to the quarterly call', segments: [] }) };
      // The audio pass stores its chunk while the parent is live; the keyframe captioning that follows is the slow step.
      const vision = { caption: async () => { await flag(parent); return 'a man at a whiteboard'; } };
      await videoMod.embedVideo(S, parent, Buffer.from('mp4'), 'video/mp4', vision, stt, true);
      const rewritten = (await files().find({ parentFileId: parent, content: { $regex: '\\[visual at' } }, { projection: { _id: 1 } }).toArray()).map(r => r._id);
      assert.deepEqual(rewritten, [], `the video job re-embedded a chunk of ${parent} with caption text after the parent was flagged deleted`);
    });

    const png = async () => createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    }).png().toBuffer();

    it('face chunk, parent live: the face provider is reached and its chunk is stored (control)', async () => {
      const parent = 'photos/faces-live.png';
      await seedFile(parent);
      let asked = 0;
      onFaces = async () => { asked++; };
      await faceMod.embedFaces(S, parent, await png());
      assert.deepEqual({ asked, derived: await derivedOf(parent) }, { asked: 1, derived: [`${parent}#face-chunk0`] },
        'control: the face job must reach its provider and its write over a live parent, or the flagged case below proves nothing');
    });

    it('face chunk: no face chunk exists for the flagged parent', async () => {
      const parent = 'photos/faces.png';
      await seedFile(parent);
      onFaces = () => flag(parent);
      await faceMod.embedFaces(S, parent, await png());
      assert.deepEqual(await derivedOf(parent), [], `the face job wrote a face chunk for ${parent}, which was flagged deleted while it ran`);
    });
  });

  describe('embedStoredRecord writes nothing onto a file row flagged since it read it', () => {
    /** The derived fields a job may not put on a flagged row. */
    const WRITTEN = ['embedding', 'embeddingModel', 'matchedText'];
    const keptOf = (row) => WRITTEN.filter(f => f in row);

    it('SUCCESS write (~:257): the vector, its model and its text are not stored on the flagged row', async () => {
      const id = 'docs/embed-success.txt';
      await seedFile(id);
      onEmbed = () => flag(id);
      const outcome = await embedRecord.embedStoredRecord(S, 'file', id);
      assert.deepEqual(keptOf(await files().findOne({ _id: id })), [],
        `embedStoredRecord answered '${outcome}' and stored derived fields on ${id}, which was flagged deleted while it embedded`);
    });

    it('failure path (~:250): the current text is not written onto the flagged row', async () => {
      const id = 'docs/embed-failure.txt';
      await seedFile(id);
      embedStatus = 400;   // not retryable: the refusal is immediate
      onEmbed = () => flag(id);
      await assert.rejects(() => embedRecord.embedStoredRecord(S, 'file', id), 'the stub endpoint refuses, so the job must fail');
      assert.deepEqual(keptOf(await files().findOne({ _id: id })), [],
        `the failure path wrote matchedText onto ${id}, which was flagged deleted while it embedded`);
    });

    it('suppressed branch (~:214), the row flagged before the call: it is not treated as a live row', async () => {
      const id = 'docs/embed-suppressed.txt';
      await seedFile(id, { space: QUIET });
      await flag(id, QUIET);
      const outcome = await embedRecord.embedStoredRecord(QUIET, 'file', id);
      assert.ok(['gone', 'superseded'].includes(outcome), `a flagged row was handled as live: outcome '${outcome}'`);
      assert.deepEqual(keptOf(await files(QUIET).findOne({ _id: id })), [], `the suppressed branch wrote matchedText onto the flagged row ${id}`);
    });

    it('derived $unset (~:200), the row flagged before the call: it is not treated as a live row', async () => {
      const id = 'docs/embed-derived.txt#chunk0';
      await seedFile(id, { parentFileId: 'docs/embed-derived.txt', embedding: [0.1, 0.2, 0.3, 0.4], embeddingModel: 'old' });
      await flag(id);
      const outcome = await embedRecord.embedStoredRecord(S, 'file', id);
      assert.ok(['gone', 'superseded'].includes(outcome), `a flagged row was handled as live: outcome '${outcome}'`);
    });
  });

  describe('the two writers with no job around them', () => {
    it('setDerivedDescriptionIfUnset: no description, no seq, no counter move on a flagged row', async () => {
      const id = 'docs/described.txt';
      await seedFile(id, { seq: 7, author: { instanceId: 'b89e2b', instanceLabel: 'b89e2b' } });
      await mongo.col('ythril_counters').updateOne({ _id: S }, { $set: { seq: 50 } }, { upsert: true });
      await flag(id);
      // In `derived-fields.ts` since bundle-89, with the other writers of what the bytes produced.
      const wrote = await processingState.setDerivedDescriptionIfUnset(S, id, 'a summary of the deleted bytes', 'generated');
      const row = await files().findOne({ _id: id });
      assert.deepEqual({ wrote, description: row.description, descriptionSource: row.descriptionSource, seq: row.seq, counter: await counter() },
        { wrote: false, description: undefined, descriptionSource: undefined, seq: 7, counter: 50 },
        'a derived description was written (and a seq stamped) onto a flagged row');
    });

    it('setFileProcessingState: no processing mark on a flagged row', async () => {
      const id = 'docs/marked.txt';
      await seedFile(id);
      await flag(id);
      await processingState.setFileProcessingState(S, id, { embeddingStatus: 'complete' });
      assert.equal((await files().findOne({ _id: id })).embeddingStatus, undefined, `embeddingStatus was written onto ${id}, a flagged row`);
    });
  });
});
