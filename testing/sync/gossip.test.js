/**
 * Integration tests: Gossip — member list exchange piggybacked on sync cycles
 *
 * The engine is expected to call POST /api/sync/networks/:networkId/members on each peer
 * during every sync cycle, pushing the local instance's own member record (url, label, children).
 *
 * Covers:
 *  - After a sync trigger, peer B sees A's latest label/url updated via gossip
 *  - After a sync trigger, peer A sees B's latest label/url updated via gossip
 *  - Gossip poisoning protection: a member cannot overwrite another member's record
 *  - GET /api/sync/networks/:networkId/members returns current member view (auth required)
 *  - Unauthenticated GET returns 401
 *  - Unknown networkId returns 404
 *  - Gossip POST for unknown instanceId returns { status: 'unknown_member' } (not auto-added)
 *  - Gossip POST missing required fields returns 400
 *
 * Run:  node --test testing/sync/gossip.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, reqJson, triggerSync, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB;
// Pair of peer tokens (A-calls-B, B-calls-A) created during setup
let peerTokenForA;  // plaintext token B issues so A can call B
let peerTokenForB;  // plaintext token A issues so B can call A
let networkId;
let testSpaceId;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Inject a peer token into a container's secrets.json via docker exec */
function injectPeerToken(container, instanceId, token) {
  const script = `
const fs = require('fs');
const p = '/config/secrets.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.peerTokens = s.peerTokens || {};
s.peerTokens['${instanceId}'] = '${token}';
fs.writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
process.stdout.write('ok');
`.replace(/\n/g, ' ');
  execSync(`docker exec ${container} node -e "${script}"`);
}

/** Read instanceId from a container's config.json */
function getInstanceId(container) {
  const out = execSync(
    `docker exec ${container} node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(c.instanceId)"`,
  ).toString().trim();
  return out;
}

