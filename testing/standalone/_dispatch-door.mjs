/**
 * Arrange what a file's processing worker leaves behind, THROUGH the byte door, and read what a second arrival did to it
 * (bundle-48, Q-259 / Q-260): the question "what does this instance do when a file's bytes arrive again", answered once for
 * every test that asks it.
 *
 * ## Why a module
 *
 * `identical-bytes-skip-media-pipeline-db` seeded the PRIOR row by hand and called the dispatcher with it. That asked the
 * dispatcher a question no door asks it: through the door the row has already been rewritten by the arrival (the new size and
 * hash) before the dispatcher reads it, so a dispatcher that compares "the stored hash" with "the arriving hash" compares the
 * arriving hash with itself. The seeded test passed for ever while a changed file on a `complete` row was skipped. This module
 * makes every first arrival go through the door, so the row, its hash and its processing state are the ones the door leaves.
 *
 * ## What a hand-written copy drops
 *
 * **The poison.** A processing state that is reset to what it already was looks untouched. The settled job row carries values a
 * reset overwrites (`attempts`, `lastError`, `claimedAt`), so "the job was left alone" is an identity, not a count. And the
 * settled row is written ONLY in its processing state: the hash, the size and the author are the door's, never seeded.
 *
 * It does not stub the writer, the dispatcher or the queue. Models are offline (`_byte-door.mjs`), so nothing is ever worked: the
 * worker's own terminal write is the one thing this module stands in for (`settle`), and it says so.
 */
import { createHash } from 'node:crypto';
import { openPushDoor } from './_push-door.mjs';
import { openByteDoor } from './_byte-door.mjs';

export const sha256Of = (content) => createHash('sha256').update(content).digest('hex');

/** What a job row holds that a reset overwrites: a reset takes `attempts` to 0 and the other two to `null`. */
export const POISON = Object.freeze({ attempts: 7, lastError: 'poison: a worker was here', claimedAt: '2020-01-01T00:00:00.000Z' });

/** The job status a worker leaves for each file status it can leave one in; `null` is a status no job row accompanies. */
const JOB_STATUS = Object.freeze({ complete: 'complete', partial: 'complete', failed: 'failed', pending: 'pending', processing: 'processing', skipped: null });

/** The statuses a settled file may be in (every `FileMetaDoc.embeddingStatus` a worker or the dispatcher leaves). */
export const SETTLED_STATUSES = Object.freeze(Object.keys(JOB_STATUS));

/**
 * @param {object} o
 * @param {string} o.suite  harness database slug
 * @param {string} o.space  the one space the door carries
 * @param {object} [o.spaceExtra]  further config for the space
 */
export async function openDispatchDoor({ suite, space, spaceExtra = {} }) {
  const door = await openPushDoor({ suite, spaces: [{ id: space, label: space, folders: [], meta: {}, ...spaceExtra }] });
  const bytes = await openByteDoor();
  const loader = await import('../../server/dist/config/loader.js');
  const { spaceCollection } = await import('../../server/dist/db/space-collection.js');

  const files = () => door.coll(space, 'files');
  const jobs = () => door.mongo.col(spaceCollection(space, 'mediaJobs'));

  /** The processing state of a file: its row's status, hash and media type, and its job row whole (`null` when there is none). */
  async function stateOf(file) {
    const row = await files().findOne({ _id: file });
    const job = await jobs().findOne({ _id: file });
    return { row, job };
  }

  /**
   * Stand in for the worker's own terminal write: put a file's row and job in the state a worker leaves `status` in, and poison
   * the job row. Only the PROCESSING fields are written; the hash, size and author are what the door left.
   */
  async function settle(file, status) {
    if (!(status in JOB_STATUS)) throw new Error(`settle: no such status ${status}`);
    const row = await files().findOne({ _id: file });
    if (!row) throw new Error(`settle: the first arrival left no row for ${file}`);
    await files().updateOne({ _id: file }, { $set: { embeddingStatus: status } });
    const jobStatus = JOB_STATUS[status];
    if (jobStatus === null) await jobs().deleteOne({ _id: file });
    else {
      const res = await jobs().updateOne({ _id: file }, { $set: { status: jobStatus, ...POISON } });
      if (res.matchedCount !== 1) throw new Error(`settle: the first arrival enqueued no job for ${file}`);
    }
    return stateOf(file);
  }

  /** A row derived from the file (a chunk the worker made): what a re-conversion removes and a skip must leave. */
  async function seedChunk(file) {
    const id = `${file}::chunk-0`;
    await files().insertOne({ _id: id, spaceId: space, path: id, parentFileId: file, sizeBytes: 1, tags: [],
      author: { instanceId: 'dispatch-door', instanceLabel: 'dispatch door' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', seq: 0 });
    return id;
  }

  /** Empty the space: rows, jobs, and the bytes a case wrote. */
  async function reset() {
    await door.wipe(space);
    await jobs().deleteMany({});
  }

  /** Change the media size cap for the next arrivals (`null` puts the configured one back). */
  function capMediaBytes(n) {
    const cfg = loader.getConfig();
    if (n === null) delete cfg.mediaEmbedding?.maxFileSizeBytes;
    else cfg.mediaEmbedding = { ...(cfg.mediaEmbedding ?? {}), maxFileSizeBytes: n };
  }

  return { door, bytes, space, files, jobs, stateOf, settle, seedChunk, reset, capMediaBytes, loader, close: () => door.close() };
}
