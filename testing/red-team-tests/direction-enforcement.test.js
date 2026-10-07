/**
 * Red-team tests: Directional network inbound write enforcement
 *
 * In pubsub and braintree networks, subscribers/children have direction='push'
 * on the publisher/parent (meaning "we push TO them"). If a subscriber
 * somehow calls the publisher's sync write endpoints directly, the server
 * must reject the write with 403.
 *
 * This test performs a full RSA invite handshake to obtain a properly-linked
 * peer token (with peerInstanceId) and then verifies every inbound write
 * endpoint rejects the push-only peer.
 *
 * The last block (bundle-51, D-14 C) holds the same line for DELETIONS on a braintree: the instance above may delete
 * what it relayed, and nothing below it may send a tombstone up, whoever it names as the issuer.
 *
 * Run: node --test testing/red-team-tests/direction-enforcement.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, createTestSpace, getInstanceId, readRecord } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let adminToken;
let networkId;
let subscriberToken;  // PAT that A created for the subscriber (has peerInstanceId)

/**
 * Perform the full RSA-4096 invite handshake against instance A and return
 * the plaintext peer token that A created for the joiner.
 */
async function doHandshake(token, netId, joinerLabel) {
  // 1. Generate invite on A
  const gen = await post(INSTANCES.a, token, '/api/invite/generate', {
    networkId: netId,
    targetInstanceLabel: joinerLabel,
    targetUrl: 'https://sub.ythril-test.example.com',
  });
  assert.equal(gen.status, 201, `generate: ${JSON.stringify(gen.body)}`);

  // 2. Generate a 4096-bit RSA keypair for the subscriber
  const { publicKey: subPubPem, privateKey: subPrivPem } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const subInstanceId = crypto.randomUUID();

  // 3. Apply — A creates a PAT with peerInstanceId = subInstanceId
  const applyResp = await fetch(`${INSTANCES.a}/api/invite/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handshakeId: gen.body.handshakeId,
      networkId: netId,
      instanceId: subInstanceId,
      instanceLabel: joinerLabel,
      instanceUrl: 'https://sub.ythril-test.example.com',
      rsaPublicKeyPem: subPubPem,
    }),
  });
  assert.equal(applyResp.status, 200, `apply: ${await applyResp.clone().text()}`);
  const applyBody = await applyResp.json();

  // 4. Decrypt the token A created for us
  const peerTokenPlaintext = crypto.privateDecrypt(
    { key: subPrivPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(applyBody.encryptedTokenForB, 'base64'),
  ).toString('utf8');
  assert.ok(peerTokenPlaintext.startsWith('ythril_'), 'Decrypted token should start with ythril_');

  // 5. Create a fake PAT "for A" and encrypt it with A's public key for finalize
  //    (The subscriber doesn't actually run a server — we just need to complete
  //     the handshake so A registers the member.)
  const fakeTokenForA = `ythril_${crypto.randomBytes(32).toString('hex')}`;
  const encryptedTokenForA = crypto.publicEncrypt(
    { key: applyBody.rsaPublicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(fakeTokenForA, 'utf8'),
  ).toString('base64');

  const finalizeResp = await fetch(`${INSTANCES.a}/api/invite/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handshakeId: gen.body.handshakeId,
      encryptedTokenForA,
    }),
  });
  assert.equal(finalizeResp.status, 200, `finalize: ${await finalizeResp.clone().text()}`);
  const finalizeBody = await finalizeResp.json();
  assert.equal(finalizeBody.status, 'joined');

  return { token: peerTokenPlaintext, instanceId: subInstanceId };
}

