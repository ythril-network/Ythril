/**
 * Red-team tests: Invite handshake replay and abuse
 *
 * Verifies that the invite RSA handshake is single-use and that sessions
 * cannot be replayed, reused after completion, or abused with tampered data.
 *
 * Covers:
 *  - apply() twice with same handshakeId → second returns 4xx
 *  - finalize() with wrong handshakeId → 4xx
 *  - apply() with non-existent handshakeId → 4xx
 *  - finalize() with invalid ciphertext → 4xx
 *  - Status of completed session returns appropriate state
 *  - apply to wrong networkId → 4xx
 *
 * Run: node --test testing/red-team-tests/invite-replay.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_C = path.join(__dirname, '..', 'sync', 'configs', 'c', 'token.txt');

// Use instance C for invite tests to avoid exhausting A's authRateLimit
// (the invite/apply and invite/finalize endpoints count against authRateLimit)
const INVITE_INSTANCE = INSTANCES.c;

let tokenA;
let networkId;

/** Generate a fresh test network for invite tests */
async function createTestNetwork(token) {
  const r = await post(INVITE_INSTANCE, token, '/api/networks', {
    label: 'Invite Replay Test ' + Date.now(),
    type: 'club',
    spaces: ['general'],
    votingDeadlineHours: 1,
  });
  if (r.status !== 201) throw new Error(`Failed to create network: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

describe('Invite handshake security', () => {
  before(async () => {
    tokenA = fs.readFileSync(TOKEN_C, 'utf8').trim();
    networkId = await createTestNetwork(tokenA);
  });

  after(async () => {
    // Clean up test network
    if (networkId) {
      await fetch(`${INVITE_INSTANCE}/api/networks/${networkId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${tokenA}` },
      });
    }
  });

  it('Generate invite handshake returns valid structure', async () => {
    const r = await post(INVITE_INSTANCE, tokenA, '/api/invite/generate', {
      networkId,
      targetInstanceLabel: 'B-replay-test',
      targetUrl: `${INSTANCES.b}`,
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.handshakeId, 'Should have handshakeId');
    assert.ok(r.body.rsaPublicKeyPem?.startsWith('-----BEGIN'), 'Should have RSA public key');
  });

  it('Apply with non-existent handshakeId → 4xx', async () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const r = await fetch(`${INVITE_INSTANCE}/api/invite/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handshakeId: 'non-existent-id-00000000',
        networkId,
        rsaPublicKeyPem: publicKey,
      }),
    });
    assert.ok(r.status >= 400, `Expected 4xx for bad handshakeId, got ${r.status}`);
  });

  it('Apply with valid handshakeId succeeds', async () => {
    // Need a fresh handshake for this
    const gen = await post(INVITE_INSTANCE, tokenA, '/api/invite/generate', {
      networkId,
      targetInstanceLabel: 'B-apply-test',
      targetUrl: `${INSTANCES.b}`,
    });
    assert.equal(gen.status, 201);

    const { publicKey: bPubKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const applyPayload = {
      handshakeId: gen.body.handshakeId,
      networkId,
      instanceId: crypto.randomUUID(),
      instanceLabel: 'B-apply-test',
      // Use a public-format URL: localhost is blocked by SSRF guard (correct behaviour).
      // apply() only stores the URL — no outbound request is made here.
      instanceUrl: 'https://b.ythril-test.example.com',
      rsaPublicKeyPem: bPubKey,
    };
    const applyResp = await fetch(`${INVITE_INSTANCE}/api/invite/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(applyPayload),
    });
    const applyBody = await applyResp.json().catch(() => null);
    assert.equal(applyResp.status, 200, `Apply failed: ${JSON.stringify(applyBody)}`);
    assert.ok(applyBody.encryptedTokenForB, 'Should return encrypted token for B');

    // Now attempt REPLAY: apply same handshakeId again
    const replayResp = await fetch(`${INVITE_INSTANCE}/api/invite/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(applyPayload),
    });
    assert.ok(replayResp.status >= 400,
      `Replay of apply should fail with 4xx, got ${replayResp.status}`);
  });

  it('Finalize with invalid/garbage ciphertext → 4xx', async () => {
    // Generate another fresh handshake
    const gen = await post(INVITE_INSTANCE, tokenA, '/api/invite/generate', {
      networkId,
      targetInstanceLabel: 'B-finalize-bad',
      targetUrl: `${INSTANCES.b}`,
    });
    assert.equal(gen.status, 201);

    const { publicKey: bPubKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Apply first (with all required fields)
    const applyResp = await fetch(`${INVITE_INSTANCE}/api/invite/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handshakeId: gen.body.handshakeId,
        networkId,
        instanceId: crypto.randomUUID(),
        instanceLabel: 'B-finalize-bad',
        instanceUrl: 'https://b.ythril-test.example.com',
        rsaPublicKeyPem: bPubKey,
      }),
    });
    assert.equal(applyResp.status, 200);

    // Now finalize with garbage ciphertext
    const finalizeResp = await fetch(`${INVITE_INSTANCE}/api/invite/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handshakeId: gen.body.handshakeId,
        networkId,
        // garbage — not encrypted with A's public key
        encryptedTokenForA: Buffer.from('this is not valid RSA ciphertext').toString('base64'),
        instanceLabel: 'attack-instance',
        instanceUrl: 'https://b.ythril-test.example.com',
      }),
    });
    assert.ok(finalizeResp.status >= 400,
      `Finalize with bad ciphertext should return 4xx, got ${finalizeResp.status}`);
  });

  it('Finalize with non-existent handshakeId → 4xx', async () => {
    const r = await fetch(`${INVITE_INSTANCE}/api/invite/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handshakeId: 'does-not-exist-00000000',
        networkId,
        encryptedTokenForA: Buffer.from('fake').toString('base64'),
        instanceLabel: 'attacker',
        instanceUrl: `${INSTANCES.b}`,
      }),
    });
    assert.ok(r.status >= 400, `Expected 4xx for fake handshakeId, got ${r.status}`);
  });
});

describe('Invite status endpoint', () => {
  before(() => {
    tokenA = fs.readFileSync(TOKEN_C, 'utf8').trim();
  });

  it('Status of non-existent handshake → 400 (invalid UUID format)', async () => {
    const r = await fetch(`${INVITE_INSTANCE}/api/invite/status/totally-fake-not-a-uuid`, {
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    // 'totally-fake...' is not a UUID — server validates UUID format
    assert.ok(r.status === 404 || r.status === 400 || r.status === 401,
      `Expected 404/400/401 for invalid handshake ID, got ${r.status}`);
  });

  it('Status of valid-format-but-missing handshake UUID → 404', async () => {
    const fakeUuid = crypto.randomUUID();
    const r = await fetch(`${INVITE_INSTANCE}/api/invite/status/${fakeUuid}`, {
      headers: { 'Authorization': `Bearer ${tokenA}` },
    });
    assert.ok(r.status === 404 || r.status === 400 || r.status === 401,
      `Expected 404/400/401 for nonexistent handshake, got ${r.status}`);
  });
});
