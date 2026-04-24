/**
 * Backup configuration loader.
 *
 * Reads backup.json from the same directory as config.json (typically
 * /config/backup.json).  This file is NEVER written by the API — it is
 * managed exclusively by the infrastructure admin via the filesystem.
 *
 * Design rationale: keeping backup config out of config.json (which IS
 * API-writable) prevents a compromised admin token from redirecting backups
 * to an attacker-controlled path.
 *
 * Example backup.json — see config/backup.example.json for the full schema.
 *
 * All fields are optional.  Returns null when the file is absent or invalid
 * (invalid config is logged as a warning and silently ignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { log } from '../util/log.js';

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
    log.warn(`backup.json: read error — ${err} — backup config ignored`);
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
    log.warn(`backup.json: invalid schema — ${result.error.message} — backup config ignored`);
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
