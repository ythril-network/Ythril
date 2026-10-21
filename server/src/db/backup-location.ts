/**
 * Where this instance's backups live, and the one way a backup id becomes a directory (bundle-157, R3.2).
 *
 * ## What it prevents
 *
 * A restore act stores a backup's ID, never its path, and resolves it again when its body runs - after a restart, possibly days later.
 * Resolving it is the route's traversal check plus "is there a backup there", and a second spelling of that check in the body would be the
 * one that forgot the traversal half. Both ask {@link backupDirOf}, and the scheduler, the list and the retention ask {@link backupsRoot}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../config/loader.js';

/** `<dataRoot>/backups`: every local backup is a directory here, named by its id. */
export function backupsRoot(): string {
  return path.join(getDataRoot(), 'backups');
}

/** Is `id` a bare directory name, so it cannot reach outside the backups root? */
export function isBackupId(id: string): boolean {
  return id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

/** The directory of backup `id` under the backups root, or null when the id could leave the root or no backup (a manifest) is there. */
export function backupDirOf(id: string): string | null {
  if (!isBackupId(id)) return null;
  const dir = path.join(backupsRoot(), id);
  return fs.existsSync(path.join(dir, 'manifest.json')) ? dir : null;
}
