/**
 * Standalone tests: secrets.json and config.json file permissions
 *
 * Verifies that the server writes both config files with restrictive
 * permissions (0o600 — owner read/write only) to prevent other OS users
 * from reading tokens or configuration secrets.
 *
 * SEC-8 requirement: credentials at rest must be readable only by the
 * process owner.
 *
 * These tests are SKIPPED on Windows because:
 *  1. Windows uses ACLs, not Unix mode bits.
 *  2. The server already skips permission enforcement on win32.
 *  3. stat().mode is not meaningful on Windows.
 *
 * To run these tests meaningfully, execute them inside the Linux Docker
 * container or in a Linux CI environment.
 *
 * Run: node --test testing/standalone/secrets-permissions.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IS_POSIX = process.platform !== 'win32';
const SKIP_WINDOWS = IS_POSIX ? false : 'Windows does not use Unix mode bits — skip permission checks';

// Detect which config file is active for instance A (port 3200).
// On the test stack the server bind-mounts testing/sync/configs/a/,
// so the host-path file IS the same file the server reads and writes.
const CANDIDATE_CONFIGS = [
  path.join(__dirname, '..', 'sync', 'configs', 'a', 'config.json'),  // test stack
  path.join(__dirname, '..', '..', 'config', 'config.json'),           // dev stack
];
const CONFIG_FILE = CANDIDATE_CONFIGS.find(p => fs.existsSync(p)) ?? null;
const SECRETS_FILE = CONFIG_FILE ? path.join(path.dirname(CONFIG_FILE), 'secrets.json') : null;
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

// On Linux CI the container's node user (uid 1000) owns secrets.json (mode 0600).
// The runner (uid 1001) cannot open it for reading directly — use docker exec instead.
// statSync (for mode checks) does not require read permission and works as-is.
const USE_DOCKER_EXEC = process.platform !== 'win32' && CONFIG_FILE?.includes(path.join('sync', 'configs'));

function readSecretsRaw() {
  if (USE_DOCKER_EXEC) {
    return execSync('docker exec ythril-a cat /config/secrets.json').toString('utf8');
  }
  return fs.readFileSync(SECRETS_FILE, 'utf8');
}

let token;

// ── Helpers ───────────────────────────────────────────────────────────────────

function modeOctal(filePath) {
  return (fs.statSync(filePath).mode & 0o777).toString(8).padStart(4, '0');
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('secrets.json — existence', () => {
  before(() => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('config.json exists on disk at the expected path', () => {
    assert.ok(fs.existsSync(CONFIG_FILE), `config.json not found at: ${CONFIG_FILE}`);
  });

  it('secrets.json exists on disk next to config.json', () => {
    assert.ok(SECRETS_FILE && fs.existsSync(SECRETS_FILE),
      `secrets.json not found at: ${SECRETS_FILE}`);
  });

  it('secrets.json is valid JSON', () => {
    const raw = readSecretsRaw();
    assert.doesNotThrow(() => JSON.parse(raw), 'secrets.json must be valid JSON');
  });

  it('peerTokens values are non-empty strings (plaintext outgoing credentials)', () => {
    // peerTokens are plaintext by design — they are Bearer tokens sent to peer instances.
    // Protection is via file permissions (0600); see the POSIX suite below.
    const obj = JSON.parse(readSecretsRaw());
    const peerTokens = obj.peerTokens ?? {};
    for (const [peer, val] of Object.entries(peerTokens)) {
      assert.ok(
        typeof val === 'string' && val.length > 0,
        `peerToken for '${peer}' should be a non-empty string, got: ${JSON.stringify(val)}`
      );
    }
  });
});

describe('secrets.json — POSIX file permissions (0o600)', () => {
  before(() => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('secrets.json has mode 0o600 (owner rw, no group/other access)', { skip: SKIP_WINDOWS }, () => {
    const mode = fs.statSync(SECRETS_FILE).mode & 0o777;
    assert.equal(mode, 0o600,
      `secrets.json has permissions ${modeOctal(SECRETS_FILE)} but must be 0600 (rw-------). ` +
      `Plaintext peer tokens would be readable by other OS users.`
    );
  });

  it('config.json has mode 0o600', { skip: SKIP_WINDOWS }, () => {
    const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
    assert.equal(mode, 0o600,
      `config.json has permissions ${modeOctal(CONFIG_FILE)} but must be 0600. ` +
      `Token bcrypt hashes and space config would be readable by other OS users.`
    );
  });

  it('secrets.json permissions are still 0o600 after reload-config', { skip: SKIP_WINDOWS }, async () => {
    // reload-config re-saves secrets.json (fixing any permissions drift)
    const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
    assert.equal(r.status, 200, `reload-config: ${JSON.stringify(r.body)}`);

    const mode = fs.statSync(SECRETS_FILE).mode & 0o777;
    assert.equal(mode, 0o600,
      `After reload-config, secrets.json permissions drifted to ${modeOctal(SECRETS_FILE)} (must be 0600).`
    );
  });

  it('config.json permissions are still 0o600 after reload-config', { skip: SKIP_WINDOWS }, async () => {
    const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
    assert.equal(r.status, 200, `reload-config: ${JSON.stringify(r.body)}`);

    const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
    assert.equal(mode, 0o600,
      `After reload-config, config.json permissions drifted to ${modeOctal(CONFIG_FILE)} (must be 0600).`
    );
  });
});
