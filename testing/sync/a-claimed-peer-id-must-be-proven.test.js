/**
 * An invite applied under the instance id of a peer this instance already knows must prove it IS that peer (`S-6`).
 *
 * The token minted at apply reaches every network the inviter shares with the CLAIMED id (the Q-47 union), and the sync
 * door admits a peer token to every network that id belongs to. So an unproven claim let anyone holding a bundle for
 * one network apply as a real peer and read every space the inviter shares with it. A known id now has to present a
 * token this instance issued to that peer; the genuine peer's own join does so, and an unknown id joins as before.
 *
 * A and B share a first network; A invites B's id into a second one.
 *
 * Run: node --test testing/sync/a-claimed-peer-id-must-be-proven.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACES = [`s6-one-${RUN}`, `s6-two-${RUN}`];
const token = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();

let tA, tB, idB;
const nets = [];

async function network(space) {
  assert.equal((await post(INSTANCES.a, tA, '/api/spaces', { id: space, label: space })).status, 201);
  const n = await post(INSTANCES.a, tA, '/api/networks', { label: `${space}-net`, type: 'club', spaces: [space] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  nets.push(n.body.id);
  return n.body.id;
}
async function bundle(networkId) {
  const inv = await post(INSTANCES.a, tA, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  return { handshakeId: inv.body.handshakeId, networkId };
}
const joinOnB = (b) => post(INSTANCES.b, tB, '/api/networks/join-remote', {
  ...b, inviteUrl: 'http://ythril-a:3200/api/invite/apply', rsaPublicKeyPem: 'x'.repeat(120), myUrl: 'http://ythril-b:3200',
});

before(async () => {
  [tA, tB] = ['a', 'b'].map(token);
  idB = (await get(INSTANCES.b, tB, '/api/about')).body.instanceId;
  const first = await bundle(await network(SPACES[0]));
  const j = await joinOnB(first);
  assert.equal(j.status, 200, `B could not join the first network: ${JSON.stringify(j.body)}`);
});

after(async () => {
  for (const [base, tok] of [[INSTANCES.a, tA], [INSTANCES.b, tB]]) {
    for (const id of nets) await del(base, tok, `/api/networks/${id}`).catch(() => {});
    for (const s of SPACES) await delWithBody(base, tok, `/api/spaces/${s}`, { confirm: true }).catch(() => {});
  }
});

describe('applying under a known peer\'s id', () => {
  it('without proof is refused, and no token is minted for it', async () => {
    const b = await bundle(await network(SPACES[1]));
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const before = (await get(INSTANCES.a, tA, '/api/tokens')).body;
    const count = (Array.isArray(before) ? before : before.tokens).filter(t => t.peerInstanceId === idB).length;

    const r = await post(INSTANCES.a, '', '/api/invite/apply', {
      handshakeId: b.handshakeId, networkId: b.networkId, instanceId: idB, instanceLabel: 'impostor',
      instanceUrl: 'https://impostor.example.com', rsaPublicKeyPem: publicKey,
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /prove|token/i);

    const after = (await get(INSTANCES.a, tA, '/api/tokens')).body;
    assert.equal((Array.isArray(after) ? after : after.tokens).filter(t => t.peerInstanceId === idB).length, count,
      'a refused apply still minted a token for the claimed peer');
  });

  it('the genuine peer\'s own join proves itself and succeeds', async () => {
    const r = await joinOnB(await bundle(nets[1]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const onA = await get(INSTANCES.a, tA, `/api/networks/${nets[1]}`);
    assert.ok(onA.body.members?.some(m => m.instanceId === idB), 'B is not a member of the second network on A');
  });
});
