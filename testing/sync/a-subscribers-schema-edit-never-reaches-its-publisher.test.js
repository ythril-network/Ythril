/**
 * A pub/sub subscriber's schema edit of a shared space stays on the subscriber: it opens no round, and the publisher never takes it, however
 * often the two sync (Q-968, a security hole in every 6.5.x; owner, 2026-11-26: a subscriber's edit is local, a network-wide change is the
 * publisher operator's).
 *
 * The hole: the subscriber's edit opened a `meta_change` round that its own yes passed at once, the publisher adopted the round at the next
 * sync and passed it on that same yes, and the subscriber's type became the network's on every member. The absence is read after both sides
 * have synced, beside its twin: the publisher's own edit DOES reach the subscriber over the same sync.
 *
 * B publishes; A subscribes.
 *
 * Run: node --test testing/sync/a-subscribers-schema-edit-never-reaches-its-publisher.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del, delWithBody, triggerSync, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q968-${RUN}`;
const SUB_TYPE = `subonly${RUN}`;
const PUB_TYPE = `pubtype${RUN}`;

let tokenA, tokenB, networkId;

const typeSchemas = (name) => ({ entity: { [name]: { propertySchemas: { note: { type: 'string' } } } } });

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.b, tokenB, '/api/spaces', { id: SPACE, label: SPACE });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `q968-${RUN}`, type: 'pubsub', spaces: [SPACE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const inv = await post(INSTANCES.b, tokenB, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const join = await post(INSTANCES.a, tokenA, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-b:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  // The subscriber holds the space before it edits it.
  await waitFor(async () => {
    await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
    return (await get(INSTANCES.a, tokenA, `/api/spaces/${SPACE}/meta`)).status === 200;
  }, 30_000, 1_500);
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

const typesOn = async (base, token) => (await get(base, token, `/api/spaces/${SPACE}/meta`)).body?.typeSchemas?.entity ?? {};
const roundsOn = async (base, token) => {
  const served = await get(base, token, `/api/sync/networks/${networkId}/votes`);
  assert.equal(served.status, 200, JSON.stringify(served.body));
  return served.body.rounds ?? [];
};

describe('a subscriber\'s schema edit stays on the subscriber', () => {
  it('the subscriber\'s edit is applied there and opens no round', async () => {
    const res = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { typeSchemas: typeSchemas(SUB_TYPE) } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok((await typesOn(INSTANCES.a, tokenA))[SUB_TYPE], 'the subscriber\'s own edit is not on the subscriber');
    const rounds = (await roundsOn(INSTANCES.a, tokenA)).filter(r => r.type === 'meta_change');
    assert.deepEqual(rounds.map(r => r.roundId), [], `the subscriber opened a schema round: ${JSON.stringify(rounds).slice(0, 400)}`);
  });

  it('the twin: the publisher\'s own edit reaches the subscriber over the same sync', async () => {
    const res = await patch(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { meta: { typeSchemas: typeSchemas(PUB_TYPE) } });
    assert.ok(res.status < 300, JSON.stringify(res.body));
    await waitFor(async () => {
      await triggerSync(INSTANCES.b, tokenB, networkId).catch(() => {});
      await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
      return !!(await typesOn(INSTANCES.a, tokenA))[PUB_TYPE];
    }, 45_000, 1_500);
  });

  it('after both have synced, the publisher holds neither the subscriber\'s type nor a round of it', async () => {
    // Two more syncs each way, past the one that carried the publisher's own edit down.
    for (let i = 0; i < 2; i++) {
      await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
      await triggerSync(INSTANCES.b, tokenB, networkId).catch(() => {});
    }
    assert.equal((await typesOn(INSTANCES.b, tokenB))[SUB_TYPE], undefined, 'the subscriber\'s type reached the publisher\'s schema');
    const held = (await roundsOn(INSTANCES.b, tokenB)).filter(r => JSON.stringify(r).includes(SUB_TYPE));
    assert.deepEqual(held.map(r => r.roundId), [], 'the publisher holds the subscriber\'s schema round');
  });
});
