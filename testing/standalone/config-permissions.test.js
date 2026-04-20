/**
 * Standalone tests: Config file permission auto-fix
 *
 * Verifies that the config loader's `checkPermissions()` logic:
 *  - Auto-fixes a config file with loose permissions (0o644) when owned by this process
 *  - Still allows loading after the fix
 *  - Does NOT crash the server on auto-fixable permission issues
 *
 * These tests ONLY run on POSIX (Linux/macOS) inside the Docker test stack.
 * On Windows `checkPermissions()` is a no-op, so these tests skip automatically.
 *
 * Run: node --test testing/standalone/config-permissions.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_CONFIGS = [
  path.join(__dirname, '..', 'sync', 'configs', 'a', 'config.json'),
  path.join(__dirname, '..', '..', 'config', 'config.json'),
];
const CONFIG_FILE = CANDIDATE_CONFIGS.find(p => fs.existsSync(p)) ?? null;
const TOKEN_FILE  = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const IS_POSIX = process.platform !== 'win32';

// On Linux CI the container's node user (uid 1000) owns config.json (mode 0600).
// The runner (uid 1001) cannot read, write, or chmod it directly — use docker exec.
// statSync (for reading mode bits) works on host since bind-mount shares the inode.
const USE_DOCKER_EXEC = IS_POSIX && CONFIG_FILE?.includes(path.join('sync', 'configs'));
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

function chmodConfig(mode) {
  if (USE_DOCKER_EXEC) {
    execSync(`docker exec ${CONTAINER_A} chmod ${mode.toString(8)} /config/config.json`);
    return;
  }
  fs.chmodSync(CONFIG_FILE, mode);
}

async function reloadConfig() {
  const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
  return r;
}

describe('Config file permission auto-fix', { skip: !IS_POSIX ? 'Skipped on Windows (no POSIX chmod)' : undefined }, () => {
  before(() => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalConfig = readConfig();
  });

  after(async () => {
    // Restore original config and permissions
    if (originalConfig) {
      writeConfig(originalConfig);
      chmodConfig(0o600);
      await reloadConfig();
    }
  });

  it('auto-fixes a config file with mode 0644 when owned by this process', async () => {
    // Set loose permissions
    chmodConfig(0o644);

    // Stat to confirm
    const before = fs.statSync(CONFIG_FILE).mode & 0o777;
    assert.equal(before, 0o644, 'Precondition: file should be 0644');

    // Reload config — the server should auto-fix permissions, not crash
    const r = await reloadConfig();
    assert.equal(r.status, 200, `reload-config should succeed, got ${r.status}: ${JSON.stringify(r.body)}`);

    // Verify the server is still alive
    const health = await fetch(`${INSTANCES.a}/health`);
    assert.equal(health.status, 200, 'Server should still respond after permission auto-fix');

    // Verify permissions were corrected to 0600
    // Note: reloadConfig() internally calls saveConfig() which does chmodSync(0o600)
    const after = fs.statSync(CONFIG_FILE).mode & 0o777;
    assert.equal(after, 0o600, `Permissions should be auto-fixed to 0600, got ${after.toString(8)}`);
  });

  it('auto-fixes a config file with mode 0666', async () => {
    chmodConfig(0o666);
    const r = await reloadConfig();
    assert.equal(r.status, 200, 'Should auto-fix mode 0666');

    const after = fs.statSync(CONFIG_FILE).mode & 0o777;
    assert.equal(after, 0o600, `Expected 0600, got ${after.toString(8)}`);
  });

  it('keeps 0600 permissions if they are already correct', async () => {
    chmodConfig(0o600);
    const r = await reloadConfig();
    assert.equal(r.status, 200);

    const after = fs.statSync(CONFIG_FILE).mode & 0o777;
    assert.equal(after, 0o600);
  });

  it('server remains functional with all spaces accessible after auto-fix', async () => {
    // Set loose permissions, reload, then verify full functionality
    chmodConfig(0o640);
    await reloadConfig();

    const r = await get(INSTANCES.a, token, '/api/spaces');
    assert.equal(r.status, 200, 'Spaces API should work after permission auto-fix');
    assert.ok(r.body.spaces?.length > 0, 'Should have at least one space');
  });
});
