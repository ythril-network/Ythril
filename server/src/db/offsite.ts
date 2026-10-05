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
import { mkdirPrivateSync } from '../util/fs-modes.js';
import path from 'node:path';
import { log, peerText } from '../util/log.js';

/**
 * Every directory under `root` that cannot be opened, as relative paths.
 *
 * ## Why this walk exists
 *
 * `fs.cpSync(…, { recursive: true })` iterates the tree in C++. When it meets a directory it cannot open, the
 * `std::filesystem` iterator throws — and that exception does not become a JavaScript error. It reaches
 * `terminate()`, which **kills the process**:
 *
 *     terminate called after throwing an instance of 'std::filesystem::__cxx11::filesystem_error'
 *       what():  filesystem error: directory iterator cannot open directory: Permission denied
 *
 * Observed, not theorised: one unreadable directory under the files root took the whole server down mid-backup
 * (container exit 139), and no `try`/`catch` around `cpSync` can prevent it. The cause that time was ours and is
 * fixed, but the hazard is not: a directory an operator dropped into the mount as another user does the same
 * thing, and a backup must never be able to take the instance with it.
 *
 * So the tree is walked in JavaScript first, where `EACCES` is an ordinary error. It costs one `readdir` per
 * directory against a copy that reads every byte of every file, and it turns an unrecoverable crash into a failed
 * request with a message naming the directory to fix.
 */
function unreadableDirs(root: string): string[] {
  const bad: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      bad.push(path.relative(root, dir) || '.');
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  };
  walk(root);
  return bad;
}

/** Throw a catchable, actionable error rather than letting `cpSync` end the process. */
function assertCopyable(root: string, what: string): void {
  const bad = unreadableDirs(root);
  if (bad.length === 0) return;
  throw new Error(
    `Cannot copy ${what}: ${bad.length} director${bad.length === 1 ? 'y is' : 'ies are'} not readable by this `
    + `process — ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? `, and ${bad.length - 5} more` : ''}. `
    + 'Fix their permissions (or ownership) and retry; copying was not attempted, because the recursive copy would '
    + 'have terminated the server rather than reporting this.',
  );
}

/**
 * Copy a completed DB backup directory to the offsite destination.
 * Creates <destRoot>/<backupId>/ as a recursive copy of <srcDir>.
 * Returns the destination path.
 */
export function copyBackupOffsite(srcDir: string, destRoot: string, backupId: string): string {
  const destDir = path.join(destRoot, backupId);
  // 0700, matching the source dump. `cpSync` preserves the source file modes, so the 0600 NDJSON files stay 0600 —
  // it is the DIRECTORY that would otherwise be created world-readable.
  //
  // This narrows the exposure; it does not remove it. The destination is usually a mounted share, and its own
  // permissions and encryption are the operator's to arrange — which is why `12-admin-api.md` now says so instead
  // of leaving a reader to assume that "encryption at rest" covered this.
  assertCopyable(srcDir, 'the database dump');
  mkdirPrivateSync(destDir);
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
  // Same reasoning as above, and it applies more here: these are the users' UPLOADED FILES, verbatim.
  assertCopyable(filesDir, 'the uploaded files');
  mkdirPrivateSync(destDir);
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
      log.warn(`pruneBackups: failed to delete ${peerText(name)}: ${peerText(err)}`);
    }
  }

  return deleted;
}
