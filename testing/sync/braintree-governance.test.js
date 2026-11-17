/**
 * Integration tests: Braintree ancestor-path governance (TODO #4)
 *
 * Topology during these tests:
 *   A (root) --> B (direct child, registered with myParentInstanceId=A)
 *
 * Governance rules under test:
 *   - ROOT joins  : only root itself must vote  → auto-concludes → 201
 *   - INTERMEDIATE joins: self + all ancestors up to root must vote
 *     B adds grandchild X → requiredVoters=[B,A] → B auto-votes → A needs to vote
 *   - ANCESTOR VETO blocks a grandchild join
 *   - REMOVAL of direct child: only root votes → immediate removal
 *
 * Run:  node --test testing/sync/braintree-governance.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, reloadConfig, get, del, delWithBody, waitFor, triggerSync } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

// ── module-level state ──────────────────────────────────────────────────────

let tokenA, tokenB;
let instanceIdA, instanceIdB;
let peerTokenForA; // token B issued → A uses to authenticate inbound calls TO B
let peerTokenForB; // token A issued → B uses to authenticate inbound calls TO A
let testSpaceId;

// ── helpers ─────────────────────────────────────────────────────────────────

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

function readContainerConfig(container) {
  const out = dockerExec(
    `docker exec ${container} node -e "const fs=require('fs');` +
    `process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`,
  ).toString();
  return JSON.parse(out);
}

// ── outer setup ─────────────────────────────────────────────────────────────

/**
 * Mint a fresh pair of peer PATs, and do it PER DESCRIBE BLOCK rather than once for the file.
 *
 * A token carrying `peerInstanceId` is enrolled in lifecycle revocation:
 * `revokePeerCredentialsIfOrphaned` deletes every token bound to an instance the moment that instance
 * stops being a member of any network — on vote conclusion, removal, departure, or NETWORK DELETION.
 *
 * Each block below creates its own network and deletes it in `after`. So one pair minted for the whole
 * file is revoked by the first teardown, and every later block runs with a dead credential. The symptom is
 * not a 401 anywhere legible: it is `waitFor timed out`, because gossip simply stops arriving.
 *
 * These PATs were bare until 2026-09-04, which is why the pattern worked — a token with no peer identity
 * is not enrolled in that revocation and is effectively immortal. Binding them is correct (the two
 * governance relays now require it, as every other `/api/sync` write already did), and this is the cost.
 */
