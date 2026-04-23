/**
 * Integration tests: Data management — config, connection test, maintenance mode,
 * backup/restore, and database migration.
 *
 * Design:
 *  - All tests run against instance A (port 3200).
 *  - The round-trip backup/restore test is self-cleaning: it seeds data, backs up,
 *    deletes, restores, verifies, then cleans up — leaving instance state unchanged.
 *  - Migration tests validate up to the dump+marker phase only (no actual restart in CI).
 *    In NODE_ENV=test the server skips process.exit() — maintenance must be manually
 *    deactivated after the test.
 *
 * Run: node --test testing/integration/db-migration.test.js
 *
 * Prerequisites: test stack up (npm run test:up or npm run test:up:rebuild)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, get, post, del, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const BASE = INSTANCES.a;
const RUN_ID = Date.now();

// URI the test instance already uses — should succeed
const CURRENT_MONGO_URI = 'mongodb://ythril-mongo-a:27017/?directConnection=true';
// URI that will never be reachable — must fail quickly
const BAD_MONGO_URI = 'mongodb://nonexistent-host-xyzabc123:27017/?serverSelectionTimeoutMS=1000&connectTimeoutMS=1000';

let adminToken;

// ── helpers ──────────────────────────────────────────────────────────────────

async function adminGet(path_) {
  return reqJson(BASE, adminToken, path_);
}

async function adminPost(path_, body) {
  return post(BASE, adminToken, path_, body);
}

async function adminDel(path_) {
  return del(BASE, adminToken, path_);
}

/** Ensure maintenance mode is off — used in cleanup hooks */
async function ensureMaintenanceOff() {
  await adminPost('/api/admin/data/maintenance', { active: false }).catch(() => {});
}

// ── Data Config ───────────────────────────────────────────────────────────────

