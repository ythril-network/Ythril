/**
 * A media job writes NOTHING about its file once its claim is gone — not a derived row, not a status mark, not an excerpt or a
 * description, not the end of its own job (bundle-44 D-29, Q-436, ruling 24).
 *
 * ## The defect
 *
 * The claim fence covered one write of a run — a conversion's whole set of rows — and nothing else. A run's other writes about its
 * file took the file's PATH and the job's ID and asked nothing of who held them. A run that lost its claim to a delete and a
 * re-upload of the same path therefore wrote into the NEW file: its processing state, its excerpt, its description, the rows it
 * derived from the old bytes (under the path the new file now has), and `completeJob` (an update by the job's `_id`, which is the
 * path) ended the NEW run's job as complete while that run was still working. Nothing was missing from the new file that anybody
 * could see; the rows simply described other bytes.
 *
 * ## The rule
 *
 * Every write a run makes about its file is made under ITS claim (`writeUnderClaim`): the database refuses it when the job document
 * no longer matches the run's token, and the run ends as ABANDONED — neither completed nor failed. So:
 *
 *  - run A claims `p`, is inside its caption call; `p` is deleted and uploaded again; run B claims the new `p`; A is released: A
 *    lands NOTHING on B's row (asserted by deep equality of the row before and after) or on B's job document, and no row derived by
 *    A exists; B then finishes by itself.
 *  - the writers and the end of a job, called with a claim that no longer holds the job, throw `JobLeaseLostError` and change nothing.
 *  - a run whose caption hop outlasts the stall threshold beats at the entry of its next hop, so stall recovery does not take the
 *    job (a run that was recovered would meet its own fence at the first write after the recovery).
 *
 * ## How
 *
 * The worker is the real one (`_parked-media-runs.mjs`): the model calls wait for the test, so "A is inside its call while the
 * file is deleted and uploaded again" is the run's own state. The direct cases take their claims from `_media-claim.mjs`.
 *
 * ## Seen red
 *
 * On e82caa5e A's caption chunk, face chunk, description, processing state and `completeJob` all land on B's row and job; B's job
 * reads `complete` while B is still parked in its caption call. The image run beats nowhere between its hops, so its `progressAt` stays
 * where it was back-dated to and stall recovery takes the job.
 *
 * Run: node --test testing/standalone/a-job-writes-nothing-about-its-file-after-its-claim-went-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';
import { seedClaim, jobOf } from './_media-claim.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 's2claim';
const T0 = '2026-09-01T00:00:00.000Z';
const LONG_AGO = '2020-01-01T00:00:00.000Z';

let runs, acts, queue, derived, loader, png;
const files = () => acts.door.coll(S, 'files');
const derivedOf = async (parent) => (await files().find({ parentFileId: parent }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
const isLeaseLost = (err) => err instanceof Error && err.name === 'JobLeaseLostError';
/** What identifies a run's claim on its job: the fields only a claim, an end or a recovery changes (never its heartbeat). */
const claimState = (job) => job && ({
  status: job.status, claimToken: job.claimToken, attempts: job.attempts, lastError: job.lastError ?? null,
  claimedAt: job.claimedAt ?? null, claimableAfter: job.claimableAfter ?? null,
});

