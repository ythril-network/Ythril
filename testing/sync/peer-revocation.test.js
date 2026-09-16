/**
 * Integration tests: peer credential revocation on removal / ejection (H7)
 *
 * Removed or ejected sync peers must not keep valid credentials:
 *  - Club direct removal: the removed member's inbound PAT (peerInstanceId)
 *    and our outbound peer token are revoked on the removing instance
 *  - Multi-network membership: credentials survive removal from ONE network
 *    while the peer is still a member of another, and are revoked after the
 *    last shared network is gone
 *  - Remove vote conclusion: same revocation on the vote path
 *  - Ejected side: after processing member_removed, the ejected instance
 *    revokes the ex-peers' credentials
 *  - Ejection guard: data endpoints (e.g. /api/sync/facts) refuse requests
 *    scoped to an ejected network with 401 {"error":"ejected"} — previously
 *    only /api/sync/networks/:id/* was guarded
 *
 * Run:  node --test testing/sync/peer-revocation.test.js
 * Pre-requisite: docker compose test stack up + testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, get, del, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB;
let instanceIdA, instanceIdB;

function getInstanceId(container) {
  return dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));` +
    `process.stdout.write(c.instanceId)"`,
  ).toString().trim();
}

function readContainerConfig(container) {
  const out = dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`,
  ).toString();
  return JSON.parse(out);
}

function readContainerSecrets(container) {
  const out = dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `process.stdout.write(fs.readFileSync('/config/secrets.json','utf8'))"`,
  ).toString();
  return JSON.parse(out);
}

function injectPeerToken(container, instanceId, token) {
  const script = [
    `const fs=require('fs');`,
    `const p='/config/secrets.json';`,
    `const s=JSON.parse(fs.readFileSync(p,'utf8'));`,
    `s.peerTokens=s.peerTokens||{};`,
    `s.peerTokens['${instanceId}']='${token}';`,
    `fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600});`,
    `process.stdout.write('ok');`,
  ].join('');
  dockerExec(`docker exec ${container} node -e "${script}"`);
}

/** Create a fresh peer PAT on `base` bound to `peerInstanceId`. */
async function createPeerToken(base, adminToken, name, peerInstanceId) {
  const r = await post(base, adminToken, '/api/tokens', { name, peerInstanceId });
  assert.equal(r.status, 201, `create peer token: ${JSON.stringify(r.body)}`);
  return { id: r.body.token?.id ?? r.body.id, plaintext: r.body.plaintext };
}

