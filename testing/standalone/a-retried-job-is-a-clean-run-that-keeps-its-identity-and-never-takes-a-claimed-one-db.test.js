/**
 * A manual retry puts a job back as a WHOLE new run, keeps what the job IS, and never overwrites a job a worker claimed in the
 * meantime (bundle-236, Q-698, DESIGN v3 C6 and C8, S8).
 *
 * ## The defects that bought it
 *
 *  - **S8, a retried deferred job was not clean.** `retryJob` resets `status`, `attempts`, `lastError`, `claimedAt` and `claimableAfter`
 *    and nothing else, so a job that a deferral had put back (`pending`, `deferredSince` and `facesOnly` set) kept both marks through a
 *    retry: the retried run read `facesOnly` and skipped the caption the person asked to have made again. (`endJob` clears them at the
 *    end of a job; `retryJob` is the one reset that reaches a job that has not ended.)
 *  - **A retry must not wipe the identity.** The reset is one spread (`RUN_RESET`) shared by every writer that returns a job to
 *    pending; a spread that also named `arrival` would turn a peer's arrived image into one written here, and face analysis, which an
 *    arrival is withheld from, would run on it. A retried arrival job keeps `arrival: true`. (CHARACTERISATION on the base, where no retry
 *    touches `arrival`: it is the guard against the fix spreading too much.)
 *  - **The interleave.** `retryJob` read the job, wrote the row `pending`, then wrote the job with no condition on its status. A worker
 *    that claimed the job between the read and the write had its claim overwritten (`status` back to `pending` under its own token) and
 *    its row marked `pending` under its feet. The write is guarded on `status` not being `processing`; when it matches nothing the retry
 *    answers `'processing'` and leaves the row alone.
 *
 * ## How the interleave is made
 *
 * The server's Mongo client goes through `_delayed-write-relay.mjs`. The retry's write of the job is HELD at the relay; a claim is made
 * while it is held (a `findAndModify`, not held); the write is then released. The retry therefore read a job that was claimable and
 * wrote after it was claimed, which is the window and not a guess at its timing.
 *
 * ## Seen red
 *
 * On abe1bde3b S8 fails (the marks survive), and the interleave fails (the claimed job reads `pending`, the row reads `pending`, the retry
 * answers `ok`). The arrival cases are green.
 *
 * Run: node --test testing/standalone/a-retried-job-is-a-clean-run-that-keeps-its-identity-and-never-takes-a-claimed-one-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod at the harness address ON LOOPBACK: the relay listens on loopback and
 * the server's client dials the harness host at the relay's port, as in every test that uses `_delayed-write-relay.mjs`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { startDelayedWriteRelay } from './_delayed-write-relay.mjs';

const skip = await mongoSkipReason();

const SPACE = 'retryclean';
const FILE = 'retry.png';
const T0 = '2026-09-01T00:00:00.000Z';
const JOBS = `${SPACE}_media_jobs`;

let door, relay, queue, jobs, files;
const jobNow = () => jobs().findOne({ _id: FILE });
const rowNow = () => files().findOne({ _id: FILE });

const job = (over) => ({
  _id: FILE, spaceId: SPACE, filePath: FILE, mimeType: 'image/png', mediaType: 'image', status: 'pending', attempts: 1, maxAttempts: 3,
  lastError: null, claimedAt: null, claimableAfter: null, createdAt: T0, updatedAt: T0, ...over,
});
const row = (embeddingStatus, over = {}) => ({ _id: FILE, spaceId: SPACE, path: FILE, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, seq: 1, embeddingStatus, ...over });

describe('a retried job is a clean run that keeps its identity and never takes a claimed one (real MongoDB)', { skip }, () => {
  before(async () => {
    relay = await startDelayedWriteRelay({ host: TEST_MONGO_HOST, port: TEST_MONGO_PORT, deliverAfterClientCloses: true });
    door = await openPushDoor({ suite: 'retryclean', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: {} }], mongoPort: relay.port });
    queue = await import('../../server/dist/files/media/job-queue.js');
    const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
    jobs = () => door.mongo.col(spaceCollection(SPACE, 'mediaJobs'));
    files = () => door.coll(SPACE, 'files');
  });
  after(async () => { relay?.releaseAll(); await door?.close(); await relay?.close(); });
  beforeEach(async () => { relay.releaseAll(); await door.wipe(SPACE); await jobs().deleteMany({}); });

  it('S8: a pending deferred job, retried, loses deferredSince and facesOnly', async () => {
    await files().insertOne(row('processing'));
    await jobs().insertOne(job({ deferredSince: new Date(Date.now() - 60_000).toISOString(), facesOnly: true, claimableAfter: new Date(Date.now() + 60_000).toISOString() }));
    assert.equal(await queue.retryJob(SPACE, FILE), 'ok');
    const after = await jobNow();
    assert.equal(after.status, 'pending');
    assert.equal(after.attempts, 0);
    assert.ok(!('deferredSince' in after) && !('facesOnly' in after),
      `the retried job kept its deferral marks (${JSON.stringify({ deferredSince: after.deferredSince, facesOnly: after.facesOnly })}): the retried run skips the caption the retry was asked for`);
  });

  describe('CHARACTERISATION: a retried arrival job keeps arrival: true (green on the base; the guard against a reset that spreads too much)', () => {
    it('retryJob, on a failed arrival job', async () => {
      await files().insertOne(row('failed', { mediaJobError: 'gave up' }));
      await jobs().insertOne(job({ status: 'failed', attempts: 3, lastError: 'gave up', arrival: true }));
      assert.equal(await queue.retryJob(SPACE, FILE), 'ok');
      const after = await jobNow();
      assert.equal(after.status, 'pending');
      assert.equal(after.arrival, true, 'a retry turned a peer\'s arrived image into one written here: face analysis it is withheld from would now run');
    });

    it('retryFailedJobs, on a failed arrival job', async () => {
      await files().insertOne(row('failed', { mediaJobError: 'gave up' }));
      await jobs().insertOne(job({ status: 'failed', attempts: 3, lastError: 'gave up', arrival: true }));
      assert.equal(await queue.retryFailedJobs(SPACE), 1);
      const after = await jobNow();
      assert.equal(after.status, 'pending');
      assert.equal(after.arrival, true);
    });
  });

  it('a claim that lands between the retry\'s read and its write is kept: the retry answers \'processing\' and leaves the row as the run left it', async () => {
    await files().insertOne(row('processing'));
    await jobs().insertOne(job({ attempts: 1, lastError: 'a failure the retry would wipe' }));
    const before = await rowNow();

    const hold = relay.hold(cmd => cmd.update === JOBS);
    const retrying = queue.retryJob(SPACE, FILE);
    await hold.first;
    queue.markSpaceMayHaveWork(SPACE);
    const claimed = await queue.claimNextJob([SPACE]);
    assert.equal(claimed?._id, FILE, 'fixture check: the claim did not land inside the retry\'s window');
    hold.releaseAll();
    const answer = await retrying;
    hold.disarm();

    const after = await jobNow();
    assert.equal(answer, 'processing', `the retry answered ${JSON.stringify(answer)} over a job a worker had just claimed`);
    assert.equal(after.status, 'processing', 'the retry put a claimed job back to pending under its worker');
    assert.equal(after.claimToken, claimed.claimToken, 'the claimed job lost or changed its claim token');
    assert.deepEqual(await rowNow(), before, 'the retry wrote the row of a file whose run it did not take over');
  });
});
