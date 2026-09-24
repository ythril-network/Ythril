/**
 * Joining a REMOTE network by the Networks column (`F-34.1`), live across two instances: A invites, B joins.
 *
 * The remote space list arrives in the handshake's apply step, before anything is written on B and before
 * finalize — so B checks the joining token there: `networks: write` on every existing local space the join maps
 * to, and `createSpaces` plus a floor of `networks: write` for any it would create. Refused, B writes nothing and
 * never finalizes; the token A made for B at apply expires with the handshake.
 *
 * Run: node --test testing/integration/a-remote-join-needs-the-networks-rung.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `rjoin-${RUN}`;
const NEW_SPACE = `rjoin-new-${RUN}`;
const FOUR = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });

let adminA, adminB;
const cleanup = { a: [], b: [] };

before(async () => {
  adminA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  adminB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [inst, tok] of [[INSTANCES.a, adminA], [INSTANCES.b, adminB]]) {
    const r = await post(inst, tok, '/api/spaces', { id: SPACE, label: SPACE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const s2 = await post(INSTANCES.a, adminA, '/api/spaces', { id: NEW_SPACE, label: NEW_SPACE });
  assert.equal(s2.status, 201, JSON.stringify(s2.body));
});

after(async () => {
  for (const id of cleanup.a) await del(INSTANCES.a, adminA, `/api/networks/${id}`).catch(() => {});
  for (const id of cleanup.b) await del(INSTANCES.b, adminB, `/api/networks/${id}`).catch(() => {});
  for (const id of [SPACE, NEW_SPACE]) {
    await delWithBody(INSTANCES.a, adminA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, adminB, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

async function mintOnB(name, rights) {
  const r = await post(INSTANCES.b, adminB, '/api/tokens', { name: `${name}-${RUN}`, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...rights } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.plaintext, id: r.body.token.id };
}

/** A network on A carrying `spaces`, and an invite bundle for it that B can reach over the Docker network. */
async function invite(spaces) {
  const net = await post(INSTANCES.a, adminA, '/api/networks', { label: `rjoin-${RUN}-${spaces.length}`, type: 'closed', spaces, votingDeadlineHours: 1 });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  cleanup.a.push(net.body.id);
  const gen = await post(INSTANCES.a, adminA, '/api/invite/generate', { networkId: net.body.id });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  return { ...gen.body, inviteUrl: 'http://ythril-a:3200/api/invite/apply', networkId: net.body.id };
}
const joinOnB = (token, bundle) => post(INSTANCES.b, token, '/api/networks/join-remote', {
  handshakeId: bundle.handshakeId, inviteUrl: bundle.inviteUrl, rsaPublicKeyPem: bundle.rsaPublicKeyPem,
  networkId: bundle.networkId, myUrl: 'http://ythril-b:3200',
});

describe('joining a remote network', () => {
  it('without write on the space it maps to, is refused — and nothing is written on B', async () => {
    // Data write, so it is not a read-only token — `denyReadOnly` would refuse that first, and this is about the network rung.
    const reader = await mintOnB('rjoin-reader', { perSpace: { [SPACE]: { ...FOUR('write'), networks: 'read' } } });
    const bundle = await invite([SPACE]);
    const r = await joinOnB(reader.token, bundle);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(SPACE));
    const onB = await get(INSTANCES.b, adminB, `/api/networks/${bundle.networkId}`);
    assert.equal(onB.status, 404, 'a refused join left the network registered on B');
  });

  it('a space the join would CREATE needs createSpaces — refused without it, and not created', async () => {
    const writer = await mintOnB('rjoin-nocreate', { floor: { ...FOUR('none'), networks: 'write' } });
    const bundle = await invite([NEW_SPACE]);
    const r = await joinOnB(writer.token, bundle);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /create/);
    const spaces = await get(INSTANCES.b, adminB, '/api/spaces');
    assert.ok(!JSON.stringify(spaces.body).includes(NEW_SPACE), 'the refused join created the space anyway');
  });

  it('with write on the space, joins — and the membership is recorded as that token\'s', async () => {
    const writer = await mintOnB('rjoin-writer', { perSpace: { [SPACE]: { ...FOUR('none'), networks: 'write' } } });
    const bundle = await invite([SPACE]);
    const r = await joinOnB(writer.token, bundle);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    cleanup.b.push(bundle.networkId);
    const onB = await get(INSTANCES.b, adminB, `/api/networks/${bundle.networkId}`);
    assert.equal(onB.status, 200, JSON.stringify(onB.body));
    assert.equal(onB.body.spaceOrigins?.[SPACE], writer.id, 'the leave rule needs to know whose membership this is');
  });
});
