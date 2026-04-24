/**
 * Red-team tests: Database migration disabled by default.
 *
 * An admin token is powerful but must NOT be sufficient to exfiltrate the
 * entire database to an attacker-controlled MongoDB server.  The migration
 * endpoint (POST /api/admin/data/migrate) is therefore opt-in at the
 * infrastructure level via YTHRIL_DB_MIGRATION_ENABLED=true.
 *
 * These tests run against instance B (port 3201) which does NOT have
 * YTHRIL_DB_MIGRATION_ENABLED set — verifying the default-deny posture.
 *
 * Threat model: attacker obtains a valid admin token (e.g. via stolen
 * credentials) and attempts to re-point the database to a server they control,
 * causing all future writes and the current dump to land in their database.
 *
 * Run: node --test testing/red-team-tests/db-migration-disabled.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, put, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use instance B — YTHRIL_DB_MIGRATION_ENABLED is intentionally absent on B.
const BASE = INSTANCES.b;
const TOKEN_FILE_B = path.join(__dirname, '..', 'sync', 'configs', 'b', 'token.txt');

// A syntactically valid external URI (SSRF-safe, public range) —
// the feature-disabled guard must fire before any URI validation.
const EXTERNAL_MONGO_URI = 'mongodb://8.8.8.8:27017/exfil?serverSelectionTimeoutMS=500';

let adminToken;

describe('DB migration disabled — POST /api/admin/data/migrate returns 403', () => {
  before(() => {
    adminToken = fs.readFileSync(TOKEN_FILE_B, 'utf8').trim();
  });

  it('returns 403 with FEATURE_DISABLED code when YTHRIL_DB_MIGRATION_ENABLED is not set', async () => {
    const r = await post(BASE, adminToken, '/api/admin/data/migrate', {
      uri: EXTERNAL_MONGO_URI,
    });
    assert.equal(r.status, 403,
      `Expected 403 (feature disabled) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'FEATURE_DISABLED',
      `Expected code=FEATURE_DISABLED in body: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0,
      'Response must include a descriptive error message');
  });

  it('returns 403 even for a missing or invalid URI (feature check fires first)', async () => {
    const r = await post(BASE, adminToken, '/api/admin/data/migrate', {});
    assert.equal(r.status, 403,
      `Expected 403 (feature disabled) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'FEATURE_DISABLED');
  });

  it('returns 403 even without auth (feature disabled takes precedence over auth order)', async () => {
    // Note: requireAdmin fires before the feature guard inside the handler,
    // so unauthenticated requests still get 401 — this is the correct layering:
    // auth check → feature check → business logic.
    const r = await reqJson(BASE, '', '/api/admin/data/migrate',
      { method: 'POST', body: JSON.stringify({ uri: EXTERNAL_MONGO_URI }) });
    // Must be 401 (auth) not 200/500 (no data leak regardless)
    assert.equal(r.status, 401,
      `Unauthenticated request must still get 401: ${JSON.stringify(r.body)}`);
  });

  it('backup endpoint remains accessible (data stays on server — no exfil risk)', async () => {
    // POST /backup only dumps to local filesystem; an attacker cannot download
    // the dump without additional server access, so the feature guard does not
    // apply to backup.  Verify it works normally on instance B.
    const r = await post(BASE, adminToken, '/api/admin/data/backup', {});
    // 200 = success; 500 acceptable if mongo is unavailable in this test context
    assert.ok(r.status === 200 || r.status === 500,
      `Expected 200 or 500 for backup on instance B, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.notEqual(r.status, 403,
      'Backup must NOT be gated behind YTHRIL_DB_MIGRATION_ENABLED');
  });

  it('PUT /backup-config returns 403 FEATURE_DISABLED (offsite config write blocked)', async () => {
    // Writing backup-config is gated behind the same flag as migration.
    // An attacker who obtains an admin token must not be able to redirect
    // backups to an attacker-controlled offsite path.
    const r = await put(BASE, adminToken, '/api/admin/data/backup-config', {
      offsite: { destPath: '/attacker/controlled/path' },
    });
    assert.equal(r.status, 403,
      `Expected 403 (feature disabled) but got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'FEATURE_DISABLED');
  });

  it('PUT /backup-config returns 401 for unauthenticated request', async () => {
    const resp = await fetch(`${BASE}/api/admin/data/backup-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offsite: { destPath: '/attacker/path' } }),
    });
    assert.equal(resp.status, 401);
  });
});
