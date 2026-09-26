/**
 * A published pub/sub key joins without admission (F-41), and the joining token decides what the network adds
 * later (S-9).
 *
 * Owner, 2026-09-26: *"the invite by the publisher must be there ready to paste in join network. no admission in
 * pubsub necessary."* `docs/network-types.md` always promised it — a reusable key "embedded in documentation pages,
 * QR codes, or shared openly" — and the only route that took the key demanded an admin token OF THE PUBLISHER, so a
 * stranger holding the key could not use it. Now `POST /api/invite/redeem` opens a handshake for the key alone, and
 * the joiner's `POST /api/networks/join-by-key` runs the whole join from the publisher's URL and the key.
 *
 * B publishes; A joins by key with an instance-admin token, so a space B adds later is adopted on A.
 *
 * Run: node --test testing/sync/a-published-pubsub-key-joins-without-admission.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, triggerSync, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `f41-${RUN}`;
const LATER = `f41-later-${RUN}`;
let tokenA, tokenB, networkId, clubId, key;

const redeem = (body) => fetch(`${INSTANCES.b}/api/invite/redeem`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const id of [SPACE, LATER]) assert.equal((await post(INSTANCES.b, tokenB, '/api/spaces', { id, label: id })).status, 201);
  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `f41-${RUN}`, type: 'pubsub', spaces: [SPACE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const k = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/invite`, {});
  assert.ok(k.status < 300, JSON.stringify(k.body));
  key = k.body.inviteKey;
  const club = await post(INSTANCES.b, tokenB, '/api/networks', { label: `f41-club-${RUN}`, type: 'club', spaces: [LATER] });
  clubId = club.body?.id;
});

after(async () => {
  for (const id of [networkId, clubId].filter(Boolean)) {
    await del(INSTANCES.a, tokenA, `/api/networks/${id}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${id}`).catch(() => {});
  }
  for (const id of [SPACE, LATER]) {
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('the publisher redeems its published key, and only that', () => {
  it('a caller with no token gets a handshake bundle for the key', async () => {
    const r = await redeem({ inviteKey: key });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.networkId, networkId);
    assert.ok(r.body.handshakeId && r.body.rsaPublicKeyPem, 'a usable handshake');
  });

  it('a wrong key, and a club network\'s key, open nothing', async () => {
    assert.equal((await redeem({ inviteKey: 'ythril_invite_' + 'x'.repeat(40) })).status, 403);
    if (clubId) {
      const ck = await post(INSTANCES.b, tokenB, `/api/networks/${clubId}/invite`, {});
      if (ck.status < 300) assert.equal((await redeem({ inviteKey: ck.body.inviteKey })).status, 403, 'a club key must never join without admission');
    }
  });
});

describe('a joiner pastes the URL and the key', () => {
  it('joins the network, with no step on the publisher', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/networks/join-by-key', {
      publisherUrl: 'http://ythril-b:3200', inviteKey: key, myUrl: 'http://ythril-a:3200',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nets = (await get(INSTANCES.a, tokenA, '/api/networks')).body.networks ?? [];
    const here = nets.find(n => n.id === networkId);
    assert.ok(here, 'the network is registered on the joiner');
    assert.ok(here.spaces.includes(SPACE), 'with the publisher\'s space');
    assert.ok(here.joinedBy, 'and the joining token recorded (S-9)');
  });

  it('a space the publisher adds later is adopted, because the joining token could have joined it', async () => {
    assert.ok((await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/spaces`, { spaceId: LATER })).status < 300);
    await waitFor(async () => {
      await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
      const net = ((await get(INSTANCES.a, tokenA, '/api/networks')).body.networks ?? []).find(n => n.id === networkId);
      return !!net?.spaces.includes(LATER);
    }, 30_000, 1_500);
  });
});
