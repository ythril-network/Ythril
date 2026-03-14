/**
 * File manifest builder for sync.
 * Produces { path, sha256, size, modifiedAt } entries for all files in a space,
 * optionally filtered to only files modified since a given timestamp.
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { getDataRoot } from '../config/loader.js';

export interface ManifestEntry {
  path: string;        // relative to space files root, e.g. "notes/2024.md"
  sha256: string;
  size: number;
  modifiedAt: string;  // ISO 8601
}

function spaceFilesRoot(spaceId: string): string {
  return path.resolve(getDataRoot(), 'files', spaceId);
}

async function hashFile(absPath: string): Promise<string> {
  const data = await fs.readFile(absPath);
  // Buffer.from() needed to satisfy createHash type in newer @types/node
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

/** Recursively walk a directory, yielding all file paths */
async function walk(dir: string, base: string, since: Date | undefined, results: ManifestEntry[]): Promise<void> {
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
      await walk(abs, base, since, results);
    } else if (stat.isFile()) {
      if (since && stat.mtimeMs < since.getTime()) continue;
      const sha256 = await hashFile(abs);
      results.push({
        path: path.relative(base, abs).replace(/\\/g, '/'),
        sha256,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
}

/** Build a full or incremental file manifest for a space */
export async function buildFileManifest(spaceId: string, since?: Date): Promise<ManifestEntry[]> {
  const root = spaceFilesRoot(spaceId);
  const results: ManifestEntry[] = [];
  await walk(root, root, since, results);
  return results;
}
