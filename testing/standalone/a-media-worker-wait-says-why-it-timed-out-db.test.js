/**
 * A wait on the real media worker that times out says why: what the worker logged while it ran, and how the claim walk saw the
 * job's space (Q-729).
 *
 * ## The defect
 *
 * `an-arrived-image-gets-faces-only-when-synced-images-are-reprocessed-db` failed once in CI after 30 s with the job `pending`,
 * `attempts: 0`, `claimedAt: null`, and nothing else. Whether the worker never reached a claim, skipped the space in quarantine,
 * found the store down, or probed the space before the job could be claimed and stopped asking, every one of those is said by
 * the worker at WARN or INFO, and the test's log capture kept them from the console and threw them away with the timeout.
 *
 * ## The rule
 *
 * `runWorkerUntil` (`_media-worker-run.mjs`), the one wait on the worker, fails a timeout with the job row, whether the claim
 * walk means to probe the space before its next full scan, the quarantined spaces, and the worker's own log lines from the run.
 * The case drives it with a job no worker may claim yet (its `claimableAfter` an hour ahead), so the wait must time out.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openMediaJobDoor } from './_media-job-door.mjs';
import { runWorkerUntil } from './_media-worker-run.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

describe('a media worker wait that times out says why (real worker, real Mongo)', { skip }, () => {
  let media, worker;
  before(async () => {
    media = await openMediaJobDoor({ suite: 'workerwaitwhy' });
    worker = await import('../../server/dist/files/media/worker.js');
  });
  after(async () => { await media?.close(); });

  it('the message carries the job, the claim walk\'s view of its space, and the worker\'s own lines', async () => {
    const id = 'not-yet.png';
    const now = new Date();
    await media.door.coll(media.space, 'media_jobs').insertOne({
      _id: id, spaceId: media.space, filePath: id, mimeType: 'image/png', mediaType: 'image', status: 'pending', attempts: 0,
      maxAttempts: 3, arrival: false, claimedAt: null, claimToken: null, lastError: null,
      claimableAfter: new Date(now.getTime() + 3_600_000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });

    const err = await runWorkerUntil({ worker, jobOf: media.jobOf, space: media.space, id, timeoutMs: 2_000 }).then(() => null, e => e);
    assert.ok(err, 'the wait ended without the job ending: the job was claimable, so the case asserts nothing');
    const msg = String(err.message);
    assert.match(msg, /"_id":"not-yet\.png".*"status":"pending"/, 'the job row');
    assert.match(msg, new RegExp(`claim walk: (probes|does not probe) ${media.space} before the next full scan`), 'the hint state of the space');
    assert.match(msg, /quarantined \[[^\]]*\]/, 'the quarantined spaces');
    assert.match(msg, /Media embedding worker: started/, 'the worker\'s own log lines from the run');
  });
});
