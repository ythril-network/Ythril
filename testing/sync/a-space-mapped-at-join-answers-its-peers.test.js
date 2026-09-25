/**
 * A space mapped under another name at join answers its peers' own sync requests (`Q-51`).
 *
 * `join-remote` records the mapping (network id → local id) and THIS instance's engine translates both ways. The
 * inbound routes did not: a peer asks for the network's id, `spaceAllowed` looked for it among the local ids and
 * answered 403. Data still arrived through this instance's own cycle, but the peer's cycle for that space was refused
 * every time — and since `Q-48` that reports the whole cycle failed.
 *
 * B hosts a club network carrying REMOTE; A joins it, mapping REMOTE onto its own LOCAL.
 *
 * Run: node --test testing/sync/a-space-mapped-at-join-answers-its-peers.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, readContainerSecrets, getInstanceId } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const REMOTE = `q51-remote-${RUN}`;
const LOCAL = `q51-local-${RUN}`;
const OUTSIDE = `q51-outside-${RUN}`;

let tokenA, tokenB, networkId, bOnA;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, token, id] of [[INSTANCES.b, tokenB, REMOTE], [INSTANCES.a, tokenA, LOCAL], [INSTANCES.a, tokenA, OUTSIDE]]) {
    const r = await post(base, token, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `q51-${RUN}`, type: 'club', spaces: [REMOTE] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const inv = await post(INSTANCES.b, tokenB, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const join = await post(INSTANCES.a, tokenA, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-b:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-a:3200', spaceMap: { [REMOTE]: LOCAL },
  });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  // The token B presents to A — what B's own sync engine uses.
  bOnA = readContainerSecrets('ythril-b').peerTokens?.[getInstanceId('ythril-a')];
  assert.ok(bOnA, 'B must hold a token for A after the join');
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  for (const id of [LOCAL, OUTSIDE]) await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${REMOTE}`, { confirm: true }).catch(() => {});
});

describe('a peer asks for a mapped space by the network\'s id', () => {
  it('and is answered, as its own sync cycle needs', async () => {
    const r = await get(INSTANCES.a, bOnA, `/api/sync/entities?spaceId=${REMOTE}&networkId=${networkId}&limit=1`);
    assert.equal(r.status, 200, `the peer's request for the mapped space was refused: ${r.status} ${JSON.stringify(r.body)}`);
  });

  it('but a space outside the network is still refused', async () => {
    const r = await get(INSTANCES.a, bOnA, `/api/sync/entities?spaceId=${OUTSIDE}&networkId=${networkId}&limit=1`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
});
