/**
 * Admin data management API.
 *
 * Routes (all require admin; most require MFA where enabled):
 *
 *   GET    /api/admin/data/config           — current Mongo URI source + redacted URI
 *   POST   /api/admin/data/config/test      — test a MongoDB connection string
 *   GET    /api/admin/data/maintenance      — maintenance mode status
 *   POST   /api/admin/data/maintenance      — toggle maintenance mode
 *   POST   /api/admin/data/backup           — trigger a manual backup (dump)
 *   GET    /api/admin/data/backups          — list existing backups
 *   POST   /api/admin/data/restore          — restore from a named backup
 *   POST   /api/admin/data/migrate          — full DB migration (dump → marker → exit)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { getConfig, getMongoUri, saveConfig, getDataRoot } from '../config/loader.js';
import { requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { isMaintenanceActive, setMaintenanceActive } from '../maintenance.js';
import { dumpDatabase } from '../db/dump.js';
import { restoreDatabase } from '../db/restore.js';
import { testConnection } from '../db/conn-test.js';
import { isSsrfSafeMongoUri } from '../util/ssrf.js';
import { log } from '../util/log.js';

export const dataRouter = Router();

// ── Shared middleware ─────────────────────────────────────────────────────────

dataRouter.use(globalRateLimit, requireAdmin);

// ── Helpers ───────────────────────────────────────────────────────────────────

function backupsRoot(): string {
  return path.join(getDataRoot(), 'backups');
}

function migrationBackupRoot(): string {
  return path.join(getDataRoot(), 'migration-backup');
}

function migrationMarkerPath(): string {
  return path.join(getDataRoot(), 'migration-marker.json');
}

/** Derive the URI source: env var > config file > built-in default. */
function getMongoUriSource(): 'env' | 'config' | 'default' {
  if (process.env['MONGO_URI']) return 'env';
  const cfg = getConfig();
  if (cfg.mongo?.uri) return 'config';
  return 'default';
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@]+@/, '//[credentials]@');
}

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
    const source = getMongoUriSource();
    const mongoUriRedacted = redactUri(getMongoUri());
    res.json({ source, mongoUriRedacted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
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
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /maintenance ──────────────────────────────────────────────────────────

dataRouter.get('/maintenance', (_req, res) => {
  res.json({ active: isMaintenanceActive() });
});

// ── POST /maintenance ─────────────────────────────────────────────────────────

dataRouter.post('/maintenance', requireAdminMfa, (req, res) => {
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Body must be { active: boolean }' });
    return;
  }
  setMaintenanceActive(parsed.data.active);
  res.json({ active: parsed.data.active });
});

// ── POST /backup ──────────────────────────────────────────────────────────────

dataRouter.post('/backup', requireAdminMfa, async (_req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = path.join(backupsRoot(), ts);

  try {
    const manifest = await dumpDatabase(getMongoUri(), destDir);
    res.json({ backup: { id: ts, dir: destDir, manifest } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`POST /api/admin/data/backup: ${err}`);
    res.status(500).json({ error: msg });
  }
});

// ── GET /backups ──────────────────────────────────────────────────────────────

dataRouter.get('/backups', (_req, res) => {
  try {
    const backups = listBackups();
    res.json({ backups });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── POST /restore ─────────────────────────────────────────────────────────────

dataRouter.post('/restore', requireAdminMfa, async (req, res) => {
  const parsed = z.object({ backupId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Body must be { backupId: string }' });
    return;
  }

  // Prevent path traversal: backupId must be a bare directory name, no slashes
  const { backupId } = parsed.data;
  if (backupId.includes('/') || backupId.includes('\\') || backupId.includes('..')) {
    res.status(400).json({ error: 'Invalid backupId' });
    return;
  }

  const backupDir = path.join(backupsRoot(), backupId);
  if (!fs.existsSync(backupDir) || !fs.existsSync(path.join(backupDir, 'manifest.json'))) {
    res.status(404).json({ error: `Backup '${backupId}' not found` });
    return;
  }

  // Auto-manage maintenance: activate → restore → deactivate
  const wasMaintenance = isMaintenanceActive();
  setMaintenanceActive(true);
  try {
    await restoreDatabase(getMongoUri(), backupDir);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`POST /api/admin/data/restore: ${err}`);
    res.status(500).json({ error: msg });
  } finally {
    setMaintenanceActive(wasMaintenance);
  }
});

// ── POST /migrate ─────────────────────────────────────────────────────────────
//
// Full database migration:
//   1. Validate + test the new URI
//   2. Enter maintenance mode
//   3. Dump current DB
//   4. Write migration marker (old URI, new URI, backup dir)
//   5. Persist new URI to config.json
//   6. Respond 200 to the client
//   7. Exit (Docker/K8s restart policy brings the container back)
//
// On restart, index.ts detects the marker and runs restoreDatabase() against
// the new URI before calling connectMongo().
//
// In NODE_ENV=test: steps 4-5 run but step 7 (process.exit) is skipped so the
// test suite remains connected. Maintenance stays active — tests must clean up.

dataRouter.post('/migrate', requireAdminMfa, async (req, res) => {
  // Guard: feature must be explicitly enabled by the infrastructure admin
  if (!isDbMigrationEnabled()) {
    res.status(403).json({
      error: 'Database migration is disabled on this instance. Set YTHRIL_DB_MIGRATION_ENABLED=true to enable.',
      code: 'FEATURE_DISABLED',
    });
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

  // Step 1: verify the new URI is reachable before committing to anything
  const connResult = await testConnection(newUri);
  if (!connResult.ok) {
    res.status(400).json({
      error: `Cannot reach the target database: ${connResult.error}`,
    });
    return;
  }

  // Step 2: enter maintenance mode — quiesces all writes
  setMaintenanceActive(true);

  try {
    // Step 3: dump current DB
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(migrationBackupRoot(), ts);
    const manifest = await dumpDatabase(getMongoUri(), backupDir);

    // Step 4: write migration marker (used by startup hook on next boot)
    const oldUri = getMongoUri();
    const marker = {
      oldUri,
      newUri,
      backupDir,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(migrationMarkerPath(), JSON.stringify(marker, null, 2), 'utf8');

    // Step 5: persist the new URI to config.json
    const cfg = getConfig();
    cfg.mongo = { ...cfg.mongo, uri: newUri };
    saveConfig(cfg);

    // Step 6: respond before we exit
    res.json({ ok: true, backupDir, manifest });

    // Step 7: exit so the container restarts with the new config
    // In NODE_ENV=test we skip the exit so the test suite stays alive.
    if (process.env['NODE_ENV'] !== 'test') {
      log.info('migrate: restarting to connect to new database…');
      setTimeout(() => process.exit(0), 200);
    } else {
      log.warn('migrate: NODE_ENV=test — skipping process.exit(); maintenance remains active');
    }
  } catch (err) {
    // Roll back maintenance mode on failure — the DB state is unchanged
    setMaintenanceActive(false);
    // If the marker was written before the error, clean it up
    try { if (fs.existsSync(migrationMarkerPath())) fs.unlinkSync(migrationMarkerPath()); } catch { /* best-effort */ }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`POST /api/admin/data/migrate: ${err}`);
    res.status(500).json({ error: msg });
  }
});
