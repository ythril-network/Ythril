import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { resolveSafePath, spaceRoot } from './sandbox.js';

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  modifiedAt?: string;
}

/** Ensure the space files directory exists */
export async function ensureSpaceFilesDir(spaceId: string): Promise<void> {
  await fs.mkdir(spaceRoot(spaceId), { recursive: true });
}

/** Read a text file — rejects if it's a directory or doesn't exist */
export async function readFile(spaceId: string, filePath: string): Promise<string> {
  const abs = resolveSafePath(spaceId, filePath);
  const content = await fs.readFile(abs, 'utf8');
  return content;
}

/** Read a file as a Buffer (for binary files) */
export async function readFileBytes(spaceId: string, filePath: string): Promise<Buffer> {
  const abs = resolveSafePath(spaceId, filePath);
  return fs.readFile(abs);
}

/** Write a text file, creating parent directories as needed */
export async function writeFile(spaceId: string, filePath: string, content: string): Promise<{ sha256: string }> {
  const abs = resolveSafePath(spaceId, filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  return { sha256 };
}

/** Write a Buffer to a file */
export async function writeFileBytes(
  spaceId: string,
  filePath: string,
  data: Buffer,
): Promise<{ sha256: string }> {
  const abs = resolveSafePath(spaceId, filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { sha256 };
}

/** List entries in a directory (non-recursive) */
export async function listDir(spaceId: string, dirPath: string): Promise<FileEntry[]> {
  const abs = resolveSafePath(spaceId, dirPath);
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
  const abs = resolveSafePath(spaceId, filePath);
  await fs.unlink(abs);
}

/** Create a directory (including parents) */
export async function createDir(spaceId: string, dirPath: string): Promise<void> {
  const abs = resolveSafePath(spaceId, dirPath);
  await fs.mkdir(abs, { recursive: true });
}

/** Move/rename a file or directory */
export async function moveFile(
  spaceId: string,
  srcPath: string,
  dstPath: string,
): Promise<void> {
  const srcAbs = resolveSafePath(spaceId, srcPath);
  const dstAbs = resolveSafePath(spaceId, dstPath);
  await fs.mkdir(path.dirname(dstAbs), { recursive: true });
  await fs.rename(srcAbs, dstAbs);
}
