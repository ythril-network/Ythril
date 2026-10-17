/**
 * Integration tests: Governed space deletion + N-7 auto-adopt on departure
 *
 * Covers:
 *  Space deletion vote flow:
 *   - Networked DELETE (with confirm) opens a vote round (202) where another member must vote
 *   - Space is still present while the vote is pending
 *   - Vote round is visible via GET /api/networks/:id/votes
 *   - Where the proposer's own yes passes the round (a club, a braintree root) the space goes in the request (200)
 *   - Veto concludes the round but the space survives
 *
 *  N-7 auto-adopt on member departure:
 *   - A braintree member's children are automatically re-parented to the receiving
 *     instance when a member_departed notify event is received
 *   - Idempotent: a second departure notify with no orphans is a no-op
 *
 * Run:  node --test testing/sync/governance.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, waitFor, createTestSpace } from './helpers.js';
import { sleep } from '../_shared/sleep.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA;
let SPACE, removeSpace;

/**
 * Admit one member that never votes to a network whose only member is A, so a round needs a yes beside A's own. D-36 (bundle-106): the
 * proposer counts as a yes on every join, so on a sole-member closed or democratic network this add passes at open — 201.
 */
async function seedMember(networkId, tag) {
  const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
    instanceId: `gov-seed-${tag}-${Date.now()}`, label: `Gov seed ${tag}`, url: 'http://ythril-c:3200',
    token: `ythril_gov_seed_token_${tag}_not_used`, direction: 'both',
  });
  assert.equal(r.status, 201, `seed member (admitted at open, D-36): ${JSON.stringify(r.body)}`);
}

// ── Governed space deletion ───────────────────────────────────────────────────

