/**
 * Chunked upload support — Content-Range based.
 *
 * Chunks are stored under /data/.chunks/<spaceId>/<uploadId>/<start>-<length>.bin (a chunk from before F-43 is
 * <start>.bin and still reads — see `chunkSpan`)
 * The uploadId is derived from (spaceId, path, total) for idempotent resume.
 * When the final chunk arrives, all parts are assembled into the target file.
 */

import fs from 'fs/promises';
import { removeTree } from './remove-tree.js';
import path from 'path';
import { createHash } from 'crypto';
import { getDataRoot } from '../config/loader.js';
import { mkdirPrivate } from '../util/fs-modes.js';
import { writeStored, readStored, statStored, pipeToStored, isMissingPath } from './stored-bytes.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { log } from '../util/log.js';

/** Deterministic upload ID from (spaceId, path, total). */
export function uploadId(spaceId: string, filePath: string, total: number): string {
  return createHash('sha256')
    .update(`${spaceId}\0${filePath}\0${total}`)
    .digest('hex')
    .slice(0, 32);
}

/** Chunk storage root: /data/.chunks */
function chunksRoot(): string {
  return path.join(getDataRoot(), '.chunks');
}

/** Directory for a specific upload: /data/.chunks/<spaceId>/<uploadId>/ */
function uploadDir(spaceId: string, id: string): string {
  return path.join(chunksRoot(), spaceId, id);
}

/** Parse Content-Range header. Returns null on invalid format. */
export function parseContentRange(
  header: string | undefined,
): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  const total = parseInt(m[3], 10);
  if (start > end || end >= total) return null;
  return { start, end, total };
}

/**
 * Store a chunk and return the total bytes received so far.
 * Duplicate ranges are silently overwritten (idempotent resume).
 */
/**
 * Where a staged chunk sits in the upload and how many PLAINTEXT bytes it holds, read from its NAME.
 *
 * The length is in the name because with a master secret a chunk is ciphertext on disk, and its plaintext size would
 * otherwise cost a file open per chunk on every resume probe and every chunk stored — an upload of N chunks reading
 * N² headers (F-43). A legacy `<start>.bin` has no length in its name and is stat'ed through the file door instead,
 * which is the one place that knows how to size a stored file. `null` for anything that is not a chunk.
 */
async function chunkSpan(dir: string, name: string): Promise<{ start: number; size: number } | null> {
  const m = /^(\d+)(?:-(\d+))?\.bin$/.exec(name);
  if (!m) return null;
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (m[2] !== undefined) {
    const size = Number(m[2]);
    return Number.isSafeInteger(size) ? { start, size } : null;
  }
  return { start, size: (await statStored(path.join(dir, name))).size };
}

/** Sum of the plaintext bytes staged in an upload directory. A chunk removed mid-count is skipped. */
async function stagedBytes(dir: string): Promise<number> {
  let received = 0;
  for (const name of await fs.readdir(dir)) {
    try { received += (await chunkSpan(dir, name))?.size ?? 0; } catch { /* removed by a concurrent cleanup */ }
  }
  return received;
}

export async function storeChunk(
  spaceId: string,
  filePath: string,
  data: Buffer,
  start: number,
  total: number,
): Promise<{ received: number; complete: boolean }> {
  const id = uploadId(spaceId, filePath, total);
  const dir = uploadDir(spaceId, id);
  // Staging holds the same bytes as the finished file, so it gets the same protection. A half-uploaded document
  // is not less confidential than a complete one.
  await mkdirPrivate(dir);

  // A re-sent chunk replaces the one at its offset. With the length in the name a resend of a DIFFERENT length would
  // otherwise sit beside the first rather than over it, so any other chunk at this start goes first.
  const name = `${start}-${data.length}.bin`;
  for (const other of await fs.readdir(dir)) {
    if (other !== name && (other === `${start}.bin` || other.startsWith(`${start}-`))) {
      await fs.rm(path.join(dir, other), { force: true });
    }
  }
  // Through the stored-bytes door, so a chunk is ciphertext at rest like the file it becomes (F-43).
  await writeStored(path.join(dir, name), data);

  // PLAINTEXT sizes, read from the names, or resume would count tags.
  const received = await stagedBytes(dir);
  return { received, complete: received >= total };
}

/**
 * Assemble all chunks into the target file.
 * Returns the sha256 of the assembled file.
 * Cleans up the chunk directory after assembly.
 *
 * Before writing anything, the chunks are verified to tile `[0, total)`
 * exactly — contiguous, no gaps, no overlaps, summing to `total`. Previously
 * only the aggregate byte count was checked (in storeChunk), so a set of
 * chunks with a gap and a compensating overlap could report "complete" and
 * assemble into silently corrupt content.
 *
 * The sha256 is computed from the same buffers that are written, in order, so
 * it always matches the file on disk. The prior implementation hashed via a
 * `data` listener attached alongside `stream.pipeline`, which put the stream in
 * flowing mode and raced the pipeline's own consumption — the hash could cover
 * a different byte view than what was written.
 */
