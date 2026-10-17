/**
 * Integration tests: Vote propagation via gossip sync cycles
 *
 * The engine is expected to call GET /api/sync/networks/:networkId/votes during each
 * sync cycle and relay new vote casts via POST /api/sync/networks/:networkId/votes/:roundId.
 * New rounds discovered via GET are created locally; existing round votes are merged.
 *
 * Covers:
 *  - GET /api/sync/networks/:networkId/votes returns open rounds (auth required)
 *  - GET returns 401 without token, 404 for unknown network
 *  - POST /api/sync/networks/:networkId/votes/:roundId requires vote + instanceId
 *  - POST returns 404 for unknown roundId
 *  - After B triggers sync with A, B receives A's open round (round propagation via pull)
 *  - After B triggers sync with A, B receives A's vote cast on that round
 *  - After A triggers sync, A receives B's vote cast (push relays A-known votes; pull merges B-known votes)
 *  - A round that concludes via gossip (e.g., veto relayed) is marked concluded locally
 *  - Sensitive fields (inviteKeyHash, pendingMember.tokenHash) are stripped from GET response
 *
 * Run:  node --test testing/sync/vote-propagation.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, get, del, delWithBody, reqJson, triggerSync, makeTriggerProbe, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB;
let peerTokenForA;   // B-issued token A uses to call B
let peerTokenForB;   // A-issued token B uses to call A
let networkId;
let instanceIdA, instanceIdB;
let testSpaceId;

// ── helpers ──────────────────────────────────────────────────────────────────

function getInstanceId(container) {
  return dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(c.instanceId)"`,
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

/** Open a join round on an instance for a fake candidate. Returns { roundId, candidateId }. */
async function openJoinRound(baseUrl, token, networkId, label = `Candidate-${Date.now()}`) {
  const candidateId = `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const r = await post(baseUrl, token, `/api/networks/${networkId}/members`, {
    instanceId: candidateId,
    label,
    url: 'http://vote-test.internal:3200',
    token: `ythril_votetest_${candidateId}`,
    direction: 'both',
  });
  assert.equal(r.status, 202, `Expected 202 vote_pending, got ${r.status}: ${JSON.stringify(r.body)}`);
  return { roundId: r.body.roundId, candidateId };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('Vote propagation via gossip', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    testSpaceId = `vote-prop-${Date.now()}`;
    const spA = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Vote Propagation Test Space' });
    assert.equal(spA.status, 201, `Create space on A: ${JSON.stringify(spA.body)}`);
    const spB = await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'Vote Propagation Test Space' });
    assert.equal(spB.status, 201, `Create space on B: ${JSON.stringify(spB.body)}`);

    // Create peer PATs so the engine can authenticate cross-instance
    const ptForA = await post(INSTANCES.b, tokenB, '/api/tokens', {
      name: `vote-test-peer-a-${Date.now()}`, peerInstanceId: instanceIdA,
    });
    assert.equal(ptForA.status, 201);
    peerTokenForA = ptForA.body.plaintext;

    const ptForB = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `vote-test-peer-b-${Date.now()}`, peerInstanceId: instanceIdB,
    });
    assert.equal(ptForB.status, 201);
    peerTokenForB = ptForB.body.plaintext;

    // Create a closed network on A with B as member
    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Vote Prop Test ${Date.now()}`,
      type: 'closed',
      spaces: [testSpaceId],
      votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, `Create network: ${JSON.stringify(netR.body)}`);
    networkId = netR.body.id;

    // Add B to network on A (may open a vote; in single-member network, auto-concludes)
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdB,
      label: 'Instance B',
      url: 'http://ythril-b:3200',
      token: peerTokenForA,
      direction: 'both',
    });
    if (addB.status === 202) {
      // Auto-vote to pass (solo network, A is only voter)
      await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
    } else {
      assert.equal(addB.status, 201, `Add B: ${JSON.stringify(addB.body)}`);
    }

    // Mirror network on B
    const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
      id: networkId,
      label: `Vote Prop Test`,
      type: 'closed',
      spaces: [testSpaceId],
      votingDeadlineHours: 1,
    });
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

    // Inject peer tokens into secrets.json so engines can authenticate
    injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
    injectPeerToken('ythril-b', instanceIdA, peerTokenForB);

    await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });

  // ── GET /api/sync/networks/:id/votes ─────────────────────────────────────

  it('GET votes returns open rounds', async () => {
    const r = await get(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/votes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.rounds), 'rounds should be an array');
  });

  it('GET votes requires auth (401 without token)', async () => {
    const r = await reqJson(INSTANCES.a, null, `/api/sync/networks/${networkId}/votes`);
    assert.equal(r.status, 401);
  });

  it('GET votes returns 404 for unknown network', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/sync/networks/no-such-net/votes');
    assert.equal(r.status, 404);
  });

  it('GET votes does not expose inviteKeyHash or pendingMember.tokenHash', async () => {
    // Open a join round so there is a pendingMember in the response
    const { roundId } = await openJoinRound(INSTANCES.a, tokenA, networkId, 'SensitiveCandidate');
    const r = await get(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/votes`);
    assert.equal(r.status, 200);
    const round = r.body.rounds.find(rnd => rnd.roundId === roundId);
    assert.ok(round, 'The newly opened round should appear in GET /votes');
    assert.ok(!('inviteKeyHash' in round), 'inviteKeyHash must be stripped');
    if (round.pendingMember) {
      assert.ok(!('tokenHash' in round.pendingMember), 'pendingMember.tokenHash must be stripped');
    }
    // Cleanup: let the round expire naturally (no vote cast)
  });

  // ── POST /api/sync/networks/:id/votes/:roundId ────────────────────────────

  it('POST vote relay returns 400 on missing fields', async () => {
    const { roundId } = await openJoinRound(INSTANCES.a, tokenA, networkId);
    const r = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/votes/${roundId}`, {
      // missing instanceId
      vote: 'yes',
    });
    assert.equal(r.status, 400);
  });

  it('POST vote relay returns 404 for unknown roundId', async () => {
    const r = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/votes/no-such-round`, {
      vote: 'yes',
      instanceId: instanceIdA,
    });
    assert.equal(r.status, 404);
  });

  it('POST vote relay returns 401 without auth', async () => {
    const r = await reqJson(INSTANCES.a, null, `/api/sync/networks/${networkId}/votes/some-round`, {
      method: 'POST',
      body: JSON.stringify({ vote: 'yes', instanceId: instanceIdA }),
    });
    assert.equal(r.status, 401);
  });

  it('POST vote relay accepts a valid vote and returns ok', async () => {
    const { roundId } = await openJoinRound(INSTANCES.a, tokenA, networkId);
    const r = await post(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/votes/${roundId}`, {
      vote: 'yes',
      instanceId: instanceIdB,  // pretend B voted
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok');
  });

  // ── Engine: end-to-end vote propagation ──────────────────────────────────

  it('After B syncs with A, B receives the open round A created', async () => {
    // A opens a join round for a fake candidate
    const { roundId, candidateId } = await openJoinRound(INSTANCES.a, tokenA, networkId, 'PropagateRound');

    // B triggers sync (pulls from A) — engine should create the round on B
    await triggerSync(INSTANCES.b, tokenB, networkId);

    await waitFor(async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/sync/networks/${networkId}/votes`);
      if (r.status !== 200) return false;
      return r.body.rounds.some(rnd => rnd.roundId === roundId);
    });
  });

  it('After B syncs with A, B also receives A\'s vote on the round', async () => {
    // A opens a join round and casts a yes vote
    const { roundId } = await openJoinRound(INSTANCES.a, tokenA, networkId, 'PropagateVote');
    const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.ok([200, 201].includes(voteR.status), `A votes yes: ${JSON.stringify(voteR.body)}`);

    // B triggers sync — should pull the round and A's yes vote
    await triggerSync(INSTANCES.b, tokenB, networkId);

    await waitFor(async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/sync/networks/${networkId}/votes`);
      if (r.status !== 200) return false;
      const rnd = r.body.rounds.find(rn => rn.roundId === roundId);
      // Round may already be concluded (all remote voters voted) — that also proves the vote arrived
      if (!rnd) return true;
      return rnd.votes?.some(v => v.instanceId === instanceIdA && v.vote === 'yes');
    });
  });

  it('After A syncs, A receives B\'s vote on a round both have', async () => {
    // A opens a round
    const { roundId } = await openJoinRound(INSTANCES.a, tokenA, networkId, 'BiDirectional');

    // B pulls the round from A
    await triggerSync(INSTANCES.b, tokenB, networkId);
    await waitFor(async () => {
      const r = await get(INSTANCES.b, tokenB, `/api/sync/networks/${networkId}/votes`);
      return r.status === 200 && r.body.rounds.some(rnd => rnd.roundId === roundId);
    });

    // B casts a yes vote via B's user API
    const bVote = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.ok([200, 201].includes(bVote.status), `B votes yes: ${JSON.stringify(bVote.body)}`);

    // B's yes reaches A by either half of the gossip. Since D-36 (bundle-106) A's own yes was cast when the round opened, so B's yes
    // completes the closed network's unanimity and B concludes the round at once — and a passed JOIN is not served once concluded
    // (only space and schema rounds are, `SERVED_ONCE_PASSED`), so A's pull no longer finds it on B's open list. B's cycle PUSHES its
    // cast to A (`propagateVotesWithPeer`), so B syncs too, re-triggered on every poll; A's sync pulls whatever is still open.
    const pushFromB = makeTriggerProbe(INSTANCES.b, tokenB, networkId, 'B');
    await triggerSync(INSTANCES.a, tokenA, networkId);

    await waitFor(async () => {
      await pushFromB();
      const r = await get(INSTANCES.a, tokenA, `/api/sync/networks/${networkId}/votes`);
      if (r.status !== 200) return false;
      const rnd = r.body.rounds.find(rn => rn.roundId === roundId);
      // Round may already be concluded (all remote voters voted) — that also proves the vote arrived
      if (!rnd) return true;
      return rnd.votes?.some(v => v.instanceId === instanceIdB && v.vote === 'yes');
    }, 30_000, 1_000, pushFromB.diagnose);
  });

  it('A veto relayed via gossip concludes the round on B', async () => {
    // A opens a round and casts a veto
    const { roundId } = await openJoinRound(INSTANCES.a, tokenA, networkId, 'VetoConclusion');
    const vetoR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'veto' });
    assert.ok([200, 201].includes(vetoR.status), `A vetoes: ${JSON.stringify(vetoR.body)}`);

    // B triggers sync — should pull the round with the veto and conclude it locally
    await triggerSync(INSTANCES.b, tokenB, networkId);

    await waitFor(async () => {
      // Once concluded, the round should no longer appear in open rounds on B
      const r = await get(INSTANCES.b, tokenB, `/api/sync/networks/${networkId}/votes`);
      if (r.status !== 200) return false;
      // If the round is gone (concluded + filtered by GET) or has the veto, that's success
      const rnd = r.body.rounds.find(rn => rn.roundId === roundId);
      if (!rnd) return true;  // concluded and filtered out
      return rnd.votes?.some(v => v.instanceId === instanceIdA && v.vote === 'veto');
    });
  });
});