async function mintPeerTokens() {
    const ptForA = await post(INSTANCES.b, tokenB, '/api/tokens', {
      name: `bt-gov-peer-a-${Date.now()}`, peerInstanceId: instanceIdA,
    });
    assert.equal(ptForA.status, 201);
    peerTokenForA = ptForA.body.plaintext;

    const ptForB = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `bt-gov-peer-b-${Date.now()}`, peerInstanceId: instanceIdB,
    });
    assert.equal(ptForB.status, 201);
    peerTokenForB = ptForB.body.plaintext;
}
describe('Braintree governance — ancestor-path voting', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    // Create dedicated space so we don't sync 9k+ stale docs from 'general'
    testSpaceId = `bt-gov-${Date.now()}`;
    const spA = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'BT-Gov Test Space' });
    assert.equal(spA.status, 201, `Create space on A: ${JSON.stringify(spA.body)}`);
    const spB = await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'BT-Gov Test Space' });
    assert.equal(spB.status, 201, `Create space on B: ${JSON.stringify(spB.body)}`);

    await mintPeerTokens();
  });

  after(async () => {
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 1: Root adds direct child
  //   A (root) adds B-peer → requiredVoters=[A] → A auto-votes yes → 201 immediate
  // ══════════════════════════════════════════════════════════════════════════

  describe('Root adds direct child — auto-concludes immediately', () => {
    let networkId;

    before(async () => {
      // Fresh credentials: the previous block deleted its network, which revokes any PAT
      // bound to a peer that thereby left every network. See `mintPeerTokens`.
      await mintPeerTokens();
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `BT-Gov Root ${Date.now()}`,
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(r.status, 201);
      networkId = r.body.id;
      injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
      await reloadConfig(INSTANCES.a, tokenA);
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    });

    it('POST members with parentInstanceId=self returns 201 (no vote round needed)', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
        instanceId: instanceIdB,
        label: 'Instance B',
        url: 'http://ythril-b:3200',
        token: peerTokenForA,
        direction: 'push',
        parentInstanceId: instanceIdA,  // B's parent = A (this server)
      });
      assert.equal(r.status, 201, `Expected 201 immediate add, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('after the immediate add, B is in A member list', async () => {
      const net = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      assert.equal(net.status, 200);
      assert.ok(
        net.body.members?.some(m => m.instanceId === instanceIdB),
        `instanceIdB (${instanceIdB}) not found in A's member list`,
      );
    });

    it('no open vote rounds remain after the immediate add', async () => {
      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      const openRounds = net?.pendingRounds?.filter(r => !r.concluded) ?? [];
      assert.equal(openRounds.length, 0, 'Expected no open rounds after immediate add');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 2: Intermediate node adds grandchild
  //   A creates the network (root, myParentInstanceId=undefined)
  //   A adds B as direct child → 201 immediate
  //   B registers the network with myParentInstanceId=instanceIdA
  //   B adds C → requiredVoters=[B,A] → B auto-votes → not yet concluded → 202
  //   A receives the round via gossip, A votes yes → round concludes → C added
  // ══════════════════════════════════════════════════════════════════════════

  describe('Intermediate node adds grandchild — all ancestors vote required', () => {
    let networkId;
    let grandchildToken;
    let grandchildPAT; // PAT that B will present when adding C

    before(async () => {
      // Fresh credentials: the previous block deleted its network, which revokes any PAT
      // bound to a peer that thereby left every network. See `mintPeerTokens`.
      await mintPeerTokens();
      // Dummy grandchild instanceId — independent of a real container for this test. Assigned BEFORE the
      // PAT below, because the PAT is bound to it.
      grandchildToken = `bt-grandchild-${Date.now()}`;

      // Create a PAT for the grandchild (C) — issued on B's instance since C may not have a token we can
      // authenticate with. Nothing presents it (C is not a real container), so `peerInstanceId` is not
      // load-bearing here — it is set anyway, because a bare peer credential in a test is a shape the
      // invite flow cannot produce, and the next person to copy this block would inherit it.
      const cPat = await post(INSTANCES.b, tokenB, '/api/tokens', {
        name: `bt-gov-grandchild-${Date.now()}`,
      });
      assert.ok(cPat.status === 201, `${cPat.status}`);
      grandchildPAT = cPat.body.plaintext;

      // A: create braintree network (A is root, no myParentInstanceId)
      const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `BT-Gov Grandchild ${Date.now()}`,
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(netR.status, 201);
      networkId = netR.body.id;

      // A: add B as direct child → should be 201 (root, single voter, auto-pass)
      injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
      await reloadConfig(INSTANCES.a, tokenA);
      const addBR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
        instanceId: instanceIdB,
        label: 'Instance B',
        url: 'http://ythril-b:3200',
        token: peerTokenForA,
        direction: 'push',
        parentInstanceId: instanceIdA,
      });
      assert.equal(addBR.status, 201, `Add B to A: ${JSON.stringify(addBR.body)}`);

      // B: register the same network, declaring A as its parent in the tree
      injectPeerToken('ythril-b', instanceIdA, peerTokenForB);
      await reloadConfig(INSTANCES.b, tokenB);
      const regBR = await post(INSTANCES.b, tokenB, '/api/networks', {
        id: networkId,
        label: 'BT-Gov Grandchild',
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
        myParentInstanceId: instanceIdA,  // B tells its own server: "my parent in this tree is A"
      });
      assert.ok(regBR.status === 201 || regBR.status === 409, `Register net on B: ${JSON.stringify(regBR.body)}`);
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    });

    it('B adding a grandchild returns 202 (multi-ancestor vote pending)', async () => {
      const r = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
        instanceId: `gc-${Date.now()}`,
        label: 'Grandchild',
        url: 'http://ythril-c:3200',
        token: grandchildPAT,
        direction: 'push',
        parentInstanceId: instanceIdB,  // grandchild's parent = B (this server)
      });
      assert.equal(r.status, 202, `Expected 202 vote_pending, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.roundId, 'Expected roundId in response');
    });

    it('the pending round has requiredVoters = [B, A]', async () => {
      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks?.find(n => n.id === networkId);
      const openRounds = netB?.pendingRounds?.filter(r => !r.concluded) ?? [];
      assert.ok(openRounds.length > 0, 'Expected at least one open round on B');
      const round = openRounds[0];
      assert.ok(round.requiredVoters, 'Expected requiredVoters to be set');
      assert.ok(
        round.requiredVoters.includes(instanceIdB),
        `requiredVoters should include B (${instanceIdB})`,
      );
      assert.ok(
        round.requiredVoters.includes(instanceIdA),
        `requiredVoters should include A (${instanceIdA})`,
      );
    });

    it("B's yes vote is already cast but round is not yet concluded", async () => {
      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks?.find(n => n.id === networkId);
      const round = netB?.pendingRounds?.find(r => !r.concluded);
      assert.ok(round, 'Expected open round');
      assert.ok(
        round.votes.some(v => v.instanceId === instanceIdB && v.vote === 'yes'),
        `Expected B's yes vote in round, got: ${JSON.stringify(round.votes)}`,
      );
      assert.ok(!round.concluded, 'Round should not be concluded without A\'s vote');
    });

    it('after A votes yes (via gossip propagation), the round concludes and grandchild is added', async () => {
      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks?.find(n => n.id === networkId);
      const targetRound = netB?.pendingRounds?.find(r => !r.concluded);
      assert.ok(targetRound, 'Expected open round on B');
      const { roundId, subjectInstanceId } = targetRound;

      // Step 1: trigger sync on A so A discovers B's open vote round
      await triggerSync(INSTANCES.a, tokenA, networkId);

      // Step 2: wait for A to have the round in its pendingRounds
      await waitFor(async () => {
        const cfgA = readContainerConfig('ythril-a');
        const netA = cfgA.networks?.find(n => n.id === networkId);
        return netA?.pendingRounds?.some(r => r.roundId === roundId);
      });

      // Step 3: A casts yes vote on their local copy of the round
      const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, {
        vote: 'yes',
      });
      assert.equal(voteR.status, 200, `A vote yes: ${JSON.stringify(voteR.body)}`);

      // Step 4: trigger sync on A again → A's yes vote propagates to B
      await triggerSync(INSTANCES.a, tokenA, networkId);

      // Step 5: wait for B's round to conclude and the grandchild to appear in B's member list
      await waitFor(async () => {
        const cfgB2 = readContainerConfig('ythril-b');
        const netB2 = cfgB2.networks?.find(n => n.id === networkId);
        return netB2?.members?.some(m => m.instanceId === subjectInstanceId);
      }, 20_000);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 3: Ancestor veto blocks grandchild join
  //   Same topology as Scenario 2, but A casts a veto
  // ══════════════════════════════════════════════════════════════════════════

  describe('Ancestor veto blocks grandchild join', () => {
    let networkId;
    let vetoRoundId;
    let grandchildInstanceId;

    before(async () => {
      // Fresh credentials: the previous block deleted its network, which revokes any PAT
      // bound to a peer that thereby left every network. See `mintPeerTokens`.
      await mintPeerTokens();
      const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `BT-Gov Veto ${Date.now()}`,
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(netR.status, 201);
      networkId = netR.body.id;

      injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
      await reloadConfig(INSTANCES.a, tokenA);
      const addBR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
        instanceId: instanceIdB,
        label: 'Instance B',
        url: 'http://ythril-b:3200',
        token: peerTokenForA,
        direction: 'push',
        parentInstanceId: instanceIdA,
      });
      assert.equal(addBR.status, 201);

      injectPeerToken('ythril-b', instanceIdA, peerTokenForB);
      await reloadConfig(INSTANCES.b, tokenB);
      const regBR = await post(INSTANCES.b, tokenB, '/api/networks', {
        id: networkId,
        label: 'BT-Gov Veto',
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
        myParentInstanceId: instanceIdA,
      });
      assert.ok(regBR.status === 201 || regBR.status === 409);

      // B opens a grandchild join round
      grandchildInstanceId = `veto-gc-${Date.now()}`;
      const gcPat = await post(INSTANCES.b, tokenB, '/api/tokens', {
        name: `bt-veto-gc-${Date.now()}`,
      });
      const addR = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
        instanceId: grandchildInstanceId,
        label: 'Veto Grandchild',
        url: 'http://ythril-c:3200',
        token: gcPat.body.plaintext,
        direction: 'push',
        parentInstanceId: instanceIdB,
      });
      assert.equal(addR.status, 202);
      vetoRoundId = addR.body.roundId;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    });

    it('A vetoing a pending grandchild join causes it to fail', async () => {
      // A first discovers the round via gossip
      await triggerSync(INSTANCES.a, tokenA, networkId);

      await waitFor(async () => {
        const cfgA = readContainerConfig('ythril-a');
        const netA = cfgA.networks?.find(n => n.id === networkId);
        return netA?.pendingRounds?.some(r => r.roundId === vetoRoundId);
      });

      // A casts a veto
      const vetoR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${vetoRoundId}`, {
        vote: 'veto',
      });
      assert.equal(vetoR.status, 200);
      assert.equal(vetoR.body.concluded, true, 'Veto should conclude the round immediately');
      assert.equal(vetoR.body.round?.passed, false, 'Round should not have passed');

      // A propagates the veto to B
      await triggerSync(INSTANCES.a, tokenA, networkId);

      // Wait for B's round to be concluded (failed)
      await waitFor(async () => {
        const cfgB = readContainerConfig('ythril-b');
        const netB = cfgB.networks?.find(n => n.id === networkId);
        const r = netB?.pendingRounds?.find(r => r.roundId === vetoRoundId);
        return r?.concluded === true && r?.passed === false;
      });

      // Grandchild must NOT be in B's member list
      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks?.find(n => n.id === networkId);
      assert.ok(
        !netB?.members?.some(m => m.instanceId === grandchildInstanceId),
        'Vetoed grandchild must not be in B\'s member list',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 4: Root removes a direct child (single-voter removal)
  //   A removes B → requiredVoters=[A] → A auto-votes → immediate removal → 204
  // ══════════════════════════════════════════════════════════════════════════

  describe('Root removes direct child — single-voter removal', () => {
    let networkId;
    let removalRoundId;

    before(async () => {
      // Fresh credentials: the previous block deleted its network, which revokes any PAT
      // bound to a peer that thereby left every network. See `mintPeerTokens`.
      await mintPeerTokens();
      const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `BT-Gov Removal ${Date.now()}`,
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(netR.status, 201);
      networkId = netR.body.id;

      injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
      await reloadConfig(INSTANCES.a, tokenA);
      const addBR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
        instanceId: instanceIdB,
        label: 'Instance B',
        url: 'http://ythril-b:3200',
        token: peerTokenForA,
        direction: 'push',
        parentInstanceId: instanceIdA,
      });
      assert.equal(addBR.status, 201, `Add B: ${JSON.stringify(addBR.body)}`);
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    });

    it('DELETE member on root returns 204 (single-ancestor braintree remove auto-concludes)', async () => {
      const r = await del(INSTANCES.a, tokenA, `/api/networks/${networkId}/members/${instanceIdB}`);
      assert.equal(r.status, 204, `Expected 204 immediate remove, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('B is no longer in A member list after removal', async () => {
      const net = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      assert.ok(
        !net.body.members?.some(m => m.instanceId === instanceIdB),
        'B should not be in A\'s member list after removal',
      );
    });

    it('no open vote rounds remain after the immediate removal', async () => {
      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks?.find(n => n.id === networkId);
      const open = net?.pendingRounds?.filter(r => !r.concluded) ?? [];
      assert.equal(open.length, 0, 'Expected no open rounds after immediate removal');
    });
  });
});
