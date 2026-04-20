/**
 * Integration tests: POST /api/admin/reload-config
 *
 * Verifies that calling reload-config after patching config.json on disk
 * ACTUALLY changes live server behaviour — not merely returns 200.
 *
 * Covers:
 *  - Returns { ok: true } / 200 for authenticated request
 *  - Returns 401 for unauthenticated request
 *  - brain.hardLimitGiB = 0 takes effect immediately after reload  → writes return 507
 *  - Restoring original config via reload removes quota enforcement → writes return 201
 *  - Adding a new space to config makes it accessible via API after reload
 *  - Removing the space via restore + reload makes it inaccessible (404)
 *
 * NOTE: Do not run in parallel with standalone/quota.test.js — both patch
 * the same config.json file on instance A.
 *
 * Run: node --test testing/standalone/reload-config.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Detect which config file is active for instance A (port 3200)
const CANDIDATE_CONFIGS = [
  path.join(__dirname, '..', 'sync', 'configs', 'a', 'config.json'), // test stack
  path.join(__dirname, '..', '..', 'config', 'config.json'),          // dev stack
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

async function applyConfig(cfg) {
  writeConfig(cfg);
  // Wait for Docker Desktop bind-mount propagation before triggering reload.
  // Without this delay the container may still read the pre-write file and
  // saveConfig() will write the stale version back, overwriting our change.
  await new Promise(resolve => setTimeout(resolve, 600));
  const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
  assert.equal(r.status, 200, `reload-config failed: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('POST /api/admin/reload-config — authentication', () => {
  before(() => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalConfig = readConfig();
  });

  it('returns { ok: true } with 200 for an authenticated request', async () => {
    const r = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const r = await post(INSTANCES.a, null, '/api/admin/reload-config', {});
    assert.equal(r.status, 401);
  });

  it('returns 403 for a standard (non-admin) token', async () => {
    // Create a non-admin token and verify it is rejected
    const created = await post(INSTANCES.a, token, '/api/tokens', { name: `non-admin-reload-${Date.now()}` });
    assert.equal(created.status, 201, `Create non-admin token: ${JSON.stringify(created.body)}`);
    const stdToken = created.body.plaintext;
    const stdTokenId = created.body.token?.id;
    try {
      const r = await post(INSTANCES.a, stdToken, '/api/admin/reload-config', {});
      assert.equal(r.status, 403, `Expected 403 for non-admin token, got ${r.status}: ${JSON.stringify(r.body)}`);
    } finally {
      if (stdTokenId) await post(INSTANCES.a, token, `/api/tokens/${stdTokenId}`, {}).catch(() => {});
      // Best-effort cleanup — use admin token to revoke
      if (stdTokenId) {
        await fetch(`${INSTANCES.a}/api/tokens/${stdTokenId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    }
  });

  it('returns 403 for a read-only token', async () => {
    const created = await post(INSTANCES.a, token, '/api/tokens', { name: `readonly-reload-${Date.now()}`, readOnly: true });
    assert.equal(created.status, 201, `Create read-only token: ${JSON.stringify(created.body)}`);
    const roToken = created.body.plaintext;
    const roTokenId = created.body.token?.id;
    try {
      const r = await post(INSTANCES.a, roToken, '/api/admin/reload-config', {});
      assert.equal(r.status, 403, `Expected 403 for read-only token, got ${r.status}: ${JSON.stringify(r.body)}`);
    } finally {
      if (roTokenId) {
        await fetch(`${INSTANCES.a}/api/tokens/${roTokenId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    }
  });
});

describe('POST /api/admin/reload-config — quota changes take effect', () => {
  before(() => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalConfig = readConfig();
  });

  after(async () => {
    // Always restore — even if a test throws
    if (originalConfig) await applyConfig(originalConfig);
  });

  it('brain.hardLimitGiB = 0 is enforced immediately after reload (writes return 507)', async () => {
    await applyConfig({
      ...originalConfig,
      storage: {
        ...(originalConfig.storage ?? {}),
        brain: { softLimitGiB: 0, hardLimitGiB: 0 },
      },
    });

    const r = await post(INSTANCES.a, token, '/api/brain/general/memories', {
      fact: `reload-config quota enforcement test ${Date.now()}`,
    });
    assert.equal(r.status, 507,
      `Expected 507 after zero-quota reload, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.storageExceeded, 'storageExceeded must be true in the 507 response');
  });

  it('restoring original config via reload removes quota enforcement (writes return 201)', async () => {
    // Re-apply zero quota first to ensure we start from constrained state
    await applyConfig({
      ...originalConfig,
      storage: { brain: { softLimitGiB: 0, hardLimitGiB: 0 } },
    });

    // Now restore
    await applyConfig(originalConfig);

    const r = await post(INSTANCES.a, token, '/api/brain/general/memories', {
      fact: `reload-config restore enforcement test ${Date.now()}`,
    });
    assert.equal(r.status, 201,
      `Expected 201 after restoring config, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

describe('POST /api/admin/reload-config — space config changes take effect', () => {
  const RUN = Date.now();
  const NEW_SPACE_ID = `reload-test-${RUN}`;

  before(() => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalConfig = readConfig();
  });

  after(async () => {
    if (originalConfig) await applyConfig(originalConfig);
  });

  it('a newly added space becomes accessible via API immediately after reload', async () => {
    const withNewSpace = {
      ...originalConfig,
      spaces: [
        ...originalConfig.spaces,
        { id: NEW_SPACE_ID, label: 'Reload Test Space', builtIn: false, folders: [] },
      ],
    };
    await applyConfig(withNewSpace);

    const r = await post(INSTANCES.a, token, `/api/brain/${NEW_SPACE_ID}/memories`, {
      fact: `testing new space after reload ${RUN}`,
    });
    assert.equal(r.status, 201,
      `Expected 201 writing to new space after reload, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('removing a space via reload makes it return 404 immediately', async () => {
    // NEW_SPACE_ID is still in config from the previous test (after runs sequentially);
    // restore to original which doesn't contain it.
    await applyConfig(originalConfig);

    // On Docker Desktop (Windows/macOS), bind-mount writes from the host may propagate
    // to the container with a brief delay.  If reloadConfig() read the stale file it will
    // have written config_with_space back via saveConfig's atomic rename — re-trigger
    // reload until the space is actually gone from the live /api/spaces list (max 3 s).
    let spaceGone = false;
    for (let attempt = 0; attempt < 20 && !spaceGone; attempt++) {
      const check = await fetch(`${INSTANCES.a}/api/spaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await check.json();
      if (!data.spaces?.find(s => s.id === NEW_SPACE_ID)) {
        spaceGone = true;
        break;
      }
      // Space still visible — re-write config (in case saveConfig() overwrote it),
      // wait for bind-mount propagation, then re-trigger reload.
      writeConfig(originalConfig);
      await new Promise(resolve => setTimeout(resolve, 600));
      await post(INSTANCES.a, token, '/api/admin/reload-config', {});
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    assert.ok(spaceGone, `Space '${NEW_SPACE_ID}' should be gone from /api/spaces after reload`);

    const r = await post(INSTANCES.a, token, `/api/brain/${NEW_SPACE_ID}/memories`, {
      fact: 'should be rejected',
    });
    assert.equal(r.status, 404,
      `Expected 404 after removing space via reload, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
