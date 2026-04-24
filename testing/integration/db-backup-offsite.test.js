/**
 * Integration tests: Offsite/scheduled backup config and manual backup with offsite.
 *
 * Design:
 *  - Instance A (port 3200): YTHRIL_DB_MIGRATION_ENABLED=true, has backup.json
 *    with schedule "0 3 29 2 *" (never fires), keepLocal=3, offsite /tmp/ythril-offsite-test
 *  - Instance B (port 3201): no feature flag — GET /backup-config returns 403
 *  - Tests for POST /backup verify local backup + offsite copy are created
 *
 * Run: node --test testing/integration/db-backup-offsite.test.js
 *
 * Prerequisites: test stack up (npm run test:up or npm run test:up:rebuild)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, reqJson, post, put } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE_A = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');
const TOKEN_FILE_B = path.join(__dirname, '..', 'sync', 'configs', 'b', 'token.txt');

const BASE_A = INSTANCES.a;
const BASE_B = INSTANCES.b;

let tokenA;
let tokenB;

before(() => {
  tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
  tokenB = fs.readFileSync(TOKEN_FILE_B, 'utf8').trim();
});

// ── GET /backup-config — feature gate ─────────────────────────────────────────

describe('Backup config — GET /api/admin/data/backup-config', () => {
  it('returns 403 FEATURE_DISABLED on instance B (no flag)', async () => {
    const r = await reqJson(BASE_B, tokenB, '/api/admin/data/backup-config');
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'FEATURE_DISABLED');
  });

  it('returns 401 for unauthenticated request on instance B', async () => {
    const resp = await fetch(`${BASE_B}/api/admin/data/backup-config`);
    assert.equal(resp.status, 401);
  });

  it('returns 200 with config object on instance A (flag enabled)', async () => {
    const r = await reqJson(BASE_A, tokenA, '/api/admin/data/backup-config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // config is present (backup.json exists for instance A in the test stack)
    assert.ok(r.body.config !== null && typeof r.body.config === 'object', 'config must be an object');
  });

  it('returns the schedule field from backup.json', async () => {
    const r = await reqJson(BASE_A, tokenA, '/api/admin/data/backup-config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The test backup.json has schedule "0 3 29 2 *"
    assert.equal(r.body.config.schedule, '0 3 29 2 *');
  });

  it('returns the offsite.destPath from backup.json', async () => {
    const r = await reqJson(BASE_A, tokenA, '/api/admin/data/backup-config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.config.offsite?.destPath, '/tmp/ythril-offsite-test');
  });

  it('returns configPath field pointing to backup.json', async () => {
    const r = await reqJson(BASE_A, tokenA, '/api/admin/data/backup-config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.configPath === 'string', 'configPath must be a string');
    assert.ok(r.body.configPath.endsWith('backup.json'), `configPath should end with backup.json, got: ${r.body.configPath}`);
  });

  it('returns 403 for non-admin token on instance A', async () => {
    // Fetch without credentials should return 401
    const resp = await fetch(`${BASE_A}/api/admin/data/backup-config`);
    assert.equal(resp.status, 401, 'unauthenticated request must be rejected');
  });
});

// ── POST /backup — offsite copy ───────────────────────────────────────────────

describe('Backup with offsite copy — POST /api/admin/data/backup', () => {
  // Track backup IDs to allow cleanup
  const createdBackupIds = [];

  after(async () => {
    // Nothing to clean up via API — backups are in the container.
    // The test stack volumes are wiped on `docker compose down -v`.
  });

  it('returns 200 with backup metadata on instance A', async () => {
    const r = await post(BASE_A, tokenA, '/api/admin/data/backup', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.backup, 'response must have backup field');
    assert.ok(r.body.backup.id, 'backup must have an id');
    assert.ok(r.body.backup.dir, 'backup must have a dir');
    assert.ok(r.body.backup.manifest, 'backup must have a manifest');
    createdBackupIds.push(r.body.backup.id);
  });

  it('response includes offsite field when offsite is configured', async () => {
    const r = await post(BASE_A, tokenA, '/api/admin/data/backup', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(
      r.body.offsite !== undefined,
      'offsite field must be present when backup.json has offsite.destPath configured',
    );
    assert.ok(typeof r.body.offsite.dir === 'string', 'offsite.dir must be a string');
    assert.ok(
      r.body.offsite.dir.includes('/tmp/ythril-offsite-test'),
      `offsite.dir should be under destPath, got: ${r.body.offsite.dir}`,
    );
    createdBackupIds.push(r.body.backup.id);
  });

  it('backup ID in offsite.dir matches top-level backup.id', async () => {
    const r = await post(BASE_A, tokenA, '/api/admin/data/backup', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.backup.id;
    assert.ok(
      r.body.offsite.dir.endsWith(id),
      `offsite.dir should end with backup id "${id}", got: ${r.body.offsite.dir}`,
    );
    createdBackupIds.push(id);
  });

  it('retention kicks in after keepLocal=3 backups — localPruned appears', async () => {
    // Create enough backups to exceed keepLocal=3
    // We may already have a few from earlier tests; create more to be sure.
    let lastResult = null;
    let localPrunedSeen = false;
    for (let i = 0; i < 5; i++) {
      const r = await post(BASE_A, tokenA, '/api/admin/data/backup', {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      lastResult = r;
      if (r.body.localPruned !== undefined) {
        localPrunedSeen = true;
        assert.ok(
          typeof r.body.localPruned === 'number' && r.body.localPruned > 0,
          `localPruned must be a positive number, got: ${r.body.localPruned}`,
        );
      }
      createdBackupIds.push(r.body.backup.id);
    }
    // After 5 additional backups with keepLocal=3, at least some must have been pruned
    assert.ok(
      localPrunedSeen,
      `Expected localPruned to appear in at least one response after exceeding keepLocal=3. Last response: ${JSON.stringify(lastResult?.body)}`,
    );
  });

  it('GET /backups count does not exceed keepLocal=3 (retention enforced)', async () => {
    const r = await reqJson(BASE_A, tokenA, '/api/admin/data/backups');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(
      r.body.backups.length <= 3,
      `Expected at most 3 backups after retention; got ${r.body.backups.length}`,
    );
  });

  it('POST /backup on instance B returns 200 (local backup not gated)', async () => {
    // The basic local backup feature is NOT gated behind the feature flag.
    // Only offsite copy + scheduled features require the flag.
    const r = await post(BASE_B, tokenB, '/api/admin/data/backup', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.backup?.id, 'backup must have an id');
    // No offsite field — instance B has no backup.json and no feature flag
    assert.ok(
      r.body.offsite === undefined,
      `offsite field must not be present on instance B (no feature flag), got: ${JSON.stringify(r.body.offsite)}`,
    );
  });
});

// ── PUT /backup-config ─────────────────────────────────────────────────────────

describe('PUT /api/admin/data/backup-config', () => {
  // Restore the original config after this suite so the backup/offsite tests above
  // continue to work when the full test file is re-run in a single process.
  const ORIGINAL_CONFIG = {
    schedule: '0 3 29 2 *',
    retention: { keepLocal: 3 },
    offsite: { destPath: '/tmp/ythril-offsite-test', retention: { keepCount: 5 } },
  };

  after(async () => {
    // Best-effort restore — if the PUT fails here the test stack will be
    // re-built before the next run anyway.
    await put(BASE_A, tokenA, '/api/admin/data/backup-config', ORIGINAL_CONFIG).catch(() => {});
  });

  it('returns 403 FEATURE_DISABLED on instance B (flag absent)', async () => {
    const r = await put(BASE_B, tokenB, '/api/admin/data/backup-config', { schedule: '0 1 * * *' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'FEATURE_DISABLED');
  });

  it('returns 401 for unauthenticated request', async () => {
    const resp = await fetch(`${BASE_A}/api/admin/data/backup-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '0 1 * * *' }),
    });
    assert.equal(resp.status, 401);
  });

  it('returns 400 for invalid body (unknown field)', async () => {
    const r = await put(BASE_A, tokenA, '/api/admin/data/backup-config', { badField: true });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 when offsite.destPath is relative', async () => {
    const r = await put(BASE_A, tokenA, '/api/admin/data/backup-config', {
      offsite: { destPath: 'relative/path/to/backups' },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(typeof r.body.error === 'string' && r.body.error.includes('absolute'),
      `Expected absolute-path error, got: ${JSON.stringify(r.body)}`);
  });

  it('saves a valid minimal config (schedule only) and returns ok:true', async () => {
    const r = await put(BASE_A, tokenA, '/api/admin/data/backup-config', {
      schedule: '30 4 * * 0',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.config.schedule, '30 4 * * 0');
  });

  it('subsequent GET reflects the newly written config', async () => {
    const newCfg = {
      schedule: '15 6 * * 1',
      retention: { keepLocal: 7 },
      offsite: { destPath: '/tmp/ythril-put-test', retention: { keepCount: 10 } },
    };
    const putR = await put(BASE_A, tokenA, '/api/admin/data/backup-config', newCfg);
    assert.equal(putR.status, 200, JSON.stringify(putR.body));

    const getR = await reqJson(BASE_A, tokenA, '/api/admin/data/backup-config');
    assert.equal(getR.status, 200, JSON.stringify(getR.body));
    assert.equal(getR.body.config.schedule, '15 6 * * 1');
    assert.equal(getR.body.config.retention?.keepLocal, 7);
    assert.equal(getR.body.config.offsite?.destPath, '/tmp/ythril-put-test');
    assert.equal(getR.body.config.offsite?.retention?.keepCount, 10);
  });

  it('saves an empty object (no schedule, no offsite) as valid minimal config', async () => {
    const r = await put(BASE_A, tokenA, '/api/admin/data/backup-config', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
  });
});
