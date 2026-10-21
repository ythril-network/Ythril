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
import { INSTANCES, post, get, del, delWithBody, waitFor } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';
import { spaceAdminRights } from '../_shared/space-admin-rights.mjs';

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

describe('H1 — a personal view belongs to its owner and reaches only what its reader reaches', () => {
  const spaceA = `esc-a-${RUN}`;
  const spaceB = `esc-b-${RUN}`;
  const viewName = `esc-view-${RUN}`;
  const viewId = `@${viewName}`;
  let ownerToken, otherToken, narrowToken;
  const tokenIds = [];

  before(async () => {
    await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceA, label: 'Esc A' });
    await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceB, label: 'Esc B' });

    const t1 = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `esc-owner-${RUN}`, rights: legacyRights({ spaces: [spaceA, spaceB] })});
    assert.equal(t1.status, 201, JSON.stringify(t1.body));
    ownerToken = t1.body.plaintext; tokenIds.push(t1.body.token.id);

    const t2 = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `esc-other-${RUN}`, rights: legacyRights({ spaces: [spaceA, spaceB] })});
    assert.equal(t2.status, 201, JSON.stringify(t2.body));
    otherToken = t2.body.plaintext; tokenIds.push(t2.body.token.id);

    const t3 = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `esc-narrow-${RUN}`, rights: legacyRights({ spaces: [spaceA] })});
    assert.equal(t3.status, 201, JSON.stringify(t3.body));
    narrowToken = t3.body.plaintext; tokenIds.push(t3.body.token.id);

    const v = await post(INSTANCES.a, ownerToken, '/api/views', { name: viewName, members: [spaceA, spaceB] });
    assert.equal(v.status, 201, `create view: ${JSON.stringify(v.body)}`);
  });

  after(async () => {
    await del(INSTANCES.a, ownerToken, `/api/views/${encodeURIComponent(viewId)}`).catch(() => {});
    for (const id of tokenIds) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
    for (const id of [spaceA, spaceB]) await delWithBody(INSTANCES.a, adminToken, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  });

  it('another token\'s view is answered as an unknown space, over MCP and over REST', async () => {
    const mcp = await mcpCall(otherToken, 'space_stats', { space: viewId });
    assert.equal(mcp.status, 200);
    assert.match(mcp.text, /not found/i,
      `VULNERABILITY: a token read another token's view over MCP. Response: ${mcp.text.slice(0, 300)}`);
    const rest = await get(INSTANCES.a, otherToken, `/api/brain/spaces/${encodeURIComponent(viewId)}/stats`);
    assert.equal(rest.status, 404, `VULNERABILITY: a token read another token's view over REST: ${JSON.stringify(rest.body)}`);
    const list = await get(INSTANCES.a, otherToken, '/api/views');
    assert.equal(list.body.views.some(v => v.id === viewId), false, 'another token\'s view must not be listed');
  });

  it('the owner reads through the view', async () => {
    const r = await mcpCall(ownerToken, 'space_stats', { space: viewId });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /not found/i,
      `Regression: the owner was refused its own view. Response: ${r.text.slice(0, 300)}`);
  });

  it('a view never widens its reader: a token that reaches one member reads only that member through it', async () => {
    const name = `esc-narrow-view-${RUN}`;
    const own = await post(INSTANCES.a, narrowToken, '/api/views', { name, members: [spaceA, spaceB] });
    // Listing a space this token cannot reach is refused outright, or accepted and narrowed on every read; never widened.
    if (own.status === 201) {
      const read = await get(INSTANCES.a, narrowToken, `/api/brain/spaces/${encodeURIComponent('@' + name)}/stats`);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(read.body.viewMembers, [spaceA], 'VULNERABILITY: a view widened its owner to a member the token does not reach');
      await del(INSTANCES.a, narrowToken, `/api/views/${encodeURIComponent('@' + name)}`).catch(() => {});
    } else {
      assert.ok([403, 404].includes(own.status), `unexpected answer: ${own.status} ${JSON.stringify(own.body)}`);
    }
  });
});

// ── H3 — token-minting privilege escalation ──────────────────────────────────

describe('H3 — space-restricted admin cannot mint a broader token', () => {
  let restrictedAdmin;
  const tokenIds = [];

  before(async () => {
    // A space-restricted admin token (admin over 'general' only).
    const t = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `esc-restricted-admin-${RUN}`, rights: spaceAdminRights(['general'])});
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
    await waitFor(async () => (await fetch(`${INSTANCES.a}/ready`)).ok, 240_000, 500, undefined,
      { what: 'instance A to come back after the MFA-disable restart', tolerate: () => true }); // mid-restart / stale socket
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
