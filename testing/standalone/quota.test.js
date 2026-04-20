/**
 * Integration tests: Storage quota enforcement
 *
 * Covers:
 *  - No storage config → writes always succeed (quota disabled)
 *  - Files hard limit: POST /api/files returns 507 when limit already exceeded
 *  - Brain hard limit: POST /api/brain/:spaceId/memories returns 507 when limit exceeded
 *  - Soft limit: write succeeds with storageWarning:true in response
 *  - GET /api/spaces includes storage usage when quota configured
 *  - Config restored to original state after each test
 *
 * These tests temporarily patch config.json on instance A (port 3200) then
 * call POST /api/admin/reload-config to pick up the changes without a restart.
 *
 * Detects which compose setup is active:
 *  - Test stack:  tests/sync/configs/a/config.json  (docker-compose.test.yml)
 *  - Dev stack:   config/config.json                (docker-compose.yml)
 *
 * Run: node --test testing/quota.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Detect which config file is active for instance A (port 3200)
const CANDIDATE_CONFIGS = [
  path.join(__dirname, '..', 'sync', 'configs', 'a', 'config.json'), // test stack
  path.join(__dirname, '..', 'config', 'config.json'),          // dev stack
];
const CONFIG_FILE = CANDIDATE_CONFIGS.find(p => fs.existsSync(p)) ?? null;
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

// On Linux CI the container's node user (uid 1000) owns config.json (mode 0600).
// The runner (uid 1001) cannot read or write it directly — use docker exec instead.
const USE_DOCKER_EXEC = process.platform !== 'win32' && CONFIG_FILE?.includes(path.join('sync', 'configs'));
const CONTAINER_A = 'ythril-a';

let token;
let originalConfig;

// ── Helpers ──────────────────────────────────────────────────────────────────

function readConfig() {
  if (USE_DOCKER_EXEC) {
    return JSON.parse(execSync(`docker exec ${CONTAINER_A} cat /config/config.json`).toString('utf8'));
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(cfg) {
  if (USE_DOCKER_EXEC) {
    const json = JSON.stringify(cfg, null, 2);
    execSync(
      `docker exec -i ${CONTAINER_A} sh -c 'cat > /config/config.json && chmod 600 /config/config.json'`,
      { input: json },
    );
    return;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
}

/** Write config to disk then signal instance A to reload it via admin endpoint. */
async function applyConfig(cfg) {
  writeConfig(cfg);
  const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
  assert.equal(r.status, 200, `reload-config failed: ${JSON.stringify(r.body)}`);
}

