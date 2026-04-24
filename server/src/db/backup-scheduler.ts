/**
 * Scheduled backup engine.
 *
 * Uses node-cron to run automatic backups on the schedule defined in
 * backup.json.  Each run:
 *
 *   1. Dumps MongoDB to a timestamped directory under <dataRoot>/backups/
 *   2. Applies local retention (retention.keepLocal)
 *   3. If offsite.destPath is configured: copies the DB dump + /data/files
 *   4. Applies offsite retention (offsite.retention.keepCount)
 *
 * The scheduler is gated behind YTHRIL_DB_MIGRATION_ENABLED=true — the same
 * feature flag that guards live DB migration.  Operators who need automated
 * offsite backups consciously set this flag.
 *
 * Exports:
 *   startBackupScheduler()  — call after MongoDB is connected (index.ts)
 *   stopBackupScheduler()   — call during graceful shutdown
 *   runBackupNow()          — on-demand backup; also called by POST /backup
 *                             when offsite/retention are configured
 */
import path from 'node:path';
import { schedule, validate, type ScheduledTask } from 'node-cron';
import { getMongoUri, getDataRoot } from '../config/loader.js';
import { dumpDatabase, type DumpManifest } from './dump.js';
import { copyBackupOffsite, copyFilesOffsite, pruneBackups } from './offsite.js';
import { loadBackupConfig } from './backup-config.js';
import { log } from '../util/log.js';

const DEFAULT_KEEP_OFFSITE = 14;

let _task: ScheduledTask | null = null;

function isBackupFeatureEnabled(): boolean {
  return (process.env['YTHRIL_DB_MIGRATION_ENABLED'] ?? '').trim().toLowerCase() === 'true';
}

// ── Core backup logic ─────────────────────────────────────────────────────────

export interface BackupResult {
  id: string;
  dir: string;
  manifest: DumpManifest;
  localPruned?: number;
  offsite?: { dir: string; filesDir?: string; pruned?: number };
}

/**
 * Run a complete backup cycle: dump → local retention → offsite copy → offsite retention.
 *
 * Throws if the MongoDB dump itself fails (so callers / the scheduler can log
 * the error and not silently swallow it).  Offsite copy failures are caught and
 * logged but do NOT cause this function to throw — a failed offsite copy does
 * not invalidate the local backup.
 *
 * Returns metadata about what was done, including the dump manifest.
 */
export async function runBackupNow(): Promise<BackupResult> {
  const cfg = loadBackupConfig();
  const dataRoot = getDataRoot();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = path.join(dataRoot, 'backups', ts);

  log.info(`Backup starting → ${destDir}`);
  const manifest = await dumpDatabase(getMongoUri(), destDir);
  log.info(`Backup dump complete: ${ts}`);

  const result: BackupResult = {
    id: ts,
    dir: destDir,
    manifest,
  };

  // Local retention
  if (cfg?.retention?.keepLocal) {
    const pruned = pruneBackups(path.join(dataRoot, 'backups'), cfg.retention.keepLocal);
    if (pruned > 0) {
      log.info(`Pruned ${pruned} local backup(s) (keepLocal=${cfg.retention.keepLocal})`);
      result.localPruned = pruned;
    }
  }

  // Offsite copy + retention
  if (isBackupFeatureEnabled() && cfg?.offsite?.destPath) {
    const destRoot = cfg.offsite.destPath;
    try {
      const offsiteDir = copyBackupOffsite(destDir, destRoot, ts);
      log.info(`Offsite DB copy complete → ${offsiteDir}`);

      const filesDir = path.join(dataRoot, 'files');
      const filesDest = copyFilesOffsite(filesDir, destRoot, ts);
      if (filesDest) log.info(`Offsite files copy complete → ${filesDest}`);

      const keepOffsite = cfg.offsite.retention?.keepCount ?? DEFAULT_KEEP_OFFSITE;
      const offsitePruned = pruneBackups(destRoot, keepOffsite);
      if (offsitePruned > 0) {
        log.info(`Pruned ${offsitePruned} offsite backup(s) (keepCount=${keepOffsite})`);
      }

      result.offsite = {
        dir: offsiteDir,
        ...(filesDest ? { filesDir: filesDest } : {}),
        ...(offsitePruned > 0 ? { pruned: offsitePruned } : {}),
      };
    } catch (err) {
      log.error(`Offsite backup copy failed (local backup is intact): ${err}`);
      // Do not re-throw — the local backup succeeded
    }
  }

  return result;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the cron-based backup scheduler.
 *
 * No-op if:
 *  - YTHRIL_DB_MIGRATION_ENABLED is not true
 *  - backup.json is absent or has no `schedule` field
 *  - The cron expression in `schedule` is invalid
 *
 * Call this from index.ts after MongoDB is connected.
 */
export function startBackupScheduler(): void {
  if (!isBackupFeatureEnabled()) return;

  const cfg = loadBackupConfig();
  if (!cfg?.schedule) return;

  if (!validate(cfg.schedule)) {
    log.warn(`backup.json: invalid cron expression "${cfg.schedule}" — scheduled backups disabled`);
    return;
  }

  // Stop any previously running task before (re-)scheduling
  _task?.stop();
  _task = null;

  _task = schedule(cfg.schedule, () => {
    runBackupNow().catch(err => log.error(`Scheduled backup error: ${err}`));
  });

  log.info(`Scheduled backup enabled (cron: "${cfg.schedule}")`);
}

/**
 * Stop the scheduled backup task.
 * Call during graceful shutdown.
 */
export function stopBackupScheduler(): void {
  _task?.stop();
  _task = null;
}
