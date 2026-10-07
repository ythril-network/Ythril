/**
 * File manifest builder for sync.
 * Produces { path, sha256, size, modifiedAt } entries for all files in a space,
 * optionally filtered to only files modified since a given timestamp.
 *
 * SHA-256 hashes are cached per space (P4). A manifest is rebuilt on every sync
 * round (twice — once for the file diff, once for the Merkle root), and hashing
 * re-reads the entire file, so re-hashing an unchanged multi-GB space every cycle
 * dominated file sync. The cache (collection `<spaceId>_file_hashes`, keyed by path
 * with the (size, mtime) it was hashed at) lets an unchanged file reuse its stored
 * hash; only new or modified files (size or mtime changed) are re-read. The cache is
 * a LOCAL derived index — it is never synced, and it is dropped with the space.
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { getDataRoot } from '../config/loader.js';
import { col, asFilter, asBulk } from '../db/mongo.js';
import { writeInOneCommands } from '../db/one-command.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { spaceCollection } from '../db/space-collection.js';
import { isMissingPath, openStoredRead, StoredFileUnreadable } from './stored-bytes.js';
import { log, peerText } from '../util/log.js';
import { noteUnreadable, clearUnreadable } from './unreadable-files.js';
import { spillIdFromPath } from '../brain/spill-path.js';
import { toDocId } from '../util/paths.js';
import { escapeRegex } from '../util/redos.js';

export interface ManifestEntry {
  path: string;        // relative to space files root, e.g. "notes/2024.md"
  sha256: string;
  size: number;
  modifiedAt: string;  // ISO 8601
}

/** Cached hash for one file, invalidated when size or mtime changes. */
interface HashCacheDoc {
  _id: string;      // path relative to the space files root
  /** The file's size ON DISK, which is what the cache is keyed on. */
  size: number;
  mtimeMs: number;
  sha256: string;
  /**
   * The PLAINTEXT size, which the manifest publishes. It differs from `size` when the file is encrypted at rest
   * (F-43); absent on a record written before that, where the file was plaintext and the two are equal.
   */
  plainSize?: number;
}

function spaceFilesRoot(spaceId: string): string {
  return path.resolve(getDataRoot(), 'files', spaceId);
}

/**
 * The sha256 and size of a file's PLAINTEXT, streamed. Peers compare what users stored, not what this instance
 * happens to keep on disk, so the hash is the same whether or not either side encrypts at rest (F-43).
 */
async function hashFile(absPath: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of await openStoredRead(absPath)) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Build a full or incremental file manifest for a space.
 *
 * @param since  when set, only files modified at/after this time are included.
 * @param opts.force  bypass the hash cache and re-read every file (reconciliation
 *   safety valve for the rare out-of-band edit that preserves size AND mtime).
 */
