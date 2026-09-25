/**
 * Chunked upload support — Content-Range based.
 *
 * Chunks are stored under /data/.chunks/<spaceId>/<uploadId>/<start>.bin
 * The uploadId is derived from (spaceId, path, total) for idempotent resume.
 * When the final chunk arrives, all parts are assembled into the target file.
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDataRoot } from '../config/loader.js';
import { FILE_MODE, harden, mkdirPrivate } from '../util/fs-modes.js';
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

  // Write chunk as <start>.bin
  const chunkFile = path.join(dir, `${start}.bin`);
  await fs.writeFile(chunkFile, data, { mode: FILE_MODE });
  await harden(chunkFile, FILE_MODE);

  // Calculate total received bytes from all chunk files
  const entries = await fs.readdir(dir);
  let received = 0;
  for (const name of entries) {
    if (!name.endsWith('.bin')) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      received += stat.size;
    } catch {
      // Chunk may have been removed by concurrent cleanup — skip it
    }
  }

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
  const entries = await fs.readdir(dir);
  const chunkFiles = entries
    .filter(n => n.endsWith('.bin'))
    .map(n => ({ name: n, start: parseInt(n.replace('.bin', ''), 10) }))
    .filter(c => Number.isInteger(c.start) && c.start >= 0)
    .sort((a, b) => a.start - b.start);

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
    const st = await fs.stat(path.join(dir, cf.name));
    sized.push({ name: cf.name, size: st.size });
    expected += st.size;
  }
  if (expected !== total) {
    throw new RangeError(
      `Chunk coverage error for '${filePath}': assembled size ${expected} does not match ` +
      `the declared total ${total}.`,
    );
  }

  await mkdirPrivate(path.dirname(targetPath));

  // Assemble sequentially: read each chunk, hash it, then write it. One chunk is
  // held in memory at a time (chunk size is bounded by the upload body limit).
  const hash = createHash('sha256');
  const out = createWriteStream(targetPath, { mode: FILE_MODE });
  try {
    for (const cf of sized) {
      const buf = await fs.readFile(path.join(dir, cf.name));
      hash.update(buf);
      await new Promise<void>((resolve, reject) => {
        out.write(buf, err => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });
  } catch (err) {
    out.destroy();
    throw err;
  }
  await harden(targetPath, FILE_MODE);   // a resumed upload OVERWRITES, and `mode:` only applies at creation

  const sha256 = hash.digest('hex');

  // Clean up chunk directory
  await fs.rm(dir, { recursive: true, force: true });

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
    const entries = await fs.readdir(dir);
    let received = 0;
    for (const name of entries) {
      if (!name.endsWith('.bin')) continue;
      const stat = await fs.stat(path.join(dir, name));
      received += stat.size;
    }
    return received;
  } catch {
    return 0;
  }
}

/**
 * Clean up stale chunk directories older than maxAge (ms).
 * Intended to run on startup + periodic (hourly).
 */
export async function cleanupStaleChunks(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const root = chunksRoot();
  let cleaned = 0;
  const now = Date.now();

  try {
    const spaceIds = await fs.readdir(root);
    for (const spaceId of spaceIds) {
      const spaceDir = path.join(root, spaceId);
      const stat = await fs.stat(spaceDir);
      if (!stat.isDirectory()) continue;

      const uploads = await fs.readdir(spaceDir);
      for (const uploadId of uploads) {
        const uploadDir = path.join(spaceDir, uploadId);
        const uStat = await fs.stat(uploadDir);
        if (!uStat.isDirectory()) continue;

        if (now - uStat.mtimeMs > maxAgeMs) {
          await fs.rm(uploadDir, { recursive: true, force: true });
          cleaned++;
        }
      }

      // Remove empty space dirs
      const remaining = await fs.readdir(spaceDir);
      if (remaining.length === 0) {
        await fs.rmdir(spaceDir).catch(() => {});
      }
    }
  } catch {
    // .chunks dir may not exist yet — that's fine
  }

  if (cleaned > 0) {
    log.info(`Cleaned up ${cleaned} stale chunk upload(s)`);
  }

  return cleaned;
}
