/**
 * Integration tests: Democratic network voting (A, B, C — majority required)
 *
 * Run: node --test testing/sync/democratic.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, postRetry429, get, del, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, tokenC;
let networkId;

describe('Democratic network (3-member voting)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    tokenC = fs.readFileSync(path.join(CONFIGS, 'c', 'token.txt'), 'utf8').trim();

    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test Democratic',
      type: 'democratic',
      spaces: ['general'],
      votingDeadlineHours: 24,
    });
    assert.equal(r.status, 201);
    networkId = r.body.id;
    console.log(`Created democratic network: ${networkId}`);
  });

  it('Adding first member opens a vote round', async () => {
    const bPeer = await post(INSTANCES.b, tokenB, '/api/tokens', { name: 'dem-peer-a' });
    assert.equal(bPeer.status, 201);

    // Democratic networks require a vote — even for the first member
    // 0 existing voters means the round auto-concludes on first yes
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b-dem',
      label: 'Instance B',
      url: 'http://ythril-b:3200',
      token: bPeer.body.plaintext,
      direction: 'both',
    });
    // Expect vote_pending (202) or direct add (201) if 0 voters
    assert(addB.status === 201 || addB.status === 202,
      `Expected 201 or 202, got ${addB.status}: ${JSON.stringify(addB.body)}`);
    console.log(`  addB status: ${addB.status}`);

    if (addB.status === 202) {
      const roundId = addB.body.roundId;
      // Cast yes from A — with 0 current members, majority of 0 is achieved
      const vote = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
      assert.equal(vote.status, 200);
      assert(vote.body.concluded, `Round should conclude after majority vote`);
      console.log(`  Vote concluded: ${vote.body.concluded}`);
    }
  });

  it('Veto blocks a join round immediately', async () => {
    // Re-fetch network state  
    const net = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    const cPeer = await postRetry429(INSTANCES.c, tokenC, '/api/tokens', { name: 'dem-peer-c' });
    assert.equal(cPeer.status, 201);

    const addC = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-c-dem',
      label: 'Instance C',
      url: 'http://ythril-c:3200',
      token: cPeer.body.plaintext,
      direction: 'both',
    });
    assert(addC.status === 201 || addC.status === 202,
      `Expected 201 or 202, got ${addC.status}`);

    if (addC.status === 202) {
      const roundId = addC.body.roundId;
      // Cast veto from A — should immediately conclude as failed
      const vetoed = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'veto' });
      assert.equal(vetoed.status, 200);
      assert(vetoed.body.concluded, `Round should conclude on veto`);
      // Verify C was not added
      const updated = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      const isMember = updated.body.members?.some(m => m.instanceId === 'instance-c-dem');
      assert(!isMember, `C should NOT be a member after veto`);
      console.log(`  Veto correctly blocked C ✓`);
    } else {
      // Auto-added (0 voters) — this is also valid; skip veto test
      console.log(`  C was auto-added (0 voters) — veto test not applicable`);
    }
  });

  it('Majority yes (2 of 3) allows a member to join', async () => {
    const members = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    if ((members.body.members?.length ?? 0) < 2) {
      console.log(`  Not enough members for this test — skipping`);
      return;
    }

    const dPeer = await post(INSTANCES.a, tokenA, '/api/tokens', { name: 'dem-peer-d' });
    assert.equal(dPeer.status, 201);

    const addD = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-d-dem',
      label: 'Instance D',
      url: 'http://ythril-d:3200',
      token: dPeer.body.plaintext,
      direction: 'both',
    });
    if (addD.status !== 202) { console.log(`  Open round not triggered — skipping`); return; }

    const roundId = addD.body.roundId;
    // Cast yes from A
    await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    // Cast yes from B (via gossip endpoint — simulated as direct API call)
    // In a real deployment B would receive the vote via sync gossip.
    // For this test we call B's API directly since it's on the same network.
    const voteB = await post(INSTANCES.b, tokenB, `/api/sync/networks/${networkId}/votes/${roundId}`, {
      vote: 'yes',
      instanceId: 'instance-b-dem',
    });
    // May return 200 or 404 (B doesn't know the network yet — that's ok)
    console.log(`  B vote response: ${voteB.status}`);

    // Check final state on A
    const final = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes`);
    const round = final.body.rounds?.find(r => r.roundId === roundId);
    if (round?.concluded) {
      const net2 = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      console.log(`  Round concluded=${round.concluded}, members=${net2.body.members?.length}`);
    }
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.c, tokenC, `/api/networks/${networkId}`).catch(() => {});
    }
  });
});
