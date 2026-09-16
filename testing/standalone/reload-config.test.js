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
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

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
    const created = await post(INSTANCES.a, token, '/api/tokens', { name: `readonly-reload-${Date.now()}`, rights: legacyRights({ readOnly: true })});
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
    // Strip any storage limits from what's on disk — a previous failed run may have
    // left hardLimitGiB:0 in config.json.  Restoring that would write zero-quota
    // right back, making every retry in the quota-restore test a no-op.
    const { storage: _dropped, ...baseConfig } = readConfig();
    originalConfig = baseConfig;
  });

  after(async () => {
    if (!originalConfig) return;
    // Retry restore until a write succeeds — prevents zero-quota from leaking into
    // subsequent test files if bind-mount propagation is slow on Docker Desktop.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        writeConfig(originalConfig);
        await new Promise(resolve => setTimeout(resolve, 600));
        const reloadR = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
        if (reloadR.status !== 200) { await new Promise(resolve => setTimeout(resolve, 400)); continue; }
        const probe = await post(INSTANCES.a, token, '/api/brain/spaces/general/facts', {
          fact: `__quota-cleanup-probe-${Date.now()}__`,
        });
        if (probe.status === 201) break;
      } catch { /* ignore, keep retrying */ }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  });

  it('brain.hardLimitGiB = 0 is enforced immediately after reload (writes return 507)', async () => {
    await applyConfig({
      ...originalConfig,
      storage: {
        ...(originalConfig.storage ?? {}),
        brain: { softLimitGiB: 0, hardLimitGiB: 0 },
      },
    });

    const r = await post(INSTANCES.a, token, '/api/brain/spaces/general/facts', {
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

    // Restore — then retry until a write actually succeeds (bind-mount propagation
    // on Docker Desktop may deliver the config.json write with a slight delay;
    // if reloadConfig() read the stale file the zero-quota is still active).
    await applyConfig(originalConfig);
    let status = 507;
    let body = {};
    for (let attempt = 0; attempt < 20 && status !== 201; attempt++) {
      const r = await post(INSTANCES.a, token, '/api/brain/spaces/general/facts', {
        fact: `reload-config restore enforcement test ${Date.now()}`,
      });
      status = r.status;
      body = r.body;
      if (status !== 201) {
        writeConfig(originalConfig);
        await new Promise(resolve => setTimeout(resolve, 600));
        await post(INSTANCES.a, token, '/api/admin/reload-config', {});
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    assert.equal(status, 201,
      `Expected 201 after restoring config, got ${status}: ${JSON.stringify(body)}`);
  });
});

describe('POST /api/admin/reload-config — space config changes take effect', () => {
  const RUN = Date.now();
  const NEW_SPACE_ID = `reload-test-${RUN}`;

  before(async () => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    // Strip storage limits regardless of what the disk currently shows.
    // The quota suite may have left hardLimitGiB:0 on disk even after its after()
    // cleared the server's in-memory state via a reload — the bind-mount propagation
    // window means readConfig() can return a stale zero-quota snapshot.  Any config
    // built by spreading originalConfig would then re-apply zero-quota on the next
    // applyConfig() call, producing a 507 that looks like a flaky test.
    const { storage: _dropped, ...baseConfig } = readConfig();
    originalConfig = baseConfig;
    // Ensure the server is also free of quota enforcement before proceeding.
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = await post(INSTANCES.a, token, '/api/brain/spaces/general/facts', {
        fact: `__space-suite-quota-guard-${Date.now()}__`,
      });
      if (probe.status === 201) break;
      // Server still has quota active — write the no-storage config and reload.
      writeConfig(originalConfig);
      await new Promise(resolve => setTimeout(resolve, 600));
      await post(INSTANCES.a, token, '/api/admin/reload-config', {});
      await new Promise(resolve => setTimeout(resolve, 400));
    }
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

    // Retry until the space appears in /api/spaces — bind-mount propagation may be slow
    // on Docker Desktop (same pattern as the "removing a space" test below).
    let spaceVisible = false;
    for (let attempt = 0; attempt < 20 && !spaceVisible; attempt++) {
      const check = await fetch(`${INSTANCES.a}/api/spaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await check.json();
      if (data.spaces?.find(s => s.id === NEW_SPACE_ID)) {
        spaceVisible = true;
        break;
      }
      writeConfig(withNewSpace);
      await new Promise(resolve => setTimeout(resolve, 600));
      await post(INSTANCES.a, token, '/api/admin/reload-config', {});
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    assert.ok(spaceVisible, `Space '${NEW_SPACE_ID}' should appear in /api/spaces after reload`);

    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${NEW_SPACE_ID}/facts`, {
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

    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${NEW_SPACE_ID}/facts`, {
      fact: 'should be rejected',
    });
    assert.equal(r.status, 404,
      `Expected 404 after removing space via reload, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
