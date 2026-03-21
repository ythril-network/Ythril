/**
 * Red-team tests: SSRF via invite handshake instanceUrl.
 *
 * The invite /apply endpoint accepts an `instanceUrl` via ApplyBody.
 * The schema uses `z.string().url()` — plain Zod URL validation — NOT the
 * `isSsrfSafeUrl()` SSRF validator used on the /networks member URL.
 *
 * This means an attacker can perform the invite handshake using a crafted
 * instanceUrl pointing at:
 *   - Cloud metadata endpoints (169.254.169.254, metadata.google.internal)
 *   - RFC-1918 private hosts
 *   - Localhost
 *   - IPv6 ULA / link-local
 *
 * The invite flow stores this URL in the pending member record and later
 * commits it to the network config.  If the server later POSTs sync data
 * to that URL, it will reach an internal host.
 *
 * These tests are EXPECTED TO FAIL until instanceUrl in ApplyBody is
 * changed to use the SSRF_SAFE_URL validator.
 *
 * Run: node --test testing/red-team-tests/ssrf-invite.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
let networkId;
let handshakeId;

// Generate a throw-away RSA-4096 key pair for the apply step.
// (real invite flow requires this; we just need a valid PEM here)
let rsaPublicKeyPem;

describe('SSRF — invite /apply must block private instanceUrl values', () => {
  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Create a network to attach the invite to
    const netR = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: 'ssrf-invite-test-net',
      type: 'closed',
      spaces: ['general'],
    });
    assert.equal(netR.status, 201, `Setup: failed to create network: ${JSON.stringify(netR.body)}`);
    networkId = netR.body.id;

    // Generate the handshake
    const genR = await post(INSTANCES.a, adminToken, '/api/invite/generate', {
      networkId,
    });
    assert.equal(genR.status, 201, `Setup: failed to generate invite: ${JSON.stringify(genR.body)}`);
    handshakeId = genR.body.handshakeId;

    // Generate a valid RSA public key for the apply body
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    rsaPublicKeyPem = publicKey;
  });

  after(async () => {
    if (networkId) {
      await fetch(`${INSTANCES.a}/api/networks/${networkId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  /**
   * Attempt an /apply with a crafted instanceUrl.
   * We generate a fresh handshake for each attempt since each call can
   * exhaust or invalidate the session.
   */
  async function tryApplyUrl(instanceUrl) {
    // Re-generate a fresh handshake for each attempt
    const genR = await post(INSTANCES.a, adminToken, '/api/invite/generate', {
      networkId,
    });
    if (genR.status !== 201) {
      // Skip gracefully if we can't get a handshake (e.g. network was deleted)
      return { status: 500, body: { error: 'setup failure: could not generate handshake' } };
    }
    const freshHandshakeId = genR.body.handshakeId;

    return post(INSTANCES.a, null, '/api/invite/apply', {
      handshakeId: freshHandshakeId,
      networkId,
      instanceId: crypto.randomUUID(),
      instanceLabel: 'SSRF probe instance',
      instanceUrl,
      rsaPublicKeyPem,
    });
  }

  it('AWS IMDS — 169.254.169.254 must be rejected with 400', async () => {
    const r = await tryApplyUrl('http://169.254.169.254/latest/meta-data/');
    assert.equal(r.status, 400,
      `VULNERABILITY: AWS IMDS URL accepted as instanceUrl in /invite/apply (got ${r.status}).\n` +
      `Change instanceUrl in ApplyBody from z.string().url() to SSRF_SAFE_URL.`);
  });

  it('Azure IMDS — 169.254.169.254 variant must be rejected with 400', async () => {
    const r = await tryApplyUrl('http://169.254.169.254:80/metadata/instance');
    assert.equal(r.status, 400,
      `VULNERABILITY: Azure IMDS URL 169.254.169.254 accepted (got ${r.status}).`);
  });

  it('GCP metadata FQDN must be rejected with 400', async () => {
    const r = await tryApplyUrl('http://metadata.google.internal/computeMetadata/v1/');
    assert.equal(r.status, 400,
      `VULNERABILITY: GCP metadata.google.internal accepted as instanceUrl (got ${r.status}).`);
  });

  it('RFC-1918 10.x address must be rejected with 400', async () => {
    const r = await tryApplyUrl('http://10.0.0.1:3200/');
    assert.equal(r.status, 400,
      `VULNERABILITY: RFC-1918 address 10.0.0.1 accepted (got ${r.status}).`);
  });

  it('Localhost must be rejected with 400', async () => {
    const r = await tryApplyUrl('http://localhost:3200/');
    assert.equal(r.status, 400,
      `VULNERABILITY: localhost accepted as instanceUrl (got ${r.status}).`);
  });

  it('IPv6 ULA must be rejected with 400', async () => {
    const r = await tryApplyUrl('http://[fd12:3456::1]:3200/');
    assert.equal(r.status, 400,
      `VULNERABILITY: IPv6 ULA accepted as instanceUrl (got ${r.status}).`);
  });

  it('URL with embedded credentials must be rejected with 400', async () => {
    const r = await tryApplyUrl('http://user:pass@example.com:3200/');
    assert.equal(r.status, 400,
      `VULNERABILITY: URL with embedded credentials accepted as instanceUrl (got ${r.status}).`);
  });
});