describe('Data Config — GET /api/admin/data/config', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('returns source field (env | config | default)', async () => {
    const r = await adminGet('/api/admin/data/config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(['env', 'config', 'default'].includes(r.body.source), `unexpected source: ${r.body.source}`);
  });

  it('returns mongoUriRedacted (no credentials in string)', async () => {
    const r = await adminGet('/api/admin/data/config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.mongoUriRedacted === 'string', 'mongoUriRedacted must be a string');
    assert.ok(r.body.mongoUriRedacted.startsWith('mongodb'), 'URI must start with mongodb');
    // Must not contain credentials (anything between // and @)
    assert.ok(!r.body.mongoUriRedacted.includes('@'), 'redacted URI must not contain @');
  });

  it('returns 403 for non-admin token', async () => {
    // Create a standard token, use it, then revoke it
    const createR = await adminPost('/api/tokens', { name: `data-config-nonAdmin-${RUN_ID}`, admin: false });
    assert.equal(createR.status, 201, JSON.stringify(createR.body));
    const stdToken = createR.body.plaintext;
    const tokenId  = createR.body.token.id;

    const r = await reqJson(BASE, stdToken, '/api/admin/data/config');
    assert.equal(r.status, 403, JSON.stringify(r.body));

    await adminDel(`/api/tokens/${tokenId}`).catch(() => {});
  });

  it('returns 401 with no auth', async () => {
    const r = await reqJson(BASE, '', '/api/admin/data/config');
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });
});

// ── Connection Test ───────────────────────────────────────────────────────────

describe('Connection Test — POST /api/admin/data/config/test', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('returns ok:true for the current active URI', async () => {
    const r = await adminPost('/api/admin/data/config/test', { uri: CURRENT_MONGO_URI });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(!r.body.error, 'error must not be set for successful connection');
  });

  it('returns ok:false for an unreachable URI', async () => {
    const r = await adminPost('/api/admin/data/config/test', { uri: BAD_MONGO_URI });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false, JSON.stringify(r.body));
    assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0, 'error string must be present');
  });

  it('returns 400 for a non-mongodb URI scheme', async () => {
    const r = await adminPost('/api/admin/data/config/test', { uri: 'http://localhost/fake' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error, 'error must be present');
  });

  it('returns 400 for missing uri field', async () => {
    const r = await adminPost('/api/admin/data/config/test', {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 403 for non-admin token', async () => {
    const createR = await adminPost('/api/tokens', { name: `conn-test-nonAdmin-${RUN_ID}`, admin: false });
    assert.equal(createR.status, 201);
    const stdToken = createR.body.plaintext;
    const tokenId  = createR.body.token.id;

    const r = await reqJson(BASE, stdToken, '/api/admin/data/config/test',
      { method: 'POST', body: JSON.stringify({ uri: CURRENT_MONGO_URI }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));

    await adminDel(`/api/tokens/${tokenId}`).catch(() => {});
  });

  it('returns 401 with no auth', async () => {
    const r = await reqJson(BASE, '', '/api/admin/data/config/test',
      { method: 'POST', body: JSON.stringify({ uri: CURRENT_MONGO_URI }) });
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });
});

// ── Maintenance Mode ──────────────────────────────────────────────────────────

describe('Maintenance Mode', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    // Always clean up — ensure maintenance is off after this suite
    await ensureMaintenanceOff();
  });

  it('GET /api/admin/data/maintenance returns { active: false } initially', async () => {
    await ensureMaintenanceOff(); // ensure clean state
    const r = await adminGet('/api/admin/data/maintenance');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.active, false, JSON.stringify(r.body));
  });

  it('activating maintenance returns 200 { active: true }', async () => {
    const r = await adminPost('/api/admin/data/maintenance', { active: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.active, true, JSON.stringify(r.body));
  });

  it('GET confirms maintenance is now active', async () => {
    const r = await adminGet('/api/admin/data/maintenance');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.active, true, JSON.stringify(r.body));
  });

  it('non-admin API requests return 503 with maintenance:true during maintenance', async () => {
    // GET /api/about requires auth but is not an admin endpoint
    const r = await reqJson(BASE, adminToken, '/api/about');
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.maintenance, true, JSON.stringify(r.body));
  });

  it('/health is not blocked during maintenance', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
  });

  it('/ready is not blocked during maintenance', async () => {
    const r = await fetch(`${BASE}/ready`);
    // 200 or 503 (service check), but NOT a maintenance 503
    const body = await r.json();
    assert.ok(
      body.maintenance !== true,
      `ready should not be a maintenance 503, got: ${JSON.stringify(body)}`,
    );
  });

  it('admin endpoints (/api/admin/*) are not blocked during maintenance', async () => {
    // GET /api/admin/data/maintenance itself should still work
    const r = await adminGet('/api/admin/data/maintenance');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('deactivating maintenance returns 200 { active: false }', async () => {
    const r = await adminPost('/api/admin/data/maintenance', { active: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.active, false, JSON.stringify(r.body));
  });

  it('requests pass through after maintenance is deactivated', async () => {
    const r = await reqJson(BASE, adminToken, '/api/about');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('returns 403 for non-admin trying to toggle maintenance', async () => {
    const createR = await adminPost('/api/tokens', { name: `maint-nonAdmin-${RUN_ID}`, admin: false });
    assert.equal(createR.status, 201);
    const stdToken = createR.body.plaintext;
    const tokenId  = createR.body.token.id;

    const r = await reqJson(BASE, stdToken, '/api/admin/data/maintenance',
      { method: 'POST', body: JSON.stringify({ active: true }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));

    await adminDel(`/api/tokens/${tokenId}`).catch(() => {});
  });

  it('returns 401 with no auth', async () => {
    const r = await reqJson(BASE, '', '/api/admin/data/maintenance',
      { method: 'POST', body: JSON.stringify({ active: true }) });
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });
});

// ── Manual Backup ─────────────────────────────────────────────────────────────

describe('Manual Backup — POST /api/admin/data/backup', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('returns 200 with backup metadata and manifest', async () => {
    const r = await adminPost('/api/admin/data/backup', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.backup, 'backup object must be present');
    assert.ok(typeof r.body.backup.id === 'string', 'backup.id must be a string');
    assert.ok(typeof r.body.backup.dir === 'string', 'backup.dir must be a string');
    assert.ok(r.body.backup.manifest, 'backup.manifest must be present');
    assert.ok(Array.isArray(r.body.backup.manifest.collections), 'manifest.collections must be an array');
    assert.ok(typeof r.body.backup.manifest.createdAt === 'string', 'manifest.createdAt must be a string');
  });

  it('returns 403 for non-admin', async () => {
    const createR = await adminPost('/api/tokens', { name: `backup-nonAdmin-${RUN_ID}`, admin: false });
    assert.equal(createR.status, 201);
    const stdToken = createR.body.plaintext;
    const tokenId  = createR.body.token.id;

    const r = await reqJson(BASE, stdToken, '/api/admin/data/backup',
      { method: 'POST', body: JSON.stringify({}) });
    assert.equal(r.status, 403, JSON.stringify(r.body));

    await adminDel(`/api/tokens/${tokenId}`).catch(() => {});
  });

  it('returns 401 with no auth', async () => {
    const r = await reqJson(BASE, '', '/api/admin/data/backup',
      { method: 'POST', body: JSON.stringify({}) });
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });
});

describe('Backups list — GET /api/admin/data/backups', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('returns 200 with backups array (at least one after POST /backup)', async () => {
    // Ensure at least one backup exists
    await adminPost('/api/admin/data/backup', {});

    const r = await adminGet('/api/admin/data/backups');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.backups), 'backups must be an array');
    assert.ok(r.body.backups.length >= 1, 'at least one backup must be listed');

    const first = r.body.backups[0];
    assert.ok(typeof first.id === 'string', 'backup.id must be a string');
    assert.ok(typeof first.createdAt === 'string', 'backup.createdAt must be a string');
    assert.ok(Array.isArray(first.collections), 'backup.collections must be an array');
  });

  it('returns 403 for non-admin', async () => {
    const createR = await adminPost('/api/tokens', { name: `backups-list-nonAdmin-${RUN_ID}`, admin: false });
    assert.equal(createR.status, 201);
    const stdToken = createR.body.plaintext;
    const tokenId  = createR.body.token.id;

    const r = await reqJson(BASE, stdToken, '/api/admin/data/backups');
    assert.equal(r.status, 403, JSON.stringify(r.body));

    await adminDel(`/api/tokens/${tokenId}`).catch(() => {});
  });
});

