/**
 * Red-team tests: auth / authorization escalation guards.
 *
 * H1 — MCP proxy fan-out cannot exceed the token's member-space scope.
 *      A token scoped only to a proxy space must NOT reach the proxy's member
 *      spaces via MCP (a wildcard `proxyFor: ['*']` token would otherwise reach
 *      the whole instance).
 * H2 — MFA setup/disable cannot be performed with just an admin PAT once MFA is
 *      enabled: rotating or removing the second factor requires a current TOTP
 *      code (otherwise a stolen admin PAT neutralises MFA).
 * H3 — A space-restricted admin token cannot mint an unrestricted (all-spaces)
 *      token, nor a token scoped to spaces outside its own allow-list.
 *
 * Run: node --test testing/red-team-tests/auth-escalation.test.js
 * Pre-requisite: the test stack is up (docker compose ... up) and tokens
 * provisioned (testing/sync/setup.js). MFA must start disabled on instance A.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let adminToken;

async function mcpCall(token, name, args) {
  const r = await fetch(`${INSTANCES.a}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { status: r.status, text: await r.text() };
}

before(() => {
  adminToken = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

// ── H1 — MCP proxy fan-out scope ─────────────────────────────────────────────

describe('H1 — MCP proxy space cannot exceed member-space token scope', () => {
  const spaceA = `esc-a-${RUN}`;
  const spaceB = `esc-b-${RUN}`;
  const proxyId = `esc-proxy-${RUN}`;
  let proxyOnlyToken, fullToken;
  const tokenIds = [];

  before(async () => {
    await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceA, label: 'Esc A' });
    await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceB, label: 'Esc B' });
    const p = await post(INSTANCES.a, adminToken, '/api/spaces', { id: proxyId, label: 'Esc Proxy', proxyFor: [spaceA, spaceB] });
    assert.equal(p.status, 201, `create proxy: ${JSON.stringify(p.body)}`);

    const t1 = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `esc-proxy-only-${RUN}`, rights: legacyRights({ spaces: [proxyId] })});
    assert.equal(t1.status, 201, JSON.stringify(t1.body));
    proxyOnlyToken = t1.body.plaintext; tokenIds.push(t1.body.token.id);

    const t2 = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `esc-full-${RUN}`, rights: legacyRights({ spaces: [proxyId, spaceA, spaceB] })});
    assert.equal(t2.status, 201, JSON.stringify(t2.body));
    fullToken = t2.body.plaintext; tokenIds.push(t2.body.token.id);
  });

  after(async () => {
    for (const id of tokenIds) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
    for (const id of [proxyId, spaceA, spaceB]) await delWithBody(INSTANCES.a, adminToken, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  });

  it('a proxy-only token is DENIED access to the proxy\'s member spaces', async () => {
    const r = await mcpCall(proxyOnlyToken, 'space_stats', { space: proxyId });
    assert.equal(r.status, 200);
    assert.match(r.text, /member space/i,
      `VULNERABILITY: proxy-only token reached member spaces via MCP. Response: ${r.text.slice(0, 300)}`);
  });

  it('a token scoped to all member spaces IS allowed', async () => {
    const r = await mcpCall(fullToken, 'space_stats', { space: proxyId });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /does not have access to member space/i,
      `Regression: full-scope token was wrongly denied. Response: ${r.text.slice(0, 300)}`);
  });
});

// ── H3 — token-minting privilege escalation ──────────────────────────────────

describe('H3 — space-restricted admin cannot mint a broader token', () => {
  let restrictedAdmin;
  const tokenIds = [];

  before(async () => {
    // A space-restricted admin token (admin over 'general' only).
    const t = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `esc-restricted-admin-${RUN}`, rights: legacyRights({ admin: true, spaces: ['general'] })});
    assert.equal(t.status, 201, JSON.stringify(t.body));
    restrictedAdmin = t.body.plaintext; tokenIds.push(t.body.token.id);
  });

  after(async () => {
    for (const id of tokenIds) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
  });

  it('cannot mint an unrestricted (all-spaces) token', async () => {
    const r = await post(INSTANCES.a, restrictedAdmin, '/api/tokens', { name: `esc-escalate-all-${RUN}`, rights: legacyRights({ admin: true })});
    if (r.status === 201 && r.body?.token?.id) tokenIds.push(r.body.token.id); // clean up if it slipped through
    assert.equal(r.status, 403, `VULNERABILITY: restricted admin minted an all-spaces token (got ${r.status}: ${JSON.stringify(r.body)})`);
  });

  it('cannot mint a token scoped to a space outside its own allow-list', async () => {
    const r = await post(INSTANCES.a, restrictedAdmin, '/api/tokens', { name: `esc-escalate-other-${RUN}`, rights: legacyRights({ spaces: ['esc-outside-scope'] })});
    if (r.status === 201 && r.body?.token?.id) tokenIds.push(r.body.token.id);
    assert.equal(r.status, 403, `VULNERABILITY: restricted admin granted access outside its scope (got ${r.status}: ${JSON.stringify(r.body)})`);
  });

  it('CAN mint a token scoped to a subset of its own spaces (control)', async () => {
    const r = await post(INSTANCES.a, restrictedAdmin, '/api/tokens', { name: `esc-subset-${RUN}`, rights: legacyRights({ spaces: ['general'] })});
    assert.equal(r.status, 201, `Regression: restricted admin could not mint an in-scope token: ${JSON.stringify(r.body)}`);
    if (r.body?.token?.id) tokenIds.push(r.body.token.id);
  });
});

// ── H2 — MFA setup/disable require a current code once enabled ────────────────

describe('H2 — MFA cannot be rotated/disabled with just an admin PAT once enabled', () => {
  // Once MFA is enabled, /api/admin/reload-config ALSO requires a TOTP code, so
  // we cannot reload our way out of it. Disabling MFA in test cleanup is done the
  // documented break-glass way: remove `totpSecret` from secrets.json on disk and
  // restart, which reloads the (now MFA-off) config from disk. Code-free and
  // reliable — no TOTP generation needed.
  async function disableMfaViaRestart() {
    execSync(`docker exec ythril-a node -e "const fs=require('fs');const p='/config/secrets.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));delete s.totpSecret;fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600})"`);
    // `-t 3`: force-kill after a 3s graceful window instead of docker's default 10s. Under
    // full-suite load the instance is mid-sync with its peers, and a slow graceful stop plus a
    // busy daemon was pushing the whole restart past the readiness deadline below.
    execSync('docker restart -t 3 ythril-a', { stdio: 'ignore' });
    // Wait for the API to actually serve again — poll the readiness endpoint
    // (not just docker's health status), retrying through the stale keep-alive
    // sockets still pointing at the dead process. Throw loudly on timeout so we
    // never run assertions against a half-restarted server. The old 45s docker-
    // health loop returned SILENTLY on timeout, so a slow restart left `before`
    // hitting a dead server and the MFA request hung to its timeout — the flake.
    // 240s (not 90s): when this test runs late in the full suite, peer instances b/c/d are
    // still syncing against A, so a fresh A is flooded on boot and readiness lags — in
    // isolation this restart is ~2s, but under that background load it has been observed to
    // take ~175s, so the deadline needs comfortable headroom above that.
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${INSTANCES.a}/ready`);
        if (r.ok) return;
      } catch { /* container mid-restart / stale socket */ }
      await new Promise(res => setTimeout(res, 500));
    }
    throw new Error('instance A did not come back after MFA-disable restart');
  }

  before(async () => {
    await disableMfaViaRestart();                 // ensure a clean (MFA-off) start
    const setup = await post(INSTANCES.a, adminToken, '/api/mfa/setup', {});  // first-time enrol needs no code
    assert.equal(setup.status, 201, `enable MFA: ${JSON.stringify(setup.body)}`);
    const status = await get(INSTANCES.a, adminToken, '/api/mfa/status');
    assert.equal(status.body.enabled, true, 'MFA should be enabled after setup');
  });

  after(async () => {
    await disableMfaViaRestart();
  });

  it('POST /api/mfa/setup (rotate) with only an admin PAT is rejected once MFA is enabled', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/mfa/setup', {});
    assert.equal(r.status, 403, `VULNERABILITY: MFA secret rotated without a code (got ${r.status}: ${JSON.stringify(r.body)})`);
    assert.equal(r.body.error, 'MFA_REQUIRED');
  });

  it('DELETE /api/mfa with only an admin PAT is rejected once MFA is enabled', async () => {
    const r = await del(INSTANCES.a, adminToken, '/api/mfa');
    assert.equal(r.status, 403, `VULNERABILITY: MFA disabled without a code (got ${r.status}: ${JSON.stringify(r.body)})`);
  });
});
