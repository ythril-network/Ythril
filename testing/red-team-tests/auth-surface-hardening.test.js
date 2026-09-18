/**
 * Red-team tests: auth surface hardening (M2, M8, M9, L1, L2)
 *
 * M2 — a raw `?token=` query param is ignored on EVERY route → 401, with no
 *      exception left. The last one was `GET /mcp`, the MCP SSE transport, whose
 *      clients might not have been able to set a header; 4.0 removed that transport
 *      and the fallback with it. The browser SSE streams (brain events, audit-log
 *      tail) authenticate via a single-use `?ticket=` minted by an authenticated
 *      POST, so no long-lived token is ever placed in a URL (access/proxy logs,
 *      Referer, browser history). EventSource still can't set headers — the ticket
 *      is what keeps the token out of the URL.
 * M8 — a TOTP code is single-use: replaying a code that is still inside its
 *      ±1-step validity window must be refused.
 * M9 — the instance-level MCP tools (`network_peers`, `network_sync`) require an admin
 *      token: they expose the peer topology / drive outbound sync and have no
 *      space scoping.
 * L1 — the token lookup `prefix` is taken from the RANDOM part of the token
 *      (offset 7), not `ythril_` + 1 char; records still carrying the old
 *      format keep authenticating and are migrated on first use.
 * L2 — POST /api/conflicts/seed (a test fixture that fabricates conflict
 *      records) is admin-gated.
 *
 * Run: node --test testing/red-team-tests/auth-surface-hardening.test.js
 * Pre-requisite: test stack up + testing/sync/setup.js. MFA must start disabled
 * on instance A.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, dockerExec } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let adminToken;

before(() => {
  adminToken = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

function readContainerConfig(container = 'ythril-a') {
  const out = dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`,
  ).toString();
  return JSON.parse(out);
}

// ── M2 — a query-param token is accepted nowhere ─────────────────────────────

describe('M2 — ?token= is accepted on no route at all', () => {
  /** Request with the token ONLY in the query string (no Authorization header). */
  /**
   * A request carrying its token in the QUERY STRING, which nothing may accept.
   *
   * It takes a method because one of these routes is a POST: reading a brain collection is
   * `POST /api/brain/filter` since 5.0. A table that could only GET would have had to drop the brain
   * row, and the brain surface is the one most worth asserting here.
   */
  async function queryTokenRequest(pathAndQuery, method = 'GET') {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const r = await fetch(`${INSTANCES.a}${pathAndQuery}${sep}token=${encodeURIComponent(adminToken)}`,
      method === 'GET' ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return r.status;
  }

  const BLOCKED = [
    '/api/spaces',
    '/api/tokens',
    '/api/networks',
    ['/api/brain/filter', 'POST'],
    '/api/files/general?path=.',
    '/api/about',
    // The last exception. It authenticated a raw ?token= until 4.0 removed the SSE transport it existed for,
    // and it belongs in this list rather than in a note: an exception nobody re-tests is one that comes back.
    '/mcp',
  ];

  for (const entry of BLOCKED) {
    const [route, method = 'GET'] = Array.isArray(entry) ? entry : [entry];
    it(`rejects a query-param token on ${route}`, async () => {
      const status = await queryTokenRequest(route, method);
      assert.equal(status, 401, `VULNERABILITY: ${route} accepted a token from the query string`);
    });
  }

  it('rejects a query-param token on a mutating (POST) route', async () => {
    const r = await fetch(`${INSTANCES.a}/api/spaces?token=${encodeURIComponent(adminToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `qt-${RUN}`, label: 'Should not be created' }),
    });
    assert.equal(r.status, 401, 'VULNERABILITY: POST accepted a token from the query string');
  });

  it('rejects a raw ?token= on the log-stream SSE endpoint (query-token fallback removed)', async () => {
    const r = await fetch(`${INSTANCES.a}/api/about/logs/stream?token=${encodeURIComponent(adminToken)}`);
    assert.equal(r.status, 401, 'VULNERABILITY: raw token in the URL still authenticates the log stream');
  });

  it('rejects a raw ?token= on the brain-events SSE stream', async () => {
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/events?token=${encodeURIComponent(adminToken)}`);
    assert.equal(r.status, 401, 'VULNERABILITY: raw token in the URL still authenticates the brain stream');
  });

  it('authenticates the log-stream SSE via a single-use ticket (EventSource)', async () => {
    const mint = await post(INSTANCES.a, adminToken, '/api/about/logs/ticket', {});
    assert.equal(mint.status, 200, `ticket mint failed: ${JSON.stringify(mint.body)}`);
    const ticket = mint.body.ticket;
    assert.ok(typeof ticket === 'string' && ticket.length >= 20, 'ticket should be opaque');
    // The SSE stream never ends — abort as soon as headers arrive.
    const ac = new AbortController();
    const r = await fetch(
      `${INSTANCES.a}/api/about/logs/stream?ticket=${encodeURIComponent(ticket)}`,
      { signal: ac.signal },
    );
    const status = r.status;
    const ctype = r.headers.get('content-type') ?? '';
    ac.abort();
    assert.equal(status, 200, 'the audit-log EventSource must authenticate via a ticket');
    assert.match(ctype, /text\/event-stream/);
  });

  it('rejects an unknown/forged ticket on the log-stream SSE endpoint', async () => {
    const ac = new AbortController();
    const r = await fetch(`${INSTANCES.a}/api/about/logs/stream?ticket=not-a-real-ticket`, { signal: ac.signal });
    const status = r.status;
    ac.abort();
    assert.equal(status, 401, 'an unknown ticket must not authenticate');
  });

  it('the Authorization header still works everywhere (regression)', async () => {
    const r = await get(INSTANCES.a, adminToken, '/api/spaces');
    assert.equal(r.status, 200);
  });
});

