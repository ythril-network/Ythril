/**
 * Admin data management API.
 *
 * Routes (all require admin; most require MFA where enabled):
 *
 *   GET    /api/admin/data/config           — current Mongo URI source + redacted URI
 *   POST   /api/admin/data/config/test      — test a MongoDB connection string
 *   GET    /api/admin/data/maintenance      — maintenance mode status
 *   POST   /api/admin/data/maintenance      — toggle maintenance mode
 *   POST   /api/admin/data/backup           — trigger a manual backup (dump + optional offsite copy)
 *   GET    /api/admin/data/backups          — list existing backups
 *   POST   /api/admin/data/restore          — restore from a named backup: one restore act per space, answered 202
 *   GET    /api/admin/data/restore          — the restore standing or the last one, per space
 *   POST   /api/admin/data/restore/abandon  — lift the holds of a standing restore's acts that have not completed
 *   POST   /api/admin/data/migrate         — copy the database into a new URI online under migrate acts, save it, exit (202)
 *   GET    /api/admin/data/migrate         — the migrate standing or the last one, in the restore report's shape
 *   POST   /api/admin/data/migrate/abandon  — end a standing migrate that cannot finish; nothing is saved, the old database stays
 *   GET    /api/admin/data/backup-config    — read backup.json (scheduled/offsite config)
 *                                             requires YTHRIL_DB_MIGRATION_ENABLED=true
 *   GET    /api/admin/data/browse-dirs      — list child directories at a given path (UI file picker)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getDataRoot } from '../config/loader.js';
import { requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { isMaintenanceActive, maintenanceState, setMaintenanceActive } from '../maintenance.js';
import { runBackupNow, BackupRefusedDuringRestore } from '../db/backup-scheduler.js';
import { loadBackupConfig, BACKUP_CONFIG_PATH, BackupConfigSchema } from '../db/backup-config.js';
import { startBackupScheduler } from '../db/backup-scheduler.js';
import { BackupNotWhole } from '../db/restore.js';
import { backupsRoot, backupDirOf, isBackupId } from '../db/backup-location.js';
import { planRestore, startRestore } from '../db/restore-act.js';
import { actSetReport, type ReportedActSetKind } from '../spaces/act-set-report.js';
import { abandonActSet } from '../spaces/act-set-abandon.js';
import { targetHoldsData, startMigrate } from '../db/migrate-act.js';
import { instanceWideActStanding, instanceWideActRefusal, spaceActClosedAnswer } from '../spaces/space-act-runner.js';
import { effectiveMongoUri, redactUri } from '../config/mongo-uri.js';
import { testConnection } from '../db/conn-test.js';
import { isSsrfSafeMongoUri } from '../util/ssrf.js';
import { refusalOfParse } from '../util/log.js';
import { sendCaughtFailure } from './send-failure.js';
import { isMissingPath } from '../files/stored-bytes.js';

export const dataRouter = Router();

// ── Shared middleware ─────────────────────────────────────────────────────────

dataRouter.use(globalRateLimit, requireAdmin);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Whether the live database migration feature is enabled on this instance.
 *
 * Disabled by default so that an enterprise infra-admin can prevent a
 * compromised admin token from being used to migrate the entire database to
 * an attacker-controlled MongoDB server.
 *
 * Enable by setting:  YTHRIL_DB_MIGRATION_ENABLED=true
 */
export function isDbMigrationEnabled(): boolean {
  return (process.env['YTHRIL_DB_MIGRATION_ENABLED'] ?? '').trim().toLowerCase() === 'true';
}

/** Safely read manifest.json from a backup directory. Returns null on error. */
function readBackupManifest(dir: string): object | null {
  const p = path.join(dir, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as object;
  } catch {
    return null;
  }
}

