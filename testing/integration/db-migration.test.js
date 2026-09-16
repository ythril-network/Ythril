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
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

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

/**
 * Ensure maintenance mode is off — and PROVE it, because this is global state.
 *
 * ## What the swallowed version cost
 *
 * This was `await adminPost(...).catch(() => {})`. The catch is the defect: maintenance mode makes the instance
 * answer **503 to everything**, so a cleanup that fails and says nothing does not lose one test — it poisons
 * every suite that runs after it in the same job. Measured 2026-08-20 while instrumenting X-20: one failed
 * cleanup under CPU contention, and then 60 consecutive `pubsub-topology` runs failed at `Create space on A`
 * with `503 System is in maintenance mode`. Sixty runs of a measurement, against a stack that could not answer.
 *
 * A swallow is right where the cost of being wrong is a missing log line. It is wrong here, where the cost is
 * every later suite reporting a catastrophic regression that is really a cleanup that did not run.
 *
 * ## So: retry, verify, and throw
 *
 * Retried because the failure mode observed was a request that did not get through under load, which is exactly
 * what a retry fixes. Verified with a GET rather than trusting the POST's own status, because "I asked" and "it
 * is off" are different claims and only the second one matters to the next suite. And it THROWS if it cannot,
 * so the suite that broke the instance is the suite that reports it.
 */
async function ensureMaintenanceOff() {
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      /*
       * The STATUS is checked, not just the absence of a throw. `reqJson` resolves for every response — it
       * returns `{status, body}` and never rejects on a 4xx/5xx — so a `try/catch` around it catches a dropped
       * connection and nothing else. A version that only caught exceptions would treat a 503 as success, which
       * is the same silence this function is being fixed for, one layer in.
       */
      const set = await adminPost('/api/admin/data/maintenance', { active: false });
      const check = await adminGet('/api/admin/data/maintenance');
      if (check.status === 200 && check.body?.active === false) return;
      last = `POST ${set.status}, GET ${check.status} active=${JSON.stringify(check.body?.active)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    // The instance may be saturated rather than broken; give it a moment before asking again.
    await new Promise(r => setTimeout(r, 250 * attempt));
  }
  throw new Error(
    `Could not turn maintenance mode off after 4 attempts (${last}). Refusing to exit quietly: this instance `
    + 'answers 503 to everything while maintenance is on, so leaving it set makes every later suite in this job '
    + 'fail for a reason that has nothing to do with what it tests.',
  );
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

  it('returns mongoUriRedacted with the credentials stripped', async () => {
    const r = await adminGet('/api/admin/data/config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const redacted = r.body.mongoUriRedacted;
    assert.ok(typeof redacted === 'string', 'mongoUriRedacted must be a string');
    assert.ok(redacted.startsWith('mongodb'), 'URI must start with mongodb');

    // Assert on the SECRET, not on the '@' delimiter.
    //
    // This test used to assert `!redacted.includes('@')`, which passed only because the
    // test database had no credentials at all — so the redaction path never actually ran.
    // `redactUri` rewrites `//user:pass@host` to `//[credentials]@host`, deliberately KEEPING
    // the '@' so the result is still a recognisable URI. The old assertion therefore tested
    // the fixture, not the redaction, and would have missed a leak of the real password.
    // The test stack now authenticates, so this exercises the real thing.
    assert.doesNotMatch(
      redacted, /ythril-test-pw/,
      `the password must never be returned; got: ${redacted}`,
    );
    assert.doesNotMatch(
      redacted, /\/\/[^/@]*:[^/@]*@/,
      `no user:pass pair may survive redaction; got: ${redacted}`,
    );
    if (redacted.includes('@')) {
      assert.match(redacted, /\/\/\[credentials\]@/, `credentials must be masked; got: ${redacted}`);
    }
  });

  it('returns 403 for non-admin token', async () => {
    // Create a standard token, use it, then revoke it
    const createR = await adminPost('/api/tokens', { name: `data-config-nonAdmin-${RUN_ID}`});
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
    const createR = await adminPost('/api/tokens', { name: `conn-test-nonAdmin-${RUN_ID}`});
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
    const createR = await adminPost('/api/tokens', { name: `maint-nonAdmin-${RUN_ID}`});
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
    const createR = await adminPost('/api/tokens', { name: `backup-nonAdmin-${RUN_ID}`});
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
    const createR = await adminPost('/api/tokens', { name: `backups-list-nonAdmin-${RUN_ID}`});
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
    const createR = await post(BASE, adminToken, '/api/brain/spaces/general/facts',
      { fact: memName, tags: ['restore-test'] });
    assert.equal(createR.status, 201, `seed fact: ${JSON.stringify(createR.body)}`);
    const memId = createR.body._id ?? createR.body.id;
    assert.ok(memId, 'memory must have an _id');

    // 2. Backup
    const backupR = await adminPost('/api/admin/data/backup', {});
    assert.equal(backupR.status, 200, `backup: ${JSON.stringify(backupR.body)}`);
    const backupId = backupR.body.backup.id;

    // 3. Delete the seeded memory
    const delR = await del(BASE, adminToken, `/api/brain/spaces/general/facts/${memId}`);
    assert.equal(delR.status, 204, `delete fact: ${JSON.stringify(delR.body)}`);

    // 4. Verify memory is gone
    const goneR = await reqJson(BASE, adminToken, `/api/brain/spaces/general/facts/${memId}`);
    assert.equal(goneR.status, 404, 'memory should be gone after delete');

    // 5. Restore from the backup (auto-manages maintenance)
    const restoreR = await adminPost('/api/admin/data/restore', { backupId });
    assert.equal(restoreR.status, 200, `restore: ${JSON.stringify(restoreR.body)}`);
    assert.equal(restoreR.body.ok, true, JSON.stringify(restoreR.body));

    // 6. Verify memory is back
    const backR = await reqJson(BASE, adminToken, `/api/brain/spaces/general/facts/${memId}`);
    assert.equal(backR.status, 200, `memory should be back after restore: ${JSON.stringify(backR.body)}`);
    const restoredFact = backR.body.fact ?? backR.body.content;
    assert.equal(restoredFact, memName, `memory content mismatch: ${JSON.stringify(backR.body)}`);

    // 7. Clean up — delete the test memory again
    await del(BASE, adminToken, `/api/brain/spaces/general/facts/${memId}`).catch(() => {});
  });

  it('restore with unknown backupId returns 404', async () => {
    const r = await adminPost('/api/admin/data/restore', { backupId: 'nonexistent-backup-id' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('restore returns 403 for non-admin', async () => {
    // First get a valid backupId
    const backupR = await adminPost('/api/admin/data/backup', {});
    const backupId = backupR.body.backup?.id;

    const createR = await adminPost('/api/tokens', { name: `restore-nonAdmin-${RUN_ID}`});
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
    const createR = await adminPost('/api/tokens', { name: `migrate-nonAdmin-${RUN_ID}`});
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