// ── M9 — instance-level MCP tools require admin ──────────────────────────────

describe('M9 — list_peers / sync_now require an admin token', () => {
  const spaceId = `m9-${RUN}`;
  let plainToken;
  const tokenIds = [];

  before(async () => {
    await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'M9' });
    const t = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: `m9-plain-${RUN}`,
      rights: legacyRights({ spaces: [spaceId] })
    });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    plainToken = t.body.plaintext;
    if (t.body.token?.id) tokenIds.push(t.body.token.id);
  });

  after(async () => {
    for (const id of tokenIds) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
    await fetch(`${INSTANCES.a}/api/spaces/${spaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });

  async function mcp(token, body) {
    const r = await fetch(`${INSTANCES.a}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    });
    return { status: r.status, text: await r.text() };
  }

  const callTool = (token, name, args = {}) =>
    mcp(token, { method: 'tools/call', params: { name, arguments: args } });

  it('list_peers via a non-admin token is refused', async () => {
    const r = await callTool(plainToken, 'network_peers');
    assert.match(r.text, /requires a token with instance-admin rights/i,
      `VULNERABILITY: non-admin token reached list_peers: ${r.text.slice(0, 300)}`);
  });

  it('sync_now via a non-admin token is refused', async () => {
    const r = await callTool(plainToken, 'network_sync');
    assert.match(r.text, /requires a token with instance-admin rights/i,
      `VULNERABILITY: non-admin token reached sync_now: ${r.text.slice(0, 300)}`);
  });

  it('tools/list hides the admin-only tools from a non-admin token', async () => {
    const r = await mcp(plainToken, { method: 'tools/list', params: {} });
    assert.ok(!/"name"\s*:\s*"network_peers"/.test(r.text), 'list_peers must not be advertised to a non-admin token');
    assert.ok(!/"name"\s*:\s*"network_sync"/.test(r.text), 'sync_now must not be advertised to a non-admin token');
  });

  it('an admin token can still call list_peers (regression)', async () => {
    const r = await callTool(adminToken, 'network_peers');
    // Absence of the CURRENT wording. The previous version of this line matched the OLD wording, so when the
    // refusal text changed it would have passed against a refused admin — a security test proving nothing
    // while reading as "admin still works".
    assert.ok(!/instance-admin rights/i.test(r.text), `admin must retain access: ${r.text.slice(0, 300)}`);
    // And a POSITIVE signal, so no future rewording can make this vacuous again: the tool answered rather
    // than erroring.
    assert.ok(!/"isError"\s*:\s*true/.test(r.text), `admin call returned an error: ${r.text.slice(0, 300)}`);
    assert.match(r.text, /peers|instanceId|\[\]/i, `expected a peer listing shape: ${r.text.slice(0, 300)}`);
  });
});