async function seedPicture(p) {
  await acts.files.writeFile(S, p, png);
  await files().insertOne({ _id: p, spaceId: S, path: p, sizeBytes: png.length, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
}

describe('a media job writes nothing about its file after its claim went (real worker, real Mongo)', { skip }, () => {
  before(async () => {
    runs = await openParkedMediaRuns({ suite: 's2claim', space: S, faces: true });
    acts = runs.acts;
    queue = runs.queue;
    derived = await import('../../server/dist/files/derived-fields.js');
    loader = await import('../../server/dist/config/loader.js');
    png = await createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    }).png().toBuffer();
  });
  after(async () => { await runs?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    loader.getConfig().softDeleteFileMeta = false;
    runs.vision.parking(true);
    runs.face.parking(false);
  });
  afterEach(() => { runs.vision.releaseAll(); runs.face.releaseAll(); });

  it('run A, released after its file was deleted and uploaded again and run B took the path, lands nothing on B\'s row or job', async () => {
    const p = 'reused.png';
    await seedPicture(p);
    const callA = runs.vision.calls.length + 1;
    await runs.startRun(p);
    await runs.vision.arrival(callA);

    assert.equal(acts.statusOf(await acts.del('REST', p)), 204, 'fixture: the delete did not answer 204');
    await seedPicture(p);
    const callB = callA + 1;
    await runs.startRun(p);
    await runs.vision.arrival(callB);

    const jobB = await jobOf(S, p);
    const rowB = await files().findOne({ _id: p });
    assert.equal(jobB?.status, 'processing', 'fixture: run B is not holding the job');
    assert.deepEqual(await derivedOf(p), [], 'fixture: a row is derived before either run wrote');

    const ended = runs.runEnded(p);
    runs.vision.release(callA);
    await ended;

    assert.deepEqual(claimState(await jobOf(S, p)), claimState(jobB), 'run A changed run B\'s job: it ended it, failed it or took its claim');
    assert.deepEqual(await files().findOne({ _id: p }), rowB, 'run A wrote on the row of the file that replaced its own: a processing state, an excerpt or a description');
    assert.deepEqual(await derivedOf(p), [], 'run A left rows derived from the bytes of the file that was deleted, under the path of the one that replaced it');

    // B is untouched and finishes by itself.
    const endedB = runs.runEnded(p);
    runs.vision.release(callB);
    await endedB;
    assert.equal((await jobOf(S, p))?.status, 'complete', 'run B did not complete its own job');
    const chunk = await files().findOne({ _id: `${p}#media-chunk0` });
    assert.equal(chunk?.content, `caption of call ${callB}`, 'the caption stored is not the one run B made');
    assert.equal((await files().findOne({ _id: p }))?.embeddingStatus, 'complete', 'run B\'s row was not completed');
  });

  it('a run whose caption hop outlasts the stall threshold beats at the entry of its next hop, and stall recovery leaves the job alone', async () => {
    const p = 'slow-caption.png';
    await seedPicture(p);
    const callN = runs.vision.calls.length + 1;
    runs.face.parking(true);
    const faceN = runs.face.calls.length + 1;
    await runs.startRun(p);
    await runs.vision.arrival(callN);
    // The caption hop is slow: nothing has beaten for far longer than any stall threshold.
    await acts.door.coll(S, 'media_jobs').updateOne({ _id: p }, { $set: { progressAt: LONG_AGO } });

    runs.vision.release(callN);
    await runs.face.arrival(faceN);
    // The beat is fire-and-forget; the run is in its face hop, so the entry of that hop has been made.
    await waitFor(async () => String((await jobOf(S, p))?.progressAt) > LONG_AGO, 5000, 50,
      'the image run entered its face hop without beating: a slow caption hop leaves the job silent past the stall threshold');
    await queue.resetStalledJobs([S], 60_000);
    assert.equal((await jobOf(S, p))?.status, 'processing', 'stall recovery took a job whose run had just entered its next hop');
    runs.face.releaseAll();
  });

  describe('the writers and the end of a job, under a claim that no longer holds the job', () => {
    const p = 'stale.png';
    let stale, current;
    beforeEach(async () => {
      await files().insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0, seq: 1, embeddingStatus: 'processing' });
      stale = await seedClaim(S, p);
      current = await seedClaim(S, p);
    });
    const chunk = () => ({ _id: `${p}#media-chunk0`, spaceId: S, path: `${p}#media-chunk0`, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, parentFileId: p, chunkIndex: 0, content: 'old caption' });

    const WRITES = {
      upsertDerivedFileRow: () => derived.upsertDerivedFileRow(S, stale, chunk()),
      replaceDerivedFileRows: () => derived.replaceDerivedFileRows(S, stale, p, [chunk()], { batch: 10 }),
      updateDerivedFileRow: () => derived.updateDerivedFileRow(S, stale, `${p}#media-chunk0`, p, { content: 'x' }),
      setDerivedExcerpt: () => derived.setDerivedExcerpt(S, stale, p, 'an excerpt of the old bytes'),
      setDerivedDescriptionIfUnset: () => derived.setDerivedDescriptionIfUnset(S, stale, p, 'a description of the old bytes', 'generated'),
      markFileProcessing: () => derived.markFileProcessing(S, stale, { embeddingStatus: 'complete' }),
      completeJob: () => queue.completeJob(S, stale, 'complete'),
      'failJob (the last attempt)': () => queue.failJob(S, stale, 3, 3, 'the old run gave up'),
      'failJob (a retry)': () => queue.failJob(S, stale, 1, 3, 'the old run will try again'),
    };

    for (const [name, write] of Object.entries(WRITES)) {
      it(`${name} throws JobLeaseLostError and changes neither the row nor the job`, async () => {
        const row = await files().findOne({ _id: p });
        const job = await jobOf(S, p);
        await assert.rejects(write, isLeaseLost, `${name} did not refuse a claim that no longer holds the job`);
        assert.deepEqual(await files().findOne({ _id: p }), row, `${name} wrote on the row`);
        assert.deepEqual(await derivedOf(p), [], `${name} created a derived row`);
        assert.deepEqual(await jobOf(S, p), job, `${name} changed the job of the run that replaced the caller`);
      });
    }

    it('control: the same calls under the claim that holds the job land, and the end of the job is one write with the row', async () => {
      await derived.upsertDerivedFileRow(S, current, chunk());
      await derived.markFileProcessing(S, current, { embeddingStatus: 'processing' });
      await queue.completeJob(S, current, 'partial');
      assert.deepEqual(await derivedOf(p), [`${p}#media-chunk0`]);
      assert.equal((await files().findOne({ _id: p }))?.embeddingStatus, 'partial');
      assert.equal((await jobOf(S, p))?.status, 'complete');
    });
  });
});
