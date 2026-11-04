/**
 * The WORKER, over a gallery that refuses while a face is labelled: the job is deferred with no attempt spent, and once its deferrals are
 * spent the face is stored and counted exactly once (Q-698, bundle-236; DESIGN v3 item 8, "the refusing-gallery worker test" and "the
 * deferral_spent worker test (31 min)").
 *
 * ## Why the worker, and why this file
 *
 * `a-gallery-that-cannot-answer-is-retried-while-a-face-is-labelled-db` asks the SEARCH (`gallerySearch`), `a-media-job-can-be-deferred-...-db`
 * asks the QUEUE (`deferJob`). Neither asks the thing bundle-236 changes in between: the worker reading `gallerySearch`'s answer and
 * `deferJob`'s, which become typed (`could_not_answer` | `deferred` | `past_cap` | `lost`). A run through the real worker is the one place
 * where a slip in either mapping (a refusal read as "no one", a deferral read as a failure that spends an attempt, a counter moved twice
 * for one face) is a visible job state.
 *
 * ## The rules
 *
 *  1. A gallery whose index refuses while a labelled face exists leaves the job `pending` with `attempts` 0 (the claim's attempt refunded),
 *     `facesOnly` and `deferredSince` set and a wait ahead of it; no face row is stored for the picture.
 *  2. Once the job has been deferred for more than 30 minutes (`deferredSince` 31 minutes ago) the same refusal stores the face (unlabelled:
 *     the picture has no earlier row), completes the job, and moves `ythril_faces_stored_unmatched_total{reason="deferral_spent"}` by
 *     exactly one, whatever value the counter started from (it is read from a poisoned start: a test that asserts an absolute 1 passes on a
 *     fresh process and says nothing about a counter that is bumped twice).
 *
 * ## State on the base
 *
 * CHARACTERISATION, green on the base (seen): the base already defers (`deferJob` returns `true`) and already stores a face past the cap and
 * counts it once, so both cases are the behaviour the typed routing must KEEP. They are the net under the change: the worker's comparison
 * `deferred === 'deferred'`, the new routes of `lost` and `past_cap`, and the `could_not_answer` branch of `embedFaces` are written against them.
 *
 * The refusal is injected at the `$vectorSearch` aggregate (`_mongot-refusals.mjs`); the file doors, the queue, the worker, the embedders and
 * the writers are the real ones, and only the two model endpoints answer for themselves (`_parked-media-runs.mjs`, answering at once).
 *
 * Needs a MongoDB and a private address: `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-refusing-gallery-defers-a-face-job-and-a-spent-deferral-stores-the-face-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'refusinggallery';
const T0 = '2026-09-01T00:00:00.000Z';
const FACE_DIMS = 128;
const MINUTE = 60_000;

let runs, acts, png, metrics;
const files = () => acts.door.coll(S, 'files');
const jobs = () => acts.door.coll(S, 'media_jobs');

async function seedPicture(p) {
  await acts.files.writeFile(S, p, png);
  await files().insertOne({ _id: p, spaceId: S, path: p, sizeBytes: png.length, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
}

/** The gallery holds a labelled face (of another picture): the only thing that makes a refused search a gallery that could not answer. */
const seedLabelledFace = () => files().insertOne({
  _id: 'someone.png#face-chunk0', spaceId: S, path: 'someone.png#face-chunk0', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: FACE_DIMS * 4,
  parentFileId: 'someone.png', chunkIndex: 0, faceEmbedding: Array.from({ length: FACE_DIMS }, (_, i) => (i + 3) / 200), faceEntityId: 'person-1', faceScore: 0.9,
});

const faceRowsOf = (p) => files().find({ parentFileId: p, faceEmbedding: { $exists: true } }).toArray();

/** The counter's series for one reason. */
async function unmatched(reason) {
  const text = await metrics.register.metrics();
  const m = text.match(new RegExp(`^ythril_faces_stored_unmatched_total\\{[^}]*reason="${reason}"[^}]*\\} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return m ? Number(m[1]) : 0;
}

describe('the worker over a gallery that refuses while a face is labelled (real worker, real Mongo)', { skip }, () => {
  before(async () => {
    runs = await openParkedMediaRuns({ suite: 'refusinggallery', space: S, faces: true });
    acts = runs.acts;
    metrics = await import('../../server/dist/metrics/registry.js');
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
    await seedLabelledFace();
  });

  it('a refused gallery leaves the job pending with no attempt spent, deferred behind a wait, and stores no face', async () => {
    const p = 'defer-me.png';
    await seedPicture(p);
    const fault = refuseVectorSearch(REFUSALS.initialSync);
    try {
      await runs.startRun(p);
      await waitFor(async () => {
        const j = await jobs().findOne({ _id: p });
        return j?.status === 'pending' && !!j.deferredSince;
      }, 20_000, 100, `the job of ${p} was never deferred`);
    } finally {
      runs.worker.stopMediaEmbeddingWorker();
      fault.restore();
    }
    assert.ok(fault.refused() >= 1, 'fixture check: the injected refusal never reached the gallery');
    const job = await jobs().findOne({ _id: p });
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0, `a deferral spent an attempt (attempts ${job.attempts}): a rebuilding face index would end the job failed after three`);
    assert.equal(job.facesOnly, true, 'the deferred job does not say its caption is stored');
    assert.ok(Date.parse(job.claimableAfter) > Date.now() + 30_000, `the deferred job is claimable again at ${job.claimableAfter}: no wait ahead of it`);
    assert.deepEqual(await faceRowsOf(p), [], 'a face was stored for a picture whose gallery had not answered');
  });

  it('a job deferred for more than 30 minutes stores the face and counts deferral_spent exactly once, from a poisoned start', async () => {
    const p = 'spent.png';
    await seedPicture(p);
    metrics.facesStoredUnmatchedTotal.labels({ reason: 'deferral_spent' }).inc(41);
    const before = await unmatched('deferral_spent');
    const ended = runs.runEnded(p);
    const fault = refuseVectorSearch(REFUSALS.initialSync);
    try {
      await jobs().insertOne({ _id: p, spaceId: S, filePath: p, mimeType: 'image/png', mediaType: 'image', status: 'pending', attempts: 0, maxAttempts: 3,
        lastError: null, claimedAt: null, claimToken: null, claimableAfter: new Date(Date.now() - 1_000).toISOString(), facesOnly: true,
        deferredSince: new Date(Date.now() - 31 * MINUTE).toISOString(), createdAt: T0, updatedAt: T0 });
      runs.queue.markSpaceMayHaveWork(S);
      runs.worker.startMediaEmbeddingWorker();
      await ended;
    } finally {
      runs.worker.stopMediaEmbeddingWorker();
      fault.restore();
    }
    assert.ok(fault.refused() >= 1, 'fixture check: the injected refusal never reached the gallery');
    assert.equal((await jobs().findOne({ _id: p })).status, 'complete', 'the job past its deferral cap was deferred again instead of completing');
    const rows = await faceRowsOf(p);
    assert.equal(rows.length, 1, `${rows.length} face rows were stored: the face must be stored once the deferrals are spent`);
    assert.equal(rows[0].faceEntityId, undefined, 'the picture has no earlier row, so the face is stored with no label');
    assert.equal((await unmatched('deferral_spent')) - before, 1, 'the counter of faces stored for want of a gallery did not move by exactly one for one face');
  });
});
