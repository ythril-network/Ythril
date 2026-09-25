/**
 * A club organiser adds a space and every member carries it after a sync — except onto a local space of the same
 * name, which is never shared without that member's own yes (`F-38.4`).
 *
 * On a club the organiser's yes carries a `space_addition` round the moment it opens, so the round is concluded
 * before any member has seen it. The organiser therefore keeps serving the PASSED round, and a member adopts it
 * and decides it again from the casts under its own rule.
 *
 * A organises; B joins by invite. B already holds a local space named like one of the two A adds.
 *
 * Run: node --test testing/sync/a-club-member-learns-a-space-its-organiser-adds.test.js
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
const FIRST = `f384-first-${RUN}`;
const FRESH = `f384-fresh-${RUN}`;
const COLLIDE = `f384-collide-${RUN}`;

let tokenA, tokenB, networkId;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, token, id] of [[INSTANCES.a, tokenA, FIRST], [INSTANCES.a, tokenA, FRESH], [INSTANCES.a, tokenA, COLLIDE], [INSTANCES.b, tokenB, COLLIDE]]) {
    const r = await post(base, token, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const net = await post(INSTANCES.a, tokenA, '/api/networks', { label: `f384-${RUN}`, type: 'club', spaces: [FIRST] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const inv = await post(INSTANCES.a, tokenA, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const join = await post(INSTANCES.b, tokenB, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-b:3200',
  });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  for (const spaceId of [FRESH, COLLIDE]) {
    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/spaces`, { spaceId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
  }
  for (const id of [FIRST, FRESH, COLLIDE]) {
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

const spacesOnB = async () => (await get(INSTANCES.b, tokenB, `/api/networks/${networkId}`)).body?.spaces ?? [];

describe('a club member learns a space its organiser adds', () => {
  it('after a sync, the member carries the new space, created there', async () => {
    await waitFor(async () => {
      await triggerSync(INSTANCES.b, tokenB, networkId).catch(() => {});
      return (await spacesOnB()).includes(FRESH);
    }, 30_000, 1_500);
    assert.equal((await get(INSTANCES.b, tokenB, `/api/spaces/${FRESH}/meta`)).status, 200, 'the space must exist on the member');
  });

  it('but a local space of the same name is not joined to the network without the member\'s yes', async () => {
    await triggerSync(INSTANCES.b, tokenB, networkId).catch(() => {});
    assert.ok(!(await spacesOnB()).includes(COLLIDE), `a member's own space was shared unasked: ${JSON.stringify(await spacesOnB())}`);
  });
});