// ── L1 — token lookup prefix entropy ─────────────────────────────────────────

describe('L1 — token lookup prefix comes from the random part of the token', () => {
  const tokenIds = [];

  after(async () => {
    for (const id of tokenIds) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
  });

  it('a new token stores prefix = plaintext.slice(7, 15), not "ythril_" + 1 char', async () => {
    const t = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `l1-${RUN}` });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const plaintext = t.body.plaintext;
    const id = t.body.token?.id;
    if (id) tokenIds.push(id);

    const record = readContainerConfig().tokens.find(x => x.id === id);
    assert.ok(record, 'token record should exist');
    assert.equal(record.prefix, plaintext.slice(7, 15));
    assert.ok(!record.prefix.startsWith('ythril_'), 'prefix must not be the constant literal');
  });

  it('a record still carrying the OLD prefix format authenticates and is migrated', async () => {
    const t = await post(INSTANCES.a, adminToken, '/api/tokens', { name: `l1-legacy-${RUN}` });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const plaintext = t.body.plaintext;
    const id = t.body.token?.id;
    if (id) tokenIds.push(id);

    // Rewrite the record to the pre-fix format, as an upgraded deployment has it.
    const oldPrefix = plaintext.slice(0, 8);
    dockerExec(
      `docker exec ythril-a node -e "const fs=require('fs');const p='/config/config.json';` +
      `const c=JSON.parse(fs.readFileSync(p,'utf8'));` +
      `const t=c.tokens.find(t=>t.id==='${id}');t.prefix='${oldPrefix}';` +
      `fs.writeFileSync(p,JSON.stringify(c,null,2),{mode:0o600})"`,
    );
    const reload = await post(INSTANCES.a, adminToken, '/api/admin/reload-config', {});
    assert.equal(reload.status, 200, JSON.stringify(reload.body));

    // It must still authenticate …
    const r = await get(INSTANCES.a, plaintext, '/api/spaces');
    assert.equal(r.status, 200, 'a token with the old prefix format must keep working');

    // … and be migrated to the new format on that first use.
    const record = readContainerConfig().tokens.find(x => x.id === id);
    assert.equal(record.prefix, plaintext.slice(7, 15), 'prefix should be migrated on first use');
  });
});

// ── L2 — conflicts/seed is admin-gated ───────────────────────────────────────

