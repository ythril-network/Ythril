/**
 * Integration tests: Leave + removal flows
 *
 * Leave flow:
 *   - DELETE /api/networks/:id broadcasts member_departed to all peers before removing locally
 *   - When a peer receives member_departed it removes the sender from its local member list
 *
 * Removal flow:
 *   - After a remove vote concludes and passes, send member_removed to the ejected instance
 *   - After receiving member_removed the ejected instance marks the network as ejected
 *   - Any subsequent sync attempt on the ejected instance for that network returns 401 {"error":"ejected"}
 *   - member_removed handling is idempotent (repeated notifies do not error)
 *
 * Run:  node --test testing/sync/leave-removal.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, get, del, reqJson, waitFor, createTestSpace } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

/** The space these tests' networks carry — their own, never `general` (`Q-75`). */
let SPACE;
let testSpace;

let tokenA, tokenB;
let peerTokenForA;   // token B issued → A uses it to authenticate TO B
let peerTokenForB;   // token A issued → B uses it to authenticate TO A
let peerTokenForAId; // id of peerTokenForA record on B (for cleanup)
let peerTokenForBId; // id of peerTokenForB record on A (for cleanup)
let instanceIdA, instanceIdB;

// ── helpers ───────────────────────────────────────────────────────────────────

function getInstanceId(container) {
  return dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));` +
    `process.stdout.write(c.instanceId)"`,
  ).toString().trim();
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

/** Tag a token record in the container's config.tokens[] with peerInstanceId.
 *  Uses the token's UUID `id` (not the 8-char prefix) to avoid false matches when
 *  many stale tokens from prior runs share the same prefix.
 *  In production, the invite handshake sets this automatically.  Tests that
 *  shortcut the handshake via POST /api/tokens must call this so the
 *  peerInstanceId verification in the notify handler passes. */
function tagPeerToken(container, tokenId, peerInstanceId) {
  const script = [
    `const fs=require('fs');`,
    `const p='/config/config.json';`,
    `const c=JSON.parse(fs.readFileSync(p,'utf8'));`,
    `const t=c.tokens.find(t=>t.id==='${tokenId}');`,
    `if(!t){process.stderr.write('token not found: ${tokenId}');process.exit(1);}`,
    `t.peerInstanceId='${peerInstanceId}';`,
    `fs.writeFileSync(p,JSON.stringify(c,null,2),{mode:0o600});`,
    `process.stdout.write('ok');`,
  ].join('');
  dockerExec(`docker exec ${container} node -e "${script}"`);
}

