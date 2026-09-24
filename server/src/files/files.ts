import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { resolveSafePathChecked, spaceRoot } from './sandbox.js';
import { getConfig, getDataRoot, getStorageConfig } from '../config/loader.js';
import { FILE_MODE, harden, hardenPath, mkdirPrivate } from '../util/fs-modes.js';

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  modifiedAt?: string;
  // ── File-level metadata, joined from the `{space}_files` FileMeta record (files only) ──
  /** Embedding lifecycle of the file, for the status pill in the merged Files list. */
  embeddingStatus?: 'pending' | 'processing' | 'complete' | 'partial' | 'failed' | 'skipped' | 'disabled';
  /** Tags on the file's metadata record. */
  tags?: string[];
  /**
   * Live stage of the file's media job — which step of THIS file's route is running, and how far in.
   * Present only while the file is in flight (`pending`/`processing`) and only once the worker has
   * reported a step; absent means "not known yet", which the UI must keep distinct from "no steps".
   */
  progress?: { step: string; steps: string[]; done?: number; total?: number };
  /** ISO8601 of the job's last sign of life, so the UI can tell "working" from "wedged". */
  progressAt?: string | null;
}

/** Ensure the space files directory exists */
export async function ensureSpaceFilesDir(spaceId: string): Promise<void> {
  // Owner-only. A space's files directory holds every document uploaded to that space; it has no business being
  // world-readable, and it was — see `util/fs-modes.ts`.
  await mkdirPrivate(spaceRoot(spaceId));
}

/** Read a text file — rejects if it's a directory or doesn't exist */
export async function readFile(spaceId: string, filePath: string): Promise<string> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  const content = await fs.readFile(abs, 'utf8');
  return content;
}

/** Read a file as a Buffer (for binary files) */
export async function readFileBytes(spaceId: string, filePath: string): Promise<Buffer> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  return fs.readFile(abs);
}

/** Write a text file, creating parent directories as needed */
export async function writeFile(spaceId: string, filePath: string, content: string): Promise<{ sha256: string }> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  await mkdirPrivate(path.dirname(abs));
  await fs.writeFile(abs, content, { encoding: 'utf8', mode: FILE_MODE });
  // `mode:` only applies when the file is CREATED, so an overwrite of a file that predates this leaves it `0644`.
  // The chmod is what makes the tightening self-healing instead of needing a boot-time walk of the whole tree.
  await harden(abs, FILE_MODE);
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  return { sha256 };
}

/** Write a Buffer to a file */
export async function writeFileBytes(
  spaceId: string,
  filePath: string,
  data: Buffer,
): Promise<{ sha256: string }> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  await mkdirPrivate(path.dirname(abs));
  await fs.writeFile(abs, data, { mode: FILE_MODE });
  await harden(abs, FILE_MODE);   // see the note in `writeFile` above
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { sha256 };
}

/** List entries in a directory (non-recursive) */
export async function listDir(spaceId: string, dirPath: string): Promise<FileEntry[]> {
  const abs = await resolveSafePathChecked(spaceId, dirPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      result.push({ name: e.name, type: 'dir' });
    } else if (e.isFile()) {
      let size: number | undefined;
      let modifiedAt: string | undefined;
      try {
        const stat = await fs.stat(path.join(abs, e.name));
        size = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch { /* stat failed — omit metadata */ }
      result.push({ name: e.name, type: 'file', size, modifiedAt });
    }
  }
  return result;
}

/** Delete a file (not a directory) */
export async function deleteFile(spaceId: string, filePath: string): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  await fs.unlink(abs);
}

/** True if a regular file exists at the given space-relative path. */
export async function fileExists(spaceId: string, filePath: string): Promise<boolean> {
  try {
    const abs = await resolveSafePathChecked(spaceId, filePath);
    const st = await fs.stat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Create a directory (including parents) */
export async function createDir(spaceId: string, dirPath: string): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, dirPath);
  await mkdirPrivate(abs);
}

/** Move/rename a file or directory */
export async function moveFile(
  spaceId: string,
  srcPath: string,
  dstPath: string,
): Promise<void> {
  const srcAbs = await resolveSafePathChecked(spaceId, srcPath);
  const dstAbs = await resolveSafePathChecked(spaceId, dstPath);
  await mkdirPrivate(path.dirname(dstAbs));
  await fs.rename(srcAbs, dstAbs);
  // A rename carries the source's mode with it, so moving a file that predates this hardening would silently
  // reintroduce an 0644 file into a tightened tree.
  //
  // `hardenPath`, not `harden(dstAbs, FILE_MODE)`: this function moves DIRECTORIES too, and `0600` on a directory
  // removes the execute bit that makes it openable at all. Getting that wrong took the server down — see the note
  // on `hardenPath`.
  await hardenPath(dstAbs);
}

/** Recursively sum file sizes under a directory. Returns 0 if dir doesn't exist. */
export async function getDirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(full);
        total += st.size;
      } catch { /* skip inaccessible files */ }
    }
  }
  return total;
}

/**
 * Recursively list every file under a space-relative directory, returning
 * space-relative forward-slash paths (e.g. `notes/2024/jan.md`). Returns [] if the
 * directory does not exist. Used to enumerate a subtree before deleting it so a sync
 * tombstone can be written for each removed file.
 */
export async function listFilesRecursive(spaceId: string, dirPath: string): Promise<string[]> {
  const root = spaceRoot(spaceId);
  let absDir: string;
  try {
    absDir = await resolveSafePathChecked(spaceId, dirPath);
  } catch {
    return [];
  }
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable — nothing to list
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  await walk(absDir);
  return out;
}

export interface QuotaCheckResult {
  /** true = proceed with write; false = reject with 507 */
  allowed: boolean;
  /** true = within hard limit but past soft limit — caller should include storageWarning */
  softWarning: boolean;
}

