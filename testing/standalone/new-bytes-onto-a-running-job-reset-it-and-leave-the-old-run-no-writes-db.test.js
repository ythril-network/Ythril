/**
 * NEW bytes written onto a path whose media job is pending or running take that job over: it is reset to a whole new run, the old
 * run's claim is revoked and nothing the old run does lands. The SAME bytes leave it alone (bundle-236, Q-698, DESIGN v3 item 1).
 *
 * ## The defect that bought it
 *
 * `enqueueMediaJob` answers a job that is `pending` or `processing` with "already queued, do not disturb". That is right for the same
 * bytes sent twice and wrong for bytes that CHANGED: a picture replaced while its job was running kept the old claim, so the old run
 * went on to caption the OLD bytes, wrote the caption, the face rows, the row's processing state and `completeJob` under the NEW
 * bytes' hash, and the file read `complete` with an analysis of a picture that was gone. (A terminal job was already reset, a text
 * job was reset whatever its state: the media branch was the odd one.)
 *
 * ## The rules
 *
 *  1. New bytes (a different sha256) onto a `processing` job: the job reads `pending`, `attempts` 0, no `lastError`, no `claimedAt`, no
 *     `claimToken` (the old run's token matches nothing), no deferral marks (`deferredSince`, `facesOnly`: they say the OLD bytes'
 *     caption is stored), and `claimableAfter` at or after the write (the settle delay), so a worker cannot take it before the
 *     row reads `pending`.
 *  2. The old claim writes NOTHING afterwards: its row state, its derived row, `completeJob` and `deferJob` change neither the file's
 *     row, the job, nor the derived rows (the writers throw `JobLeaseLostError`; `deferJob` answers `'lost'`).
 *  3. CHARACTERISATION (green on the base, kept so the rule above is not paid for with the other): the SAME bytes onto a `pending` or a
 *     `processing` job leave it exactly as it is, down to its poisoned `attempts`, `lastError` and `claimedAt`. Case 1 is its pair:
 *     the one difference between them is the hash.
 *
 * ## Seen red
 *
 * On abe1bde3b cases 1 and 2 fail: the job still reads `processing` under the old token, so every old-run write lands. Case 3 is green.
 *
 * Run: node --test testing/standalone/new-bytes-onto-a-running-job-reset-it-and-leave-the-old-run-no-writes-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { POISON } from './_dispatch-door.mjs';
import { openReplacedBytesDoor } from './_replaced-bytes-door.mjs';
import { isLeaseLost } from './_media-claim.mjs';

const skip = await mongoSkipReason();

const SPACE = 'newbytesrun';
const FILE = 'photo.png';
const OLD = 'the bytes of the picture before it was replaced';
const NEW = 'the bytes of the picture that replaced it';
/** A deferral a minute old: inside the 30 minute cap, so the old run's own deferral would be made (and must be refused as lost). */
const MARKS = { deferredSince: new Date(Date.now() - 60_000).toISOString(), facesOnly: true };

let d;
const jobNow = () => d.jobs().findOne({ _id: FILE });
const rowNow = () => d.files().findOne({ _id: FILE });

/** The first bytes written, their job claimed, the claim carrying a deferral's marks and a failure's trace: a run in flight. */
async function runInFlight() {
  await d.put(FILE, OLD);
  const held = await d.claimNow(FILE);
  await d.jobs().updateOne({ _id: FILE }, { $set: { lastError: 'poison: an earlier attempt', ...MARKS } });
  return held;
}

