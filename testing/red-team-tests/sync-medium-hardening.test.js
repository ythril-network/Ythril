/**
 * Red-team tests: sync-layer hardening (M3, M5)
 *
 * M3 — a peer-bound token may reach a space only through a network the peer is
 *      actually a member of. Two networks sharing a space but with disjoint
 *      membership must not leak into each other.
 * M5 — a document whose seq is too close to the 2^50 protocol ceiling is refused
 *      on every ingest path, so a single crafted push cannot drag the space's
 *      counter into the reserve band and strand its future writes.
 *
 * (The directional-write regression — a push-direction member cannot write
 * inbound — is asserted below too; that enforcement pre-dates this batch and is
 * kept as a guard. See the tracker's M4 note for why the absent-peerInstanceId
 * case is intentionally not blocked.)
 *
 * These drive the real /api/sync endpoints on instance A. Peer tokens are minted
 * with peerInstanceId to mimic the invite handshake.
 *
 * Run: node --test testing/red-team-tests/sync-medium-hardening.test.js
 * Pre-requisite: test stack up + testing/sync/setup.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, dockerExec } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let adminToken;
let instanceIdA;

function getInstanceId(container = 'ythril-a') {
  return dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `process.stdout.write(JSON.parse(fs.readFileSync('/config/config.json','utf8')).instanceId)"`,
  ).toString().trim();
}

/** Authenticated POST with a raw Bearer token (helpers.post reads a token string too). */
async function syncPost(token, pathAndQuery, body) {
  const r = await fetch(`${INSTANCES.a}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, body: json, text };
}

async function makeSpace(id) {
  const r = await post(INSTANCES.a, adminToken, '/api/spaces', { id, label: id });
  assert.ok(r.status === 201 || r.status === 409, `create space ${id}: ${r.status} ${JSON.stringify(r.body)}`);
}

async function deleteSpace(id) {
  await fetch(`${INSTANCES.a}/api/spaces/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
}

async function makeNetwork(spaces, type = 'club') {
  const r = await post(INSTANCES.a, adminToken, '/api/networks', {
    label: `sync-med-${RUN}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    spaces,
    votingDeadlineHours: 1,
  });
  assert.equal(r.status, 201, `create network: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Add a member and return the peer token it will present (with peerInstanceId). */
async function addMember(networkId, peerInstanceId, direction = 'both') {
  const pt = await post(INSTANCES.a, adminToken, '/api/tokens', {
    name: `sync-med-peer-${peerInstanceId}-${RUN}`,
    peerInstanceId,
    rights: legacyRights({ spaces: undefined })
  });
  assert.equal(pt.status, 201, `create peer token: ${JSON.stringify(pt.body)}`);
  const add = await post(INSTANCES.a, adminToken, `/api/networks/${networkId}/members`, {
    instanceId: peerInstanceId,
    label: `peer-${peerInstanceId}`,
    url: 'http://peer.internal:3200',
    token: pt.body.plaintext,
    direction,
  });
  assert.equal(add.status, 201, `add member: ${JSON.stringify(add.body)}`);
  return { token: pt.body.plaintext, tokenId: pt.body.token?.id };
}

const memoryDoc = (spaceId, seq, id = randomUUID()) => ({
  _id: id,
  spaceId,
  fact: `sync-med test ${id}`,
  seq,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  author: { instanceId: randomUUID(), instanceLabel: 'Peer X' },
  tags: [],
  entityIds: [],
  embedding: [0.1, 0.2, 0.3],
  embeddingModel: 'test-model',
});

before(() => {
  adminToken = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  instanceIdA = getInstanceId();
});

// ── M3 — network membership, not just space scope ────────────────────────────

describe('M3 — a peer may reach a space only via a network it belongs to', () => {
  const shared = `m3-shared-${RUN}`;
  let netX, peerXId, peerX, netY, peerYId;
  const cleanupTokens = [];

  before(async () => {
    await makeSpace(shared);
    peerXId = randomUUID();
    peerYId = randomUUID();
    // Two networks BOTH carrying `shared`, with disjoint membership.
    netX = await makeNetwork([shared]);
    const x = await addMember(netX, peerXId);
    peerX = x.token; cleanupTokens.push(x.tokenId);
    netY = await makeNetwork([shared]);
    const y = await addMember(netY, peerYId);
    cleanupTokens.push(y.tokenId);
  });

  after(async () => {
    await del(INSTANCES.a, adminToken, `/api/networks/${netX}`).catch(() => {});
    await del(INSTANCES.a, adminToken, `/api/networks/${netY}`).catch(() => {});
    for (const id of cleanupTokens) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
    await deleteSpace(shared);
  });

  it('peer X (member of net X) may write the shared space via net X', async () => {
    const r = await syncPost(peerX, `/api/sync/facts?spaceId=${shared}&networkId=${netX}`, memoryDoc(shared, 1));
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  });

  it('peer X CANNOT use net Y (it is not a member of net Y) for the same space', async () => {
    const r = await syncPost(peerX, `/api/sync/facts?spaceId=${shared}&networkId=${netY}`, memoryDoc(shared, 1));
    assert.equal(r.status, 403, `VULNERABILITY: peer reached a space via a network it is not a member of (${r.status})`);
  });

  it('peer X reading the shared space via net Y is refused', async () => {
    const r = await get(INSTANCES.a, peerX, `/api/sync/facts?spaceId=${shared}&networkId=${netY}`);
    assert.equal(r.status, 403, `VULNERABILITY: cross-network read via disjoint membership (${r.status})`);
  });
});

// ── M4 — directional write attribution ───────────────────────────────────────

describe('Directional-write regression — an identified push member is refused', () => {
  const space = `dir-${RUN}`;
  let netId, pushPeer;
  const cleanupTokens = [];

  before(async () => {
    await makeSpace(space);
    netId = await makeNetwork([space], 'pubsub');
    // A push-direction member: WE push to them → they must not push back to us.
    const p = await addMember(netId, randomUUID(), 'push');
    pushPeer = p.token; cleanupTokens.push(p.tokenId);
  });

  after(async () => {
    await del(INSTANCES.a, adminToken, `/api/networks/${netId}`).catch(() => {});
    for (const id of cleanupTokens) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
    await deleteSpace(space);
  });

  it('a push-direction member (identified by peerInstanceId) cannot write inbound', async () => {
    const r = await syncPost(pushPeer, `/api/sync/facts?spaceId=${space}&networkId=${netId}`, memoryDoc(space, 1));
    assert.equal(r.status, 403, `VULNERABILITY: push-side member wrote inbound (${r.status})`);
  });
});

// ── M5 — seq-counter poisoning ───────────────────────────────────────────────

describe('M5 — implausible seq values are refused', () => {
  const space = `m5-${RUN}`;
  let netId, peer, peerId;
  const cleanupTokens = [];

  before(async () => {
    await makeSpace(space);
    netId = await makeNetwork([space]);
    peerId = randomUUID();
    const p = await addMember(netId, peerId);
    peer = p.token; cleanupTokens.push(p.tokenId);
  });

  after(async () => {
    await del(INSTANCES.a, adminToken, `/api/networks/${netId}`).catch(() => {});
    for (const id of cleanupTokens) await del(INSTANCES.a, adminToken, `/api/tokens/${id}`).catch(() => {});
    await deleteSpace(space);
  });

  it('a normal low-seq document is accepted', async () => {
    const r = await syncPost(peer, `/api/sync/facts?spaceId=${space}&networkId=${netId}`, memoryDoc(space, 5));
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  });

  it('a document with seq near the 2^50 ceiling is refused', async () => {
    const nearCeiling = 2 ** 50 - 1;
    const r = await syncPost(peer, `/api/sync/facts?spaceId=${space}&networkId=${netId}`, memoryDoc(space, nearCeiling));
    assert.equal(r.status, 400, `VULNERABILITY: counter-poisoning seq accepted (${r.status})`);
    assert.match(r.text, /ceiling|refused/i);
  });

  it('after the poison attempt the counter is intact — a normal doc still lands', async () => {
    const r = await syncPost(peer, `/api/sync/facts?spaceId=${space}&networkId=${netId}`, memoryDoc(space, 6));
    assert.equal(r.status, 200, `space should still accept normal writes after a rejected poison (${r.status})`);
  });

  it('batch-upsert drops implausible docs but keeps the good ones', async () => {
    const good = memoryDoc(space, 7);
    const poison = memoryDoc(space, 2 ** 50 - 5);
    const r = await syncPost(peer, `/api/sync/batch-upsert?spaceId=${space}&networkId=${netId}`, {
      facts: [good, poison],
    });
    assert.equal(r.status, 200, `batch-upsert should not 500: ${r.text.slice(0, 200)}`);
    // The good doc is retrievable; the poison one is not.
    const fetchGood = await get(INSTANCES.a, adminToken, `/api/sync/facts/${good._id}?spaceId=${space}`);
    assert.equal(fetchGood.status, 200, 'the plausible doc should have been stored');
    const fetchPoison = await get(INSTANCES.a, adminToken, `/api/sync/facts/${poison._id}?spaceId=${space}`);
    assert.equal(fetchPoison.status, 404, 'the poison doc must not have been stored');
  });
});