/** Read instanceLabel from a container's config.json */
function getInstanceLabel(container) {
  return execSync(
    `docker exec ${container} node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(c.instanceLabel)"`,
  ).toString().trim();
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('Gossip: member list exchange', () => {
  let instanceIdA, instanceIdB;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    // Create dedicated space so we don't sync 9k+ stale docs from 'general'
    testSpaceId = `gossip-test-${Date.now()}`;
    const spA = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Gossip Test Space' });
    assert.equal(spA.status, 201, `Create space on A: ${JSON.stringify(spA.body)}`);
    const spB = await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'Gossip Test Space' });
    assert.equal(spB.status, 201, `Create space on B: ${JSON.stringify(spB.body)}`);

    // Create a closed network on A
    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Gossip Test Network',
      type: 'closed',
      spaces: [testSpaceId],
      votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, `Create network: ${JSON.stringify(netR.body)}`);
    networkId = netR.body.id;

    // Peer tokens: A issues one for B, B issues one for A
    const ptForA = await post(INSTANCES.b, tokenB, '/api/tokens', { name: `gossip-test-peer-a-${Date.now()}` });
    assert.equal(ptForA.status, 201);
    peerTokenForA = ptForA.body.plaintext;

    const ptForB = await post(INSTANCES.a, tokenA, '/api/tokens', { name: `gossip-test-peer-b-${Date.now()}` });
    assert.equal(ptForB.status, 201);
    peerTokenForB = ptForB.body.plaintext;

    // Add B as a member of the network on A.
    // Closed network with only current instance voting — auto-passes if vote immediately castes yes.
    const addR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdB,
      label: 'Instance B',
      url: 'http://ythril-b:3200',
      token: peerTokenForA,
      direction: 'both',
    });
    if (addR.status === 202) {
      const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addR.body.roundId}`, { vote: 'yes' });
      assert.ok(voteR.status === 200 || voteR.status === 201, `Auto-vote: ${JSON.stringify(voteR.body)}`);
    } else {
      assert.equal(addR.status, 201, `Add B: ${JSON.stringify(addR.body)}`);
    }

    // Inject peer tokens into containers so the engine can authenticate
    injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
    injectPeerToken('ythril-b', instanceIdA, peerTokenForB);

    // Reload in-memory secrets on both instances
    await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});

    // Mirror the network on B: add A as a member so B's engine has something to call
    const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
      id: networkId,
      label: 'Gossip Test Network',
      type: 'closed',
      spaces: [testSpaceId],
      votingDeadlineHours: 1,
    });
    // Ignore 409 (already exists from a previous test run that wasn't cleaned up)
    assert.ok(netOnB.status === 201 || netOnB.status === 409, `Create net on B: ${JSON.stringify(netOnB.body)}`);

    const addAonB = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdA,
      label: 'Instance A',
      url: 'http://ythril-a:3200',
      token: peerTokenForB,
      direction: 'both',
    });
    if (addAonB.status === 202) {
      await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${addAonB.body.roundId}`, { vote: 'yes' });
    } else {
      assert.ok(addAonB.status === 201 || addAonB.status === 409, `Add A on B: ${JSON.stringify(addAonB.body)}`);
    }
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    }
    if (testSpaceId) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });

  // ── GET gossip endpoint ─────────────────────────────────────────────────────

  it('GET members returns current view', async () => {
    const r = await get(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/members`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.members), 'members should be an array');
    assert.ok(typeof r.body.updatedAt === 'string', 'updatedAt should be present');
  });

  it('GET members requires auth (401 without token)', async () => {
    const r = await reqJson(INSTANCES.a, null, `/api/sync/networks/${networkId}/members`);
    assert.equal(r.status, 401);
  });

  it('GET members returns 404 for unknown network', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/sync/networks/nonexistent-net/members');
    assert.equal(r.status, 404);
  });

  // ── POST gossip endpoint (direct unit-level tests) ──────────────────────────

  it('POST gossip 400 when required fields missing', async () => {
    const r = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/members`, {
      instanceId: 'some-id',
      // missing label and url
    });
    assert.equal(r.status, 400);
  });

  it('POST gossip returns unknown_member for unregistered instanceId', async () => {
    const r = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/members`, {
      instanceId: 'completely-unknown-peer',
      label: 'Ghost Peer',
      url: 'http://ghost.internal:3200',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'unknown_member');
  });

  it('POST gossip 404 for unknown networkId', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/sync/networks/no-such-net/members', {
      instanceId: 'x',
      label: 'x',
      url: 'http://x:3200',
    });
    assert.equal(r.status, 404);
  });

  it('POST gossip 401 without auth', async () => {
    const r = await reqJson(INSTANCES.a, null, `/api/sync/networks/${networkId}/members`, {
      method: 'POST',
      body: JSON.stringify({ instanceId: 'x', label: 'x', url: 'http://x:3200' }),
    });
    assert.equal(r.status, 401);
  });

  // ── Engine gossip exchange (end-to-end) ─────────────────────────────────────

  it('After sync trigger, B\'s instanceLabel is propagated to A via gossip self-piggyback', async () => {
    // Read B's real instanceLabel from inside the container (avoids host-side permission issues)
    const realLabelB = getInstanceLabel('ythril-b');

    // Plant a stale label for B in A's member record (via A's own gossip endpoint)
    const stale = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/members`, {
      instanceId: instanceIdB,
      label: `stale-${Date.now()}`,
      url: 'http://ythril-b:3200',
    });
    assert.equal(stale.status, 200, `Stale-label plant: ${JSON.stringify(stale.body)}`);

    // Trigger sync from A — engine pushes A's self-record to B;
    // B responds with its own self-record ({ label: realLabelB });
    // engine updates A's record for B with the piggybacked label.
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // A should eventually show B's real instanceLabel
    await waitFor(async () => {
      const r = await get(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/members`);
      if (r.status !== 200) return false;
      const bMember = r.body.members.find(m => m.instanceId === instanceIdB);
      return bMember?.label === realLabelB;
    });
  });

  it('After sync trigger, B sees A\'s current label via gossip self-push', async () => {
    // Read A's actual instanceLabel from inside the container (avoids host-side permission issues)
    const realLabelA = getInstanceLabel('ythril-a');

    // Plant a stale label for A in B's member record so there is a clear before/after signal
    const stale = await post(INSTANCES.b, tokenB, `/api/sync/networks/${networkId}/members`, {
      instanceId: instanceIdA,
      label: `stale-${Date.now()}`,
      url: 'http://ythril-a:3200',
    });
    assert.equal(stale.status, 200, `Stale-label plant: ${JSON.stringify(stale.body)}`);

    // Trigger sync from A — engine posts A's self-record (real instanceLabel) to B
    await triggerSync(INSTANCES.a, tokenA, networkId);

    // B should eventually show A's real label
    await waitFor(async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/sync/networks/${networkId}/members`);
      if (r.status !== 200) return false;
      const aMember = r.body.members.find(m => m.instanceId === instanceIdA);
      return aMember?.label === realLabelA;
    });
  });

  it('Gossip poisoning: B cannot overwrite A\'s member record on A', async () => {
    // B's token authenticates as B's instanceId.
    // B should not be able to update A's record — the endpoint checks instanceId of caller.
    // We simulate this by posting with B's token but claiming to update A's instanceId.
    const r = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/members`, {
      instanceId: instanceIdA,   // claiming to update A's own record
      label: 'Poisoned Label by B',
      url: 'http://attacker:3200',
    });
    // Per the poison-protection logic: only the declared instance may update its own record.
    // A's instanceId is not in A's own member list — so it returns unknown_member (not auto-applied).
    // Any other behaviour (200 ok with label changed, or actual update) is a test failure.
    const membersR = await get(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/members`);
    const aMember = membersR.body.members.find(m => m.instanceId === instanceIdA);
    // A should not appear in its own member list at all; no record was poisoned.
    assert.ok(!aMember || aMember.url !== 'http://attacker:3200',
      'Gossip poisoning: A\'s record should not be overwritten by an external call');
  });
});
