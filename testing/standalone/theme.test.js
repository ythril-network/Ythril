/**
 * Standalone tests: GET /api/theme — external theming endpoint
 *
 * Covers:
 *  - Endpoint is accessible without authentication (pre-login)
 *  - Returns { cssUrl: null } when no theme configured
 *  - Returns { cssUrl: "..." } when theme.cssUrl is set in config
 *  - Restores original config after test
 *  - Security headers are present on theme responses
 *
 * Run: node --test testing/standalone/theme.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_CONFIGS = [
  path.join(__dirname, '..', 'sync', 'configs', 'a', 'config.json'),
  path.join(__dirname, '..', '..', 'config', 'config.json'),
];
const CONFIG_FILE = CANDIDATE_CONFIGS.find(p => fs.existsSync(p)) ?? null;
const TOKEN_FILE  = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

// On Linux CI the container's node user (uid 1000) owns config.json (mode 0600).
// The runner (uid 1001) cannot read or write it directly — use docker exec instead.
const USE_DOCKER_EXEC = process.platform !== 'win32' && CONFIG_FILE?.includes(path.join('sync', 'configs'));
const CONTAINER_A = 'ythril-a';

let token;
let originalConfig;

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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

async function reloadConfig() {
  // Wait for Docker Desktop bind-mount propagation before triggering reload.
  await new Promise(resolve => setTimeout(resolve, 600));
  const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
  assert.equal(r.status, 200, `reload-config failed: ${JSON.stringify(r.body)}`);
}

describe('GET /api/theme — external theming endpoint', () => {
  before(() => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalConfig = readConfig();
  });

  after(async () => {
    // Restore original config
    if (originalConfig) {
      writeConfig(originalConfig);
      await reloadConfig();
    }
  });

  it('is accessible without authentication (no Bearer token)', async () => {
    const r = await fetch(`${INSTANCES.a}/api/theme`);
    assert.equal(r.status, 200, `Expected 200 got ${r.status}`);
  });

  it('returns { cssUrl: null } when no theme is configured', async () => {
    // Ensure no theme block in config
    const cfg = readConfig();
    delete cfg.theme;
    writeConfig(cfg);
    await reloadConfig();

    const r = await fetch(`${INSTANCES.a}/api/theme`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.cssUrl, null, 'cssUrl should be null when no theme configured');
  });

  it('returns { cssUrl: "https://..." } when theme.cssUrl is set', async () => {
    const testUrl = 'https://cdn.example.com/ythril-theme.css';
    const cfg = readConfig();
    cfg.theme = { cssUrl: testUrl };
    writeConfig(cfg);
    await reloadConfig();

    // Retry in case bind-mount propagation is still in progress after the
    // initial reload (saveConfig() in the server may have written back the
    // stale version on the first attempt).
    let body;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await fetch(`${INSTANCES.a}/api/theme`);
      assert.equal(r.status, 200);
      body = await r.json();
      if (body.cssUrl === testUrl) break;
      writeConfig(cfg);
      await new Promise(resolve => setTimeout(resolve, 600));
      await post(INSTANCES.a, token, '/api/admin/reload-config', {});
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    assert.equal(body.cssUrl, testUrl, `Expected cssUrl '${testUrl}', got '${body.cssUrl}'`);
  });

  it('response has security headers', async () => {
    const r = await fetch(`${INSTANCES.a}/api/theme`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('x-request-id'), 'X-Request-Id should be present');
  });

  it('returns JSON content-type', async () => {
    const r = await fetch(`${INSTANCES.a}/api/theme`);
    const ct = r.headers.get('content-type') ?? '';
    assert.ok(ct.includes('application/json'), `Expected JSON content-type, got: ${ct}`);
  });
});