describe('L2 — POST /api/conflicts/seed requires an admin token', () => {
  const spaceId = `l2-${RUN}`;
  let plainToken;
  const tokenIds = [];

  before(async () => {
    await post(INSTANCES.a, adminToken, '/api/spaces', { id: spaceId, label: 'L2' });
    const t = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: `l2-plain-${RUN}`,
      rights: legacyRights({ spaces: [spaceId] })
    });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    plainToken = t.body.plaintext;
    if (t.body.token?.id) tokenIds.push(t.body.token.id);
  });

  after(async () => {
    for (const id of tokenIds) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
    await fetch(`${INSTANCES.a}/api/spaces/${spaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });

  const seedBody = () => ({
    _id: `seed-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
    spaceId,
    originalPath: 'notes.md',
    conflictPath: 'notes.conflict.md',
    peerInstanceId: 'attacker',
    peerInstanceLabel: 'Totally Legit Peer',
  });

  it('a space-scoped non-admin token cannot fabricate a conflict record', async () => {
    const r = await post(INSTANCES.a, plainToken, '/api/conflicts/seed', seedBody());
    assert.equal(r.status, 403, `VULNERABILITY: non-admin token seeded a conflict (${r.status})`);
  });

  it('an admin token can still seed (regression — the tests depend on it)', async () => {
    const r = await post(INSTANCES.a, adminToken, '/api/conflicts/seed', seedBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});

// ── M8 — TOTP codes are single-use ───────────────────────────────────────────

describe('M8 — a TOTP code cannot be replayed inside its validity window', () => {
  let secret;

  // Break-glass disable: remove totpSecret from secrets.json + restart.
  // (Once MFA is on, reload-config itself demands a code.)
  function disableMfaViaRestart() {
    dockerExec(
      `docker exec ythril-a node -e "const fs=require('fs');const p='/config/secrets.json';` +
      `const s=JSON.parse(fs.readFileSync(p,'utf8'));delete s.totpSecret;delete s.totpLastStep;` +
      `fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600})"`,
    );
    execSync('docker restart ythril-a', { stdio: 'ignore' });
    const sleep1s = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    for (let i = 0; i < 45; i++) {
      try {
        if (execSync('docker inspect -f "{{.State.Health.Status}}" ythril-a').toString().trim() === 'healthy') return;
      } catch { /* container mid-restart */ }
      sleep1s();
    }
  }

  /** After a restart the keep-alive pool still holds sockets to the dead process,
   *  so the first request can surface as ECONNRESET. Drive one through until the
   *  API answers cleanly. */
  async function waitForApi() {
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${INSTANCES.a}/health`);
        if (r.ok) return;
      } catch { /* stale socket / still booting */ }
      await new Promise(res => setTimeout(res, 500));
    }
    throw new Error('instance A did not come back after restart');
  }

  // RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — mirrors server/src/auth/totp.ts
  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function base32Decode(input) {
    let bits = '';
    for (const c of input.toUpperCase().replace(/=+$/, '')) {
      const v = BASE32.indexOf(c);
      if (v === -1) continue;
      bits += v.toString(2).padStart(5, '0');
    }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    return Buffer.from(bytes);
  }
  function totp(sec, epoch = Math.floor(Date.now() / 1000)) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(Math.floor(epoch / 30)));
    const hmac = crypto.createHmac('sha1', base32Decode(sec)).update(buf).digest();
    const off = hmac[hmac.length - 1] & 0x0f;
    const code = (((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]) % 1e6;
    return code.toString().padStart(6, '0');
  }

  before(async () => {
    disableMfaViaRestart();
    await waitForApi();
    const setup = await post(INSTANCES.a, adminToken, '/api/mfa/setup', {});
    assert.equal(setup.status, 201, `enable MFA: ${JSON.stringify(setup.body)}`);
    secret = setup.body.secret;
    assert.ok(secret, 'setup should return the base32 secret');
  });

  after(() => {
    disableMfaViaRestart();
  });

  it('a fresh code verifies, and the SAME code is refused on replay', async () => {
    const code = totp(secret);

    const first = await post(INSTANCES.a, adminToken, '/api/mfa/verify', { code });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.valid, true, 'a fresh code must verify');

    const replay = await post(INSTANCES.a, adminToken, '/api/mfa/verify', { code });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(
      replay.body.valid, false,
      'VULNERABILITY: the same TOTP code verified twice — a captured code stays replayable for up to 90 s',
    );
  });

  it('a code from an ALREADY-CONSUMED earlier step is refused (window replay)', async () => {
    // The previous step's code is normally still valid (±1 window). After a
    // later step has been consumed, it must be rejected as stale.
    const prevStepCode = totp(secret, Math.floor(Date.now() / 1000) - 30);
    const r = await post(INSTANCES.a, adminToken, '/api/mfa/verify', { code: prevStepCode });
    assert.equal(r.body.valid, false, 'a code from a step at/below the last consumed one must be refused');
  });

  it('an MFA-gated route accepts a fresh code but not its replay', async () => {
    // /api/admin/reload-config is requireAdminMfa — a real gated action.
    // The CURRENT step was already burned by the tests above, so take the NEXT
    // step's code: it is inside the +1 skew window (hence valid) and its step is
    // above the last consumed one (hence not a replay). Avoids a 30 s wait.
    const code = totp(secret, Math.floor(Date.now() / 1000) + 30);
    const first = await fetch(`${INSTANCES.a}/api/admin/reload-config`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        'x-totp-code': code,
      },
      body: '{}',
    });
    assert.equal(first.status, 200, 'a fresh code must pass the MFA gate');

    const replay = await fetch(`${INSTANCES.a}/api/admin/reload-config`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        'x-totp-code': code,
      },
      body: '{}',
    });
    assert.equal(replay.status, 403, 'VULNERABILITY: a replayed TOTP code passed the MFA gate');
  });
});
