/**
 * A round a peer serves is adopted only while it can still be voted on here — and never twice.
 *
 * ## What was true before
 *
 * Gossip adopted every round a peer served, as open, and the next pass concluded it. So a round that had ended elsewhere —
 * the peer list also serves PASSED `space_addition` and `meta_change` rounds, for the late joiner — came back to life here for
 * one pass and was concluded as a failure: a stale round resurrected, and one whose id this instance had already recorded
 * ended a second time. A peer could also serve a round whose deadline was years away, or whose deadline nobody could read, and
 * it stayed open here for as long as the peer chose.
 *
 * ## What adoption refuses now
 *
 * A round that is past its deadline, whose deadline cannot be read, whose deadline is later than `openedAt + 72 h` (the longest
 * `votingDeadlineHours` allows), or whose `roundId` this instance already has an outcome for. An honest round — open, a deadline
 * inside the cap — is adopted exactly as before, which is what the control rows hold.
 *
 * ## How it is driven
 *
 * The receiving side is `runSyncForPeer` (the engine's own gossip), against a peer that answers over HTTP. What the peer answers
 * is NOT hand-written: it is what the REAL `GET /api/sync/networks/:id/votes` route serves for a second network in the same
 * config, so the test cannot drift from what a peer really sends.
 *
 * Run: node --test testing/standalone/a-gossip-adopts-only-a-round-that-is-still-live.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, removeInstanceDir, bootInstance, settled, callRoute, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { startVotesPeer, SELF, P1, P2 } from './_vote-round-sites.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';

const dir = tempInstanceDir('ythril-round-adoption-');
const HOUR = 3_600_000;
const T = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const member = (instanceId, extra = {}) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });
const wireRound = (roundId, over = {}) => ({
  roundId, type: 'space_deletion', spaceId: 'notes', subjectInstanceId: P2, subjectLabel: 'Proposer', subjectUrl: '',
  openedAt: iso(T - HOUR), deadline: iso(T + 23 * HOUR), votes: [], concluded: false, ...over,
});

/** What the peer holds: each is served by the real route (open rounds, and PASSED meta_change / space_addition ones). */
const SERVED = [
  wireRound('honest-open'),
  wireRound('open-at-the-cap', { openedAt: iso(T - HOUR), deadline: iso(T - HOUR + 72 * HOUR) }),
  wireRound('open-past-the-cap', { openedAt: iso(T - HOUR), deadline: iso(T - HOUR + 72 * HOUR + 60_000) }),
  wireRound('open-years-away', { deadline: '2099-01-01T00:00:00.000Z' }),
  wireRound('open-already-recorded'),
  wireRound('passed-and-past', { type: 'meta_change', concluded: true, passed: true, openedAt: iso(T - 30 * HOUR), deadline: iso(T - 6 * HOUR), pendingMeta: { purpose: 'x' }, metaChangedFields: ['purpose'] }),
  wireRound('passed-undatable', { type: 'space_addition', spaceId: 'fresh', concluded: true, passed: true, deadline: 'whenever' }),
  wireRound('passed-blank-deadline', { type: 'space_addition', spaceId: 'fresh', concluded: true, passed: true, deadline: '' }),
];
const ADOPTED = ['honest-open', 'open-at-the-cap'];
const REFUSED = {
  'open-past-the-cap': 'its deadline is later than openedAt + 72 hours, the longest a network allows',
  'open-years-away': 'its deadline is years away',
  'open-already-recorded': 'this instance already recorded how it ended',
  'passed-and-past': 'it is past its deadline (it ended elsewhere)',
  'passed-undatable': 'its deadline cannot be read',
  'passed-blank-deadline': 'its deadline is empty',
};

