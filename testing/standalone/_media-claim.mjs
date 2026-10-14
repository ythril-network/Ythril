/**
 * The claim a media job's writes speak for, made for a test that calls a media writer or an embedder directly — the question "what
 * does a run that holds its job's claim look like", answered once for every test that asks it (bundle-44 D-29, Q-436, ruling 32).
 *
 * ## Why a module
 *
 * Every write a media job makes about its file runs under its claim (`writeUnderClaim`, `files/media/lease.ts`): the writers in
 * `derived-fields.ts`, `completeJob` and `failJob` all take a `JobClaim`, and the database refuses the write when the job
 * document no longer matches it. A test that calls one of them directly has to be a run that holds a claim, and a hand-written
 * job document is the copy that drifts: it forgets the token, or the status, and the fence then matches nothing and the writer
 * throws `JobLeaseLostError` for a reason the test never meant to exercise.
 *
 * ## What it does, and what a hand-written copy drops
 *
 * `seedClaim` inserts the job exactly as the queue's claim leaves it — `processing`, a fresh random `claimToken` — and hands
 * back the `JobClaim` a worker would hold. **The token is fresh per call**: two claims on one job (a run, and the run that
 * replaced it after a re-upload) must differ, or a test of "the old run writes nothing on the new run's job" passes about one
 * run. `revoke` takes the claim away as every remover does, by deleting the job document, which is what a delete's
 * `cancelMediaJob` leaves; `recover` takes it away as stall recovery does (the token cleared, the job `pending`).
 *
 * It does not stub the fence, the queue or the writers: the job is a real document in the space's job collection, and the
 * caller must have the harness database open (`openTestMongo`, `openPushDoor`) before calling.
 */
import { randomUUID } from 'node:crypto';

const NOW = '2026-09-01T00:00:00.000Z';

async function jobs(space) {
  const { col } = await import('../../server/dist/db/mongo.js');
  const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
  return col(spaceCollection(space, 'mediaJobs'));
}

/**
 * Insert (or replace) the `processing` job of `fileId` with a fresh claim token and return the claim that holds it.
 *
 * @param {string} space
 * @param {string} fileId  the file's id, which is its job's id
 * @param {object} [over]  fields to override on the job document (`mediaType`, `attempts`, `progressAt`...)
 * @returns {Promise<{ jobId: string, claimToken: string }>}
 */
export async function seedClaim(space, fileId, over = {}) {
  const claimToken = randomUUID();
  await (await jobs(space)).replaceOne({ _id: fileId }, {
    _id: fileId, spaceId: space, filePath: fileId, mimeType: 'application/octet-stream', mediaType: 'image',
    status: 'processing', attempts: 1, maxAttempts: 3, lastError: null,
    claimedAt: NOW, progressAt: NOW, claimToken, createdAt: NOW, updatedAt: NOW, ...over,
  }, { upsert: true });
  return { jobId: fileId, claimToken };
}

/** Take the claim on `fileId` away the way a delete or a move does: the job is gone (or held), so its token matches nothing. */
export async function revoke(space, fileId) {
  await (await jobs(space)).deleteOne({ _id: fileId });
}

/** Take the claim away the way stall recovery does: the job goes back to `pending` and its token is cleared. */
export async function recover(space, fileId) {
  await (await jobs(space)).updateOne({ _id: fileId }, { $set: { status: 'pending', claimedAt: null, claimToken: null } });
}

/** The job document of `fileId`, or `null`: what a test reads to see what a run did (or did not do) to its job. */
export async function jobOf(space, fileId) {
  return await (await jobs(space)).findOne({ _id: fileId });
}