export async function assembleChunks(
  spaceId: string,
  filePath: string,
  total: number,
  targetPath: string,
): Promise<string> {
  const id = uploadId(spaceId, filePath, total);
  const dir = uploadDir(spaceId, id);

  // List and sort chunk files by their start offset.
  const chunkFiles: { name: string; start: number; size: number }[] = [];
  for (const name of await fs.readdir(dir)) {
    const span = await chunkSpan(dir, name);
    if (span) chunkFiles.push({ name, ...span });
  }
  chunkFiles.sort((a, b) => a.start - b.start);

  // Verify the chunks tile [0, total) exactly before touching the target file.
  let expected = 0;
  const sized: { name: string; size: number }[] = [];
  for (const cf of chunkFiles) {
    if (cf.start !== expected) {
      throw new RangeError(
        `Chunk coverage error for '${filePath}': expected a chunk at offset ${expected}, ` +
        `found one at ${cf.start} (gap or overlap).`,
      );
    }
    sized.push({ name: cf.name, size: cf.size });
    expected += cf.size;
  }
  if (expected !== total) {
    throw new RangeError(
      `Chunk coverage error for '${filePath}': assembled size ${expected} does not match ` +
      `the declared total ${total}.`,
    );
  }

  // Assemble sequentially: read each chunk, hash its PLAINTEXT, then stream it into the target. One chunk is
  // held in memory at a time (chunk size is bounded by the upload body limit), and the target streams through
  // the stored-bytes door, so a file of any size is encrypted at rest without ever being held whole (F-43).
  const hash = createHash('sha256');
  const plaintextChunks = async function* () {
    for (const cf of sized) {
      const buf = await readStored(path.join(dir, cf.name));
      // The name promised this many bytes; a chunk that decodes to a different length would tile wrongly and
      // assemble a corrupt file whose hash is nonetheless "correct".
      if (buf.length !== cf.size) {
        throw new RangeError(`Chunk ${cf.name} of '${filePath}' holds ${buf.length} bytes, not the ${cf.size} its name records.`);
      }
      hash.update(buf);
      yield buf;
    }
  };
  await pipeToStored(targetPath, plaintextChunks());

  const sha256 = hash.digest('hex');

  // Clean up chunk directory
  await removeTree(dir);

  return sha256;
}

/** Get total received bytes for an upload. Returns 0 if upload doesn't exist. */
export async function getUploadReceived(
  spaceId: string,
  filePath: string,
  total: number,
): Promise<number> {
  const id = uploadId(spaceId, filePath, total);
  const dir = uploadDir(spaceId, id);

  try {
    return await stagedBytes(dir);
  } catch {
    return 0;
  }
}

/** The name a failure of the stale-chunk cleanup is reported, counted and walked under. */
const CLEANUP_STEP = declareStep('Stale chunk cleanup');

/** A directory that is not there is an answer; any other failure to look at it is the caller's to be told. */
const orMissing = async <T>(read: Promise<T>, whenMissing: T): Promise<T> => {
  try { return await read; } catch (err) {
    if (isMissingPath(err)) return whenMissing;
    throw err;
  }
};

/**
 * Clean up stale chunk directories older than maxAge (ms).
 * Intended to run on startup + periodic (hourly, `intervalJob` in `index.ts`).
 *
 * ## One bad directory is that directory's (`Q-274`)
 *
 * Every space DIRECTORY under `.chunks` is walked through `eachSpace` (`util/housekeeping-walk.ts`), and every upload
 * directory inside it is a unit of its space (`eachUnit`). A space whose listing fails is reported once, by name,
 * and the next is still cleaned; an upload that cannot be examined or removed is reported by its id, retried next
 * cycle, and the others of its space still go. This used to be one `try` whose `catch {}` read every failure as
 * "the `.chunks` directory may not exist yet", so the first failure ended the pass in silence for everything after
 * it, every hour.
 *
 * "Not there" is `isMissingPath` and nothing else: a missing `.chunks` root is a clean pass, an upload that vanished
 * between the listing and the `stat` is already cleaned, and a root that fails to list for any other reason THROWS
 * to the caller (the boot call and the interval job both say it) rather than answering "nothing to clean".
 *
 * **What this does not bound:** the walk's housekeeping bound is for database operations, and this is the file
 * system. A directory on a hung network mount holds the pass (and its hourly job's lock, which the job names as a
 * long-running tick); it is not a database operation and no figure of the walk ends it (risk R5 of bundle-53).
 */
export async function cleanupStaleChunks(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const root = chunksRoot();
  let cleaned = 0;
  const now = Date.now();

  const spaceDirs = await orMissing(fs.readdir(root), [] as string[]);
  await eachSpace(CLEANUP_STEP, spaceDirs, async (spaceDirName) => {
    const spaceDir = path.join(root, spaceDirName);
    const stat = await orMissing(fs.stat(spaceDir), null);
    if (!stat?.isDirectory()) return;

    const uploads = await orMissing(fs.readdir(spaceDir), [] as string[]);
    await eachUnit(uploads, async (upload) => {
      const uploadPath = path.join(spaceDir, upload);
      const uStat = await orMissing(fs.stat(uploadPath), null);   // gone since the listing: nothing left to clean
      if (!uStat?.isDirectory()) return;
      if (now - uStat.mtimeMs > maxAgeMs) {
        await removeTree(uploadPath);
        cleaned++;
      }
    });

    // Remove an empty space dir; one that gained an upload since the listing is not empty, and one already gone is done.
    const remaining = await orMissing(fs.readdir(spaceDir), null);
    if (remaining?.length === 0) {
      await fs.rmdir(spaceDir).catch((err: unknown) => {
        if (!isMissingPath(err) && (err as NodeJS.ErrnoException | null)?.code !== 'ENOTEMPTY') throw err;
      });
    }
  });

  if (cleaned > 0) {
    log.info(`Cleaned up ${cleaned} stale chunk upload(s)`);
  }

  return cleaned;
}
