/**
 * Joining a second network with the same peer must not cut off the first (`Q-47`).
 *
 * An instance keeps ONE outbound token per peer, so the token the newest handshake hands over is the one the joiner
 * uses for every network the two share. It was scoped to the joining network's spaces alone, so after a second join
 * every request on the first network answered 403 — in both directions, immediately, and silently. Found moving the
 * `flows` space between two instances: `flows` (pub/sub) then `flows-feedback` (club) with the same peer.
 *
 * Run: node --test testing/integration/a-second-network-with-the-same-peer-keeps-the-first.test.js
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

const JOINER = '55555555-5555-4555-8555-555555555555';
const SECOND_SPACE = `q47-second-${Date.now()}`;
let admin, latest;
const networks = [];

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const s = await post(INSTANCES.a, admin, '/api/spaces', { id: SECOND_SPACE, label: 'Q-47 second' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  for (const space of ['general', SECOND_SPACE]) {
    const r = await post(INSTANCES.a, admin, '/api/networks', { label: `q47-${space}`, type: 'club', spaces: [space] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    networks.push({ id: r.body.id, space });
  }
});
after(async () => {
  for (const n of networks) await del(INSTANCES.a, admin, `/api/networks/${n.id}`).catch(() => {});
  await del(INSTANCES.a, admin, `/api/spaces/${SECOND_SPACE}`).catch(() => {});
});

/** Run the whole handshake as the joiner would, and return the token the inviter handed it. */
async function join(networkId) {
  const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const b = generateKeyPairSync('rsa', { modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const apply = await post(INSTANCES.a, '', '/api/invite/apply', {
    handshakeId: gen.body.handshakeId, networkId, instanceId: JOINER, instanceLabel: 'q47 joiner',
    instanceUrl: 'http://ythril-b:3200', rsaPublicKeyPem: b.publicKey,
  });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  const tokenForB = privateDecrypt({ key: b.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(apply.body.encryptedTokenForB, 'base64')).toString('utf8');
  const encryptedTokenForA = publicEncrypt({ key: apply.body.rsaPublicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`ythril_${randomBytes(32).toString('base64url')}`, 'utf8')).toString('base64');
  const fin = await post(INSTANCES.a, '', '/api/invite/finalize', { handshakeId: gen.body.handshakeId, encryptedTokenForA });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  return tokenForB;
}

const syncRead = (token, n) => get(INSTANCES.a, token, `/api/sync/entities?spaceId=${n.space}&networkId=${n.id}&limit=1`);

describe('two networks between the same pair', () => {
  it('the token from the LATEST handshake still reaches every network the pair shares', async () => {
    await join(networks[0].id);
    latest = await join(networks[1].id);
    for (const n of networks) {
      const r = await syncRead(latest, n);
      assert.equal(r.status, 200, `the peer can no longer sync network '${n.space}': ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  it('and reaches nothing the pair does not share', async () => {
    assert.ok(latest, 'needs the token from the case above');
    const r = await get(INSTANCES.a, latest, `/api/sync/entities?spaceId=general&networkId=${networks[1].id}&limit=1`);
    assert.equal(r.status, 403, `a space outside the named network must still be refused: ${r.status}`);
  });
});