// ── Backup + Restore Round-Trip ───────────────────────────────────────────────

describe('Backup + Restore — round-trip', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    await ensureMaintenanceOff();
  });

  it('backup → delete data → restore → data is back', async () => {
    // 1. Seed a uniquely-named memory
    const memName = `restore-test-memory-${RUN_ID}`;
    const createR = await post(BASE, adminToken, '/api/brain/general/memories',
      { fact: memName, tags: ['restore-test'] });
    assert.equal(createR.status, 201, `seed memory: ${JSON.stringify(createR.body)}`);
    const memId = createR.body._id ?? createR.body.id;
    assert.ok(memId, 'memory must have an _id');

    // 2. Backup
    const backupR = await adminPost('/api/admin/data/backup', {});
    assert.equal(backupR.status, 200, `backup: ${JSON.stringify(backupR.body)}`);
    const backupId = backupR.body.backup.id;

    // 3. Delete the seeded memory
    const delR = await del(BASE, adminToken, `/api/brain/general/memories/${memId}`);
    assert.equal(delR.status, 204, `delete memory: ${JSON.stringify(delR.body)}`);

    // 4. Verify memory is gone
    const goneR = await reqJson(BASE, adminToken, `/api/brain/general/memories/${memId}`);
    assert.equal(goneR.status, 404, 'memory should be gone after delete');

    // 5. Restore from the backup (auto-manages maintenance)
    const restoreR = await adminPost('/api/admin/data/restore', { backupId });
    assert.equal(restoreR.status, 200, `restore: ${JSON.stringify(restoreR.body)}`);
    assert.equal(restoreR.body.ok, true, JSON.stringify(restoreR.body));

    // 6. Verify memory is back
    const backR = await reqJson(BASE, adminToken, `/api/brain/general/memories/${memId}`);
    assert.equal(backR.status, 200, `memory should be back after restore: ${JSON.stringify(backR.body)}`);
    const restoredFact = backR.body.fact ?? backR.body.content;
    assert.equal(restoredFact, memName, `memory content mismatch: ${JSON.stringify(backR.body)}`);

    // 7. Clean up — delete the test memory again
    await del(BASE, adminToken, `/api/brain/general/memories/${memId}`).catch(() => {});
  });

  it('restore with unknown backupId returns 404', async () => {
    const r = await adminPost('/api/admin/data/restore', { backupId: 'nonexistent-backup-id' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('restore returns 403 for non-admin', async () => {
    // First get a valid backupId
    const backupR = await adminPost('/api/admin/data/backup', {});
    const backupId = backupR.body.backup?.id;

    const createR = await adminPost('/api/tokens', { name: `restore-nonAdmin-${RUN_ID}`, admin: false });
    const stdToken = createR.body.plaintext;
    const tokenId  = createR.body.token.id;

    const r = await reqJson(BASE, stdToken, '/api/admin/data/restore',
      { method: 'POST', body: JSON.stringify({ backupId }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));

    await adminDel(`/api/tokens/${tokenId}`).catch(() => {});
  });
});

// ── Migration Auth Guards ─────────────────────────────────────────────────────

describe('Migration — POST /api/admin/data/migrate (auth + validation)', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  after(async () => {
    // If any test left maintenance on, turn it off
    await ensureMaintenanceOff();
  });

  it('returns 403 for non-admin', async () => {
    const createR = await adminPost('/api/tokens', { name: `migrate-nonAdmin-${RUN_ID}`, admin: false });
    const stdToken = createR.body.plaintext;
    const tokenId  = createR.body.token.id;

    const r = await reqJson(BASE, stdToken, '/api/admin/data/migrate',
      { method: 'POST', body: JSON.stringify({ uri: CURRENT_MONGO_URI }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));

    await adminDel(`/api/tokens/${tokenId}`).catch(() => {});
  });

  it('returns 401 with no auth', async () => {
    const r = await reqJson(BASE, '', '/api/admin/data/migrate',
      { method: 'POST', body: JSON.stringify({ uri: CURRENT_MONGO_URI }) });
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });

  it('returns 400 for invalid URI scheme (not mongodb)', async () => {
    const r = await adminPost('/api/admin/data/migrate', { uri: 'http://some-host/db' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error, 'error must be present');
  });

  it('returns 400 for missing uri', async () => {
    const r = await adminPost('/api/admin/data/migrate', {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for unreachable URI (connection test fails before migration starts)', async () => {
    const r = await adminPost('/api/admin/data/migrate', { uri: BAD_MONGO_URI });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error, 'error must describe the connection failure');
  });

  it('in test mode: migrate to current URI runs dump+marker without restart', async () => {
    // NODE_ENV=test: server skips process.exit(); maintenance must be cleaned up after
    const r = await adminPost('/api/admin/data/migrate', { uri: CURRENT_MONGO_URI });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.backupDir, 'backupDir must be present in response');
    assert.ok(r.body.manifest, 'manifest must be present in response');

    // Maintenance was activated during migration — clean up
    await ensureMaintenanceOff();
  });

  it('returns 409 when maintenance mode is already active', async () => {
    // Activate maintenance first
    await adminPost('/api/admin/data/maintenance', { active: true });

    const r = await adminPost('/api/admin/data/migrate', { uri: CURRENT_MONGO_URI });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.ok(r.body.error, 'error must explain maintenance conflict');

    await ensureMaintenanceOff();
  });
});