function readContainerConfig(container) {
  const out = dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`,
  ).toString();
  return JSON.parse(out);
}

/** Mint fresh peer PATs on both instances. Departures/removals now REVOKE the
 *  departed peer's credentials (H7), so tokens cannot be reused across the
 *  leave/removal cycles in this file — each setup mints its own pair. */
async function mintPeerTokens() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ptForA = await post(INSTANCES.b, tokenB, '/api/tokens', {
    name: `leave-test-peer-a-${suffix}`,
    peerInstanceId: instanceIdA,
  });
  assert.equal(ptForA.status, 201, `Create peer token for A on B: ${JSON.stringify(ptForA.body)}`);
  peerTokenForA = ptForA.body.plaintext;
  peerTokenForAId = ptForA.body.token?.id;

  const ptForB = await post(INSTANCES.a, tokenA, '/api/tokens', {
    name: `leave-test-peer-b-${suffix}`,
    peerInstanceId: instanceIdB,
  });
  assert.equal(ptForB.status, 201, `Create peer token for B on A: ${JSON.stringify(ptForB.body)}`);
  peerTokenForB = ptForB.body.plaintext;
  peerTokenForBId = ptForB.body.token?.id;
}

/** Create a club network on A, mirror on B, inject peer tokens. Returns networkId. */
async function setupClubNetwork() {
  await mintPeerTokens();
  const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
    label: `Leave Test ${Date.now()}`,
    type: 'club',
    spaces: [SPACE],
    votingDeadlineHours: 1,
  });
  assert.equal(netR.status, 201, `Create network: ${JSON.stringify(netR.body)}`);
  const nid = netR.body.id;

  // Club = direct add (no vote round)
  const addB = await post(INSTANCES.a, tokenA, `/api/networks/${nid}/members`, {
    instanceId: instanceIdB,
    label: 'Instance B',
    url: 'http://ythril-b:3200',
    token: peerTokenForA,
    direction: 'both',
  });
  assert.equal(addB.status, 201, `Add B: ${JSON.stringify(addB.body)}`);

  const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
    id: nid,
    label: 'Leave Test',
    type: 'club',
    spaces: [SPACE],
    votingDeadlineHours: 1,
  });
  assert.ok(netOnB.status === 201 || netOnB.status === 409, `Create net on B: ${JSON.stringify(netOnB.body)}`);

  const addAonB = await post(INSTANCES.b, tokenB, `/api/networks/${nid}/members`, {
    instanceId: instanceIdA,
    label: 'Instance A',
    url: 'http://ythril-a:3200',
    token: peerTokenForB,
    direction: 'both',
  });
  assert.ok(addAonB.status === 201 || addAonB.status === 409, `Add A on B: ${JSON.stringify(addAonB.body)}`);

  injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
  injectPeerToken('ythril-b', instanceIdA, peerTokenForB);

  // Reload in-memory config+secrets on both instances so they see the injected peer tokens
  // and the peerInstanceId tags set during the before() hook.
  await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
  await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});

  return nid;
}

/** Create a democratic network on A, mirror on B, inject peer tokens. Returns networkId. */
async function setupDemocraticNetwork() {
  await mintPeerTokens();
  const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
    label: `Removal Test ${Date.now()}`,
    type: 'democratic',
    spaces: [SPACE],
    votingDeadlineHours: 1,
  });
  assert.equal(netR.status, 201, `Create network: ${JSON.stringify(netR.body)}`);
  const nid = netR.body.id;

  // Democratic = direct add for club path? No — democratic always votes. But with only A present
  // before B is added, the first join vote for B auto-concludes (A is only voter).
  const addB = await post(INSTANCES.a, tokenA, `/api/networks/${nid}/members`, {
    instanceId: instanceIdB,
    label: 'Instance B',
    url: 'http://ythril-b:3200',
    token: peerTokenForA,
    direction: 'both',
  });
  // democratic with 0 existing members → direct add (or 202 with auto-pass)
  if (addB.status === 202) {
    const vr = await post(INSTANCES.a, tokenA, `/api/networks/${nid}/votes/${addB.body.roundId}`, { vote: 'yes' });
    assert.ok(vr.status === 200, `Auto-vote for B join: ${JSON.stringify(vr.body)}`);
  } else {
    assert.equal(addB.status, 201, `Add B: ${JSON.stringify(addB.body)}`);
  }

  const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
    id: nid,
    label: 'Removal Test',
    type: 'democratic',
    spaces: [SPACE],
    votingDeadlineHours: 1,
  });
  assert.ok(netOnB.status === 201 || netOnB.status === 409, `Create net on B: ${JSON.stringify(netOnB.body)}`);

  const addAonB = await post(INSTANCES.b, tokenB, `/api/networks/${nid}/members`, {
    instanceId: instanceIdA,
    label: 'Instance A',
    url: 'http://ythril-a:3200',
    token: peerTokenForB,
    direction: 'both',
  });
  if (addAonB.status === 202) {
    const vr = await post(INSTANCES.b, tokenB, `/api/networks/${nid}/votes/${addAonB.body.roundId}`, { vote: 'yes' });
    assert.ok(vr.status === 200, `Auto-vote for A join on B: ${JSON.stringify(vr.body)}`);
  } else {
    assert.ok(addAonB.status === 201 || addAonB.status === 409, `Add A on B: ${JSON.stringify(addAonB.body)}`);
  }

  injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
  injectPeerToken('ythril-b', instanceIdA, peerTokenForB);

  await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
  await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});

  return nid;
}

// ── top-level suite ───────────────────────────────────────────────────────────

describe('Leave and removal flows', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    testSpace = await createTestSpace('leave-removal', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
    SPACE = testSpace.id;

    // Peer PATs (with peerInstanceId so the notify handler's identity
    // verification passes) are minted fresh by each setup*Network call —
    // see mintPeerTokens().
  });

  after(async () => {
    // Clean up the shared peer tokens created in before(). Without this they
    // accumulate across runs and eventually cause prefix collisions in tagPeerToken.
    if (peerTokenForAId) {
      await fetch(`${INSTANCES.b}/api/tokens/${peerTokenForAId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenB}` },
      }).catch(() => {});
    }
    if (peerTokenForBId) {
      await fetch(`${INSTANCES.a}/api/tokens/${peerTokenForBId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenA}` },
      }).catch(() => {});
    }
    await testSpace?.remove();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LEAVE FLOW
  // ══════════════════════════════════════════════════════════════════════════

  describe('Leave flow', () => {
    it('DELETE /api/networks/:id requires auth (401 without token)', async () => {
      const nid = await setupClubNetwork();
      try {
        const r = await reqJson(INSTANCES.a, null, `/api/networks/${nid}`, { method: 'DELETE' });
        assert.equal(r.status, 401);
      } finally {
        await del(INSTANCES.a, tokenA, `/api/networks/${nid}`).catch(() => {});
        await del(INSTANCES.b, tokenB, `/api/networks/${nid}`).catch(() => {});
      }
    });

    it('DELETE /api/networks/:id returns 204 and removes network locally', async () => {
      const nid = await setupClubNetwork();
      try {
        const r = await del(INSTANCES.a, tokenA, `/api/networks/${nid}`);
        assert.equal(r.status, 204, JSON.stringify(r.body));

        const check = await get(INSTANCES.a, tokenA, `/api/networks/${nid}`);
        assert.equal(check.status, 404, 'Network should be gone after DELETE');
      } finally {
        await del(INSTANCES.b, tokenB, `/api/networks/${nid}`).catch(() => {});
      }
    });

    it('After A leaves, B receives member_departed event', async () => {
      const nid = await setupClubNetwork();
      try {
        // A leaves
        const r = await del(INSTANCES.a, tokenA, `/api/networks/${nid}`);
        assert.equal(r.status, 204, JSON.stringify(r.body));

        // Verify B received the member_departed event
        await waitFor(async () => {
          const events = await get(INSTANCES.b, tokenB, `/api/notify?networkId=${nid}`);
          if (events.status !== 200) return false;
          return events.body.events.some(
            e => e.event === 'member_departed' && e.instanceId === instanceIdA && e.networkId === nid,
          );
        });
      } finally {
        await del(INSTANCES.b, tokenB, `/api/networks/${nid}`).catch(() => {});
      }
    });

    it('After A leaves, B removes A from its local member list', async () => {
      const nid = await setupClubNetwork();
      try {
        // A leaves
        await del(INSTANCES.a, tokenA, `/api/networks/${nid}`);

        // Wait for B to process the departure and remove A from its member list
        await waitFor(async () => {
          const cfgB = readContainerConfig('ythril-b');
          const netB = cfgB.networks?.find(n => n.id === nid);
          if (!netB) return false; // B still has the network but may have removed A
          return !netB.members.some(m => m.instanceId === instanceIdA);
        });
      } finally {
        await del(INSTANCES.b, tokenB, `/api/networks/${nid}`).catch(() => {});
      }
    });

    it('member_departed for an unknown instanceId is accepted idempotently (204)', async () => {
      const nid = await setupClubNetwork();
      try {
        // member_departed is advisory — any authenticated peer may announce departure.
        // If the instanceId is not in the member list, we silently accept (no state change).
        const r = await post(INSTANCES.b, tokenB, '/api/notify', {
          networkId: nid,
          instanceId: `not-a-member-${Date.now()}`,
          event: 'member_departed',
        });
        assert.equal(r.status, 204, `Expected 204 for idempotent unknown departure, got ${r.status}`);
      } finally {
        await del(INSTANCES.a, tokenA, `/api/networks/${nid}`).catch(() => {});
        await del(INSTANCES.b, tokenB, `/api/networks/${nid}`).catch(() => {});
      }
    });

    it('member_departed without auth returns 401', async () => {
      const nid = await setupClubNetwork();
      try {
        const r = await reqJson(INSTANCES.b, null, '/api/notify', {
          method: 'POST',
          body: JSON.stringify({ networkId: nid, instanceId: instanceIdA, event: 'member_departed' }),
        });
        assert.equal(r.status, 401);
      } finally {
        await del(INSTANCES.a, tokenA, `/api/networks/${nid}`).catch(() => {});
        await del(INSTANCES.b, tokenB, `/api/networks/${nid}`).catch(() => {});
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // REMOVAL FLOW
  // ══════════════════════════════════════════════════════════════════════════

  describe('Removal flow', () => {
    let removalNetworkId;

    before(async () => {
      // Create democratic network on A and B; B is being removed by A
      removalNetworkId = await setupDemocraticNetwork();

      // A opens a remove round for B (democratic: voters = [A], so A voting yes passes it)
      const removeR = await del(INSTANCES.a, tokenA, `/api/networks/${removalNetworkId}/members/${instanceIdB}`);
      assert.equal(removeR.status, 202, `Expected 202 vote_pending: ${JSON.stringify(removeR.body)}`);
      const { roundId } = removeR.body;

      // A votes yes → concludes immediately (A is only non-subject voter in democratic)
      const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${removalNetworkId}/votes/${roundId}`, { vote: 'yes' });
      assert.equal(voteR.status, 200, `Vote yes: ${JSON.stringify(voteR.body)}`);
      assert.equal(voteR.body.concluded, true, 'Round should conclude immediately');

      // Wait until B's config shows ejection (member_removed processed)
      await waitFor(async () => {
        const cfgB = readContainerConfig('ythril-b');
        return cfgB.ejectedFromNetworks?.includes(removalNetworkId);
      });
    });

    after(async () => {
      // A still has the network (B was removed from members, not the network itself)
      // B's network was removed when it processed member_removed
      await del(INSTANCES.a, tokenA, `/api/networks/${removalNetworkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${removalNetworkId}`).catch(() => {});
    });

    it('After remove vote passes, B has processed member_removed (network ejected)', async () => {
      const cfgB = readContainerConfig('ythril-b');
      assert.ok(
        cfgB.ejectedFromNetworks?.includes(removalNetworkId),
        `Expected ejectedFromNetworks to contain ${removalNetworkId}`,
      );
      // B's network should be gone from its networks list
      assert.ok(
        !cfgB.networks?.some(n => n.id === removalNetworkId),
        'Ejected network should be removed from B\'s networks list',
      );
    });

    it('Sync to B for the ejected network returns 401 ejected', async () => {
      // peerTokenForA = token B issued → A uses it to call B's sync endpoints
      const gossipR = await get(
        INSTANCES.b,
        peerTokenForA,
        `/api/sync/networks/${removalNetworkId}/members`,
      );
      assert.equal(gossipR.status, 401, `Expected 401 ejected, got ${gossipR.status}: ${JSON.stringify(gossipR.body)}`);
      assert.equal(gossipR.body?.error, 'ejected', `Expected {error:"ejected"}, got ${JSON.stringify(gossipR.body)}`);
    });

    it('Vote endpoint for the ejected network also returns 401 ejected', async () => {
      const votesR = await get(
        INSTANCES.b,
        peerTokenForA,
        `/api/sync/networks/${removalNetworkId}/votes`,
      );
      assert.equal(votesR.status, 401, `Expected 401 ejected: ${JSON.stringify(votesR.body)}`);
      assert.equal(votesR.body?.error, 'ejected');
    });

    it('member_removed is idempotent — second notify returns 204 or 404, never 5xx', async () => {
      // Network is already ejected on B; resending should not blow up
      const r = await post(INSTANCES.b, tokenB, '/api/notify', {
        networkId: removalNetworkId,
        instanceId: instanceIdA,
        event: 'member_removed',
      });
      assert.ok(
        r.status === 204 || r.status === 404,
        `Expected 204 or 404 for idempotent member_removed, got ${r.status}: ${JSON.stringify(r.body)}`,
      );
    });
  });
});