describe('new bytes onto a running media job reset it and leave the old run no writes (real MongoDB)', { skip }, () => {
  before(async () => { d = await openReplacedBytesDoor({ suite: 'newbytesrun', space: SPACE }); });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); });

  it('a different hash puts a processing job back to pending, attempts 0, no claim, no marks, claimable only after the write', async () => {
    const { job } = await runInFlight();
    assert.equal(job.attempts, 1, 'fixture check: the claim counted its attempt');
    const before = Date.now();
    await d.put(FILE, NEW);

    const after = await jobNow();
    assert.equal(after.status, 'pending', 'the picture was replaced and its job still reads processing: the old run is going on over bytes that are gone');
    assert.equal(after.attempts, 0, 'the new bytes inherit the old run\'s attempts');
    assert.equal(after.lastError ?? null, null, 'the new run carries the old run\'s error');
    assert.equal(after.claimedAt ?? null, null);
    assert.ok(!after.claimToken, 'the job still carries the old run\'s claim token: that run can still write under it');
    assert.ok(!('deferredSince' in after) && !('facesOnly' in after),
      `the job kept the marks of a deferral of the OLD bytes (${JSON.stringify({ deferredSince: after.deferredSince, facesOnly: after.facesOnly })}): the new run would skip the caption it owes`);
    assert.ok(after.claimableAfter && Date.parse(after.claimableAfter) >= before,
      `claimableAfter is ${JSON.stringify(after.claimableAfter)}, not at or after the write: a worker can claim before the row reads pending`);
    assert.equal((await rowNow()).embeddingStatus, 'pending', 'the row of the replaced file does not read pending');
  });

  describe('the old run\'s claim, after the bytes were replaced, writes nothing', () => {
    const WRITES = {
      'a row state (markFileProcessing)': (c) => d.derived.markFileProcessing(SPACE, c, { embeddingStatus: 'complete' }),
      'a derived row (upsertDerivedFileRow)': (c) => d.derived.upsertDerivedFileRow(SPACE, c, {
        _id: `${FILE}#media-chunk0`, spaceId: SPACE, path: `${FILE}#media-chunk0`, tags: [], createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 5, parentFileId: FILE, chunkIndex: 0, content: 'caption of the old bytes',
      }),
      'the end of the job (completeJob)': (c) => d.queue.completeJob(SPACE, c, 'complete'),
    };

    for (const [name, write] of Object.entries(WRITES)) {
      it(`${name} throws JobLeaseLostError and changes neither the row, the job nor the derived rows`, async () => {
        const { claim } = await runInFlight();
        await d.put(FILE, NEW);
        const row = await rowNow();
        const job = await jobNow();
        await assert.rejects(() => write(claim), isLeaseLost, `${name} of the old run was not refused: the replaced file's analysis is written by the run that read the bytes before`);
        assert.deepEqual(await rowNow(), row, `${name} wrote on the row of the file that replaced the run's own`);
        assert.deepEqual(await jobNow(), job, `${name} changed the job of the new bytes`);
        assert.deepEqual(await d.derivedIds(FILE), [], `${name} left a row derived from the old bytes`);
      });
    }

    it('a deferral (deferJob) is answered \'lost\' and changes neither the job nor the row', async () => {
      const { claim } = await runInFlight();
      await d.put(FILE, NEW);
      const row = await rowNow();
      const job = await jobNow();
      const answer = await d.queue.deferJob(SPACE, claim.jobId, claim.claimToken, 'index_not_ready');
      assert.equal(answer, 'lost', `the old run's deferral was answered ${JSON.stringify(answer)}, not 'lost'`);
      assert.deepEqual(await jobNow(), job, 'the old run\'s deferral changed the job of the new bytes');
      assert.deepEqual(await rowNow(), row);
    });
  });

  describe('CHARACTERISATION: the same bytes onto a queued job leave it exactly as it is (the pair of the first case)', () => {
    for (const status of ['pending', 'processing']) {
      it(`a ${status} job, written again with the same bytes, is not touched (poisoned attempts, error and claim survive)`, async () => {
        await d.put(FILE, OLD);
        if (status === 'processing') await d.claimNow(FILE);
        await d.jobs().updateOne({ _id: FILE }, { $set: { ...POISON, ...(status === 'pending' ? { claimableAfter: null } : {}) } });
        const job = await jobNow();
        const row = await rowNow();
        assert.equal(job.status, status, 'fixture check');

        await d.put(FILE, OLD);
        assert.deepEqual(await jobNow(), job, `identical bytes disturbed a ${status} job: the run under way is thrown away for nothing`);
        assert.equal((await rowNow()).embeddingStatus, row.embeddingStatus);
      });
    }
  });
});
