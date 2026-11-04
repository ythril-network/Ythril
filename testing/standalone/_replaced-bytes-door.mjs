/**
 * Write bytes onto a path through the real file door, and hold the job a run of it holds: the question "what does the write
 * door do to the media job at a path when the bytes there are replaced", answered once for every test that asks it (bundle-236,
 * Q-698).
 *
 * ## Why a module
 *
 * Four tests ask it (a running job reset, a settle delay and a move hold, a skipped replacement, a failed job write). Each needs the
 * same three things, and the copy that drops one passes for the wrong reason:
 *
 * **The write goes in through the byte door** (`POST /api/files`, a person's token or a peer's), which reads the prior row, writes the
 * new one and dispatches (`recordAndDispatchFile`), so the door under test is the real one and the prior row is the door's own, never
 * a row a test wrote.
 *
 * **A claim is a real claim.** `claimNow` makes the job claimable (a door that waits a settle delay before a replaced path's job can
 * run sets `claimableAfter` in the future, so a fixture that claimed straight after the write would find nothing) and takes it through
 * `claimNextJob`, so the token is the queue's own, as a worker's is.
 *
 * **The derived rows carry their parent.** `seedDerived` writes the caption and face rows a run leaves (`<path>#media-chunk0`,
 * `<path>#face-chunk0`) with `parentFileId`, the field every remover of derived rows follows.
 *
 * It starts no worker: a test that claims a job holds the claim itself, so "the old run" is a claim in the test's hand.
 */
import assert from 'node:assert/strict';
import { openDispatchDoor, sha256Of } from './_dispatch-door.mjs';
import { postWhole } from './_byte-door-uploads.mjs';
import { USER_TOKEN } from './_byte-door.mjs';
import { peerToken } from './_push-door.mjs';

export { sha256Of };

const T0 = '2026-09-01T00:00:00.000Z';

/**
 * @param {object} o
 * @param {string} o.suite  harness database slug, unique to the caller
 * @param {string} o.space
 */
export async function openReplacedBytesDoor({ suite, space }) {
  const h = await openDispatchDoor({ suite, space });
  const queue = await import('../../server/dist/files/media/job-queue.js');
  const derived = await import('../../server/dist/files/derived-fields.js');
  const moveFlight = await import('../../server/dist/files/move-flight.js');
  const moveTiming = (await import('../../server/dist/files/move-timing.js')).moveTiming;

  /** Write `content` at `path` through the byte door; a person's write, or a peer's arrival. Returns the door's answer. */
  async function put(path, content, { arrival = false, lenient = false } = {}) {
    const answer = await postWhole(h.bytes, { space, path, content, token: arrival ? peerToken('replaced-bytes-peer') : USER_TOKEN });
    // `lenient`: a case about a write that is MEANT to fail somewhere inside the door reads the answer itself.
    if (!lenient) assert.ok([200, 201, 202].includes(answer.code), `fixture: the byte door refused the write of ${path}: ${JSON.stringify(answer)}`);
    return answer;
  }

  /** Make the job of `path` claimable now and claim it as a worker does: the claimed job and the claim a run holds. */
  async function claimNow(path) {
    await h.jobs().updateOne({ _id: path }, { $set: { claimableAfter: null } });
    queue.markSpaceMayHaveWork(space);
    const job = await queue.claimNextJob([space]);
    assert.equal(job?._id, path, `fixture: the claim returned ${JSON.stringify(job?._id)}, not ${path}`);
    assert.equal(job.status, 'processing');
    return { job, claim: { jobId: job._id, claimToken: job.claimToken } };
  }

  /** The caption row and the face row a run of `path` derives, with their parent. Returns their ids. */
  async function seedDerived(path, extra = {}) {
    const ids = [`${path}#media-chunk0`, `${path}#face-chunk0`];
    for (const id of ids) {
      await h.files().insertOne({ _id: id, spaceId: space, path: id, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, seq: 0,
        parentFileId: path, chunkIndex: 0, content: 'derived from the old bytes', ...extra });
    }
    return ids;
  }

  const derivedIds = async (path) => (await h.files().find({ parentFileId: path }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();

  return { ...h, queue, derived, moveFlight, moveTiming, put, claimNow, seedDerived, derivedIds };
}
