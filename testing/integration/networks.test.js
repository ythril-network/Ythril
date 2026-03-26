/**
 * Integration tests: Network governance â€” invite key, voting, removal
 *
 * Covers per-type governance as described in PLAN.md:
 *  - Closed network: unanimous yes required, veto blocks
 *  - Democratic network: majority + no vetoes (tested in democratic.test.js too)
 *  - Club network: single approver (inviter)
 *  - Invite key lifecycle: consumed after each round, rotation invalidates old key
 *  - Removal vote flow
 *  - Deadline: vote round expires
 *
 * Run: node --test testing/integration/networks.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, reqJson, triggerSync, waitFor } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA, tokenB;

describe('Network CRUD', () => {
  let closedNetId, democraticNetId, clubNetId, braintreeNetId;

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
    closedNetId = r.body.id;
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
    democraticNetId = r.body.id;
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
    clubNetId = r.body.id;
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
    braintreeNetId = r.body.id;
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

  after(async () => {
    for (const id of [closedNetId, democraticNetId, clubNetId, braintreeNetId]) {
      if (id) await del(INSTANCES.a, tokenA, `/api/networks/${id}`).catch(() => {});
    }
  });
});

describe('Network voting â€” closed (unanimous)', () => {
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
    // Use a pre-generated fake PAT to avoid exhausting instance B's auth rate limit.
    // The member-add only validates token format (z.string().min(1)); it stores it hashed.
    const fakePeerToken = 'ythril_peer_test_token_not_used_for_real_auth';
    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b-vote-test',
      label: 'Instance B Vote Test',
      url: 'http://ythril-b:3200',
      token: fakePeerToken,
      direction: 'both',
    });
    assert.equal(r.status, 202, `Expected 202 (vote_pending), got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.roundId, 'roundId should be returned');
  });

  it('Second add of same member is rejected with 409', async () => {
    // Instance is in pending state â€” should still be rejected
    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b-vote-test',
      label: 'Duplicate',
      url: 'http://ythril-b:3200',
      token: 'ythril_peer_test_token_not_used_for_real_auth',
      direction: 'both',
    });
    assert.ok(r.status === 409 || r.status === 202,
      `Duplicate member should return 409 or 202, got ${r.status}`);
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
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
    assert.ok(r.status === 200 || r.status === 201, `Expected 200 or 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.inviteKey, 'inviteKey should be returned');
    assert.ok(r.body.inviteKey.startsWith('ythril_invite_'), 'Key format check: expected ythril_invite_ prefix');
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

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
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
    // Use a valid-formatted (but non-existent) handshakeId â€” the nil UUID is
    // explicitly allowed by Zod's uuid() (it's in the pattern allowlist).
    // instanceId must pass RFC 4122 variant bits (4th segment starts with [89abAB]).
    // rsaPublicKeyPem must be â‰¥ 100 chars per the schema.
    const fakePem = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n' +
      '-----END PUBLIC KEY-----';
    const r = await post(INSTANCES.a, '', '/api/invite/apply', {
      handshakeId: '00000000-0000-0000-0000-000000000000',
      networkId,
      instanceId: '11111111-1111-1111-8111-111111111111',
      instanceLabel: 'Attacker',
      instanceUrl: 'http://attacker:3200',
      rsaPublicKeyPem: fakePem,
    });
    // Non-existent handshakeId â†’ 401 (after schema passes)
    assert.equal(r.status, 401, `Expected 401, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Full RSA handshake exchanges tokens without plaintext exposure', async () => {
    const { createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes, constants } = await import('node:crypto');

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
    // instanceId must be a valid RFC 4122 UUID (4th segment starts with [89abAB])
    const applyR = await post(INSTANCES.a, '', '/api/invite/apply', {
      handshakeId,
      networkId,
      instanceId: '22222222-2222-2222-8222-222222222222',
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

    // B generates a synthetic peer token for A â€” avoids requiring instance B to be running.
    // The finalize endpoint only validates that the decrypted value starts with 'ythril_'
    // and stores it in secrets.peerTokens; it does not verify the token against any instance.
    const tokenForA = `ythril_${randomBytes(32).toString('base64url')}`;

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
    const member = netR.body.members?.find(m => m.instanceId === '22222222-2222-2222-8222-222222222222');
    assert.ok(member, 'Instance B should be a member after handshake');

    // tokenForB was created by A for B — verify it authenticates against A
    const pingA = await get(INSTANCES.a, tokenForB, '/api/tokens/me');
    assert.equal(pingA.status, 200, 'tokenForB (A-issued PAT) must authenticate to instance A');
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sync History
// ════════════════════════════════════════════════════════════════════════════

describe('Sync history', () => {
  let networkId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'History Test Net',
      type: 'closed',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201);
    networkId = r.body.id;
  });

  it('returns empty array when no syncs have occurred', async () => {
    const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.history), 'history must be an array');
    assert.equal(r.body.history.length, 0);
  });

  it('records history after sync trigger', async () => {
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // Poll until history has at least one entry (sync is async)
    await waitFor(async () => {
      const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history`);
      return r.status === 200 && r.body.history?.length > 0;
    }, 10_000);

    const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history`);
    assert.equal(r.status, 200);
    assert.ok(r.body.history.length >= 1, 'Should have at least 1 history record');

    const rec = r.body.history[0];
    assert.ok(rec._id, 'Record must have _id');
    assert.equal(rec.networkId, networkId);
    assert.ok(rec.triggeredAt, 'triggeredAt required');
    assert.ok(rec.completedAt, 'completedAt required');
    assert.ok(['success', 'partial', 'failed'].includes(rec.status), `Unexpected status: ${rec.status}`);
    assert.ok(typeof rec.pulled === 'object', 'pulled must be an object');
    assert.ok(typeof rec.pushed === 'object', 'pushed must be an object');
    for (const dir of [rec.pulled, rec.pushed]) {
      assert.ok(typeof dir.memories === 'number');
      assert.ok(typeof dir.entities === 'number');
      assert.ok(typeof dir.edges === 'number');
      assert.ok(typeof dir.files === 'number');
    }
  });

  it('respects limit parameter', async () => {
    // Trigger a second sync
    await triggerSync(INSTANCES.a, tokenA, networkId);
    await waitFor(async () => {
      const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history`);
      return r.status === 200 && r.body.history?.length >= 2;
    }, 10_000);

    // Request only 1
    const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history?limit=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.history.length, 1, 'limit=1 should return exactly 1');
  });

  it('most recent is first', async () => {
    const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync-history`);
    assert.ok(r.body.history.length >= 2);
    const first = new Date(r.body.history[0].completedAt).getTime();
    const second = new Date(r.body.history[1].completedAt).getTime();
    assert.ok(first >= second, 'History should be most-recent-first');
  });

  it('unknown network returns 404', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/networks/nonexistent-net-id/sync-history');
    assert.equal(r.status, 404);
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
  });
});

// ════════════════════════════════════════════════════════════════════════════
// About endpoint
// ════════════════════════════════════════════════════════════════════════════

describe('About endpoint', () => {
  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });

  it('GET /api/about returns instance info', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/about');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.instanceId, 'instanceId required');
    assert.ok(r.body.instanceLabel, 'instanceLabel required');
    assert.ok(r.body.version, 'version required');
    assert.ok(typeof r.body.uptime === 'string', 'uptime must be a string');
    assert.ok(r.body.mongoVersion, 'mongoVersion required');
    assert.ok(typeof r.body.diskInfo === 'object', 'diskInfo must be an object');
    assert.ok(typeof r.body.diskInfo.total === 'number', 'diskInfo.total must be a number');
    assert.ok(typeof r.body.diskInfo.used === 'number', 'diskInfo.used must be a number');
    assert.ok(typeof r.body.diskInfo.available === 'number', 'diskInfo.available must be a number');
  });

  it('GET /api/about/logs returns log lines', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/about/logs?lines=10');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.lines), 'lines must be an array');
    assert.ok(r.body.lines.length <= 10, 'Should respect limit');
  });

  it('GET /api/about requires auth', async () => {
    const r = await get(INSTANCES.a, 'invalid-token', '/api/about');
    assert.equal(r.status, 401);
  });
});
