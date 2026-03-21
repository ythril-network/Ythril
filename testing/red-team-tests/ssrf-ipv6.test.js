/**
 * Red-team tests: IPv6 SSRF gaps in network peer URL validation.
 *
 * The existing isSsrfSafeUrl() in networks.ts blocks RFC-1918 IPv4, loopback,
 * and localhost — but it does NOT block:
 *  - IPv6 ULA addresses  (fc00::/7 → fc__ and fd__)
 *  - IPv6 link-local     (fe80::/10 → fe80 through fe_B_)
 *
 * These tests are EXPECTED TO FAIL until the fix is applied.
 *
 * Run: node --test testing/red-team-tests/ssrf-ipv6.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
let networkId;

describe('SSRF — IPv6 ULA and link-local addresses must be blocked', () => {
  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    const r = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: 'ssrf-ipv6-test-network',
      type: 'closed',
      spaces: ['general'],
    });
    assert.equal(r.status, 201, `Setup failed to create network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;
  });

  after(async () => {
    if (networkId) {
      await fetch(`${INSTANCES.a}/api/networks/${networkId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  async function tryMemberUrl(url) {
    return post(INSTANCES.a, adminToken, `/api/networks/${networkId}/members`, {
      instanceId: 'ssrf-ipv6-probe',
      label: 'IPv6 SSRF probe',
      url,
      token: 'ythril_fakefakefakefakefakefakefake',
    });
  }

  // ── IPv6 ULA (fc00::/7) ──────────────────────────────────────────────────
  // fc00::/7 covers fc__ and fd__ prefixes.
  // These are "Unique Local Addresses" — RFC 4193 — private IPv6 equivalents
  // of 10.x.x.x / 172.16.x.x / 192.168.x.x.  Must never be reachable as
  // a sync peer.

  it('fc00::1 (ULA fc00::/8 lower half) must be rejected with 400', async () => {
    const r = await tryMemberUrl('http://[fc00::1]:3200/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 ULA fc00::1 was not blocked (got ${r.status}).\n` +
      `Add /^f[cd][0-9a-f]{0,2}:/i check to isSsrfSafeUrl().`);
  });

  it('fd12:3456:789a::1 (ULA fd00::/8 upper half) must be rejected with 400', async () => {
    const r = await tryMemberUrl('http://[fd12:3456:789a::1]:3200/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 ULA fd12:3456:789a::1 was not blocked (got ${r.status}).`);
  });

  it('fd00::1 (ULA lower bound) must be rejected with 400', async () => {
    const r = await tryMemberUrl('http://[fd00::1]/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 ULA fd00::1 was not blocked (got ${r.status}).`);
  });

  it('fc80::1 (ULA variant) must be rejected with 400', async () => {
    const r = await tryMemberUrl('http://[fc80::1]/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 ULA fc80::1 (fc00::/7) was not blocked (got ${r.status}).`);
  });

  // ── IPv6 link-local (fe80::/10) ──────────────────────────────────────────
  // fe80::/10 covers fe80 through feBF (fe80, fe90, fea0, feb0).
  // These are link-local — analogous to 169.254.x.x. They could allow
  // reaching NIC-local services on the server host.

  it('fe80::1 (link-local canonical) must be rejected with 400', async () => {
    const r = await tryMemberUrl('http://[fe80::1]/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 link-local fe80::1 was not blocked (got ${r.status}).\n` +
      `Add /^fe[89ab][0-9a-f]:/i check to isSsrfSafeUrl().`);
  });

  it('fe80::1%eth0 (link-local with zone ID) must be rejected with 400', async () => {
    // Browsers percent-encode zone IDs; Node's URL parser normalises them.
    // The test uses the percent-encoded form that the URL class accepts.
    const r = await tryMemberUrl('http://[fe80::1%25eth0]/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 link-local with zone ID was not blocked (got ${r.status}).`);
  });

  it('feb0::1 (link-local feBF boundary) must be rejected with 400', async () => {
    const r = await tryMemberUrl('http://[feb0::1]/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 link-local feb0::1 was not blocked (got ${r.status}).`);
  });

  it('fe89::1 (link-local fe89) must be rejected with 400', async () => {
    const r = await tryMemberUrl('http://[fe89::1]/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 link-local fe89::1 was not blocked (got ${r.status}).`);
  });

  // ── IPv6 loopback (::1) — already blocked, regression guard ─────────────

  it('::1 (loopback) is still blocked — regression guard', async () => {
    const r = await tryMemberUrl('http://[::1]:3200/');
    assert.equal(r.status, 400, `Regression: IPv6 loopback ::1 is no longer blocked (got ${r.status}).`);
  });

  // ── Public IPv6 (2001:db8 is documentation range; use a real public prefix) ─

  it('A syntactically valid IPv6 URL with a non-private prefix is NOT auto-rejected', async () => {
    // 2606:4700::6810:1 is a Cloudflare public IP — the server will likely
    // time out trying to reach it, but the SSRF validator should PASS the URL.
    // We only check that it was not rejected with 400 (SSRF block); a 50x/timeout
    // is fine here.
    const r = await tryMemberUrl('http://[2606:4700::6810:1]:3200/');
    assert.notEqual(r.status, 400,
      `False positive: public IPv6 2606:4700::6810:1 was blocked when it should not be.`);
  });
});
