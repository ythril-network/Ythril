/**
 * A media embedder whose claim is gone ends the run: it THROWS the abandonment, never breaks out of its loop and returns a result, and
 * never absorbs it in a catch (bundle-44, D-29, Q-436; rulings 4, 14, 45).
 *
 * ## The rule
 *
 * The loss of a run's claim (or of its space's writability) is not a chunk, a keyframe or a face that failed: the file is another run's now.
 * Every hop of an embedder therefore stops through the lease check that THROWS (`stopIfLeaseLost`, `files/media/lease.ts`), so the worker
 * ends the run as abandoned: no `completeJob`, no `failJob`, nothing written. The audio and the video loops used to `break` on the lease flag
 * and return what they had: a run that lost its claim to a move reported a partial transcript as a result, and the video went on to the
 * re-embed of the chunks with the captions it had.
 *
 * ## What each case holds
 *
 *  - **audio** and the video's **keyframe loop**: once the lease flag is set the next hop is not made and the run rejects with the lost lease.
 *  - **the video's re-embed catch** and **the face step's auto-label catch**: a claim that went inside a write about the file rethrows. Both
 *    already did; they are held here because a catch that swallows looks right everywhere it stands (the derived gate over every catch is
 *    `every-catch-that-sees-a-fenced-write-rethrows-abandonment`).
 *
 * Run: node --test testing/standalone/an-embedder-that-loses-its-claim-ends-the-run-instead-of-returning-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';
import { seedClaim, revoke } from './_media-claim.mjs';
import { installFfmpeg } from './_media-job-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'embabandon';
const T0 = '2026-09-01T00:00:00.000Z';
const PERSON = '33333333-3333-4333-8333-333333333333';

let runs, acts, audioMod, videoMod, imageMod, png;
const files = () => acts.door.coll(S, 'files');
const derivedOf = async (parent) => (await files().find({ parentFileId: parent }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
const isLeaseLost = (err) => err instanceof Error && err.name === 'JobLeaseLostError';

/** A plaintext handle's file under the harness's data root; the embedders read a PATH and a size, never bytes. */
function handleFor(id, bytes = Buffer.from('wav')) {
  const p = path.join(process.env['DATA_ROOT'], `handle-${id.replace(/[^a-z0-9.]/gi, '-')}`);
  fs.writeFileSync(p, bytes);
  return { path: p, size: bytes.length, copied: true, dispose: async () => {} };
}
async function seedFileRow(id) {
  await files().insertOne({ _id: id, spaceId: S, path: id, sizeBytes: 4, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
}

describe('an embedder whose claim is gone ends the run (real MongoDB, real writers)', { skip }, () => {
  before(async () => {
    runs = await openParkedMediaRuns({ suite: 'embabandon', space: S, faces: true });
    acts = runs.acts;
    audioMod = await import('../../server/dist/files/media/audio-embedder.js');
    videoMod = await import('../../server/dist/files/media/video-embedder.js');
    imageMod = await import('../../server/dist/files/media/image-embedder.js');
    png = await createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    }).png().toBuffer();
  });
  after(async () => { await runs?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones', 'entities']) await acts.door.coll(S, part).deleteMany({});
    runs.vision.parking(false);
    runs.face.parking(false);
  });

  it('audio: once the lease flag is set the next segment is not transcribed and the run rejects with the lost lease', async () => {
    const id = 'calls/flag.wav';
    await seedFileRow(id);
    const claim = await seedClaim(S, id, { mediaType: 'audio' });
    const ffmpeg = installFfmpeg({ durationS: 900 });
    try {
      let lost = false;
      let transcriptions = 0;
      const stt = { transcribe: async () => { transcriptions++; lost = true; return { text: 'words', segments: [] }; } };

      await assert.rejects(
        () => audioMod.embedAudio(S, id, handleFor(id), 'audio/wav', stt, undefined, { claim, shouldStop: () => lost }),
        isLeaseLost, 'a run whose lease flag was set returned a result instead of ending as abandoned');
      assert.equal(transcriptions, 1, 'the run went on transcribing after its lease flag was set');
    } finally { ffmpeg.restore(); }
  });

  it('video, keyframe loop: once the lease flag is set the next frame is not captioned and the run rejects with the lost lease', async () => {
    const id = 'clips/flag.mp4';
    await seedFileRow(id);
    const claim = await seedClaim(S, id, { mediaType: 'video' });
    const ffmpeg = installFfmpeg({ durationS: 900 });
    try {
      let lost = false;
      let captions = 0;
      const vision = { caption: async () => { captions++; lost = true; return 'a frame'; } };
      const stt = { transcribe: async () => ({ text: 'words', segments: [] }) };

      await assert.rejects(
        () => videoMod.embedVideo(S, id, handleFor(id), 'video/mp4', vision, stt, true, 5000, 30, { claim, shouldStop: () => lost }),
        isLeaseLost, 'a run whose lease flag was set went on to re-embed its chunks with the captions it had and returned');
      assert.equal(captions, 1, 'the run went on captioning after its lease flag was set');
    } finally { ffmpeg.restore(); }
  });

  it('video, re-embed catch: a claim that went before the chunk rewrite is rethrown, not logged as a chunk that failed to re-embed', async () => {
    const id = 'clips/reembed.mp4';
    await seedFileRow(id);
    const claim = await seedClaim(S, id, { mediaType: 'video' });
    const ffmpeg = installFfmpeg({ durationS: 900 });
    try {
      let captions = 0;
      const vision = { caption: async () => { if (++captions === 1) await revoke(S, id); return 'a frame'; } };
      const stt = { transcribe: async () => ({ text: 'words', segments: [] }) };

      await assert.rejects(
        () => videoMod.embedVideo(S, id, handleFor(id), 'video/mp4', vision, stt, true, 5000, 30, { claim, shouldStop: () => false }),
        isLeaseLost, 'the re-embed of a chunk whose claim had gone was absorbed as a chunk failure');
    } finally { ffmpeg.restore(); }
  });

  it('image, face auto-label catch: a claim that went before the label is written is rethrown, not logged as a failed auto-label', async () => {
    const id = 'photos/label.png';
    await acts.files.writeFile(S, id, png);
    await files().insertOne({ _id: id, spaceId: S, path: id, sizeBytes: png.length, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
    await acts.door.coll(S, 'entities').insertOne({ _id: PERSON, spaceId: S, name: 'P', type: 'person', tags: [], createdAt: T0, seq: 1, author: { instanceId: 'x', instanceLabel: 'x' } });
    const claim = await seedClaim(S, id);
    const handle = handleFor(id, png);
    // The gallery answers a labelled face (a real answer needs a vector-search index, which the test store has not): the face is auto-labelled.
    // The claim is taken in the instant the label is about to be decided on, the read the label's own guard makes.
    const filesProto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
    const aggregate = filesProto.aggregate;
    const countDocuments = filesProto.countDocuments;
    filesProto.aggregate = function gallery(pipeline, ...rest) {
      if (this.collectionName === `${S}_files` && Array.isArray(pipeline) && pipeline[0]?.['$vectorSearch']) {
        return { toArray: async () => [{ window: [{ n: 0, min: 0 }], hits: [{ _id: 'labelled', score: 0.99, faceEntityId: PERSON }] }] };
      }
      return aggregate.call(this, pipeline, ...rest);
    };
    filesProto.countDocuments = async function takeTheClaimFirst(...args) {
      if (this.collectionName === `${S}_media_jobs`) await revoke(S, id);
      return countDocuments.apply(this, args);
    };
    try {
      await assert.rejects(
        () => imageMod.embedImage(S, id, handle, 'image/png', { caption: async () => 'a grey square' }, { claim }),
        isLeaseLost, 'the loss of the claim in the face step\'s auto-label was absorbed as a failed label');
    } finally {
      filesProto.aggregate = aggregate;
      filesProto.countDocuments = countDocuments;
    }
    assert.deepEqual((await derivedOf(id)).filter(r => r.includes('#face-chunk')), [`${id}#face-chunk0`], 'the face row written while the claim was held is the only one that may stand');
  });
});
