/**
 * A round past its deadline is closed to everyone, whichever way they reach it: refused by the operator act (REST and MCP
 * both call it), refused by the peer relay, not listed to the operator, not served as open to a peer, not counted on the
 * space chip, not a reason to refuse a fresh proposal, and answered 403 to a joiner polling its own round.
 *
 * ## What was true before
 *
 * Every one of those places asked `!round.concluded`, and a round past its deadline stays unconcluded until something
 * touches it. So the operator list showed it, a cast on it was TAKEN (and concluded it as a failure on the spot), the relay
 * took a peer's cast on it, the space chip asked the operator to vote on it, a proposal to add the same space was refused as
 * "already open", and a joiner polling its round was told "vote pending" for as long as nothing touched it.
 *
 * ## What each door answers now
 *
 * | the round                        | the operator act / the relay               | listed to the operator | served to a peer |
 * |----------------------------------|--------------------------------------------|------------------------|------------------|
 * | open, before its deadline        | takes the cast                              | yes                    | yes              |
 * | open on paper, past its deadline | 409 `round_expired`, naming the deadline    | no                     | no               |
 * | concluded                        | 404 `Round not found or already concluded`  | no                     | passed `meta_change` / `space_addition` only |
 *
 * The 404 sentence is ONE sentence for both doors (the relay used to say "concluded" alone). The 409 carries the deadline in its
 * body so a client formats it in the viewer's own style.
 *
 * Run: node --test testing/standalone/a-cast-on-a-round-past-its-deadline-is-refused.test.js  (requires a prior server build)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance, callRoute } from './_vote-round-instance.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const dir = tempInstanceDir('ythril-closed-round-');
const CONFIG = process.env['CONFIG_PATH'];
after(() => removeInstanceDir(dir));

const HOUR = 3_600_000;
const T = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const PAST = iso(T - HOUR);
const FUTURE = iso(T + HOUR);
const SPACES = [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }, { id: 'extra', label: 'Extra', folders: [] }];
const member = (instanceId) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both' });
const round = (roundId, over = {}) => ({
  roundId, type: 'space_deletion', spaceId: 'notes', subjectInstanceId: P1, subjectLabel: 'Proposer', subjectUrl: '',
  openedAt: iso(T - 2 * HOUR), deadline: FUTURE, votes: [], concluded: false, ...over,
});
const network = (rounds, over = {}) => ({
  id: 'n', label: 'N', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general', 'notes'], members: [member(P1)],
  votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: rounds, ...over,
});
const boot = (rounds, over) => bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network(rounds, over)] });
const acts = () => import('../../server/dist/networks/vote-acts.js');
const relay = async (roundId, vote = 'yes') => {
  const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
  return callRoute(syncVotesRouter, 'post', '/networks/:networkId/votes/:roundId', {
    params: { networkId: 'n', roundId }, body: { instanceId: P1, vote, castAt: iso(T) }, authToken: { peerInstanceId: P1, rights: { instanceAdmin: false } },
  });
};
const roundOnDisk = (id) => JSON.parse(fs.readFileSync(CONFIG, 'utf8')).networks[0].pendingRounds.find(r => r.roundId === id);

describe('the operator act (what REST and MCP both call)', () => {
  it('takes a cast on an open round', async () => {
    const loader = await boot([round('open')]);
    const { castVoteAct } = await acts();
    const res = castVoteAct('n', 'open', { vote: 'yes' });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.equal(loader.getConfig().networks[0].pendingRounds[0].votes.length, 1);
  });

  it('refuses a cast on a round past its deadline with 409 round_expired, naming the deadline', async () => {
    const loader = await boot([round('late', { deadline: PAST })]);
    const { castVoteAct } = await acts();
    const res = castVoteAct('n', 'late', { vote: 'yes' });
    assert.equal(res.status, 409, `a cast on a round past its deadline was answered ${res.status}: ${JSON.stringify(res)}`);
    assert.equal(res.code, 'round_expired');
    assert.equal(res.deadline, PAST, 'the refusal does not carry the deadline for the client to format');
    assert.match(res.error, new RegExp(`^Voting on this round closed at ${PAST.replace(/[.]/g, '\\.')}`));
    assert.deepEqual(loader.getConfig().networks[0].pendingRounds[0].votes, [], 'the refused cast was recorded anyway');
    assert.notEqual(loader.getConfig().networks[0].pendingRounds[0].concluded, true, 'refusing a cast concluded the round on the way out');
  });

  it('answers a concluded round 404 with the one sentence', async () => {
    await boot([round('done', { concluded: true, passed: false })]);
    const { castVoteAct } = await acts();
    const res = castVoteAct('n', 'done', { vote: 'yes' });
    assert.deepEqual([res.status, res.error], [404, 'Round not found or already concluded']);
  });

  it('answers a round that does not exist the same 404', async () => {
    await boot([]);
    const { castVoteAct } = await acts();
    assert.deepEqual([castVoteAct('n', 'nope', { vote: 'yes' }).status, castVoteAct('n', 'nope', { vote: 'yes' }).error], [404, 'Round not found or already concluded']);
  });

  it('the refusal code is one of the codes a client translates by', async () => {
    const { NETWORK_REFUSAL_CODES } = await import('../../server/dist/networks/refusal-codes.js');
    assert.ok(NETWORK_REFUSAL_CODES.includes('round_expired'), 'round_expired is not in NETWORK_REFUSAL_CODES, so no client and no MCP text gate knows it');
  });
});

describe('the peer relay answers a closed round in the operator act\'s own words', () => {
  it('takes a relayed cast on an open round', async () => {
    await boot([round('open')]);
    assert.equal((await relay('open')).code, 200);
    assert.equal(roundOnDisk('open').votes.length, 1);
  });

  it('refuses a relayed cast past the deadline: the same 409, code, deadline and sentence as the act', async () => {
    await boot([round('late', { deadline: PAST })]);
    const { castVoteAct } = await acts();
    const viaAct = castVoteAct('n', 'late', { vote: 'yes' });
    const viaRelay = await relay('late');
    assert.equal(viaRelay.code, 409, `the relay answered ${viaRelay.code}: ${JSON.stringify(viaRelay.body)}`);
    assert.equal(viaRelay.body.error, viaAct.error, 'the two doors word the same refusal differently');
    assert.equal(viaRelay.body.code, 'round_expired');
    assert.equal(viaRelay.body.deadline, PAST);
    assert.deepEqual(roundOnDisk('late').votes, [], 'the relayed cast was recorded on a closed round');
  });

  it('answers a concluded round with the act\'s 404 sentence, not its own', async () => {
    await boot([round('done', { concluded: true, passed: false })]);
    const { castVoteAct } = await acts();
    const viaRelay = await relay('done');
    assert.equal(viaRelay.code, 404);
    assert.equal(viaRelay.body.error, castVoteAct('n', 'done', { vote: 'yes' }).error);
  });
});

describe('what each reader lists as open', () => {
  const rounds = () => [
    round('open'),
    round('late', { deadline: PAST }),
    round('undatable', { deadline: 'whenever' }),
    round('done', { concluded: true, passed: false }),
    round('passed-meta', { type: 'meta_change', concluded: true, passed: true, deadline: PAST, pendingMeta: { purpose: 'x' }, metaChangedFields: ['purpose'] }),
    round('passed-addition', { type: 'space_addition', spaceId: 'fresh', concluded: true, passed: true }),
    round('failed-meta', { type: 'meta_change', concluded: true, passed: false, pendingMeta: { purpose: 'x' }, metaChangedFields: ['purpose'] }),
  ];

  it('the operator list shows the open round and no other', async () => {
    await boot(rounds());
    const { listOpenVotesAct } = await acts();
    assert.deepEqual(listOpenVotesAct('n').body.rounds.map(r => r.roundId), ['open']);
  });

  it('the operator list carries no proposal body, no credential and no pending member — and does carry a summary of a proposal', async () => {
    await boot([
      round('meta', { type: 'meta_change', pendingMeta: { purpose: 'a purpose' }, metaChangedFields: ['purpose'], changedTypes: ['fact:Note'], keptTypes: [], inviteKeyHash: 'bcrypt-hash' }),
      round('join', { type: 'join', subjectInstanceId: JOINER, pendingMember: { ...member(JOINER) }, inviteKeyHash: 'bcrypt-hash' }),
    ]);
    const { listOpenVotesAct } = await acts();
    const listed = listOpenVotesAct('n').body.rounds;
    assert.equal(listed.length, 2);
    for (const r of listed) {
      for (const key of ['pendingMeta', 'pendingMember', 'inviteKeyHash']) assert.ok(!(key in r), `the operator list still carries ${key} on ${r.roundId}`);
    }
    assert.ok(!JSON.stringify(listed).includes('bcrypt-hash') && !JSON.stringify(listed).includes('"tokenHash"'), 'a credential reached the operator list');
    const meta = listed.find(r => r.roundId === 'meta');
    assert.equal(typeof meta.summary, 'string', 'a meta_change round is listed with no summary of what it proposes');
    assert.ok(meta.summary.length > 0);
  });

  it('a peer is served the open round, and the PASSED meta_change / space_addition rounds, and nothing else', async () => {
    await boot(rounds());
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    const res = await callRoute(syncVotesRouter, 'get', '/networks/:networkId/votes', { params: { networkId: 'n' }, authToken: { peerInstanceId: P1 } });
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.rounds.map(r => r.roundId).sort(), ['open', 'passed-addition', 'passed-meta']);
  });

  it('the space chip asks for a vote only on a round that can still be voted on', async () => {
    await boot([round('late', { deadline: PAST }), round('undatable', { deadline: 'whenever' })]);
    const { spaceNetworkInfo } = await import('../../server/dist/spaces/network-status.js');
    const { getConfig } = await import('../../server/dist/config/loader.js');
    const nets = getConfig().networks;
    assert.notEqual(spaceNetworkInfo(nets, 'notes', () => false, SELF).networkStatus, 'vote', 'the chip asks the operator to vote on a round that closed');
    nets[0].pendingRounds.push(round('open'));
    assert.equal(spaceNetworkInfo(nets, 'notes', () => false, SELF).networkStatus, 'vote', 'the chip stopped asking about an open round');
  });
});

describe('a proposal to add a space is blocked only by a round that can still be voted on', () => {
  const admin = { rights: { instanceAdmin: true } };
  it('an open round for the same space blocks it (409 already open)', async () => {
    await boot([round('adding', { type: 'space_addition', spaceId: 'extra' })]);
    const { addNetworkSpaceAct } = await import('../../server/dist/networks/network-acts.js');
    const res = addNetworkSpaceAct(admin, 'n', { spaceId: 'extra' });
    assert.equal(res.status, 409, JSON.stringify(res));
    assert.match(res.error, /already open/);
  });
  it('a round past its deadline does not: the proposal opens a fresh round', async () => {
    const loader = await boot([round('adding', { type: 'space_addition', spaceId: 'extra', deadline: PAST })]);
    const { addNetworkSpaceAct } = await import('../../server/dist/networks/network-acts.js');
    const res = addNetworkSpaceAct(admin, 'n', { spaceId: 'extra' });
    assert.equal(res.status, 202, `a round nobody can vote on blocked a new proposal: ${JSON.stringify(res)}`);
    assert.ok(loader.getConfig().networks[0].pendingRounds.some(r => r.type === 'space_addition' && r.roundId !== 'adding'));
  });
});

describe('a joiner polling its own round', () => {
  const KEY = 'invite-key-the-joiner-holds';
  const body = { inviteKey: KEY, instanceId: JOINER, label: 'Joiner', url: 'https://joiner.example', token: 'token-for-the-inviter' };
  const joinRound = async (over = {}) => {
    const bcrypt = (await import('bcrypt')).default;
    return round('join-round', { type: 'join', subjectInstanceId: JOINER, pendingMember: member(JOINER), inviteKeyHash: await bcrypt.hash(KEY, 4), ...over });
  };

  it('is told "vote pending" while the round is open', async () => {
    await boot([await joinRound()]);
    const { admitByInviteKeyAct } = await import('../../server/dist/networks/member-acts.js');
    const res = await admitByInviteKeyAct('n', body);
    assert.equal(res.status, 202, JSON.stringify(res));
  });

  it('is told it was denied the moment the round is past its deadline — not "pending" until something touches it', async () => {
    await boot([await joinRound({ deadline: PAST })]);
    const { admitByInviteKeyAct } = await import('../../server/dist/networks/member-acts.js');
    const res = await admitByInviteKeyAct('n', body);
    assert.equal(res.status, 403, `a joiner polling a round that closed was answered ${res.status}: ${JSON.stringify(res)}`);
    assert.match(res.error, /denied|expired/);
  });

  it('is still told it was denied after the round has been pruned — not "no active invite key"', async () => {
    const loader = await boot([await joinRound({ deadline: PAST, concluded: true, passed: false })]);
    const { pruneExpiredRounds } = await import('../../server/dist/sync/vote-round-retention.js');
    assert.equal(pruneExpiredRounds(loader.getConfig().networks[0], T), 1, 'setup: the concluded round was not pruned');
    const { admitByInviteKeyAct } = await import('../../server/dist/networks/member-acts.js');
    const res = await admitByInviteKeyAct('n', body);
    assert.equal(res.status, 403, `after the prune the joiner was answered ${res.status}: ${JSON.stringify(res)}`);
    assert.match(res.error, /denied|expired/);
  });

  it('and one who never had a round is not told it was denied', async () => {
    await boot([]);
    const { admitByInviteKeyAct } = await import('../../server/dist/networks/member-acts.js');
    const res = await admitByInviteKeyAct('n', body);
    assert.equal(res.status, 400, 'no round and no invite key must stay the "no active invite key" answer');
    assert.match(res.error, /No active invite key/);
  });
});

describe('the two sentences are each written once', () => {
  it('the "Round not found or already concluded" text appears in one source file (the relay used its own)', () => {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk('server/src');
    assert.ok(files.length >= 100, 'the source listing is broken');
    const holders = files.filter(f => /Round not found or (?:already )?concluded/.test(stripComments(fs.readFileSync(f, 'utf8'))));
    assert.deepEqual(holders, ['server/src/networks/round-state.ts'], 'the refusal for a closed round is written out in more than the one module that owns it');
  });
});
