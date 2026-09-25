/**
 * A pub/sub subscriber takes its publisher's schema for a shared space, and merges it into its own additively
 * (`F-39.1`).
 *
 * Only records travelled: a space created or mapped by a join had none of the network's type schemas, purpose or
 * usage notes. Now the subscriber pulls them from its publisher each cycle. The owner's rule is that it only adds —
 * a type the subscriber already has keeps its own properties and gains the network's, and nothing local is removed.
 *
 * B publishes; A joins onto a space of the same id that already holds a local type.
 *
 * Run: node --test testing/sync/a-space-schema-flows-down-to-subscribers.test.js
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
const SPACE = `f391-${RUN}`;
const OTHER = `f391-other-${RUN}`;

let tokenA, tokenB, networkId;

const typeSchemas = (types) => ({ entity: Object.fromEntries(types.map(([name, props]) =>
  [name, { propertySchemas: Object.fromEntries(props.map(([p, type]) => [p, { type }])) }])) });

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, token, id] of [[INSTANCES.b, tokenB, SPACE], [INSTANCES.b, tokenB, OTHER], [INSTANCES.a, tokenA, SPACE]]) {
    const r = await post(base, token, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const pub = await patch(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { meta: {
    purpose: `network purpose ${RUN}`,
    typeSchemas: typeSchemas([['theirs', [['b', 'string']]], ['shared', [['x', 'number']]]]),
  } });
  assert.ok(pub.status < 300, JSON.stringify(pub.body));
  const sub = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: {
    typeSchemas: typeSchemas([['mine', [['a', 'string']]], ['shared', [['y', 'string']]]]),
  } });
  assert.ok(sub.status < 300, JSON.stringify(sub.body));

  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `f391-${RUN}`, type: 'pubsub', spaces: [SPACE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const inv = await post(INSTANCES.b, tokenB, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const join = await post(INSTANCES.a, tokenA, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-b:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(join.status, 200, JSON.stringify(join.body));
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  for (const id of [SPACE, OTHER]) await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

const metaOnA = async () => (await get(INSTANCES.a, tokenA, `/api/spaces/${SPACE}/meta`)).body;

describe('the subscriber takes the publisher\'s schema', () => {
  it('after a sync, the network\'s types are in the subscriber\'s space', async () => {
    await waitFor(async () => {
      await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
      return !!(await metaOnA())?.typeSchemas?.entity?.theirs;
    }, 30_000, 1_500);
  });

  it('and nothing local was removed: the subscriber\'s own type is still there', async () => {
    assert.ok((await metaOnA()).typeSchemas.entity.mine, 'the subscriber lost its own type');
  });

  it('a type both hold keeps the local property and gains the network\'s', async () => {
    assert.deepEqual(Object.keys((await metaOnA()).typeSchemas.entity.shared.propertySchemas).sort(), ['x', 'y']);
  });

  it('the network\'s purpose arrives with it', async () => {
    assert.equal((await metaOnA()).purpose, `network purpose ${RUN}`);
  });
});

describe('GET /api/sync/meta', () => {
  it('serves what the network governs and never the server\'s own counters', async () => {
    const r = await get(INSTANCES.b, tokenB, `/api/sync/meta?spaceId=${SPACE}&networkId=${networkId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.meta.purpose, `network purpose ${RUN}`);
    for (const owned of ['version', 'previousVersions', 'updatedAt']) assert.ok(!(owned in r.body.meta), `served ${owned}`);
  });

  it('refuses a space the network does not carry', async () => {
    const r = await get(INSTANCES.b, tokenB, `/api/sync/meta?spaceId=${OTHER}&networkId=${networkId}`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
});
