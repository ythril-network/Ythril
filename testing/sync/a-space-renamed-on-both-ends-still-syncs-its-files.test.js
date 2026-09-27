/**
 * A space renamed on BOTH ends of a network still syncs its files (`Q-68`).
 *
 * A rename keeps the network's id for the space and maps it to the new local one (`spaceMap`), so both ends go on
 * naming it by the network id. The sync routes translate that id to the receiver's local one (`space-alias.ts`),
 * but a file travels through the plain file routes, which know only local ids: the peer's token reaches no space of
 * that name and every file push and pull is refused 403, while records and meta sync. Found live on the flows
 * network after `flows` became `y-flows` on dev and on home.
 *
 * Run: node --test testing/sync/a-space-renamed-on-both-ends-still-syncs-its-files.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, del, delWithBody, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const OLD = `q68o-${RUN}`;
const NEW = `q68n-${RUN}`;
const FILE = 'guide/renamed.md';
let tokenA, tokenB, networkId;

const auth = t => ({ Authorization: `Bearer ${t}` });

async function syncBoth() {
  await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/sync?wait=true`, {});
  await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync?wait=true`, {});
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  assert.equal((await post(INSTANCES.b, tokenB, '/api/spaces', { id: OLD, label: OLD })).status, 201);
  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `q68r-${RUN}`, type: 'pubsub', spaces: [OLD] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const k = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/invite`, {});
  const j = await post(INSTANCES.a, tokenA, '/api/networks/join-by-key', {
    publisherUrl: 'http://ythril-b:3200', inviteKey: k.body.inviteKey, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  await waitFor(async () => { await syncBoth(); return (await fetch(`${INSTANCES.a}/api/spaces/${OLD}/meta`, { headers: auth(tokenA) })).ok; },
    60_000, 2_000, () => `space ${OLD} was never adopted on A`);

  // The rename, on both ends — what the operator did to y-flows on dev and on home.
  for (const [base, t] of [[INSTANCES.b, tokenB], [INSTANCES.a, tokenA]]) {
    const r = await patch(base, t, `/api/spaces/${OLD}/rename`, { newId: NEW });
    assert.ok(r.status < 300, `rename on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  for (const id of [OLD, NEW]) {
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('a file after the rename', () => {
  it('a file the publisher writes reaches the subscriber under the new name', async () => {
    const w = await fetch(`${INSTANCES.b}/api/files/${NEW}?path=${encodeURIComponent(FILE)}`, {
      method: 'POST', headers: { ...auth(tokenB), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `renamed ${RUN}\n`, encoding: 'utf8' }),
    });
    assert.ok(w.status < 300, `write answered ${w.status}`);
    await waitFor(async () => {
      await syncBoth();
      const r = await fetch(`${INSTANCES.a}/api/files/${NEW}?path=${encodeURIComponent(FILE)}`, { headers: auth(tokenA) });
      return r.ok && (await r.text()).includes(`renamed ${RUN}`);
    }, 60_000, 2_000, () => 'the file never reached the subscriber after the rename');
  });
});