async function uploadFile(t, filePath, content = 'hello quota test') {
  const url = `${INSTANCES.a}/api/files/general?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${t}`,
    },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function writeMemory(t, fact = 'quota test memory') {
  return post(INSTANCES.a, t, '/api/brain/general/memories', { fact });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Storage quota enforcement', () => {
  before(async () => {
    if (!CONFIG_FILE) {
      throw new Error(
        'No config.json found for instance A.\n' +
        'Expected one of:\n' +
        CANDIDATE_CONFIGS.map(p => `  ${p}`).join('\n') + '\n' +
        'Ensure the instance is running and configured.',
      );
    }
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalConfig = readConfig();
  });

  after(async () => {
    // Always restore original config, even if tests fail
    if (CONFIG_FILE && originalConfig) {
      await applyConfig(originalConfig);
    }
  });

  // ── No quota configured ───────────────────────────────────────────────────

  it('No storage config → file write succeeds without storageWarning', async () => {
    const cfg = { ...originalConfig };
    delete cfg.storage;
    await applyConfig(cfg);

    const r = await uploadFile(token, `quota-test-no-limit-${Date.now()}.txt`);
    assert.equal(r.status, 201, `Expected 201 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(!r.body?.storageWarning, 'storageWarning must be absent when quota not configured');
  });

  it('No storage config → memory write succeeds without storageWarning', async () => {
    const cfg = { ...originalConfig };
    delete cfg.storage;
    await applyConfig(cfg);

    const r = await writeMemory(token, `quota-test-no-limit-${Date.now()}`);
    assert.equal(r.status, 201, `Expected 201 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(!r.body?.storageWarning, 'storageWarning must be absent when quota not configured');
  });

  // ── Hard limit: reject ────────────────────────────────────────────────────

  it('Files hard limit exceeded → POST /api/files returns 507', async () => {
    // hardLimitGiB:0 guarantees the already-used bytes exceed the limit
    await applyConfig({ ...originalConfig, storage: { files: { softLimitGiB: 0, hardLimitGiB: 0 } } });

    const r = await uploadFile(token, `quota-hard-files-${Date.now()}.txt`);
    assert.equal(r.status, 507, `Expected 507 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.storageExceeded, 'storageExceeded flag required in 507 body');
    assert.ok(typeof r.body?.error === 'string', 'error message required');
  });

  it('Brain hard limit exceeded → POST /api/brain/.../memories returns 507', async () => {
    await applyConfig({ ...originalConfig, storage: { brain: { softLimitGiB: 0, hardLimitGiB: 0 } } });

    const r = await writeMemory(token, `quota-hard-brain-${Date.now()}`);
    assert.equal(r.status, 507, `Expected 507 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.storageExceeded, 'storageExceeded flag required in 507 body');
    assert.ok(typeof r.body?.error === 'string', 'error message required');
  });

  it('Total hard limit exceeded → file write returns 507', async () => {
    await applyConfig({ ...originalConfig, storage: { total: { softLimitGiB: 0, hardLimitGiB: 0 } } });

    const r = await uploadFile(token, `quota-hard-total-${Date.now()}.txt`);
    assert.equal(r.status, 507, `Expected 507 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.storageExceeded);
  });

  // ── Soft limit: warn but allow ────────────────────────────────────────────

  it('Files soft limit breached → write succeeds with storageWarning:true', async () => {
    // softLimitGiB:0 so current usage already exceeds it; hard limit is huge
    await applyConfig({ ...originalConfig, storage: { files: { softLimitGiB: 0, hardLimitGiB: 9999 } } });

    const r = await uploadFile(token, `quota-soft-files-${Date.now()}.txt`);
    assert.equal(r.status, 201, `Expected 201 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.storageWarning, true, 'storageWarning must be true when soft limit exceeded');
  });

  it('Brain soft limit breached → memory write succeeds with storageWarning:true', async () => {
    await applyConfig({ ...originalConfig, storage: { brain: { softLimitGiB: 0, hardLimitGiB: 9999 } } });

    const r = await writeMemory(token, `quota-soft-brain-${Date.now()}`);
    assert.equal(r.status, 201, `Expected 201 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.storageWarning, true, 'storageWarning must be true when soft limit exceeded');
  });

  // ── GET /api/spaces includes usage ────────────────────────────────────────

  it('GET /api/spaces includes storage usage when quota configured', async () => {
    await applyConfig({ ...originalConfig, storage: { total: { softLimitGiB: 100, hardLimitGiB: 200 } } });

    const r = await get(INSTANCES.a, token, '/api/spaces');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body?.storage, 'storage field must be present when quota configured');
    assert.ok(typeof r.body.storage.usageGiB?.files === 'number', 'usageGiB.files must be a number');
    assert.ok(typeof r.body.storage.usageGiB?.brain === 'number', 'usageGiB.brain must be a number');
    assert.ok(typeof r.body.storage.usageGiB?.total === 'number', 'usageGiB.total must be a number');
  });

  it('GET /api/spaces omits storage when no quota configured', async () => {
    const cfg = { ...originalConfig };
    delete cfg.storage;
    await applyConfig(cfg);

    const r = await get(INSTANCES.a, token, '/api/spaces');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body?.storage, 'storage field must be absent when quota not configured');
  });
});
