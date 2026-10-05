/**
 * Backup configuration loader.
 *
 * Reads backup.json from the same directory as config.json (typically
 * /config/backup.json).  It can also be written by the API via
 * `PUT /api/admin/data/backup-config`, but only behind `requireAdminMfa` AND
 * the `YTHRIL_DB_MIGRATION_ENABLED` feature flag (off by default); otherwise
 * it is managed by the infrastructure admin on the filesystem.
 *
 * Design rationale: keeping backup config out of config.json (which is freely
 * API-writable) means redirecting backups to an attacker-controlled path takes
 * MFA plus an explicitly-enabled feature flag, not just an admin token — and
 * `offsite.destPath` is additionally required to be absolute.
 *
 * Example backup.json — see config/backup.example.json for the full schema.
 *
 * All fields are optional.  Returns null when the file is absent or invalid
 * (invalid config is logged as a warning and silently ignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { log, peerText } from '../util/log.js';

const CONFIG_PATH = process.env['CONFIG_PATH'] ?? '/config/config.json';

export const BACKUP_CONFIG_PATH = path.join(path.dirname(CONFIG_PATH), 'backup.json');

// ── Schema ────────────────────────────────────────────────────────────────────

const BackupConfigSchema = z
  .object({
    /**
     * Cron expression for automatic scheduled backups.
     * Only active when YTHRIL_DB_MIGRATION_ENABLED=true.
     * Example: "0 2 * * *"  (daily at 02:00)
     */
    schedule: z.string().optional(),

    /**
     * Encrypt every record line in a backup with the configured master secret.
     *
     * **Default false — plaintext.** Chosen deliberately (owner, 2026-08-03) over encrypt-by-default: a backup
     * you cannot restore is not a backup, and encrypting by default makes disaster recovery onto a *fresh*
     * instance depend on having the old key to hand **before** the restore. Some operators also back up
     * precisely so they can inspect or migrate the data with other tools.
     *
     * This ONE value is read by every path that produces a backup — the manual endpoint, the scheduled run and
     * the offsite copy — because they all funnel through `dumpDatabase`. It is also the value the UI toggle
     * writes, so "infra" and "in the UI" are the same setting rather than two that can disagree.
     *
     * Restore needs no equivalent: it detects an envelope per line, so an operator never has to remember how a
     * backup was written.
     *
     * **Requires `YTHRIL_MASTER_KEY` or `YTHRIL_MASTER_PASSPHRASE`.** Enabling it without one fails the backup
     * before writing anything, rather than producing a half-plaintext directory. Losing the secret makes the
     * backup unrecoverable — by design; store it somewhere other than the instance it protects.
     */
    encrypt: z.boolean().optional(),

    retention: z
      .object({
        /**
         * Maximum number of local backups to keep under <dataRoot>/backups/.
         * Oldest backups beyond this limit are deleted after each backup run.
         * Default when absent: no automatic pruning.
         */
        keepLocal: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),

    offsite: z
      .object({
        /**
         * Absolute path on the container filesystem to copy backups to after
         * each run.  Use Docker/K8s volume mounts to point this at an external
         * drive, NFS share, or any mounted storage.
         */
        destPath: z.string().min(1),

        retention: z
          .object({
            /**
             * Maximum number of offsite backup sets to retain.
             * Default when absent: 14.
             */
            keepCount: z.number().int().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type BackupConfig = z.infer<typeof BackupConfigSchema>;
export { BackupConfigSchema };

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Load and validate backup.json.
 *
 * Returns null when:
 *  - The file does not exist (this is the normal state when backup is not configured)
 *  - The file contains invalid JSON or fails schema validation
 *  - offsite.destPath is not an absolute path
 *
 * Never throws.
 */
export function loadBackupConfig(): BackupConfig | null {
  if (!fs.existsSync(BACKUP_CONFIG_PATH)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(BACKUP_CONFIG_PATH, 'utf8');
  } catch (err) {
    log.warn(`backup.json: read error — ${peerText(err)} — backup config ignored`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('backup.json: invalid JSON — backup config ignored');
    return null;
  }

  const result = BackupConfigSchema.safeParse(parsed);
  if (!result.success) {
    log.warn(`backup.json: invalid schema — ${peerText(result.error.message)} — backup config ignored`);
    return null;
  }

  // Security: offsite.destPath must be absolute and must not contain traversal
  // sequences, even though only infra admins can write this file.
  const offsite = result.data.offsite;
  if (offsite) {
    if (!path.isAbsolute(offsite.destPath)) {
      log.warn('backup.json: offsite.destPath must be an absolute path — backup config ignored');
      return null;
    }
    if (offsite.destPath.includes('..')) {
      log.warn('backup.json: offsite.destPath must not contain ".." — backup config ignored');
      return null;
    }
  }

  return result.data;
}
