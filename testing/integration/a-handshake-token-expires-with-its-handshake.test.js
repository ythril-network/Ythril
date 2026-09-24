/**
 * The peer token an invite handshake creates at APPLY lives only as long as the handshake — until FINALIZE makes the
 * membership real.
 *
 * Apply creates a PAT on the inviter for the joiner, before finalize registers the joiner as a member. It was
 * created with no expiry, and the handshake session that knew about it lives in memory for an hour. So a joiner that
 * applied and never finalized — it crashed, it was refused locally, the network dropped — left the inviter holding a
 * token to the network's spaces that never expired, belonged to no member record, and was listed nowhere a member is.
 * A restart in between orphaned it the same way, with no session left to clean up.
 *
 * Now the token carries the handshake's own expiry, which the auth path enforces, and finalize clears it.
 *
 * Run: node --test testing/integration/a-handshake-token-expires-with-its-handshake.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { INSTANCES, post, get, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let admin, networkId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, admin, '/api/networks', { label: `handshake-expiry-${Date.now()}`, type: 'closed', spaces: ['general'], votingDeadlineHours: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  networkId = r.body.id;
});
after(async () => { if (networkId) await del(INSTANCES.a, admin, `/api/networks/${networkId}`).catch(() => {}); });

function keys() {
  return generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
}
async function apply(instanceId) {
  const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const b = keys();
  const r = await post(INSTANCES.a, '', '/api/invite/apply', {
    handshakeId: gen.body.handshakeId, networkId, instanceId, instanceLabel: `joiner ${instanceId.slice(0, 4)}`,
    instanceUrl: 'http://ythril-b:3200', rsaPublicKeyPem: b.publicKey,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { handshakeId: gen.body.handshakeId, expiresAt: gen.body.expiresAt, apply: r.body, b };
}
async function peerToken(instanceId) {
  const r = await get(INSTANCES.a, admin, '/api/tokens');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = Array.isArray(r.body) ? r.body : (r.body.tokens ?? []);
  return list.find(t => t.peerInstanceId === instanceId);
}

describe('the handshake token', () => {
  it('after APPLY alone, expires with the handshake', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const h = await apply(id);
    const t = await peerToken(id);
    assert.ok(t, 'apply created a peer token');
    assert.ok(t.expiresAt, 'a token for a membership that does not exist yet must not live for ever');
    assert.ok(new Date(t.expiresAt) <= new Date(h.expiresAt), `the token outlives its handshake: ${t.expiresAt} > ${h.expiresAt}`);
  });

  it('after FINALIZE, lives with the membership', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const h = await apply(id);
    const tokenForB = privateDecrypt({ key: h.b.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(h.apply.encryptedTokenForB, 'base64')).toString('utf8');
    assert.ok(tokenForB.startsWith('ythril_'));
    const encryptedTokenForA = publicEncrypt({ key: h.apply.rsaPublicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(`ythril_${randomBytes(32).toString('base64url')}`, 'utf8')).toString('base64');
    const fin = await post(INSTANCES.a, '', '/api/invite/finalize', { handshakeId: h.handshakeId, encryptedTokenForA });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    const t = await peerToken(id);
    assert.equal(t?.expiresAt ?? null, null, 'a member\'s token must not expire an hour after it joined');
    assert.equal((await get(INSTANCES.a, tokenForB, '/api/tokens/me')).status, 200, 'and it still authenticates');
  });
});