describe('Directional network: push-only peer cannot write to sync endpoints', () => {
  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Create a pubsub network on A
    const r = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: 'Direction Enforcement Test',
      type: 'pubsub',
      spaces: ['general'],
    });
    assert.equal(r.status, 201, `Create pubsub network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;

    // Add a subscriber via full RSA handshake — creates a PAT with peerInstanceId
    const sub = await doHandshake(adminToken, networkId, 'Red-Team Subscriber');
    subscriberToken = sub.token;

    // Verify member exists with direction=push
    const netR = await get(INSTANCES.a, adminToken, `/api/networks/${networkId}`);
    assert.equal(netR.status, 200);
    const member = netR.body.members?.find(m => m.instanceId === sub.instanceId);
    assert.ok(member, 'Subscriber should exist in member list');
    assert.equal(member.direction, 'push', 'Subscriber direction should be push (publisher pushes to them)');
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, adminToken, `/api/networks/${networkId}`).catch(() => {});
    }
  });

  // ── Write endpoints that must be blocked ─────────────────────────────────

  it('Subscriber cannot POST /api/sync/facts → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/facts?spaceId=general&networkId=${networkId}`,
      { _id: crypto.randomUUID(), fact: 'injected by subscriber', seq: 1 },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error?.includes('write not permitted'), `Error message should mention write not permitted: ${r.body.error}`);
  });

  it('Subscriber cannot POST /api/sync/entities → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/entities?spaceId=general&networkId=${networkId}`,
      { _id: crypto.randomUUID(), name: 'injected entity', type: 'person', seq: 1 },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Subscriber cannot POST /api/sync/edges → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/edges?spaceId=general&networkId=${networkId}`,
      { _id: crypto.randomUUID(), from: 'a', to: 'b', label: 'injected', seq: 1 },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Subscriber cannot POST /api/sync/chrono → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/chrono?spaceId=general&networkId=${networkId}`,
      { _id: crypto.randomUUID(), type: 'fact', targetId: 'x', seq: 1 },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Subscriber cannot POST /api/sync/batch-upsert → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/batch-upsert?spaceId=general&networkId=${networkId}`,
      { facts: [{ _id: crypto.randomUUID(), fact: 'batch-injected', seq: 1 }] },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Subscriber cannot POST /api/sync/tombstones → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/tombstones?spaceId=general&networkId=${networkId}`,
      [{ _id: crypto.randomUUID(), type: 'fact', instanceId: 'attacker', deletedAt: new Date().toISOString() }],
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Subscriber cannot POST /api/sync/file-tombstones → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/file-tombstones?networkId=${networkId}`,
      { spaceId: 'general', tombstones: [{ _id: crypto.randomUUID(), path: 'attack.txt', deletedAt: new Date().toISOString() }] },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ── Read endpoints should still work (subscriber can pull) ───────────────

  it('Subscriber CAN GET /api/sync/facts → 200', async () => {
    const r = await get(INSTANCES.a, subscriberToken,
      `/api/sync/facts?spaceId=general&networkId=${networkId}`,
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Subscriber CAN GET /api/sync/entities → 200', async () => {
    const r = await get(INSTANCES.a, subscriberToken,
      `/api/sync/entities?spaceId=general&networkId=${networkId}`,
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Subscriber CAN GET /api/sync/tombstones → 200', async () => {
    const r = await get(INSTANCES.a, subscriberToken,
      `/api/sync/tombstones?spaceId=general&networkId=${networkId}`,
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ── networkId is wire input — omitting or misdirecting it must not bypass ──
  // (S10: pre-fix, the guard keyed on the caller-supplied networkId query
  //  param, so a push-only peer could write by simply leaving it out.)

  it('Subscriber cannot bypass the guard by OMITTING networkId → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/facts?spaceId=general`,
      { _id: crypto.randomUUID(), fact: 'injected without networkId', seq: 1 },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error?.includes('write not permitted'), `Error should be the direction guard: ${r.body.error}`);
  });

  it('Subscriber cannot bypass the guard by naming a BOGUS networkId → 403', async () => {
    const r = await post(INSTANCES.a, subscriberToken,
      `/api/sync/facts?spaceId=general&networkId=${crypto.randomUUID()}`,
      { _id: crypto.randomUUID(), fact: 'injected via bogus networkId', seq: 1 },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// S10: the sync data-write surface is peer-only — a space-scoped user PAT
// must not be able to write through /api/sync/* at all (it could otherwise
// forge raw seq/_id/author stream metadata and push content upstream in a
// directional network). Reads stay open; admin remains a local override.
// ══════════════════════════════════════════════════════════════════════════

describe('S10: non-peer user PATs are refused on sync data writes', () => {
  let userPat;          // space-scoped, non-admin, no peerInstanceId
  let closedNetworkId;
  let closedPeerToken;  // peer-bound token with direction='both' (positive control)

  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    const t = await post(INSTANCES.a, adminToken, '/api/tokens', {
      name: `s10-user-pat-${Date.now()}`,
      rights: legacyRights({ spaces: ['general'] })
    });
    assert.equal(t.status, 201);
    userPat = t.body.plaintext;

    // Closed network + handshake-joined peer → direction 'both' (may write)
    const n = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: `S10 Closed ${Date.now()}`,
      type: 'closed',
      spaces: ['general'],
    });
    assert.equal(n.status, 201);
    closedNetworkId = n.body.id;
    const peer = await doHandshake(adminToken, closedNetworkId, 'S10 Closed Peer');
    closedPeerToken = peer.token;
  });

  after(async () => {
    if (closedNetworkId) {
      await del(INSTANCES.a, adminToken, `/api/networks/${closedNetworkId}`).catch(() => {});
    }
  });

  const WRITE_CASES = [
    ['facts', { fact: 'user-pat injected', seq: 1 }],
    ['entities', { name: 'user-pat entity', type: 'person', seq: 1 }],
    ['edges', { from: 'a', to: 'b', label: 'user-pat edge', seq: 1 }],
    ['chrono', { type: 'fact', targetId: 'x', seq: 1 }],
  ];

  for (const [endpoint, doc] of WRITE_CASES) {
    it(`user PAT cannot POST /api/sync/${endpoint} → 403 (peer-token required)`, async () => {
      const r = await post(INSTANCES.a, userPat,
        `/api/sync/${endpoint}?spaceId=general&networkId=${closedNetworkId}`,
        { _id: crypto.randomUUID(), ...doc },
      );
      assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.error?.includes('peer token'), `Error should demand a peer token: ${r.body.error}`);
    });
  }

  it('user PAT cannot POST /api/sync/batch-upsert → 403', async () => {
    const r = await post(INSTANCES.a, userPat,
      `/api/sync/batch-upsert?spaceId=general`,
      { facts: [{ _id: crypto.randomUUID(), fact: 'user-pat batch', seq: 1 }] },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('user PAT cannot POST /api/sync/tombstones → 403', async () => {
    const r = await post(INSTANCES.a, userPat,
      `/api/sync/tombstones?spaceId=general`,
      { tombstones: [{ _id: crypto.randomUUID(), type: 'fact', instanceId: 'attacker', deletedAt: new Date().toISOString() }] },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('user PAT cannot POST /api/sync/file-tombstones → 403', async () => {
    const r = await post(INSTANCES.a, userPat,
      `/api/sync/file-tombstones`,
      { spaceId: 'general', tombstones: [{ _id: crypto.randomUUID(), path: 'attack.txt', deletedAt: new Date().toISOString() }] },
    );
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ── What must still work ──────────────────────────────────────────────────

  it('user PAT can still READ /api/sync/facts → 200', async () => {
    const r = await get(INSTANCES.a, userPat, `/api/sync/facts?spaceId=general`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('admin token can still write (local operator override) → 200', async () => {
    const r = await post(INSTANCES.a, adminToken,
      `/api/sync/batch-upsert?spaceId=general`,
      { facts: [{ _id: crypto.randomUUID(), fact: `s10 admin positive control ${Date.now()}`, seq: 1 }] },
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it("peer with direction 'both' (closed network) can still write → 200", async () => {
    const r = await post(INSTANCES.a, closedPeerToken,
      `/api/sync/batch-upsert?spaceId=general&networkId=${closedNetworkId}`,
      { facts: [{ _id: crypto.randomUUID(), fact: `s10 peer positive control ${Date.now()}`, seq: 1 }] },
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Bundle-51 (D-14 C): on a braintree, a deletion travels DOWN. A child that
// sends a tombstone to its parent is refused, and so is a sibling — two
// children of the same parent are strangers to each other. The refusal does not
// depend on who the tombstone says issued it: the child is refused when it names
// itself, the other child, or the parent, and what it targets survives.
//
// A is the root here (a handshake admits a child at once only on the root), which
// is the instance whose door is knocked on; the "upstream may delete what it
// relayed" half is a behaviour of a receiving node and is held by the sync suite
// (`braintree.test.js`) and the standalone door tests, not here.
// ══════════════════════════════════════════════════════════════════════════

describe('Braintree: a child and a sibling cannot send tombstones up to their parent', () => {
  let space;
  let btNetworkId;
  let rootId;
  const peers = {};       // { child: { token, instanceId }, sibling: { token, instanceId } }
  const victims = {};     // record id by AUTHOR: the child, the sibling and the root
  const FILE = `bt-direction-${Date.now()}.md`;

  /** A fact stored on A by A's admin through the sync door, which keeps the author it is given. */
  async function plantFactAuthoredBy(instanceId, label) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const r = await post(INSTANCES.a, adminToken, `/api/sync/batch-upsert?spaceId=${space.id}`, {
      facts: [{ _id: id, spaceId: space.id, fact: `bt-direction victim authored by ${label}`, tags: [],
        author: { instanceId, instanceLabel: label }, createdAt: now, updatedAt: now, seq: 5 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.facts?.inserted, 1, `the fixture record was not stored: ${JSON.stringify(r.body)}`);
    return id;
  }

  const fileStatus = async () => (await fetch(`${INSTANCES.a}/api/files/${space.id}?path=${encodeURIComponent(FILE)}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).status;

  before(async () => {
    adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    rootId = getInstanceId('ythril-a');
    space = await createTestSpace('bt-direction', [[INSTANCES.a, adminToken]]);

    const n = await post(INSTANCES.a, adminToken, '/api/networks', {
      label: `BT Direction ${Date.now()}`, type: 'braintree', spaces: [space.id], votingDeadlineHours: 1,
    });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    btNetworkId = n.body.id;

    // Two children of the root, each admitted by the real handshake: each holds a token bound to its own id.
    peers.child = await doHandshake(adminToken, btNetworkId, 'Red-Team BT Child');
    peers.sibling = await doHandshake(adminToken, btNetworkId, 'Red-Team BT Sibling');
    const members = (await get(INSTANCES.a, adminToken, `/api/networks/${btNetworkId}`)).body?.members ?? [];
    for (const [who, peer] of Object.entries(peers)) {
      assert.equal(members.find(m => m.instanceId === peer.instanceId)?.direction, 'push', `the ${who} must be a push-only member`);
    }

    victims.child = await plantFactAuthoredBy(peers.child.instanceId, 'the child');
    victims.sibling = await plantFactAuthoredBy(peers.sibling.instanceId, 'the sibling');
    victims.root = await plantFactAuthoredBy(rootId, 'the root');
    const w = await fetch(`${INSTANCES.a}/api/files/${space.id}?path=${encodeURIComponent(FILE)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ content: 'bt-direction file that no tombstone from below may delete', encoding: 'utf8' }),
    });
    assert.ok(w.status < 300, `fixture file: ${w.status}`);
    assert.equal(await fileStatus(), 200, 'the fixture file must be readable before the attempts');
  });

  after(async () => {
    if (btNetworkId) await del(INSTANCES.a, adminToken, `/api/networks/${btNetworkId}`).catch(() => {});
    await space?.remove();
  });

  for (const who of ['child', 'sibling']) {
    it(`a ${who} sending record tombstones up is refused whoever it names as the issuer, and nothing is deleted`, async () => {
      const peer = peers[who];
      // One tombstone per author that exists in the tree — the child, the sibling, the root — each claiming that author
      // as its issuer, so the set covers a peer naming itself, its sibling and its parent.
      const tombstones = Object.entries(victims).map(([author, id], i) => ({
        _id: id, type: 'fact', spaceId: space.id, deletedAt: new Date().toISOString(),
        instanceId: author === 'root' ? rootId : peers[author].instanceId, seq: Date.now() + 1_000_000 + i,
      }));
      assert.ok(tombstones.length >= 3, 'the attempt must name an issuer of each kind');
      const r = await post(INSTANCES.a, peer.token, `/api/sync/tombstones?spaceId=${space.id}&networkId=${btNetworkId}`, { tombstones });
      assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body?.error?.includes('write not permitted'), `Error should be the direction guard: ${r.body?.error}`);
      for (const [author, id] of Object.entries(victims)) {
        assert.equal((await readRecord(INSTANCES.a, adminToken, space.id, 'facts', id)).status, 200,
          `a ${who}'s tombstone deleted the record authored by the ${author}`);
      }
    });

    it(`a ${who} sending a file tombstone up is refused, and the file stays`, async () => {
      const peer = peers[who];
      const r = await post(INSTANCES.a, peer.token, `/api/sync/file-tombstones?networkId=${btNetworkId}`, {
        spaceId: space.id,
        tombstones: [{ _id: crypto.randomUUID(), path: FILE, deletedAt: new Date().toISOString(), issuer: rootId }],
      });
      assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(await fileStatus(), 200, `a ${who}'s file tombstone deleted the file`);
    });
  }

  it('control: the same child can still READ what its parent serves, so the refusals above are the direction guard', async () => {
    const r = await get(INSTANCES.a, peers.child.token, `/api/sync/tombstones?spaceId=${space.id}&networkId=${btNetworkId}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
