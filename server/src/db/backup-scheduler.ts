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
import { log, outsideRequest } from '../util/log.js';
import { armedSchedules } from '../util/armed-schedule.js';
import { runExclusive } from '../util/single-flight.js';
import { backupsRoot } from './backup-location.js';
import { instanceWideActStanding, backupsNamedByActs } from '../spaces/space-act-runner.js';
import type { SpaceActKind } from '../config/types.js';

const DEFAULT_KEEP_OFFSITE = 14;

let _task: ScheduledTask | null = null;
/** See `util/armed-schedule.ts`: this route is called on every save, most of which do not touch the cron. */
const _armed = armedSchedules();
const ARMED = 'the one task';

function isBackupFeatureEnabled(): boolean {
  return (process.env['YTHRIL_DB_MIGRATION_ENABLED'] ?? '').trim().toLowerCase() === 'true';
}

// ── Core backup logic ─────────────────────────────────────────────────────────

/** A backup was asked for while an act that stands on every space (a restore) stands; answered `409` by the door. */
export class BackupRefusedDuringRestore extends Error {
  override readonly name = 'BackupRefusedDuringRestore';
  readonly code = 'backup_refused_during_restore';
  constructor(kind: SpaceActKind) {
    super(`No backup is taken while a ${kind} stands: it would dump a database that is part old and part restored. Retry once it has ended.`);
  }
}

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
 *
 * `underAct` says the caller IS the body of the instance-wide act of that kind standing now (a migrate's dump of the database it is
 * about to copy): every space is held by it, so the dump is consistent, and only then is the refusal below passed.
 */
export async function runBackupNow({ underAct }: { underAct?: SpaceActKind } = {}): Promise<BackupResult> {
  // Never while a restore stands: the dump would be half old and half restored, and become the newest backup (bundle-157, R4.1, R5.4).
  const standing = instanceWideActStanding();
  if (standing && standing !== underAct) throw new BackupRefusedDuringRestore(standing);
  const cfg = loadBackupConfig();
  const dataRoot = getDataRoot();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = path.join(backupsRoot(), ts);

  log.info(`Backup starting → ${destDir}`);
  // The one setting, reaching the one choke point. The offsite copy below copies whatever this wrote, so it
  // inherits the choice rather than needing its own flag.
  const manifest = await dumpDatabase(getMongoUri(), destDir, { encrypt: cfg?.encrypt === true });
  log.info(`Backup dump complete: ${ts}`);

  const result: BackupResult = {
    id: ts,
    dir: destDir,
    manifest,
  };

  // Local retention
  if (cfg?.retention?.keepLocal) {
    // A backup a standing act names (a restore's) is kept whatever the count: its acts resolve it when they run.
    const pruned = pruneBackups(backupsRoot(), cfg.retention.keepLocal, backupsNamedByActs());
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

  /*
   * ALREADY ARMED ON THIS EXPRESSION — leave it running.
   *
   * The route that writes `backup.json` calls this on every save, and a save that only changed
   * `offsite.destPath` or a retention count has nothing to do with the cron. Restarting the task there would
   * reset its phase: a nightly backup ninety seconds away goes back to a full day, and an operator adjusting
   * three fields in a row could push it repeatedly.
   */
  if (cfg?.schedule && _task && _armed.isArmed(ARMED, cfg.schedule)) return;

  // Stop any previously running task before (re-)scheduling — including when the schedule was CLEARED, which
  // is how disabling scheduled backups takes effect rather than waiting for a restart.
  //
  // Clearing `_armedCron` here is belt to the guard's braces rather than load-bearing: the guard also requires
  // `_task`, so a stale expression with no task behind it cannot make it return early. Kept because the two
  // are one fact — what is armed — and letting them disagree is how the next change to this function goes
  // wrong. Deliberately NOT gated: a test that failed on removing it would be asserting the redundancy.
  _task?.stop();
  _task = null;
  _armed.forget();

  if (!cfg?.schedule) return;

  if (!validate(cfg.schedule)) {
    log.warn(`backup.json: invalid cron expression "${cfg.schedule}" — scheduled backups disabled`);
    return;
  }

  // node-cron fires on schedule whether or not the last dump finished: one that outlasts its period is skipped, not overlapped.
  // `runExclusive` never throws; a failed dump is logged as "Scheduled backup failed: …".
  // `outsideRequest`: the backup route re-arms this task, and a tick must not run (and log) under that request's id.
  _task = schedule(cfg.schedule, () => outsideRequest(() => {
    void runExclusive('Scheduled backup', () => runBackupNow());
  }));
  _armed.note(ARMED, cfg.schedule);

  log.info(`Scheduled backup enabled (cron: "${cfg.schedule}")`);
}

/**
 * Stop the scheduled backup task.
 * Call during graceful shutdown.
 */
export function stopBackupScheduler(): void {
  _task?.stop();
  _task = null;
  _armed.forget();
}
