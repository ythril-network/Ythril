/**
 * Integration tests: Voting API — member join and remove vote rounds
 *
 * Covers:
 *  - GET /api/networks/:id/votes: list rounds, empty when none pending
 *  - a join or removal the proposer's own yes decides (D-36) → 201 / 204 at open, no round left behind
 *  - POST /api/networks/:id/votes/:roundId: cast veto → member blocked
 *  - Invalid vote value → 400
 *  - Vote on non-existent round → 404
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

// ── helpers ───────────────────────────────────────────────────────────────────

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

/** Ask instance A to add a member to a network; the raw answer and the member's id. */
async function addMember(networkId) {
  const iid = `vote-member-${run}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/members`, {
    instanceId: iid,
    label: `Vote Test Member ${iid}`,
    url: 'http://vote-test.internal:3200',
    token: `ythril_vote_test_token_${iid}`,
    direction: 'both',
  });
  return { r, instanceId: iid };
}

/**
 * Admit a member to a closed network whose only member is A. D-36 (bundle-106): the proposer counts as a yes on every join, and with no
 * other member that yes is the whole quorum, so the add passes AT OPEN: 201 with the member, no round (it was 202 and a second call).
 */
async function admitAtOnce(networkId) {
  const { r, instanceId } = await addMember(networkId);
  assert.equal(r.status, 201, `Admit at open (D-36): ${JSON.stringify(r.body)}`);
  return instanceId;
}

/**
 * Open a join vote that stays open: the network must already hold another member (see {@link admitAtOnce}), whose yes a closed
 * network needs beside A's own. Returns the round id.
 */
async function openJoinRound(networkId) {
  const { r, instanceId } = await addMember(networkId);
  assert.equal(r.status, 202, `Open join round: ${JSON.stringify(r.body)}`);
  return { roundId: r.body.roundId, instanceId };
}

async function isMember(networkId, instanceId) {
  const r = await get(INSTANCES.a, token, `/api/networks/${networkId}`);
  assert.equal(r.status, 200);
  return (r.body.members ?? []).some(m => m.instanceId === instanceId);
}

// ── GET /api/networks/:id/votes ───────────────────────────────────────────────

describe('Votes API — list rounds', () => {
  let networkId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
    // A second member, so the join below needs a yes beside A's own and stays open (D-36).
    await admitAtOnce(networkId);
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

// ── Join vote — yes ────────────────────────────────────────────────────────────

// The proposer's yes is a cast from the start (D-36, bundle-106), so the old "open, then cast yes, then concluded" sequence of a sole
// member no longer exists: where that yes is the quorum the join passes AT OPEN. A round that stays open needs another voter, and A
// cannot supply that voter's yes — so the yes path is the at-open one, and the cast paths below are the veto and the error paths.
describe('Votes API — join round: the proposer\'s yes admits the member at once on a sole-member closed network (D-36)', () => {
  let networkId;
  let memberId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('The add answers 201 with the member: the proposer\'s yes concluded the round at open', async () => {
    memberId = await admitAtOnce(networkId);
  });

  it('Member IS in the network once the add answered', async () => {
    assert.equal(await isMember(networkId, memberId), true, 'Member must be added when the proposer\'s yes passes the join');
  });

  it('No open join round is left behind', async () => {
    const r = await get(INSTANCES.a, token, `/api/networks/${networkId}/votes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rounds.filter(rnd => rnd.type === 'join' && !rnd.concluded), [], 'a join the proposer alone decides left an open round');
  });

  it('Adding the same member again is refused 409', async () => {
    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/members`, {
      instanceId: memberId, label: 'again', url: 'http://vote-test.internal:3200', token: `ythril_vote_test_token_${memberId}`, direction: 'both',
    });
    assert.equal(r.status, 409, `Expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ── Join vote — veto ───────────────────────────────────────────────────────────

describe('Votes API — join round: veto blocks member', () => {
  let networkId;
  let memberId;
  let roundId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
    await admitAtOnce(networkId);   // another voter, so the join stays open past A's own yes (D-36)
    const res = await openJoinRound(networkId);
    roundId = res.roundId;
    memberId = res.instanceId;
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('Casting veto concludes the round immediately', async () => {
    // A's veto replaces the yes it cast as proposer; on a closed network one veto fails the round.
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

// ── Remove vote — yes ──────────────────────────────────────────────────────────

// The subject of a removal does not vote on it, so on a closed network of A and one member A's own yes — cast as proposer, D-36 — is the
// whole quorum: the removal passes AT OPEN and answers 204 (guide 08, Remove Member). It was 202 and a second call casting yes.
describe('Votes API — remove round: the proposer\'s yes removes the member at once when it is the quorum (D-36)', () => {
  let networkId;
  let memberId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
    memberId = await admitAtOnce(networkId);
    assert.equal(await isMember(networkId, memberId), true, 'Member must be present before remove test');
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
  });

  it('DELETE member answers 204: the removal passed at open', async () => {
    const resp = await del(INSTANCES.a, token, `/api/networks/${networkId}/members/${memberId}`);
    assert.equal(resp.status, 204, `Expected 204 (D-36: removed at open), got ${resp.status}: ${JSON.stringify(resp.body)}`);
  });

  it('The member is gone and no open remove round is left behind', async () => {
    assert.equal(await isMember(networkId, memberId), false, 'Member must be removed when the proposer\'s yes passes the removal');
    const r = await get(INSTANCES.a, token, `/api/networks/${networkId}/votes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rounds.filter(rnd => rnd.type === 'remove' && !rnd.concluded), [], 'a removal the proposer alone decides left an open round');
  });
});

// ── Remove vote — veto ─────────────────────────────────────────────────────────

// "Veto on a remove round keeps the member" is not reachable from one instance any more: a removal stays open only while a member
// other than A and the subject must vote, and A cannot admit that member on its own yes (a closed join needs every member's yes, D-36).
// The veto of an open round on this door is held by "join round: veto blocks member" above; a vetoed REMOVAL needs a third member that
// votes, which is a multi-instance (sync stack) scenario, not this single-instance file.

// ── Error paths ────────────────────────────────────────────────────────────────

describe('Votes API — error paths', () => {
  let networkId;
  let roundId;

  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    run = Date.now();
    networkId = await createClosedNetwork();
    await admitAtOnce(networkId);   // another voter, so the round below stays open (D-36)
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
