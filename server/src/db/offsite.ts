/**
 * Offsite backup utilities.
 *
 * Handles copying a completed local backup to an offsite destination and
 * pruning old backup sets based on a retention policy.
 *
 * The "offsite" destination is any absolute path on the container filesystem —
 * use Docker/K8s volume mounts to point it at external drives, NFS shares, etc.
 *
 * Layout at the offsite destination root:
 *   <destRoot>/<backupId>/            — MongoDB NDJSON dump (manifest.json + *.ndjson)
 *   <destRoot>/<backupId>-files/      — copy of <dataRoot>/files/ (user-uploaded files)
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../util/log.js';

/**
 * Copy a completed DB backup directory to the offsite destination.
 * Creates <destRoot>/<backupId>/ as a recursive copy of <srcDir>.
 * Returns the destination path.
 */
export function copyBackupOffsite(srcDir: string, destRoot: string, backupId: string): string {
  const destDir = path.join(destRoot, backupId);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  return destDir;
}

/**
 * Copy the files directory to the offsite destination alongside a DB backup.
 * Destination: <destRoot>/<backupId>-files/
 *
 * Returns the destination path, or null if filesDir does not exist (e.g. no
 * files have been uploaded yet).
 */
export function copyFilesOffsite(
  filesDir: string,
  destRoot: string,
  backupId: string,
): string | null {
  if (!fs.existsSync(filesDir)) return null;
  const destDir = path.join(destRoot, `${backupId}-files`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(filesDir, destDir, { recursive: true });
  return destDir;
}

/**
 * Prune backup directories in `dir`, keeping only the `keepCount` most recent.
 *
 * A backup directory is identified by the presence of manifest.json inside it.
 * Directories are sorted lexicographically — this works because backup IDs are
 * ISO 8601 timestamps (e.g. 2025-06-01T02-00-00-000Z) which sort correctly.
 *
 * When a DB backup is pruned, the corresponding -files copy is also removed if
 * present, so the two always stay in sync.
 *
 * Returns the number of backup sets deleted.
 */
export function pruneBackups(dir: string, keepCount: number): number {
  if (!fs.existsSync(dir)) return 0;

  const entries: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    try {
      const fullPath = path.join(dir, name);
      if (
        fs.statSync(fullPath).isDirectory() &&
        fs.existsSync(path.join(fullPath, 'manifest.json'))
      ) {
        entries.push(name);
      }
    } catch {
      /* skip unreadable entries */
    }
  }

  // Newest first (ISO timestamp names sort lexicographically ascending)
  entries.sort().reverse();

  if (entries.length <= keepCount) return 0;

  let deleted = 0;
  for (const name of entries.slice(keepCount)) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      deleted++;

      // Remove the corresponding files copy if present
      const filesCopy = path.join(dir, `${name}-files`);
      if (fs.existsSync(filesCopy)) {
        fs.rmSync(filesCopy, { recursive: true, force: true });
      }
    } catch (err) {
      log.warn(`pruneBackups: failed to delete ${name}: ${err}`);
    }
  }

  return deleted;
}
