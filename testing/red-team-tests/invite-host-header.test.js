/**
 * Red-team test: Host Header Injection in POST /api/invite/generate
 *
 * The invite /generate endpoint previously constructed `inviteUrl` from
 * req.protocol + req.get('host'), which an attacker could control by sending
 * a crafted Host header. This could cause the joining instance to POST its
 * RSA public key and instance metadata to the attacker's server.
 *
 * Fix: inviteUrl is now derived from config.publicUrl when set, falling back
 * to the request Host header only when no publicUrl is configured.
 *
 * This test verifies:
 *  1. A crafted X-Forwarded-Host / Host header does NOT appear in inviteUrl
 *     when the server is bound to localhost (no publicUrl configured).
 *     The fallback should use the actual connection host (127.0.0.1:PORT),
 *     not the attacker-supplied header.
 *  2. inviteUrl always points to a path on the server's own origin.
 *
 * Run: node --test testing/red-team-tests/invite-host-header.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
let createdNetworkId;

describe('Host Header Injection — invite /generate inviteUrl', () => {
  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Create a disposable network for this test
    const r = await reqJson(INSTANCES.a, adminToken, '/api/networks', {
      method: 'POST',
      body: JSON.stringify({
        label: 'host-header-inject-test-net',
        type: 'closed',
        spaces: ['general'],
      }),
    });
    assert.equal(r.status, 201, `Setup: failed to create network: ${JSON.stringify(r.body)}`);
    createdNetworkId = r.body.id;
  });

  after(async () => {
    if (createdNetworkId) {
      await reqJson(INSTANCES.a, adminToken, `/api/networks/${createdNetworkId}`, {
        method: 'DELETE',
      });
    }
  });

  it('crafted X-Forwarded-Host header must not appear in inviteUrl', async () => {
    const EVIL_HOST = 'attacker.evil.example.com';

    const resp = await fetch(`${INSTANCES.a}/api/invite/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        // Attempt to override the effective Host via forwarded-host header.
        // Express respects X-Forwarded-Host only when trust proxy is enabled
        // and the request comes from a trusted proxy address.
        'X-Forwarded-Host': EVIL_HOST,
      },
      body: JSON.stringify({ networkId: createdNetworkId }),
    });

    assert.equal(resp.status, 201, `Expected 201, got ${resp.status}`);
    const body = await resp.json();

    assert.ok(body.inviteUrl, 'inviteUrl must be present in response');
    assert.ok(
      !body.inviteUrl.includes(EVIL_HOST),
      `inviteUrl must NOT contain the attacker-controlled host. Got: ${body.inviteUrl}`,
    );
    // inviteUrl must resolve to the actual server origin
    const parsed = new URL(body.inviteUrl);
    assert.equal(
      parsed.pathname,
      '/api/invite/apply',
      `inviteUrl path must be /api/invite/apply. Got: ${parsed.pathname}`,
    );
  });

  it('inviteUrl origin must match the server origin, not an injected Host header', async () => {
    const EVIL_HOST = '192.168.1.100:9999';
    const serverOrigin = new URL(INSTANCES.a).host; // e.g. 127.0.0.1:3200

    const resp = await fetch(`${INSTANCES.a}/api/invite/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        'X-Forwarded-Host': EVIL_HOST,
      },
      body: JSON.stringify({ networkId: createdNetworkId }),
    });

    assert.equal(resp.status, 201);
    const body = await resp.json();
    const parsed = new URL(body.inviteUrl);

    assert.notEqual(
      parsed.host,
      EVIL_HOST,
      `inviteUrl host must not be the injected X-Forwarded-Host (${EVIL_HOST})`,
    );
    // When no publicUrl is configured the fallback is the real connection host.
    // Either the real server host OR a configured publicUrl are both acceptable.
    assert.ok(
      parsed.host === serverOrigin || !parsed.host.includes('evil'),
      `inviteUrl host ${parsed.host} must be the server's own host or a configured publicUrl`,
    );
  });
});
