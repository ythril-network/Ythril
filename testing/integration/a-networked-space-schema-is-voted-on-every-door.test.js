/**
 * A networked space's schema is changed by the network's vote on every door, not on some of them (`Q-52`).
 *
 * `PATCH /api/spaces/:id` and MCP `schema_update` turn a schema edit on a networked space into a `meta_change`
 * round. `PUT /schema` and the per-type upsert and delete wrote it at once — one edit, voted on one door and not on
 * the other, and a way to change a shared space's schema without the network. They now open the round too.
 *
 * Run: node --test testing/integration/a-networked-space-schema-is-voted-on-every-door.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { INSTANCES, post, put, get, del, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `q52-${RUN}`;

let admin, netId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  assert.equal((await post(INSTANCES.a, admin, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  // A type to delete later, written while the space is in no network — that path still writes at once.
  const seed = await put(INSTANCES.a, admin, `/api/spaces/${SPACE}/meta/typeSchemas/entity/seed`, {});
  assert.ok(seed.status < 300, `a space in no network must still write at once: ${seed.status} ${JSON.stringify(seed.body)}`);
  const n = await post(INSTANCES.a, admin, '/api/networks', { label: `q52-${RUN}`, type: 'closed', spaces: [SPACE] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  netId = n.body.id;
  // A real member by the handshake, so no round can pass on this instance's yes alone.
  const gen = await post(INSTANCES.a, admin, '/api/invite/generate', { networkId: netId });
  const b = generateKeyPairSync('rsa', { modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const apply = await post(INSTANCES.a, '', '/api/invite/apply', { handshakeId: gen.body.handshakeId, networkId: netId,
    instanceId: '33333333-3333-4333-8333-333333333333', instanceLabel: 'q52 peer', instanceUrl: 'http://ythril-b:3200', rsaPublicKeyPem: b.publicKey });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  const enc = publicEncrypt({ key: apply.body.rsaPublicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`ythril_${randomBytes(32).toString('base64url')}`)).toString('base64');
  assert.equal((await post(INSTANCES.a, '', '/api/invite/finalize', { handshakeId: gen.body.handshakeId, encryptedTokenForA: enc })).status, 200);
});

after(async () => {
  if (netId) await del(INSTANCES.a, admin, `/api/networks/${netId}`).catch(() => {});
  await delWithBody(INSTANCES.a, admin, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

const types = async () => Object.keys((await get(INSTANCES.a, admin, `/api/spaces/${SPACE}/meta`)).body?.typeSchemas?.entity ?? {}).sort();

describe('every schema door opens the vote on a networked space', () => {
  it('PUT /schema', async () => {
    const r = await put(INSTANCES.a, admin, `/api/spaces/${SPACE}/schema`, { typeSchemas: { entity: { replaced: {} } } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.status, 'vote_pending');
    assert.deepEqual(await types(), ['seed'], 'the schema was replaced without the vote');
  });

  it('the per-type upsert', async () => {
    const r = await put(INSTANCES.a, admin, `/api/spaces/${SPACE}/meta/typeSchemas/entity/added`, {});
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(await types(), ['seed'], 'a type was added without the vote');
  });

  it('the per-type delete', async () => {
    const r = await del(INSTANCES.a, admin, `/api/spaces/${SPACE}/meta/typeSchemas/entity/seed`);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(await types(), ['seed'], 'a type was deleted without the vote');
  });

  it('and each opened a round on the network', async () => {
    const rounds = (await get(INSTANCES.a, admin, `/api/networks/${netId}/votes`)).body.rounds.filter(r => r.type === 'meta_change');
    assert.ok(rounds.length >= 3, `expected a meta_change round per edit, found ${rounds.length}`);
  });
});