/** Create a club network on A with B as a direct member. Returns networkId. */
async function createClubWithB(outboundTokenForB) {
  const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
    label: `Revocation Test ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'club',
    spaces: ['general'],
    votingDeadlineHours: 1,
  });
  assert.equal(netR.status, 201, `create network: ${JSON.stringify(netR.body)}`);
  const nid = netR.body.id;
  const addB = await post(INSTANCES.a, tokenA, `/api/networks/${nid}/members`, {
    instanceId: instanceIdB,
    label: 'Instance B',
    url: 'http://ythril-b:3200',
    token: outboundTokenForB,
    direction: 'both',
  });
  assert.equal(addB.status, 201, `add B: ${JSON.stringify(addB.body)}`);
  return nid;
}

function tokensWithPeerId(container, peerInstanceId) {
  const cfg = readContainerConfig(container);
  return (cfg.tokens ?? []).filter(t => t.peerInstanceId === peerInstanceId);
}

/** Delete leftover networks from prior (failed) runs of this file — a stale
 *  network still listing the peer as a member legitimately blocks revocation. */
async function cleanupStaleNetworks(base, adminToken) {
  const r = await get(base, adminToken, '/api/networks');
  if (r.status !== 200) return;
  for (const n of r.body.networks ?? []) {
    if (n.label?.startsWith('Revocation')) {
      await del(base, adminToken, `/api/networks/${n.id}`).catch(() => {});
    }
  }
}

describe('Peer credential revocation (H7)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    await cleanupStaleNetworks(INSTANCES.a, tokenA);
    await cleanupStaleNetworks(INSTANCES.b, tokenB);
  });

  it('club direct removal revokes the removed peer\'s PAT and the outbound token', async () => {
    // Inbound PAT on A that "B" would present, bound to B's instanceId
    const pat = await createPeerToken(INSTANCES.a, tokenA, `revoke-club-${Date.now()}`, instanceIdB);
    const nid = await createClubWithB('dummy-outbound-token-club');

    // Sanity: PAT exists, outbound token stored by the add-member call
    assert.ok(tokensWithPeerId('ythril-a', instanceIdB).length >= 1, 'PAT should exist before removal');
    assert.ok(readContainerSecrets('ythril-a').peerTokens?.[instanceIdB], 'outbound token should exist before removal');

    const rm = await del(INSTANCES.a, tokenA, `/api/networks/${nid}/members/${instanceIdB}`);
    assert.equal(rm.status, 204, `remove member: ${JSON.stringify(rm.body)}`);

    await waitFor(async () => tokensWithPeerId('ythril-a', instanceIdB).length === 0);
    await waitFor(async () => !readContainerSecrets('ythril-a').peerTokens?.[instanceIdB]);

    // The revoked PAT must no longer authenticate
    const r = await get(INSTANCES.a, pat.plaintext, '/api/spaces');
    assert.equal(r.status, 401, `revoked PAT must not authenticate, got ${r.status}`);

    await del(INSTANCES.a, tokenA, `/api/networks/${nid}`).catch(() => {});
  });

  it('credentials survive removal while the peer is still a member of another network', async () => {
    const pat = await createPeerToken(INSTANCES.a, tokenA, `revoke-multi-${Date.now()}`, instanceIdB);
    const nid1 = await createClubWithB('dummy-outbound-token-m1');
    const nid2 = await createClubWithB('dummy-outbound-token-m2');

    // Remove B from network 1 only — still a member of network 2
    const rm1 = await del(INSTANCES.a, tokenA, `/api/networks/${nid1}/members/${instanceIdB}`);
    assert.equal(rm1.status, 204);

    // Give the async revocation a moment, then confirm the PAT survived.
    // Negative assertion — fixed wait is correct; do NOT convert to waitFor (Q3).
    await new Promise(r => setTimeout(r, 1500));
    assert.ok(
      tokensWithPeerId('ythril-a', instanceIdB).length >= 1,
      'PAT must survive while B is still a member of another network',
    );
    const stillValid = await get(INSTANCES.a, pat.plaintext, '/api/spaces');
    assert.equal(stillValid.status, 200, 'PAT should still authenticate');

    // Remove B from network 2 — now orphaned, credentials must go
    const rm2 = await del(INSTANCES.a, tokenA, `/api/networks/${nid2}/members/${instanceIdB}`);
    assert.equal(rm2.status, 204);
    await waitFor(async () => tokensWithPeerId('ythril-a', instanceIdB).length === 0);

    await del(INSTANCES.a, tokenA, `/api/networks/${nid1}`).catch(() => {});
    await del(INSTANCES.a, tokenA, `/api/networks/${nid2}`).catch(() => {});
  });

  describe('remove-vote conclusion + ejection side', () => {
    let nid;
    let patOnA;   // B's PAT on A (revoked when the remove vote concludes on A)
    let patOnB;   // A's PAT on B (revoked when B processes member_removed)

    before(async () => {
      patOnA = await createPeerToken(INSTANCES.a, tokenA, `revoke-vote-a-${Date.now()}`, instanceIdB);
      patOnB = await createPeerToken(INSTANCES.b, tokenB, `revoke-vote-b-${Date.now()}`, instanceIdA);

      // Democratic network on A with B as member; A can notify B via patOnB
      const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `Revocation Vote Test ${Date.now()}`,
        type: 'democratic',
        spaces: ['general'],
        votingDeadlineHours: 1,
      });
      assert.equal(netR.status, 201);
      nid = netR.body.id;

      const addB = await post(INSTANCES.a, tokenA, `/api/networks/${nid}/members`, {
        instanceId: instanceIdB,
        label: 'Instance B',
        url: 'http://ythril-b:3200',
        token: patOnB.plaintext,
        direction: 'both',
      });
      if (addB.status === 202) {
        const vr = await post(INSTANCES.a, tokenA, `/api/networks/${nid}/votes/${addB.body.roundId}`, { vote: 'yes' });
        assert.equal(vr.status, 200);
      } else {
        assert.equal(addB.status, 201, JSON.stringify(addB.body));
      }

      // Mirror the network on B so it can process the ejection
      const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
        id: nid,
        label: 'Revocation Vote Test',
        type: 'democratic',
        spaces: ['general'],
        votingDeadlineHours: 1,
      });
      assert.ok(netOnB.status === 201 || netOnB.status === 409);
      const addAonB = await post(INSTANCES.b, tokenB, `/api/networks/${nid}/members`, {
        instanceId: instanceIdA,
        label: 'Instance A',
        url: 'http://ythril-a:3200',
        token: patOnA.plaintext,
        direction: 'both',
      });
      if (addAonB.status === 202) {
        const vr = await post(INSTANCES.b, tokenB, `/api/networks/${nid}/votes/${addAonB.body.roundId}`, { vote: 'yes' });
        assert.equal(vr.status, 200);
      }
      // Outbound orientation: A calls B with the token B issued (patOnB), and
      // vice versa — same as the invite handshake would set up.
      injectPeerToken('ythril-a', instanceIdB, patOnB.plaintext);
      injectPeerToken('ythril-b', instanceIdA, patOnA.plaintext);
      await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
      await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});

      // A opens + concludes the remove vote for B
      const removeR = await del(INSTANCES.a, tokenA, `/api/networks/${nid}/members/${instanceIdB}`);
      assert.equal(removeR.status, 202, JSON.stringify(removeR.body));
      const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${nid}/votes/${removeR.body.roundId}`, { vote: 'yes' });
      assert.equal(voteR.status, 200, JSON.stringify(voteR.body));
      assert.equal(voteR.body.concluded, true);

      // Wait until B has processed member_removed
      await waitFor(async () => readContainerConfig('ythril-b').ejectedFromNetworks?.includes(nid));
    });

    after(async () => {
      // B's copy was removed by the ejection; clean up A's copy.
      await del(INSTANCES.a, tokenA, `/api/networks/${nid}`).catch(() => {});
    });

    it('the removing instance revokes the ejected peer\'s credentials', async () => {
      await waitFor(async () => tokensWithPeerId('ythril-a', instanceIdB).length === 0);
      await waitFor(async () => !readContainerSecrets('ythril-a').peerTokens?.[instanceIdB]);
    });

    it('the ejected instance revokes the ex-peer\'s credentials after member_removed', async () => {
      await waitFor(async () => tokensWithPeerId('ythril-b', instanceIdA).length === 0);
    });

    it('data endpoints refuse requests scoped to the ejected network (401 ejected)', async () => {
      // Previously only /api/sync/networks/:id/* was guarded; data endpoints
      // fell back to "space exists" because the network config was deleted.
      const r = await get(INSTANCES.b, tokenB, `/api/sync/facts?spaceId=general&networkId=${nid}`);
      assert.equal(r.status, 401, `expected 401 ejected, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, 'ejected');
    });

    it('data endpoints for other networks still work on the ejected instance', async () => {
      const r = await get(INSTANCES.b, tokenB, '/api/sync/facts?spaceId=general');
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  });
});