export async function buildFileManifest(
  spaceId: string,
  since?: Date,
  opts: { force?: boolean } = {},
): Promise<ManifestEntry[]> {
  const root = spaceFilesRoot(spaceId);
  const cacheColl = col<HashCacheDoc>(spaceCollection(spaceId, 'fileHashes'));

  // Load the existing hash cache once (empty on a forced rebuild).
  const cache = new Map<string, HashCacheDoc>();
  if (!opts.force) {
    const docs = await cacheColl.find(asFilter<HashCacheDoc>({})).toArray() as HashCacheDoc[];
    for (const d of docs) cache.set(d._id, d);
  }

  const results: ManifestEntry[] = [];
  const seen = new Set<string>();
  const updates: HashCacheDoc[] = [];

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return; // directory doesn't exist — no files
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      // Gone since the listing: nothing to offer. A file that cannot be looked at is left out too — offering it
      // would advertise bytes this instance cannot serve — but said once, as an unreadable file is (preship-4 P4-5).
      const stat = await fs.stat(abs).catch((err: unknown) => {
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (!isMissingPath(err) && noteUnreadable(spaceId, rel, String((err as NodeJS.ErrnoException).code))) {
          log.warn(`manifest: skipped '${peerText(rel)}' in ${peerText(spaceId)}: it cannot be looked at: ${peerText(err)}`);
        }
        return null;
      });
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(abs);
      } else if (stat.isFile()) {
        if (since && stat.mtimeMs < since.getTime()) continue;
        const relPath = path.relative(root, abs).replace(/\\/g, '/');
        // A spill an older version wrote into the space (Q-92) is one caller's search result, not content:
        // never offered to a peer, and so never counted in the space hash either. The sweep removes it.
        if (spillIdFromPath(relPath)) continue;
        seen.add(relPath);
        const cached = cache.get(relPath);
        let sha256: string;
        let plainSize: number;
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          sha256 = cached.sha256; // unchanged — reuse the cached hash
          plainSize = cached.plainSize ?? stat.size;
        } else {
          try {
            ({ sha256, size: plainSize } = await hashFile(abs));
          } catch (err) {
            /*
             * ONE unreadable file is left out, never the manifest. A file under a foreign key or with altered
             * bytes throwing out of here would fail the manifest route, file sync and the Merkle root for the
             * whole space on every cycle — a whole space stopped over one file. It is logged, and the refusal
             * reaches anyone who reads the file itself.
             */
            if (err instanceof StoredFileUnreadable) {
              if (noteUnreadable(spaceId, relPath, `${stat.size}:${stat.mtimeMs}`)) log.warn(`manifest: skipped '${peerText(relPath)}' in ${peerText(spaceId)}: ${peerText(err.message)}`);
              continue;
            }
            throw err;
          }
          clearUnreadable(spaceId, relPath);
          updates.push({ _id: relPath, size: stat.size, mtimeMs: stat.mtimeMs, sha256, plainSize });
        }
        results.push({
          path: relPath,
          sha256,
          size: plainSize,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  }

  await walk(root);

  // Persist newly-computed / changed hashes so the next round reuses them.
  if (updates.length > 0) {
    await writeInOneCommands(
      updates.map(u => ({ replaceOne: { filter: { _id: u._id }, replacement: u, upsert: true } })),
      (slice, { ordered }) => cacheColl.bulkWrite(asBulk<HashCacheDoc>(slice), { ordered }),
      { ordered: true },
    );
  }
  // Prune cache entries for files that no longer exist (only on a full walk, where
  // `seen` is complete). Bounded by the number of deletions since the last build.
  if (!since && !opts.force) {
    const stale = [...cache.keys()].filter(p => !seen.has(p));
    if (stale.length > 0) {
      await cacheColl.deleteMany(asFilter<HashCacheDoc>({ _id: { $in: stale } }));
    }
  }

  return results;
}

/**
 * Forget the cached hash of files that are gone, so the cache never advertises a path nothing holds — what a delete does
 * (`files/remove-file-here.ts`) and what the legacy spill sweep does, one spelling of "this path has no bytes any more".
 * A full manifest walk prunes the same entries on its next round; this is the delete saying so itself, which an
 * incremental walk never does.
 */
export async function forgetFileHashes(spaceId: string, ids: readonly string[]): Promise<void> {
  const cache = col<HashCacheDoc>(spaceCollection(spaceId, 'fileHashes'));
  for (const chunk of inChunks([...new Set(ids)], ROWS_PER_BULK_COMMAND)) {
    await cache.deleteMany(asFilter<HashCacheDoc>({ _id: { $in: chunk } }));
  }
}

/**
 * {@link forgetFileHashes} for every path under the directory `dirPath` — what a directory delete does for the tree it took
 * (`files/delete-cascade.ts`), as a single file's delete does for its path. Without it the cache keeps advertising every file
 * of a tree nothing holds until a full manifest walk happens to prune it, which an incremental one never does.
 *
 * The prefix is the directory's path and a `/`, regex-escaped, so `my.dir` never forgets `myXdir/` nor `my.dir2/`; an empty
 * path matches nothing here rather than everything.
 */
export async function forgetFileHashesByPrefix(spaceId: string, dirPath: string): Promise<void> {
  const norm = toDocId(dirPath).replace(/\/?$/, '');
  if (!norm) return;
  await col<HashCacheDoc>(spaceCollection(spaceId, 'fileHashes')).deleteMany(
    asFilter<HashCacheDoc>({ _id: { $regex: `^${escapeRegex(norm + '/')}` } }));
}

/**
 * Record a hash this process already knows, so the next manifest does not re-read the file to learn it. The
 * migration computes the plaintext hash while it encrypts; without this every migrated file — which has a new
 * size on disk — would be streamed and decrypted a second time on the next sync cycle.
 */
export async function seedFileHash(
  spaceId: string, relPath: string, entry: { size: number; mtimeMs: number; sha256: string; plainSize: number },
): Promise<void> {
  await col<HashCacheDoc>(spaceCollection(spaceId, 'fileHashes')).replaceOne(
    asFilter<HashCacheDoc>({ _id: relPath }), { ...entry }, { upsert: true });
}
