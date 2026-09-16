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
import { spaceCollection } from '../db/space-collection.js';

export interface ManifestEntry {
  path: string;        // relative to space files root, e.g. "notes/2024.md"
  sha256: string;
  size: number;
  modifiedAt: string;  // ISO 8601
}

/** Cached hash for one file, invalidated when size or mtime changes. */
interface HashCacheDoc {
  _id: string;      // path relative to the space files root
  size: number;
  mtimeMs: number;
  sha256: string;
}

function spaceFilesRoot(spaceId: string): string {
  return path.resolve(getDataRoot(), 'files', spaceId);
}

async function hashFile(absPath: string): Promise<string> {
  const data = await fs.readFile(absPath);
  // Buffer.from() needed to satisfy createHash type in newer @types/node
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
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
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(abs);
      } else if (stat.isFile()) {
        if (since && stat.mtimeMs < since.getTime()) continue;
        const relPath = path.relative(root, abs).replace(/\\/g, '/');
        seen.add(relPath);
        const cached = cache.get(relPath);
        let sha256: string;
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          sha256 = cached.sha256; // unchanged — reuse the cached hash
        } else {
          sha256 = await hashFile(abs);
          updates.push({ _id: relPath, size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
        }
        results.push({
          path: relPath,
          sha256,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  }

  await walk(root);

  // Persist newly-computed / changed hashes so the next round reuses them.
  if (updates.length > 0) {
    await cacheColl.bulkWrite(asBulk<HashCacheDoc>(
      updates.map(u => ({ replaceOne: { filter: { _id: u._id }, replacement: u, upsert: true } })),
    ));
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
