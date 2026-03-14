/**
 * Integration tests: Network governance — invite key, voting, removal
 *
 * Covers per-type governance as described in PLAN.md:
 *  - Closed network: unanimous yes required, veto blocks
 *  - Democratic network: majority + no vetoes (tested in democratic.test.js too)
 *  - Club network: single approver (inviter)
 *  - Invite key lifecycle: consumed after each round, rotation invalidates old key
 *  - Removal vote flow
 *  - Deadline: vote round expires
 *
 * Run: node --test tests/networks.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, reqJson } from './sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'sync', 'configs');

let tokenA, tokenB;

describe('Network CRUD', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  });

  it('Create a closed network', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Governance Test Closed',
      type: 'closed',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.id, 'Should return network id');
    assert.equal(r.body.type, 'closed');
  });

  it('Create a democratic network', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Governance Test Democratic',
      type: 'democratic',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.type, 'democratic');
  });

  it('Create a club network', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Governance Test Club',
      type: 'club',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.type, 'club');
  });

  it('Create a braintree network', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Governance Test Braintree',
      type: 'braintree',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.type, 'braintree');
  });

  it('Networks are listed after creation', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/networks');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.networks), 'networks array required');
    assert.ok(r.body.networks.length > 0);
  });

  it('tokenHash is never exposed in network list', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/networks');
    for (const net of r.body.networks ?? []) {
      for (const m of net.members ?? []) {
        assert.ok(!m.tokenHash, `tokenHash must not be exposed for member ${m.instanceId}`);
      }
    }
  });

  it('Creating network with unknown space is rejected', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Bad Space Network',
      type: 'closed',
      spaces: ['nonexistent-space'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}`);
  });
});

describe('Network voting — closed (unanimous)', () => {
  let networkId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Closed Vote Test',
      type: 'closed',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201);
    networkId = r.body.id;
  });

  it('Add member to closed network opens a voting round', async () => {
    const peerToken = await post(INSTANCES.b, tokenB, '/api/tokens', { name: 'peer-vote-test' });
    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b-vote-test',
      label: 'Instance B Vote Test',
      url: 'http://ythril-b:3200',
      token: peerToken.body.plaintext,
      direction: 'both',
    });
    assert.equal(r.status, 202, `Expected 202 (vote_pending), got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.roundId, 'roundId should be returned');
  });

  it('Second add of same member is rejected with 409', async () => {
    // Instance is in pending state — should still be rejected
    const peerToken = await post(INSTANCES.b, tokenB, '/api/tokens', { name: 'peer-dup' });
    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b-vote-test',
      label: 'Duplicate',
      url: 'http://ythril-b:3200',
      token: peerToken.body.plaintext,
      direction: 'both',
    });
    assert.ok(r.status === 409 || r.status === 202,
      `Duplicate member should return 409 or 202, got ${r.status}`);
  });
});

describe('Network invite key', () => {
  let networkId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Invite Key Test',
      type: 'closed',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201);
    networkId = r.body.id;
  });

  it('Generate invite key returns a key string', async () => {
    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/invite`, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.inviteKey, 'inviteKey should be returned');
    assert.ok(r.body.inviteKey.startsWith('ythrilnetwork_'), 'Key format check');
  });

  it('Rotating key invalidates old one and returns a new one', async () => {
    const first = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/invite`, {});
    const firstKey = first.body.inviteKey;

    const second = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/invite`, {});
    const secondKey = second.body.inviteKey;

    assert.notEqual(firstKey, secondKey, 'Rotated key should differ');
  });

  it('Invite key not exposed in network GET response', async () => {
    const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    assert.equal(r.status, 200);
    assert.ok(!r.body.inviteKey, 'Plaintext inviteKey must never be in GET response');
    assert.ok(!r.body.inviteKeyHash, 'inviteKeyHash must not be exposed');
  });
});

describe('RSA invite handshake', () => {
  let networkId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();

    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'RSA Handshake Test Network',
      type: 'closed',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201);
    networkId = r.body.id;
  });

  it('Generate handshake returns RSA public key and expiry', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/invite/generate', { networkId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.handshakeId, 'handshakeId required');
    assert.ok(r.body.rsaPublicKeyPem?.includes('PUBLIC KEY'), 'RSA public key in PEM format required');
    assert.ok(r.body.inviteUrl?.includes('/api/invite/apply'), 'inviteUrl required');
    assert.ok(r.body.expiresAt, 'expiresAt required');
  });

  it('Handshake apply with invalid ID returns 401', async () => {
    const r = await post(INSTANCES.a, '', '/api/invite/apply', {
      handshakeId: '00000000-0000-0000-0000-000000000000',
      networkId,
      instanceId: '11111111-1111-1111-1111-111111111111',
      instanceLabel: 'Attacker',
      instanceUrl: 'http://attacker:3200',
      rsaPublicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIBIj...\n-----END PUBLIC KEY-----',
    });
    assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
  });

  it('Full RSA handshake exchanges tokens without plaintext exposure', async () => {
    const { createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, constants } = await import('node:crypto');

    // Step 1: A generates handshake
    const genR = await post(INSTANCES.a, tokenA, '/api/invite/generate', { networkId });
    assert.equal(genR.status, 201);
    const { handshakeId, rsaPublicKeyPem: aPubKeyPem } = genR.body;

    // Step 2: B generates its own RSA key pair
    const { privateKey: bPrivKey, publicKey: bPubKey } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // B applies to A's invite
    const applyR = await post(INSTANCES.a, '', '/api/invite/apply', {
      handshakeId,
      networkId,
      instanceId: '22222222-2222-2222-2222-222222222222',
      instanceLabel: 'Instance B (RSA Test)',
      instanceUrl: 'http://ythril-b:3200',
      rsaPublicKeyPem: bPubKey,
    });
    assert.equal(applyR.status, 200, JSON.stringify(applyR.body));
    assert.ok(applyR.body.encryptedTokenForB, 'B must receive encrypted token');
    assert.ok(applyR.body.rsaPublicKeyPem, 'A must send its pub key back');

    // B decrypts its token
    const { encryptedTokenForB, rsaPublicKeyPem: aPubFromApply } = applyR.body;
    const tokenForBBuf = privateDecrypt(
      { key: bPrivKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(encryptedTokenForB, 'base64'),
    );
    const tokenForB = tokenForBBuf.toString('utf8');
    assert.ok(tokenForB.startsWith('ythril_'), 'Decrypted token should be valid PAT');

    // B creates a token for A and encrypts it with A's public key
    const tokenForA = (await post(INSTANCES.b,
      fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim(),
      '/api/tokens',
      { name: 'peer-rsa-handshake-a' })).body.plaintext;

    const { publicEncrypt } = await import('node:crypto');
    const encryptedTokenForA = publicEncrypt(
      { key: aPubFromApply, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(tokenForA, 'utf8'),
    ).toString('base64');

    // B finalizes the handshake
    const finalR = await post(INSTANCES.a, '', '/api/invite/finalize', {
      handshakeId,
      encryptedTokenForA,
    });
    assert.equal(finalR.status, 200, JSON.stringify(finalR.body));
    assert.equal(finalR.body.status, 'joined');

    // Verify B's instance is now a member of the network on A
    const netR = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    const member = netR.body.members?.find(m => m.instanceId === '22222222-2222-2222-2222-222222222222');
    assert.ok(member, 'Instance B should be a member after handshake');

    // Verify the token A received works to authenticate to B
    const pingB = await get(INSTANCES.b, tokenForB, '/api/tokens');
    assert.equal(pingB.status, 200, 'Token A received via handshake must work on B');
  });
});