/** List all valid backup directories under backupsRoot(), sorted newest first. */
function listBackups(): Array<{ id: string; dir: string; createdAt: string; collections: unknown[] }> {
  const root = backupsRoot();
  if (!fs.existsSync(root)) return [];

  return fs.readdirSync(root)
    .filter(name => {
      const dir = path.join(root, name);
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'manifest.json'));
    })
    .map(name => {
      const dir = path.join(root, name);
      const manifest = readBackupManifest(dir) as Record<string, unknown> | null;
      return {
        id: name,
        dir,
        createdAt: (manifest?.createdAt as string) ?? name,
        collections: (manifest?.collections as unknown[]) ?? [],
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Validate a MongoDB URI: must be valid, must be mongodb/mongodb+srv, and SSRF-safe. */
function validateMongoUri(uri: unknown): { valid: true; uri: string } | { valid: false; error: string } {
  if (typeof uri !== 'string' || !uri.trim()) {
    return { valid: false, error: 'uri is required and must be a non-empty string' };
  }
  const trimmed = uri.trim();
  if (!trimmed.startsWith('mongodb://') && !trimmed.startsWith('mongodb+srv://')) {
    return { valid: false, error: 'URI must use the mongodb:// or mongodb+srv:// scheme' };
  }
  if (!isSsrfSafeMongoUri(trimmed)) {
    return { valid: false, error: 'URI targets a private, loopback, or cloud-metadata address — rejected for security' };
  }
  return { valid: true, uri: trimmed };
}

// ── GET /config ───────────────────────────────────────────────────────────────

dataRouter.get('/config', (_req, res) => {
  try {
    const { uri, source } = effectiveMongoUri();
    const mongoUriRedacted = redactUri(uri);
    const migrationEnabled = isDbMigrationEnabled();
    res.json({ source, mongoUriRedacted, migrationEnabled });
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/admin/data/config', err, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /config/test ─────────────────────────────────────────────────────────

dataRouter.post('/config/test', requireAdminMfa, async (req, res) => {
  const validation = validateMongoUri(req.body?.uri);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const result = await testConnection(validation.uri);
    res.json(result);
  } catch (err) {
    /*
     * NOT `sendCaughtFailure`, deliberately: the store this answers about is the CANDIDATE the operator is testing,
     * not this instance's own. A driver failure here is the answer they asked for — read as our store failing, it
     * would be a 503 telling them to retry a URI that will never connect (bundle-30 I12).
     */
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /maintenance ──────────────────────────────────────────────────────────

dataRouter.get('/maintenance', (_req, res) => {
  res.json(maintenanceState());
});

// ── POST /maintenance ─────────────────────────────────────────────────────────

dataRouter.post('/maintenance', requireAdminMfa, (req, res) => {
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Body must be { active: boolean }' });
    return;
  }
  // Read the current state BEFORE flipping it — the direction is the point, and a no-op re-toggle
  // should record nothing rather than look like a state change.
  req.auditSnapshots = { before: { active: isMaintenanceActive() }, after: { active: parsed.data.active } };

  // The toggle moves the MANUAL half only: a standing restore holds maintenance until its last act ends, and the answer says so.
  setMaintenanceActive(parsed.data.active);
  res.json(maintenanceState());
});

// ── POST /backup ──────────────────────────────────────────────────────────────
//
// Runs a full backup cycle via runBackupNow():
//   1. Dumps MongoDB to <dataRoot>/backups/<timestamp>/
//   2. If YTHRIL_DB_MIGRATION_ENABLED=true and backup.json is present:
//      a. Applies local retention (retention.keepLocal)
//      b. Copies backup + /data/files to offsite.destPath if configured
//      c. Applies offsite retention (offsite.retention.keepCount)

dataRouter.post('/backup', requireAdminMfa, async (_req, res) => {
  try {
    const result = await runBackupNow();
    res.json({
      backup: { id: result.id, dir: result.dir, manifest: result.manifest },
      ...(result.localPruned !== undefined ? { localPruned: result.localPruned } : {}),
      ...(result.offsite ? { offsite: result.offsite } : {}),
    });
  } catch (err) {
    if (err instanceof BackupRefusedDuringRestore) { res.status(409).json({ error: err.message, code: err.code }); return; }
    sendCaughtFailure(res, `POST /api/admin/data/backup`, err, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /backups ──────────────────────────────────────────────────────────────

dataRouter.get('/backups', (_req, res) => {
  try {
    const backups = listBackups();
    res.json({ backups });
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/admin/data/backups', err, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /backup-config ────────────────────────────────────────────────────────

dataRouter.get('/backup-config', (_req, res) => {
  if (!isDbMigrationEnabled()) {
    res.status(403).json({
      error:
        'Scheduled/offsite backup is disabled on this instance. ' +
        'Set YTHRIL_DB_MIGRATION_ENABLED=true to enable.',
      code: 'FEATURE_DISABLED',
    });
    return;
  }
  const config = loadBackupConfig();
  const backupsPath = path.join(getDataRoot(), 'backups');
  res.json({ config, configPath: BACKUP_CONFIG_PATH, backupsPath });
});

// ── GET /browse-dirs ─────────────────────────────────────────────────────────
//
// Lists immediate child directories at the given absolute path.
// Admin-only (enforced by shared middleware). Used by the backup destination
// browser in the settings UI.

dataRouter.get('/browse-dirs', (req, res) => {
  const rawPath =
    typeof req.query['path'] === 'string' ? req.query['path'].trim() : '/';

  const normalized = path.normalize(rawPath);

  if (!path.isAbsolute(normalized)) {
    res.status(400).json({ error: 'path must be absolute' });
    return;
  }

  // Belt-and-suspenders: after normalize, no segment should still be '..'
  if (normalized.split(path.sep).some(seg => seg === '..')) {
    res.status(400).json({ error: 'path traversal not allowed' });
    return;
  }

  try {
    // No existsSync pre-check: it answers false for a directory the server may not read (EACCES/EPERM), which turned a
    // permission failure into "not found". statSync throws the real errno, and the catch below answers it by what it is.
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'path is not a directory' });
      return;
    }

    const entries = fs.readdirSync(normalized, { withFileTypes: true });
    const dirs: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden entries
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        // Follow the symlink — useful for /mnt/* or volume-mount points
        try {
          const target = fs.statSync(path.join(normalized, entry.name));
          if (target.isDirectory()) dirs.push(entry.name);
        } catch {
          // Broken symlink — skip
        }
      }
    }

    dirs.sort();
    res.json({ path: normalized, dirs });
  } catch (err) {
    // A directory the file system will not show is not a malformed request: gone is `404`, not permitted is `403`, anything else is the
    // server's own fault (`500`, by what it is). All in our words — the runtime's message is not what the operator is told (Q-542).
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (isMissingPath(err)) { res.status(404).json({ error: 'That directory does not exist.' }); return; }
    if (code === 'EACCES' || code === 'EPERM') { res.status(403).json({ error: 'The server is not permitted to read that directory.' }); return; }
    sendCaughtFailure(res, 'GET /api/admin/data/browse-dirs', err);
  }
});

// ── PUT /backup-config ────────────────────────────────────────────────────────

dataRouter.put('/backup-config', requireAdminMfa, (req, res) => {
  if (!isDbMigrationEnabled()) {
    res.status(403).json({
      error:
        'Scheduled/offsite backup is disabled on this instance. ' +
        'Set YTHRIL_DB_MIGRATION_ENABLED=true to enable.',
      code: 'FEATURE_DISABLED',
    });
    return;
  }

  const parsed = BackupConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(refusalOfParse(parsed.error));
    return;
  }

  const cfg = parsed.data;

  // Security: offsite.destPath must be absolute
  if (cfg.offsite && !path.isAbsolute(cfg.offsite.destPath)) {
    res.status(400).json({ error: 'offsite.destPath must be an absolute path' });
    return;
  }

  // Snapshot before the write. This is a whole-document PUT, so the previous file IS the before-state;
  // the allowlist decides which of its fields may be recorded.
  req.auditSnapshots = { before: loadBackupConfig(), after: cfg };

  try {
    fs.mkdirSync(path.dirname(BACKUP_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(BACKUP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    /*
     * RE-ARM, or the schedule that was just saved does not exist.
     *
     * `startBackupScheduler` reads `backup.json` at call time and stops its own previous task first — its own
     * comment says "Stop any previously running task before (re-)scheduling" — and it was called exactly once,
     * from `bootstrap.ts`. So this route wrote the file, answered `{ ok: true }`, and the instance kept running
     * on the boot-time cron: a changed schedule was ignored, a cleared one kept firing, and an operator
     * ENABLING scheduled backups for the first time got a success response and no backups at all until a
     * restart. That is the worst shape this can take, because believing you have backups is worse than knowing
     * you do not.
     *
     * `api/networks/crud.ts` already does exactly this for a network's sync schedule — the same pattern, done
     * right in one place and missing here.
     */
    startBackupScheduler();
    res.json({ ok: true, config: cfg });
  } catch (err) {
    sendCaughtFailure(res, 'PUT /api/admin/data/backup-config', err, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /restore ─────────────────────────────────────────────────────────────
//
// A restore is a set of space acts (bundle-157, `db/restore-act.ts`): the backup is checked whole and the space set decided before
// anything is registered, then one `restore` act per served space is registered in one config write and the answer is 202. Every space
// is held and the instance is in maintenance from that write until the last act ends; GET /restore reports the progress and the outcome.

dataRouter.post('/restore', requireAdminMfa, async (req, res) => {
  const parsed = z.object({ backupId: z.string().min(1), leaveOut: z.array(z.string().min(1)).max(1000).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Body must be { backupId: string, leaveOut?: string[] }' });
    return;
  }

  // Prevent path traversal: backupId must be a bare directory name, no slashes
  const { backupId, leaveOut = [] } = parsed.data;
  if (!isBackupId(backupId)) {
    res.status(400).json({ error: 'Invalid backupId' });
    return;
  }

  const backupDir = backupDirOf(backupId);
  if (!backupDir) {
    res.status(404).json({ error: `Backup '${backupId}' not found` });
    return;
  }

  const standing = instanceWideActStanding();
  if (standing) {
    res.status(409).json(instanceWideActRefusal('restore', standing));
    return;
  }

  try {
    const plan = await planRestore(backupId, backupDir, leaveOut);
    if (!plan.ok) {
      res.status(400).json({
        error: `The backup holds space(s) this instance does not serve: ${plan.unserved.map(s => `'${s}'`).join(', ')}. They were renamed or `
          + 'deleted after the backup, so their data has no space to be restored into. Name them in leaveOut to restore without them.',
        code: 'backup_names_unserved_spaces', spaces: plan.unserved,
      });
      return;
    }
    const started = startRestore(plan);
    if (!started) {
      res.status(409).json(instanceWideActRefusal('restore', instanceWideActStanding() ?? 'restore'));
      return;
    }
    res.status(202).json(started);
  } catch (err) {
    if (err instanceof BackupNotWhole) {
      res.status(400).json({ error: `Backup '${backupId}' cannot be restored: ${err.message}.`, code: 'backup_not_whole' });
      return;
    }
    const closedAnswer = spaceActClosedAnswer(err);
    if (closedAnswer) { res.status(closedAnswer.status).json(closedAnswer.body); return; }
    sendCaughtFailure(res, `POST /api/admin/data/restore`, err, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /restore, GET /migrate ────────────────────────────────────────────────
//
// The set of that kind standing, or the last one, from ONE report (`spaces/act-set-report.ts`): per space its state (owed, running, done,
// <kind>_abandoned), attempts, our sentence for its last failure and what its body reported (a restore's index results, the backup a
// migrate went through), and the set's own `lastError` when a whole-set failure ended it. `{ restore: null }` / `{ migrate: null }` when
// none ever ran on this instance. A migrate's target URI is never in it.

const sendActSetReport = (kind: ReportedActSetKind): RequestHandler => (_req, res) => { res.json(actSetReport(kind)); };
dataRouter.get('/restore', requireAdminMfa, sendActSetReport('restore'));
dataRouter.get('/migrate', requireAdminMfa, sendActSetReport('migrate'));

// ── POST /restore/abandon, POST /migrate/abandon ──────────────────────────────
//
// End the standing set of that kind: the holds of its acts that have not completed lift in one write (and the maintenance it holds).
// A restore's released spaces keep whatever their acts reached and may be half restored; a migrate saves nothing, so the old database
// stays in use, and the new one may hold part of the copy (Q-564). One answer for both (`spaces/act-set-abandon.ts`): 200 with the
// released spaces, 404 `no_<kind>_standing`, 409 `<kind>_act_running` while a body runs (an abandon never cuts a body).

const sendActSetAbandon = (kind: ReportedActSetKind): RequestHandler => async (_req, res) => {
  try {
    const a = await abandonActSet(kind);
    res.status(a.status).json(a.body);
  } catch (err) {
    sendCaughtFailure(res, `POST /api/admin/data/${kind}/abandon`, err, { error: err instanceof Error ? err.message : String(err) });
  }
};
dataRouter.post('/restore/abandon', requireAdminMfa, sendActSetAbandon('restore'));
dataRouter.post('/migrate/abandon', requireAdminMfa, sendActSetAbandon('migrate'));

// ── POST /migrate ─────────────────────────────────────────────────────────────
//
// Move this instance to another database ONLINE (bundle-157, Q-553): after the refusals below, one `migrate` act per served space is
// registered in one config write and answered 202. The act set's one body dumps this database as a normal backup, restores it into the
// new URI and builds the indexes there; its completion saves the URI in the write that lifts the holds, and the process then ends so
// the next start connects to the new database (`db/migrate-act.ts`). Refused before anything is registered: a URI the environment
// supplies (`INFRA_MANAGED`: the infrastructure owns it), an act standing on every space, manual maintenance, a target that cannot be
// reached, and a target that already holds data (`target_not_empty`; never its collection names).
//
// In NODE_ENV=test the process is not ended; maintenance stays on after the completion.

dataRouter.post('/migrate', requireAdminMfa, async (req, res) => {
  // Guard: feature must be explicitly enabled by the infrastructure admin
  if (!isDbMigrationEnabled()) {
    res.status(403).json({
      error: 'Database migration is disabled on this instance. Set YTHRIL_DB_MIGRATION_ENABLED=true to enable.',
      code: 'FEATURE_DISABLED',
    });
    return;
  }

  // Guard: cannot migrate when the operator has explicitly locked out API-based migration.
  // Set YTHRIL_MONGO_INFRA_MANAGED=true in deployments where the MongoDB URI is
  // managed entirely through infrastructure config (e.g. K8s secrets / MONGO_URI env var)
  // and API-driven migration should be prevented regardless of admin credentials.
  if (process.env['YTHRIL_MONGO_INFRA_MANAGED'] === 'true') {
    res.status(409).json({
      error: 'Database migration via API is disabled on this instance. The MongoDB connection is marked as infra-managed (YTHRIL_MONGO_INFRA_MANAGED=true). Update the connection URI in your infrastructure configuration instead.',
      code: 'INFRA_MANAGED',
    });
    return;
  }

  // Guard: an act standing on every space (a restore, another migrate) answers with its own kind's code.
  const standing = instanceWideActStanding();
  if (standing) {
    res.status(409).json(instanceWideActRefusal('migrate', standing));
    return;
  }

  // Guard: cannot start migration while maintenance is already active
  if (isMaintenanceActive()) {
    res.status(409).json({
      error: 'Maintenance mode is already active. Deactivate it before starting a migration.',
    });
    return;
  }

  const validation = validateMongoUri(req.body?.uri);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const newUri = validation.uri;

  // Verify the new URI is reachable before committing to anything
  const connResult = await testConnection(newUri);
  if (!connResult.ok) {
    res.status(400).json({
      error: `Cannot reach the target database: ${connResult.error}`,
    });
    return;
  }

  // Guard: a URI the environment supplies is the infrastructure's. A migrate would save a config URI the environment then overrides,
  // so the instance would come back on the old database. An EMPTY MONGO_URI is unset (`effectiveMongoUri`), so it is not refused.
  if (effectiveMongoUri().source === 'env') {
    res.status(409).json({
      error: 'Database migration via API is not possible on this instance: the MongoDB URI comes from the MONGO_URI environment variable, which overrides the configured one. Change it in your infrastructure configuration instead.',
      code: 'INFRA_MANAGED',
    });
    return;
  }

  try {
    // Guard: the target is copied into, never merged with. Its contents are not named in the answer.
    if (await targetHoldsData(newUri)) {
      res.status(409).json({
        error: 'The target database already holds data. A migrate copies into an empty database only: empty it, or name another, and migrate again.',
        code: 'target_not_empty',
      });
      return;
    }
    const started = startMigrate(newUri);
    if (!started) {
      res.status(409).json(instanceWideActRefusal('migrate', instanceWideActStanding() ?? 'migrate'));
      return;
    }
    res.status(202).json(started);
  } catch (err) {
    const closed = spaceActClosedAnswer(err);
    if (closed) { res.status(closed.status).json(closed.body); return; }
    sendCaughtFailure(res, `POST /api/admin/data/migrate`, err);
  }
});
