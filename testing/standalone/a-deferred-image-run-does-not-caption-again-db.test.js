/**
 * The re-run of a deferred image job analyses the faces only: it does not caption the image again when the caption is already stored
 * (Q-327, bundle-72; AUDIT-VET S2, premise P11).
 *
 * ## Why
 *
 * An image whose face gallery could not answer is deferred (`job-queue.ts: deferJob`, `a-media-job-can-be-deferred-without-spending-an-attempt-db`)
 * and run again a minute later, possibly many times while a face index rebuilds. The run is `embedImage`: caption first (a vision model call, the
 * expensive step), then the faces. Re-running it whole spends a vision call per deferral per photo, and a rebuild after a container recreate is
 * 120 s or more, over every face photo of a space (the same cost as the retries it replaces, `failJob`, which re-ran the caption three times).
 *
 * ## The rules
 *
 *  1. A job carrying `facesOnly` skips the caption step when the caption row of the same file already exists
 *     (`<file>#media-chunk0`, written by the first run): the vision model is not called and the stored caption is untouched. The upsert stays the
 *     one writer of that row (`upsertDerivedFileRow`), so a run that did NOT find the row still writes it.
 *  2. The face step still runs, and the job still ends `complete`.
 *  3. A `facesOnly` job whose caption row does NOT exist still captions: the flag skips work that is done, never work that is owed.
 *  4. A job without the flag captions as ever (the control: the worker and the call counting below are the real ones).
 *
 * ## How
 *
 * The real worker, over a real Mongo, with the vision and the face endpoints answered by the harness (`_parked-media-runs.mjs`, answering at once
 * here): a skipped caption is a vision call that never arrives. The deferred job is written whole, as `deferJob` leaves one (`pending`, a wait that
 * has run out, `facesOnly`, `deferredSince`), so this file's rules do not depend on the writer being there.
 *
 * Seen red on the base: the caption is made again (a vision call) and the stored caption is replaced.
 *
 * Needs a MongoDB and a private address (the face endpoint is fetched through the SSRF guards): `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-deferred-image-run-does-not-caption-again-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'defercaption';
const T0 = '2026-09-01T00:00:00.000Z';
const STORED = 'the caption the first run stored';

let runs, acts, png;
const files = () => acts.door.coll(S, 'files');
const jobs = () => acts.door.coll(S, 'media_jobs');

async function seedPicture(p) {
  await acts.files.writeFile(S, p, png);
  await files().insertOne({ _id: p, spaceId: S, path: p, sizeBytes: png.length, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
}

/** The caption row the first run of `p` stored. */
const seedCaption = (p) => files().insertOne({ _id: `${p}#media-chunk0`, spaceId: S, path: `${p}#media-chunk0`, tags: [], createdAt: T0, updatedAt: T0,
  sizeBytes: Buffer.byteLength(STORED), parentFileId: p, chunkIndex: 0, content: STORED, matchedText: STORED });

/** The job as a deferral leaves it, claimable now. */
const deferredJob = (p) => ({ _id: p, spaceId: S, filePath: p, mimeType: 'image/png', mediaType: 'image', status: 'pending', attempts: 0,
  maxAttempts: 3, lastError: null, claimedAt: null, claimToken: null, claimableAfter: new Date(Date.now() - 1_000).toISOString(),
  facesOnly: true, deferredSince: new Date(Date.now() - 120_000).toISOString(), createdAt: T0, updatedAt: T0 });

/** Run the job of `p` to its end with the model endpoints answering at once; what the run asked of them. */
async function runToEnd(p, insertJob) {
  const visionBefore = runs.vision.calls.length;
  const faceBefore = runs.face.calls.length;
  const ended = runs.runEnded(p);
  await insertJob();
  runs.queue.markSpaceMayHaveWork(S);
  runs.worker.startMediaEmbeddingWorker();
  const line = await ended;
  return { line, vision: runs.vision.calls.length - visionBefore, face: runs.face.calls.length - faceBefore };
}

describe('the re-run of a deferred image job analyses faces only (real worker, real Mongo)', { skip }, () => {
  before(async () => {
    runs = await openParkedMediaRuns({ suite: 'defercaption', space: S, faces: true });
    acts = runs.acts;
    png = await createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    }).png().toBuffer();
  });
  after(async () => { await runs?.close(); });
  beforeEach(async () => {
    await acts.reset();
    await jobs().deleteMany({});
    runs.vision.parking(false);
    runs.face.parking(false);
  });

  it('control: a job without the flag captions the image, even where a caption row exists, and runs the face step', async () => {
    const p = 'control.png';
    await seedPicture(p);
    await seedCaption(p);
    const ran = await runToEnd(p, () => queue().enqueueMediaJob(S, p, 'image/png', 'image'));
    assert.equal(ran.vision, 1, `the control run made ${ran.vision} vision calls: the harness does not count a caption, so no case below says anything`);
    assert.ok(ran.face >= 1, 'the control run never reached the face step');
    assert.notEqual((await files().findOne({ _id: `${p}#media-chunk0` })).content, STORED, 'the control run did not rewrite the caption row');
  });

  it('a facesOnly job with its caption row stored does not call the vision model, leaves the caption alone, and still runs the faces', async () => {
    const p = 'faces-only.png';
    await seedPicture(p);
    await seedCaption(p);
    const ran = await runToEnd(p, () => jobs().insertOne(deferredJob(p)));
    assert.equal(ran.vision, 0, `the re-run made ${ran.vision} vision call(s): every deferral of every photo of the space captions it again`);
    assert.equal((await files().findOne({ _id: `${p}#media-chunk0` })).content, STORED, 'the stored caption was replaced');
    assert.ok(ran.face >= 1, 'the face step did not run: a faces-only re-run that skips the faces is no re-run');
    assert.equal((await jobs().findOne({ _id: p })).status, 'complete', `the run did not complete its job: ${ran.line}`);
  });

  it('a facesOnly job whose caption row does not exist still captions: the flag skips work that is done, never work that is owed', async () => {
    const p = 'owed.png';
    await seedPicture(p);
    const ran = await runToEnd(p, () => jobs().insertOne(deferredJob(p)));
    assert.equal(ran.vision, 1, 'the image has no caption row and the faces-only run did not make one');
    assert.ok((await files().findOne({ _id: `${p}#media-chunk0` }))?.content, 'no caption row was written');
    assert.ok(ran.face >= 1);
  });
});

/** The queue module the harness loaded, read at call time: the run's own, so enqueue and claim share one module state. */
function queue() { return runs.queue; }
