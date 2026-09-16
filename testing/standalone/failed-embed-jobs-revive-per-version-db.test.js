/**
 * A terminally-failed embedding job gets one clean attempt per server VERSION — and never more.
 *
 * ## The report
 *
 * Owner, from a live instance, 2026-08-15: *"after updating all space indexing failed and since has not been
 * retried automatically."*
 *
 * The retry policy is sized for a PER-RECORD failure and was being applied to a SYSTEMIC one. Five attempts
 * at 5s / 30s / 120s / 600s is a budget of about twelve and a half minutes from the first failure to terminal
 * `failed`, and `claimNextEmbedJob` filters on `status: 'pending'` — so terminal means never claimed again.
 * An embedder unreachable for a quarter of an hour during an upgrade takes every job in every space terminal,
 * at once, and the instance stops indexing without reporting a fault: each job did exactly what it was told.
 *
 * ## Why the version, and why this suite has to prove BOTH directions
 *
 * The repair is only safe because it is bounded. A boot sweep would re-run genuinely-bad records on every
 * restart; a timer would do it for ever. Keyed on the running version, a new version earns one honest retry
 * and a restart on the same version earns none — so the two assertions that matter are "it revives" and "it
 * does not revive twice". A test that only proved the first would pass on a sweep that churns for ever.
 *
 * Against a real MongoDB, because the whole mechanism is one `updateMany` filter — `{ status: 'failed',
 * revivedForVersion: { $ne: version } }` — and the half that is easy to get wrong is that an ABSENT field
 * must match `$ne`. A mock would answer whatever the author assumed.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/failed-embed-jobs-revive-per-version-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const OTHER = 'research';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-embed-revive-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, queue;

const jobs = (space) => mongo.col(`${space}_embed_jobs`);

/** A job row as `failEmbedJob` leaves one when the attempt budget is spent. */
const failedJob = (space, id, over = {}) => ({
  _id: `fact:${id}`,
  spaceId: space,
  recordType: 'fact',
  recordId: id,
  status: 'failed',
  attempts: 5,
  maxAttempts: 5,
  lastError: 'embedder unreachable',
  claimedAt: null,
  progressAt: null,
  claimableAfter: null,
  claimToken: null,
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
  ...over,
});

describe('failed embed jobs revive once per version (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }, { id: OTHER, label: 'Research' }], networks: [], tokens: [] },
      null, 2,
    ));
    mongo = await openTestMongo('embedrevive');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await jobs(SPACE).deleteMany({});
    await jobs(OTHER).deleteMany({});
  });

  it('revives a job that never carried the marker, and says how many', async () => {
    // The field is ABSENT on every job that failed before this existed — which is all of them on the
    // instance that reported this. If `$ne` did not match an absent field, the fix would help nobody.
    await jobs(SPACE).insertOne(failedJob(SPACE, 'a'));
    assert.equal(await queue.reviveFailedEmbedJobs([SPACE], '3.1.0'), 1);

    const row = await jobs(SPACE).findOne({ _id: 'fact:a' });
    assert.equal(row.status, 'pending', 'a terminal job is never claimed again — it has to go back to pending');
    assert.equal(row.attempts, 0, 'kept at 5 it would fail once and go straight back to terminal');
    assert.equal(row.claimableAfter, null, 'and it must be claimable now, not after the old backoff');
    assert.equal(row.revivedForVersion, '3.1.0');
  });

  it('KEEPS lastError, so an operator can still see what it died of', async () => {
    await jobs(SPACE).insertOne(failedJob(SPACE, 'a'));
    await queue.reviveFailedEmbedJobs([SPACE], '3.1.0');
    assert.equal((await jobs(SPACE).findOne({ _id: 'fact:a' })).lastError, 'embedder unreachable');
  });

  it('does NOT revive the same job twice on the same version', async () => {
    // The whole safety argument. A restart on the same version must be a no-op, or a genuinely-bad record
    // is re-run on every boot for ever — which is the churn a plain boot sweep would have caused.
    await jobs(SPACE).insertOne(failedJob(SPACE, 'a'));
    assert.equal(await queue.reviveFailedEmbedJobs([SPACE], '3.1.0'), 1);
    await jobs(SPACE).updateOne({ _id: 'fact:a' }, { $set: { status: 'failed', attempts: 5 } });
    assert.equal(await queue.reviveFailedEmbedJobs([SPACE], '3.1.0'), 0, 'the same version revived it again');
    assert.equal((await jobs(SPACE).findOne({ _id: 'fact:a' })).status, 'failed');
  });

  it('a NEW version revives it again — that is the owner\'s case', async () => {
    await jobs(SPACE).insertOne(failedJob(SPACE, 'a', { revivedForVersion: '3.1.0' }));
    assert.equal(await queue.reviveFailedEmbedJobs([SPACE], '3.2.0'), 1);
    assert.equal((await jobs(SPACE).findOne({ _id: 'fact:a' })).status, 'pending');
  });

  it('touches only FAILED jobs — pending and processing are somebody else\'s business', async () => {
    // `processing` belongs to `resetStalledEmbedJobs`, which measures a stall from progressAt. Reviving one
    // here would return a job its worker is still holding.
    await jobs(SPACE).insertMany([
      failedJob(SPACE, 'p', { status: 'pending', attempts: 2, claimableAfter: '2999-01-01T00:00:00.000Z' }),
      failedJob(SPACE, 'w', { status: 'processing', claimedAt: '2026-08-15T00:00:00.000Z' }),
    ]);
    assert.equal(await queue.reviveFailedEmbedJobs([SPACE], '3.1.0'), 0);

    const pending = await jobs(SPACE).findOne({ _id: 'fact:p' });
    assert.equal(pending.attempts, 2, 'a pending job kept its attempt count');
    assert.equal(pending.claimableAfter, '2999-01-01T00:00:00.000Z', 'and its backoff');
    assert.equal((await jobs(SPACE).findOne({ _id: 'fact:w' })).status, 'processing');
  });

  it('sweeps every space it is given, and counts across all of them', async () => {
    // Jobs live in a per-space collection, so a loop that reads only the first space would repair one space
    // and report success — the exact shape of "all space indexing failed".
    await jobs(SPACE).insertOne(failedJob(SPACE, 'a'));
    await jobs(OTHER).insertMany([failedJob(OTHER, 'b'), failedJob(OTHER, 'c')]);
    assert.equal(await queue.reviveFailedEmbedJobs([SPACE, OTHER], '3.1.0'), 3);
    assert.equal(await jobs(OTHER).countDocuments({ status: 'pending' }), 2);
  });

  it('is safe on a space that has no job collection at all', async () => {
    assert.equal(await queue.reviveFailedEmbedJobs(['never-used'], '3.1.0'), 0);
  });

  it('wakes the workers, or the revived jobs sit until the idle poll', async () => {
    // The queue is event-driven: `waitForEmbedWork` returns when an enqueue announces work. A revive that
    // did not announce would leave a repaired queue idle for up to the 30s backstop, per space, at boot —
    // which reads as "it still is not indexing".
    const before = queue.currentEmbedWorkEpoch();
    await jobs(SPACE).insertOne(failedJob(SPACE, 'a'));
    await queue.reviveFailedEmbedJobs([SPACE], '3.1.0');
    assert.notEqual(queue.currentEmbedWorkEpoch(), before, 'the revive did not announce the work');
  });
});
