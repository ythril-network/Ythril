/**
 * No row derived from a file survives under a path whose file was deleted, moved or wiped while a media job was writing for it
 * (bundle-44 D-29, Q-436: the claim fence).
 *
 * ## The defect
 *
 * A media job reads its file's row, spends a long step on the bytes, and then writes the rows it derived (a caption, a face, a
 * transcript segment, a conversion's passages). The write asked "is the parent still live?" with a READ and wrote afterwards, and
 * the check cannot move into the write's filter, because the derived row is a different document from its parent. A delete
 * removes a file's derived rows first and flags or removes the parent after, so a write whose read came before the flag and
 * whose write came after the children went left a derived row behind a parent that was gone. No listing reaches it (its parent is
 * flagged or absent), nothing removed it, and a face row is matched by the gallery search for ever.
 *
 * ## The rule, asserted over the act that races
 *
 * A derived row is written only by the run that holds the file's claim, in the same transaction that reads the parent; whoever
 * removes or re-keys a file takes the claims first. So, whatever the order the two interleave in, **no derived row exists whose
 * parent is flagged or absent** (asserted as the IDENTITIES of the rows whose `parentFileId` is the file, expecting none), and a
 * run that lost its claim stops, not swallows it.
 *
 * ## How the interleaving is made
 *
 * Through the real worker (`_parked-media-runs.mjs`): the vision and face endpoints answer when the test says, so "the run is
 * inside its model call" is a fact the test waits for. The act that races is the real one — REST `DELETE`, REST `PATCH` (a move),
 * `wipeSpace` — and where the race is inside the act (between a delete's child removal and its flag) the driver call that flags
 * is parked (`_parked-driver-call.mjs`). Where one call must wait for another, the test waits until the server reports the waiting
 * write alive (`currentOp`), not for a sleep.
 *
 * ## Seen red
 *
 * On e82caa5e a run released between a delete's child removal and its flag writes its caption under the flagged parent; one parked
 * inside its write lets the delete finish without waiting for it, and the row lands under a gone parent; a move and a wipe leave
 * the same. The cases marked CONTROL are expected green there: they hold what the fence must not break.
 *
 * Run: node --test testing/standalone/a-derived-write-racing-a-delete-or-a-move-leaves-no-row-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';
import { parkDriverCall } from './_parked-driver-call.mjs';
import { waitForLiveWrite } from './_active-operations.mjs';
import { seedClaim, revoke } from './_media-claim.mjs';
import { installFfmpeg } from './_media-job-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 's2race';
const T0 = '2026-09-01T00:00:00.000Z';

let runs, acts, lifecycle, loader, audioMod, imageMod, png;
const files = () => acts.door.coll(S, 'files');
/** The identities of every row derived from `parent`: expected to be none once the parent is gone. */
const derivedOf = async (parent) => (await files().find({ parentFileId: parent }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
const parentOf = (id) => files().findOne({ _id: id });
const isLeaseLost = (err) => err instanceof Error && err.name === 'JobLeaseLostError';
const nextCall = () => runs.vision.calls.length + 1;

/** A stored PNG (the face step decodes the pixels) and its file row, as an upload leaves them. */
async function seedPicture(p) {
  await acts.files.writeFile(S, p, png);
  await files().insertOne({ _id: p, spaceId: S, path: p, sizeBytes: png.length, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
}

/** Seed `p`, queue its job and wait until its run is parked inside its caption call. Returns that call's number. */
async function runInCaptionCall(p) {
  await seedPicture(p);
  const n = nextCall();
  await runs.startRun(p);
  await runs.vision.arrival(n);
  return n;
}

describe('a derived write racing a delete, a move or a wipe leaves no row (real worker, real Mongo)', { skip }, () => {
  before(async () => {
    runs = await openParkedMediaRuns({ suite: 's2race', space: S, faces: true });
    acts = runs.acts;
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    loader = await import('../../server/dist/config/loader.js');
    audioMod = await import('../../server/dist/files/media/audio-embedder.js');
    imageMod = await import('../../server/dist/files/media/image-embedder.js');
    png = await createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    }).png().toBuffer();
  });
  after(async () => { await runs?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    runs.vision.parking(true);
    runs.face.parking(false);
  });
  afterEach(() => { runs.vision.releaseAll(); runs.face.releaseAll(); });

  for (const soft of [true, false]) {
    const how = soft ? 'flagged' : 'absent';

    it(`a run released BETWEEN a delete's child removal and its flag writes nothing: no derived row under a ${how} parent`, async () => {
      loader.getConfig().softDeleteFileMeta = soft;
      const p = `between-${how}.png`;
      const n = await runInCaptionCall(p);
      // The delete's last step is the parent's flag (soft) or removal (hard). Parked BEFORE it runs, the children have gone.
      const flag = soft
        ? parkDriverCall(acts.door.mongo, S, 'files', 'updateOne', (f, u) => f?._id === p && Array.isArray(u), { before: true })
        : parkDriverCall(acts.door.mongo, S, 'files', 'deleteOne', (f) => f?._id === p, { before: true });
      try {
        const del = acts.del('REST', p);
        await flag.reached;
        const ended = runs.runEnded(p);
        runs.vision.release(n);
        await ended;
        flag.release();
        assert.equal(acts.statusOf(await del), 204, 'the delete did not answer 204');
      } finally { flag.restore(); }
      assert.deepEqual(await derivedOf(p), [], `a derived row stands under ${p}, which the delete ${soft ? 'flagged' : 'removed'}`);
      const parent = await parentOf(p);
      assert.ok(parent === null || parent.deletedAt, 'fixture: the parent is still live, so the delete did not run');
    });

    it(`a delete that lands while the run's write is open waits for it and removes what it wrote: no derived row under a ${how} parent`, async () => {
      loader.getConfig().softDeleteFileMeta = soft;
      const p = `inside-${how}.png`;
      const n = await runInCaptionCall(p);
      const chunk = `${p}#media-chunk0`;
      // The run's write is parked just before its row lands: past its fence (the job document is held), before the row.
      const write = parkDriverCall(acts.door.mongo, S, 'files', 'replaceOne', (f) => f?._id === chunk, { before: true });
      let blocked = false;
      try {
        const ended = runs.runEnded(p);
        runs.vision.release(n);
        await write.reached;
        const del = acts.del('REST', p);
        // The delete's first step takes the job. If the run holds it, that write is ALIVE in the server and waiting.
        blocked = await waitForLiveWrite(acts.door.mongo, `${S}_media_jobs`, { startMs: 3000 });
        write.release();
        await ended;
        assert.equal(acts.statusOf(await del), 204, 'the delete did not answer 204');
      } finally { write.restore(); }
      assert.deepEqual(await derivedOf(p), [], `a derived row stands under ${p}, which the delete ${soft ? 'flagged' : 'removed'}`);
      assert.ok(blocked, 'the delete did not wait for the run that held its job: it can finish while the run is still about to write');
    });
  }

  it('CONTROL: a run released after the whole delete finds its claim gone and writes nothing', async () => {
    const p = 'after-delete.png';
    const n = await runInCaptionCall(p);
    assert.equal(acts.statusOf(await acts.del('REST', p)), 204);
    const ended = runs.runEnded(p);
    runs.vision.release(n);
    await ended;
    assert.deepEqual(await derivedOf(p), [], `a derived row stands under ${p}`);
  });

  it('CONTROL: a run that finished before the delete leaves rows, and the delete removes every one', async () => {
    const p = 'before-delete.png';
    runs.vision.parking(false);
    await seedPicture(p);
    const ended = runs.runEnded(p);
    await runs.startRun(p);
    await ended;
    assert.ok((await derivedOf(p)).length > 0, 'fixture: the run wrote no row, so there is nothing for the delete to remove');
    assert.equal(acts.statusOf(await acts.del('REST', p)), 204);
    assert.deepEqual(await derivedOf(p), [], `a derived row stands under ${p} after its delete`);
  });

  it('a MOVE that lands while the run\'s write is open waits for it: no row stands at the old id, the rows follow the file', async () => {
    const p = 'move-from.png';
    const to = 'move-to.png';
    const n = await runInCaptionCall(p);
    const chunk = `${p}#media-chunk0`;
    const write = parkDriverCall(acts.door.mongo, S, 'files', 'replaceOne', (f) => f?._id === chunk, { before: true });
    let blocked = false;
    try {
      const ended = runs.runEnded(p);
      runs.vision.release(n);
      await write.reached;
      const mv = acts.move('REST', p, to);
      blocked = await waitForLiveWrite(acts.door.mongo, `${S}_media_jobs`, { startMs: 3000 });
      write.release();
      await ended;
      assert.equal(acts.statusOf(await mv), 200, 'the move did not answer 200');
    } finally { write.restore(); }
    assert.deepEqual(await derivedOf(p), [], `a derived row stands under ${p}, the path the file left`);
    assert.equal(await parentOf(p), null, 'the file is still at its old id');
    assert.ok(await parentOf(to), 'the file is not at its new id');
    assert.ok(blocked, 'the move did not wait for the run that held its job');
  });

  it('a space WIPE that lands while the run\'s write is open waits for it: no derived row survives the wipe', async () => {
    const p = 'wipe.png';
    const n = await runInCaptionCall(p);
    const chunk = `${p}#media-chunk0`;
    const write = parkDriverCall(acts.door.mongo, S, 'files', 'replaceOne', (f) => f?._id === chunk, { before: true });
    let blocked = false;
    try {
      const ended = runs.runEnded(p);
      runs.vision.release(n);
      await write.reached;
      const wipe = lifecycle.wipeSpace(S, ['files']);
      blocked = await waitForLiveWrite(acts.door.mongo, `${S}_media_jobs`, { startMs: 3000 });
      write.release();
      await wipe;
      await ended;
    } finally { write.restore(); }
    assert.deepEqual(await files().find({}, { projection: { _id: 1 } }).toArray(), [], 'a row of the wiped space survived the wipe');
    assert.ok(blocked, 'the wipe did not take the space\'s jobs before it removed the rows: a run in flight can still write after it');
  });

  describe('an embedder whose claim went does not swallow it', () => {
    it('an audio run stops at the chunk whose write found its claim gone: no further transcription call', async () => {
      const id = 'calls/long.wav';
      const handle = { path: seedHandle(id), size: 4, copied: true, dispose: async () => {} };
      const ffmpeg = installFfmpeg({ durationS: 900 });
      try {
        await files().insertOne({ _id: id, spaceId: S, path: id, sizeBytes: 4, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
        const claim = await seedClaim(S, id, { mediaType: 'audio' });
        let transcriptions = 0;
        const stt = { transcribe: async () => { transcriptions++; if (transcriptions === 1) await revoke(S, id); return { text: 'words', segments: [] }; } };
        await assert.rejects(
          () => audioMod.embedAudio(S, id, handle, 'audio/wav', stt, undefined, { claim, shouldStop: () => false }),
          isLeaseLost, 'the run swallowed the loss of its claim');
        assert.equal(transcriptions, 1, 'the run went on transcribing chunks after its first write found its claim gone');
        assert.deepEqual(await derivedOf(id), [], 'a transcript chunk was written without the claim');
      } finally { ffmpeg.restore(); }
    });

    it('an image run whose claim went inside the face step does not swallow it through the face catch', async () => {
      const id = 'photos/faces.png';
      await seedPicture(id);
      const claim = await seedClaim(S, id);
      const handle = { path: seedHandle(id, png), size: png.length, copied: true, dispose: async () => {} };
      runs.face.parking(true);
      const faceCall = runs.face.calls.length + 1;
      const vision = { caption: async () => 'a grey square' };
      const run = imageMod.embedImage(S, id, handle, 'image/png', vision, { claim });
      await runs.face.arrival(faceCall);
      await revoke(S, id);
      runs.face.release(faceCall);
      await assert.rejects(() => run, isLeaseLost, 'the face step\'s loss of the claim was absorbed as a face failure');
      assert.deepEqual(await derivedOf(id), [`${id}#media-chunk0`], 'only the caption written while the claim was held may stand');
    });
  });
});

/** A plaintext handle's file under the harness's data root; the embedders read a PATH and a size, never bytes. */
function seedHandle(id, bytes = Buffer.from('wav')) {
  const p = path.join(process.env['DATA_ROOT'], `handle-${id.replace(/[^a-z0-9.]/gi, '-')}`);
  fs.writeFileSync(p, bytes);
  return p;
}