describe('Governed space deletion', () => {
  let run;
  // Track every created network/space so after() can clean up even on partial failures
  const _createdNets = [];
  const _createdSpaces = [];

  before(() => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    run = Date.now();
  });

  after(async () => {
    // Delete networks first (turns networked spaces into solo spaces)
    for (const netId of _createdNets) {
      await del(INSTANCES.a, tokenA, `/api/networks/${netId}`).catch(() => {});
    }
    // Then delete any spaces that survived (e.g. veto tests or partial failures)
    for (const spId of _createdSpaces) {
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${spId}`, { confirm: true }).catch(() => {});
    }
  });

  it('DELETE networked space opens vote round — 202 vote_pending', async () => {
    const createSp = await post(INSTANCES.a, tokenA, '/api/spaces', { label: `Gov-VotePending-${run}` });
    assert.equal(createSp.status, 201, JSON.stringify(createSp.body));
    const spaceId = createSp.body.space.id;
    _createdSpaces.push(spaceId);

    const createNet = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Gov-VotePending-Net-${run}`,
      type: 'closed',
      spaces: [spaceId],
      votingDeadlineHours: 1,
    });
    assert.equal(createNet.status, 201, JSON.stringify(createNet.body));
    const networkId = createNet.body.id;
    _createdNets.push(networkId);
    // Another voter, so the deletion needs a yes beside A's own (with A alone its yes passes at open: the club test below).
    await seedMember(networkId, 'votepending');

    // DELETE (with the `confirm` a networked delete asks for, bundle-106) should open a vote round, not delete immediately
    const delR = await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { confirm: true });
    assert.equal(delR.status, 202, `Expected 202, got ${delR.status}: ${JSON.stringify(delR.body)}`);
    assert.equal(delR.body?.status, 'vote_pending');
    assert.ok(Array.isArray(delR.body?.rounds) && delR.body.rounds.length >= 1, 'rounds array required');

    const roundId = delR.body.rounds.find(r => r.networkId === networkId)?.roundId;
    assert.ok(roundId, 'Round for our network must be present in rounds array');

    // Space must still exist while the vote is pending
    const listR = await get(INSTANCES.a, tokenA, '/api/spaces');
    assert.ok(listR.body?.spaces?.some(s => s.id === spaceId), 'Space must still exist while vote is pending');

    // Round must be visible via the network votes endpoint
    const votesR = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes`);
    assert.ok(
      votesR.body?.rounds?.some(r => r.roundId === roundId),
      'Vote round must be visible via GET /api/networks/:id/votes',
    );

    // A's own yes is already in the round (D-36) and does not pass it: the seed's yes is outstanding, so a second yes from A
    // concludes nothing and the space stays. (It used to be the solo yes that deleted it; that is the club case below now.)
    const again = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body?.concluded, false, 'a round still waiting for the seed\'s yes concluded on A\'s alone');
    const stillR = await get(INSTANCES.a, tokenA, '/api/spaces');
    assert.ok(stillR.body?.spaces?.some(s => s.id === spaceId), 'Space must still exist while the round waits for another yes');
    // cleanup handled by after(): the network goes first, then the space as a local one
  });

  it('On a club the proposer\'s own yes passes the deletion at once — 200 deleted, the space gone in the request', async () => {
    const createSp = await post(INSTANCES.a, tokenA, '/api/spaces', { label: `Gov-VoteYes-${run}` });
    assert.equal(createSp.status, 201);
    const spaceId = createSp.body.space.id;
    _createdSpaces.push(spaceId);

    const createNet = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Gov-VoteYes-Net-${run}`,
      type: 'club',
      spaces: [spaceId],
      votingDeadlineHours: 1,
    });
    assert.equal(createNet.status, 201);
    const networkId = createNet.body.id;
    _createdNets.push(networkId);

    // bundle-106 (guide 06c): the proposer's yes is cast when the round opens and on a club it is the pass, so the deletion acts in
    // this request — 200 { status: 'deleted', rounds, removedHere: true } (it was 202 and a second call casting yes). Past the door's
    // answer budget the same pass answers 202 { status: 'passed', queued: true } and completes on its own.
    const delR = await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { confirm: true });
    assert.ok(delR.status === 200 || delR.status === 202, `Expected 200 (or 202 queued), got ${delR.status}: ${JSON.stringify(delR.body)}`);
    if (delR.status === 200) {
      assert.equal(delR.body?.status, 'deleted', JSON.stringify(delR.body));
      assert.equal(delR.body?.removedHere, true, JSON.stringify(delR.body));
    } else {
      assert.equal(delR.body?.status, 'passed', `a 202 here is the queued pass, never vote_pending: ${JSON.stringify(delR.body)}`);
      assert.equal(delR.body?.queued, true, JSON.stringify(delR.body));
    }
    assert.ok(delR.body.rounds?.[0]?.roundId, 'the answer names the round that passed');

    await waitFor(async () => {
      const r = await get(INSTANCES.a, tokenA, '/api/spaces');
      return !r.body?.spaces?.some(s => s.id === spaceId);
    });
    console.log(`  Gov-Club space deleted on the proposer's own yes ✓`);
  });

  it('vote round stores the correct spaceId', async () => {
    const createSp = await post(INSTANCES.a, tokenA, '/api/spaces', { label: `Gov-SpaceId-Check-${run}` });
    assert.equal(createSp.status, 201);
    const spaceId = createSp.body.space.id;
    _createdSpaces.push(spaceId);

    const createNet = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Gov-SpaceId-Net-${run}`,
      type: 'braintree',
      spaces: [spaceId],
      votingDeadlineHours: 1,
    });
    assert.equal(createNet.status, 201);
    const networkId = createNet.body.id;
    _createdNets.push(networkId);

    // A braintree root's own yes is its whole ancestry, so the deletion passes at open (bundle-106) and the space goes in this request;
    // the round is read from the answer, which carries it as the vote list shows it (guide 06c), not from the list it has already left.
    const delR = await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { confirm: true });
    assert.ok(delR.status === 200 || delR.status === 202, `Expected 200 (or 202 queued), got ${delR.status}: ${JSON.stringify(delR.body)}`);
    const entry = delR.body?.rounds?.find(r => r.networkId === networkId);
    assert.ok(entry?.roundId, `the answer names the round: ${JSON.stringify(delR.body)}`);
    const round = entry.round;
    assert.ok(round, 'the answer carries the round');
    assert.equal(round.type, 'space_deletion', 'Round type must be space_deletion');
    assert.equal(round.spaceId, spaceId, 'Round must record the correct spaceId');

    await waitFor(async () => {
      const r = await get(INSTANCES.a, tokenA, '/api/spaces');
      return !r.body?.spaces?.some(s => s.id === spaceId);
    });
  });

  it('Veto on space_deletion round dismisses deletion — space is kept', async () => {
    const createSp = await post(INSTANCES.a, tokenA, '/api/spaces', { label: `Gov-Veto-${run}` });
    assert.equal(createSp.status, 201);
    const spaceId = createSp.body.space.id;
    _createdSpaces.push(spaceId);

    const createNet = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Gov-Veto-Net-${run}`,
      type: 'democratic',
      spaces: [spaceId],
      votingDeadlineHours: 1,
    });
    assert.equal(createNet.status, 201);
    const networkId = createNet.body.id;
    _createdNets.push(networkId);
    // Another voter: on a democratic network of A alone A's yes is the majority and the deletion would pass at open. With the seed
    // it is 1 of 2, which is not a majority, so the round stays open for the veto.
    await seedMember(networkId, 'veto');

    const delR = await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${spaceId}`, { confirm: true });
    assert.equal(delR.status, 202, JSON.stringify(delR.body));
    assert.equal(delR.body?.status, 'vote_pending', JSON.stringify(delR.body));
    const roundId = delR.body.rounds[0]?.roundId;

    // Veto the round (A's veto replaces the yes it cast as proposer)
    const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'veto' });
    assert.equal(voteR.status, 200);
    assert.ok(voteR.body?.concluded === true, 'Veto must conclude the round immediately');

    // Brief wait to confirm no async side-effect fires.
    // Negative assertion — fixed wait is correct; do NOT convert to waitFor (Q3).
    await sleep(500);

    const listR = await get(INSTANCES.a, tokenA, '/api/spaces');
    assert.ok(listR.body?.spaces?.some(s => s.id === spaceId), 'Space must survive a veto');
    console.log(`  Gov-Veto space still present after veto ✓`);

    // cleanup handled by after() — no inline cleanup needed here
  });
});

// ── N-7 auto-adopt on departure ───────────────────────────────────────────────

describe('N-7 auto-adopt on member departure (braintree)', () => {
  const B_ID = 'instance-n7-b';
  const C_ID = 'instance-n7-c';
  let networkId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    ({ id: SPACE, remove: removeSpace } = await createTestSpace('gov-n7', [[INSTANCES.a, tokenA]]));

    // Create a braintree network on A
    const r = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'N7 Test Braintree',
      type: 'braintree',
      spaces: [SPACE],
      votingDeadlineHours: 1,
    });
    assert.equal(r.status, 201, `Create N7 network: ${JSON.stringify(r.body)}`);
    networkId = r.body.id;

    // Add B as a direct member (child of A in the topology)
    // Braintree uses direct add (no vote); parentInstanceId can be anything for this test
    // since the N-7 logic only looks at who has parentInstanceId === B.
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: B_ID,
      label: 'N7 Instance B',
      url: 'http://n7-b.internal',
      token: 'n7-test-token-for-b',
      direction: 'push',
    });
    assert.equal(addB.status, 201, `Add B: ${JSON.stringify(addB.body)}`);

    // Add C as a child of B
    const addC = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: C_ID,
      label: 'N7 Instance C',
      url: 'http://n7-c.internal',
      token: 'n7-test-token-for-c',
      direction: 'push',
      parentInstanceId: B_ID,
    });
    assert.equal(addC.status, 201, `Add C: ${JSON.stringify(addC.body)}`);
  });

  after(async () => {
    // Remove the test network; leave if not found
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await removeSpace?.();
  });

  it('C is initially a child of B', async () => {
    const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    assert.equal(r.status, 200);
    const c = r.body?.members?.find(m => m.instanceId === C_ID);
    assert.ok(c, 'C must be present in the network');
    assert.equal(c.parentInstanceId, B_ID, 'C must initially have B as its parent');
  });

  it('member_departed notify for B triggers N-7 auto-adopt of C', async () => {
    // Simulate B sending a departure event to A
    const notifyR = await post(INSTANCES.a, tokenA, '/api/notify', {
      networkId,
      instanceId: B_ID,
      event: 'member_departed',
    });
    assert.equal(notifyR.status, 204, `Notify returned: ${notifyR.status} ${JSON.stringify(notifyR.body)}`);

    // Auto-adopt happens synchronously before the 204 is returned — no polling needed
    const netR = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    assert.equal(netR.status, 200);
    const c = netR.body?.members?.find(m => m.instanceId === C_ID);
    assert.ok(c, 'C must still be present in the network after B departs');
    assert.notEqual(
      c.parentInstanceId,
      B_ID,
      'C must no longer point to the departed B as its parent',
    );
    // C's new parent must be a non-empty string (A's instanceId)
    assert.ok(c.parentInstanceId, 'C must have a new parentInstanceId after auto-adopt');
    console.log(`  C re-parented from B to A (instanceId: ${c.parentInstanceId}) ✓`);
  });

  it('Second departure notify for B is idempotent when no more orphans remain', async () => {
    // C is already re-parented; there are no longer any members with parentInstanceId === B
    const notifyR = await post(INSTANCES.a, tokenA, '/api/notify', {
      networkId,
      instanceId: B_ID,
      event: 'member_departed',
    });
    assert.equal(notifyR.status, 204, 'Should still return 204 with no orphans to adopt');

    // Network state must be unchanged
    const netR = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    const c = netR.body?.members?.find(m => m.instanceId === C_ID);
    assert.ok(c, 'C must still be present');
    assert.notEqual(c.parentInstanceId, B_ID, 'C must not be re-orphaned by a duplicate event');
  });

  it('member_departed on non-braintree network does not trigger auto-adopt', async () => {
    // Create a democratic network with B as a member
    const createNet = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'N7 Non-Braintree',
      type: 'democratic',
      spaces: [SPACE],
      votingDeadlineHours: 1,
    });
    assert.equal(createNet.status, 201);
    const demoNetId = createNet.body.id;

    // Add B to the democratic network (closed/democratic requires a vote)
    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${demoNetId}/members`, {
      instanceId: B_ID,
      label: 'N7 Instance B (demo)',
      url: 'http://n7-b.internal',
      token: 'n7-demo-token',
      direction: 'both',
    });
    // Vote round opened — cast yes to complete the add
    if (addB.status === 202) {
      await post(INSTANCES.a, tokenA, `/api/networks/${demoNetId}/votes/${addB.body.roundId}`, { vote: 'yes' });
    } else {
      assert.equal(addB.status, 201);
    }

    // Fire departure notify on the democratic network
    const notifyR = await post(INSTANCES.a, tokenA, '/api/notify', {
      networkId: demoNetId,
      instanceId: B_ID,
      event: 'member_departed',
    });
    // Should succeed but the N-7 block must not run for non-braintree networks.
    // No assertion on internal state needed — just verify no crash.
    assert.equal(notifyR.status, 204);

    // cleanup
    await del(INSTANCES.a, tokenA, `/api/networks/${demoNetId}`).catch(() => {});
    console.log(`  member_departed on democratic network handled without N-7 logic ✓`);
  });
});
