/**
 * Integration tests: Voting API â€” member join and remove vote rounds
 *
 * Covers:
 *  - GET /api/networks/:id/votes: list rounds, empty when none pending
 *  - POST /api/networks/:id/votes/:roundId: cast yes â†’ member added / member removed
 *  - POST /api/networks/:id/votes/:roundId: cast veto â†’ member blocked / member kept
 *  - Invalid vote value â†’ 400
 *  - Vote on non-existent round â†’ 404
 *  - Re-voting on an already-concluded round â†’ 409 or 404
 *
 * Targets instance A (port 3200) only. No sync stack required.
 *
 * Run: node --test testing/integration/votes.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;
let run;

// â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function createClosedNetwork() {
  const r = await post(INSTANCES.a, token, '/api/networks', {
    label: `Vote Test (Closed) ${run}`,
    type: 'closed',
    spaces: ['general'],
    votingDeadlineHours: 1,
  });
  assert.equal(r.status, 201, `Create network: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Open a join vote by adding a member to a closed network. Returns roundId. */
async function openJoinRound(networkId, instanceId = undefined) {
  const iid = instanceId ?? `vote-member-${run}-${Date.now()}`;
  const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/members`, {
    instanceId: iid,
    label: `Vote Test Member ${iid}`,
    url: 'http://vote-test.internal:3200',
    token: `ythril_vote_test_token_${iid}`,
    direction: 'both',
  });
  assert.equal(r.status, 202, `Open join round: ${JSON.stringify(r.body)}`);
  return { roundId: r.body.roundId, instanceId: iid };
}

async function isMember(networkId, instanceId) {
  const r = await get(INSTANCES.a, token, `/api/networks/${networkId}`);
  assert.equal(r.status, 200);
  return (r.body.members ?? []).some(m => m.instanceId === instanceId);
}

// â”€â”€ GET /api/networks/:id/votes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Votes API â€” list rounds', () => {
  let networkId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('GET /api/networks/:id/votes returns rounds array (empty initially)', async () => {
    const r = await get(INSTANCES.a, token, `/api/networks/${networkId}/votes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.rounds), 'rounds must be an array');
  });

  it('GET /api/networks/:id/votes returns added round after member-add', async () => {
    const { roundId } = await openJoinRound(networkId);
    const r = await get(INSTANCES.a, token, `/api/networks/${networkId}/votes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const round = r.body.rounds.find(rnd => rnd.roundId === roundId);
    assert.ok(round, 'The new join round must appear in the vote list');
    assert.equal(round.type, 'join', 'Round type must be join');
    assert.ok(round.deadline, 'Round must have a deadline');
    assert.ok(round.openedAt, 'Round must have an openedAt timestamp');
  });

  it('GET /api/networks/:id/votes on unknown network returns 404', async () => {
    const r = await get(INSTANCES.a, token, '/api/networks/00000000-0000-0000-0000-000000000000/votes');
    assert.equal(r.status, 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// â”€â”€ Join vote â€” yes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Votes API â€” join round: yes vote adds member', () => {
  let networkId;
  let memberId;
  let roundId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
    const res = await openJoinRound(networkId);
    roundId = res.roundId;
    memberId = res.instanceId;
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('Member is NOT in the network while vote is pending', async () => {
    assert.equal(await isMember(networkId, memberId), false, 'Member must not be present while vote is pending');
  });

  it('Casting yes concludes the round and returns concluded: true', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.concluded, true, 'Round must be marked concluded after a unanimous-solo yes');
  });

  it('Member IS in the network after yes vote passes', async () => {
    assert.equal(await isMember(networkId, memberId), true, 'Member must be added after yes vote');
  });

  it('Voting again on a concluded round returns 409 or 404', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.ok(r.status === 409 || r.status === 404, `Expected 409 or 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// â”€â”€ Join vote â€” veto â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Votes API â€” join round: veto blocks member', () => {
  let networkId;
  let memberId;
  let roundId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
    const res = await openJoinRound(networkId);
    roundId = res.roundId;
    memberId = res.instanceId;
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('Casting veto concludes the round immediately', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'veto' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.concluded, true, 'Veto must conclude the round immediately');
  });

  it('Member is NOT added to the network after a veto', async () => {
    assert.equal(await isMember(networkId, memberId), false, 'Vetoed member must not be added');
  });

  it('Round is no longer listed in pending votes after veto', async () => {
    const r = await get(INSTANCES.a, token, `/api/networks/${networkId}/votes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const stillPending = r.body.rounds.some(rnd => rnd.roundId === roundId);
    assert.equal(stillPending, false, 'Concluded round must not appear in the pending votes list');
  });
});

// â”€â”€ Remove vote â€” yes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Votes API â€” remove round: yes vote removes member', () => {
  let networkId;
  let memberId;
  let removeRoundId;  // set in first test, used by subsequent tests

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();

    // Add a member and approve the join vote so the member is actually present
    const { roundId, instanceId } = await openJoinRound(networkId);
    memberId = instanceId;
    await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });

    assert.equal(await isMember(networkId, memberId), true, 'Member must be present before remove test');
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('DELETE member on closed network opens a remove vote round (202)', async () => {
    const resp = await del(INSTANCES.a, token, `/api/networks/${networkId}/members/${memberId}`);
    assert.equal(resp.status, 202, `Expected 202 vote_pending, got ${resp.status}: ${JSON.stringify(resp.body)}`);
    assert.ok(resp.body.roundId, 'roundId must be returned for remove round');
    removeRoundId = resp.body.roundId;
  });

  it('Member is still present while remove vote is pending', async () => {
    assert.equal(await isMember(networkId, memberId), true, 'Member must still be present while remove vote is pending');
  });

  it('Yes vote on remove round concludes and removes the member', async () => {
    assert.ok(removeRoundId, 'removeRoundId must have been captured by the preceding test');
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${removeRoundId}`, { vote: 'yes' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.concluded, true, 'Round must be concluded after yes');
    assert.equal(await isMember(networkId, memberId), false, 'Member must be removed after yes vote');
  });
});

// â”€â”€ Remove vote â€” veto â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Votes API â€” remove round: veto keeps member', () => {
  let networkId;
  let memberId;
  let removeRoundId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();

    const { roundId, instanceId } = await openJoinRound(networkId);
    memberId = instanceId;
    await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });

    // Open a remove round
    const delR = await del(INSTANCES.a, token, `/api/networks/${networkId}/members/${memberId}`);
    assert.equal(delR.status, 202, `Expected 202 remove round, got ${delR.status}: ${JSON.stringify(delR.body)}`);
    removeRoundId = delR.body.roundId;
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('Veto on remove round concludes and keeps the member', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${removeRoundId}`, { vote: 'veto' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.concluded, true, 'Veto must conclude the round');

    assert.equal(await isMember(networkId, memberId), true, 'Member must be retained after remove veto');
  });
});

// â”€â”€ Error paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Votes API â€” error paths', () => {
  let networkId;
  let roundId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
    const res = await openJoinRound(networkId);
    roundId = res.roundId;
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('Invalid vote value returns 400', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'abstain' });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('Vote on non-existent round returns 404', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/00000000-nonexistent-round`, { vote: 'yes' });
    assert.equal(r.status, 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('GET /api/networks/:id/votes unauthenticated returns 401', async () => {
    const r = await get(INSTANCES.a, '', `/api/networks/${networkId}/votes`);
    assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
  });

  it('POST vote unauthenticated returns 401', async () => {
    const r = await post(INSTANCES.a, '', `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
  });

  it('Missing vote field returns 400', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/votes/${roundId}`, {});
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