describe('what gossip adopts from a peer', { skip: privateAddressSkipReason() }, () => {
  let peer, loader, adoptedIds;
  before(async () => {
    allowEngineToDialPrivatePeers();
    peer = await startVotesPeer();
    loader = await bootInstance(dir, {
      instanceId: SELF, peerTokens: { [P1]: 'token-p1' },
      networks: [
        // The receiver. It carries no space, so the cycle never reaches the data plane; the peer is below the version floor, so it
        // ends after governance has been exchanged.
        {
          id: 'receiver', label: 'Receiver', type: 'closed', origin: 'created', syncSchedule: '', spaces: [], votingDeadlineHours: 24,
          createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
          members: [member(P1, { url: 'will-be-set', version: '1.0.0', versionCheckedAt: iso(T - HOUR) })],
          roundOutcomes: [{ roundId: 'open-already-recorded', type: 'space_deletion', space: 'notes', subjectLabel: 'x', openedAt: iso(T - 50 * HOUR), deadline: iso(T - 26 * HOUR), concludedAt: iso(T - 26 * HOUR), outcome: 'expired', yes: 0, veto: 0, eligible: 2 }],
        },
        // The peer's own copy of the network, served through the real route.
        {
          id: 'served', label: 'Served', type: 'closed', origin: 'created', syncSchedule: '', spaces: [], votingDeadlineHours: 24,
          createdAt: '2026-01-01T00:00:00.000Z', members: [member(P2)], pendingRounds: SERVED.map(r => ({ ...r })),
        },
      ],
    });
    loader.getConfig().networks[0].members[0].url = peer.url;

    // What the REAL route serves. The two served-but-ended rounds are in it because the route serves passed meta_change /
    // space_addition rounds to a late joiner.
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    const served = await callRoute(syncVotesRouter, 'get', '/networks/:networkId/votes', { params: { networkId: 'served' }, authToken: { peerInstanceId: P1 } });
    assert.equal(served.code, 200);
    const sent = served.body.rounds.map(r => r.roundId);
    for (const id of [...ADOPTED, ...Object.keys(REFUSED)].filter(id => !['passed-and-past', 'passed-undatable', 'passed-blank-deadline'].includes(id))) {
      assert.ok(sent.includes(id), `the real route does not serve ${id}, so this case would test nothing: ${sent.join(', ')}`);
    }
    for (const id of ['passed-and-past']) assert.ok(sent.includes(id), `the real route stopped serving a passed meta_change round to a late joiner (${id})`);
    peer.serve(served.body.rounds);

    const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
    await runSyncForPeer(P1);
    adoptedIds = await settled(() => (loader.getConfig().networks.find(n => n.id === 'receiver')?.pendingRounds ?? []).map(r => r.roundId).sort());
  });
  after(async () => { await peer?.close(); removeInstanceDir(dir); });

  for (const id of ADOPTED) {
    it(`adopts ${id}, as an open round`, () => {
      assert.ok(adoptedIds.includes(id), `an honest round was refused: ${id}`);
      const r = loader.getConfig().networks.find(n => n.id === 'receiver').pendingRounds.find(x => x.roundId === id);
      assert.equal(r.concluded, false);
    });
  }
  for (const [id, why] of Object.entries(REFUSED)) {
    it(`refuses ${id}: ${why}`, () => {
      assert.ok(!adoptedIds.includes(id), `${id} was adopted although ${why}`);
    });
  }
  it('adopts exactly the honest rounds and nothing else', () => {
    assert.deepEqual(adoptedIds, [...ADOPTED].sort());
  });
  it('a refused round that had an outcome keeps exactly the one it had', () => {
    const net = loader.getConfig().networks.find(n => n.id === 'receiver');
    assert.deepEqual(net.roundOutcomes.filter(e => e.roundId === 'open-already-recorded').map(e => e.outcome), ['expired']);
  });
  it('a refused round leaves no trace in the outcome log (it never lived here)', () => {
    const net = loader.getConfig().networks.find(n => n.id === 'receiver');
    for (const id of ['passed-and-past', 'passed-undatable', 'open-past-the-cap']) {
      assert.ok(!(net.roundOutcomes ?? []).some(e => e.roundId === id), `${id} was recorded as having ended here`);
    }
  });
});
