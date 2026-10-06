/**
 * Integration tests: Democratic network voting (A, B, C — majority required)
 *
 * ## What each case builds, and why none of them can end early
 *
 * A democratic network ALWAYS opens a round to add a member (`addMemberAct`: 202 for `closed` and `democratic`, never
 * the direct 201), so each case asserts the 202 rather than branching on it. These cases used to branch — "if it
 * auto-added, this is also valid; skip" — and to skip when the network held fewer than two members; both branches
 * were unreachable guesses about a setup the test never made, and each ended the case green having voted on nothing.
 *
 * The majority case needs a SECOND VOTING MEMBER that can really vote, which a network held by A alone (its members
 * are made-up ids on made-up URLs) cannot supply. It builds `mirroredNetwork` — A and B each hold the network and list
 * the other — so B's yes is a real, signed cast that reaches A through the sync cycle, exactly as in production.
 *
 * Run: node --test testing/sync/democratic.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, postRetry429, get, del, createTestSpace, mirroredNetwork, syncUntil } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, tokenC;
let networkId;
let SPACE, removeSpace;

describe('Democratic network (3-member voting)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    tokenC = fs.readFileSync(path.join(CONFIGS, 'c', 'token.txt'), 'utf8').trim();
    ({ id: SPACE, remove: removeSpace } = await createTestSpace('dem', [
      [INSTANCES.a, tokenA], [INSTANCES.b, tokenB], [INSTANCES.c, tokenC],
    ]));

    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Test Democratic',
      type: 'democratic',
      spaces: [SPACE],
      votingDeadlineHours: 24,
    });
    assert.equal(r.status, 201);
    networkId = r.body.id;
    console.log(`Created democratic network: ${networkId}`);
  });

  it('Adding first member opens a vote round', async () => {
    const bPeer = await post(INSTANCES.b, tokenB, '/api/tokens', { name: 'dem-peer-a' });
    assert.equal(bPeer.status, 201);

    // Democratic networks require a vote — even for the first member. With no other member the electorate is A alone,
    // so A's own yes is a majority and the round concludes on it.
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-b-dem',
      label: 'Instance B',
      url: 'http://ythril-b:3200',
      token: bPeer.body.plaintext,
      direction: 'both',
    });
    assert.equal(addB.status, 202, `A democratic network puts every join to a vote: ${JSON.stringify(addB.body)}`);

    const roundId = addB.body.roundId;
    const vote = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.equal(vote.status, 200);
    assert(vote.body.concluded, `Round should conclude after majority vote`);
    console.log(`  Vote concluded: ${vote.body.concluded}`);
  });

  it('Veto blocks a join round immediately', async () => {
    const cPeer = await postRetry429(INSTANCES.c, tokenC, '/api/tokens', { name: 'dem-peer-c' });
    assert.equal(cPeer.status, 201);

    const addC = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: 'instance-c-dem',
      label: 'Instance C',
      url: 'http://ythril-c:3200',
      token: cPeer.body.plaintext,
      direction: 'both',
    });
    assert.equal(addC.status, 202, `A democratic network puts every join to a vote: ${JSON.stringify(addC.body)}`);

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
  });

  it('Majority yes: one yes of two voting members does not pass a join, the second yes does', async () => {
    // A and B both hold this network and list each other, so there are two members who vote: A's yes alone is one of two
    // (not more than half), and the round has to wait for B's real, signed yes to arrive through a sync cycle.
    const mirrored = await mirroredNetwork({
      label: `dem-majority-${Date.now()}`, type: 'democratic', spaces: [SPACE],
      a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB],
    });
    try {
      const id = mirrored.networkId;
      const dPeer = await post(INSTANCES.a, tokenA, '/api/tokens', { name: `dem-peer-d-${Date.now()}` });
      assert.equal(dPeer.status, 201);

      const addD = await post(INSTANCES.a, tokenA, `/api/networks/${id}/members`, {
        instanceId: 'instance-d-dem',
        label: 'Instance D',
        url: 'http://ythril-d:3200',
        token: dPeer.body.plaintext,
        direction: 'both',
      });
      assert.equal(addD.status, 202, `A democratic network puts every join to a vote: ${JSON.stringify(addD.body)}`);
      const roundId = addD.body.roundId;

      const yesA = await post(INSTANCES.a, tokenA, `/api/networks/${id}/votes/${roundId}`, { vote: 'yes' });
      assert.equal(yesA.status, 200, JSON.stringify(yesA.body));
      assert.equal(yesA.body.concluded, false, 'one yes of two voting members is not a majority — A decided for B');
      const stillOut = await get(INSTANCES.a, tokenA, `/api/networks/${id}`);
      assert.ok(!stillOut.body.members?.some(m => m.instanceId === 'instance-d-dem'), 'D joined on one yes of two');

      // B has to hold the round before it can vote on it: it arrives with A's yes on B's next cycle.
      const openOnB = async () => ((await get(INSTANCES.b, tokenB, `/api/sync/networks/${id}/votes`)).body?.rounds ?? [])
        .some(r => r.roundId === roundId);
      await syncUntil(INSTANCES.b, tokenB, id, openOnB, 'B to receive the open join round', { label: 'B' });

      const yesB = await post(INSTANCES.b, tokenB, `/api/networks/${id}/votes/${roundId}`, { vote: 'yes' });
      assert.equal(yesB.status, 200, `B's yes: ${JSON.stringify(yesB.body)}`);

      // B's cycle pushes its cast to A, which concludes the round and admits D (A holds the candidate's credential).
      const dIsMemberOnA = async () => (await get(INSTANCES.a, tokenA, `/api/networks/${id}`)).body?.members
        ?.some(m => m.instanceId === 'instance-d-dem') === true;
      await syncUntil(INSTANCES.b, tokenB, id, dIsMemberOnA, "B's yes to reach A and carry the round", { label: 'B' });
    } finally {
      await mirrored.remove();
    }
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.c, tokenC, `/api/networks/${networkId}`).catch(() => {});
    }
    await removeSpace?.();
  });
});
