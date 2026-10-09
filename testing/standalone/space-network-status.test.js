/**
 * Standalone unit tests for the Brain space-chip network indicator (F8).
 *
 * Exercises the REAL compiled logic — `spaceNetworkInfo` from
 * server/src/spaces/network-status.ts (imported from dist, built in CI before the
 * standalone suite runs) — so it cannot drift from the route that uses it.
 *
 * The rules under test:
 *   - a space in no network → undefined (chip shows no indicator)
 *   - status priority: degraded > syncing > vote > idle
 *   - degraded only when a peer has failed >= DEGRADE_THRESHOLD consecutive cycles
 *     (a single retried blip must NOT read as degraded)
 *   - vote is ACTIONABLE: only an open round awaiting THIS instance's own cast
 *     (eligible + not yet voted). A round we've voted on, or one restricted to
 *     other required voters, must NOT light the chip — so a busy network does not
 *     sit permanently blue.
 *   - network-wide rounds (no spaceId) affect every member space; space-scoped
 *     rounds (space_deletion/meta_change) only their own space
 *
 * Run: node --test testing/standalone/space-network-status.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spaceNetworkInfo, DEGRADE_THRESHOLD } from '../../server/dist/spaces/network-status.js';

const ME = 'me-instance';

/** Build a minimal NetworkConfig-shaped object for the fields the function reads. */
function net(overrides = {}) {
  return {
    id: 'n1', label: 'Braintree', type: 'braintree',
    spaces: ['work'], members: [], pendingRounds: [],
    ...overrides,
  };
}
const member = (consecutiveFailures = 0) => ({ instanceId: 'peer', label: 'Peer', consecutiveFailures });
/** An open round awaiting everyone (no votes cast, open to all members) by default. */
// A deadline in the far future: a round with none (or an unreadable one) is past its deadline, and a past round asks nobody to vote.
const round = (extra = {}) => ({ roundId: 'r1', concluded: false, votes: [], deadline: '2099-01-01T00:00:00.000Z', ...extra });
const neverSyncing = () => false;
const alwaysSyncing = () => true;
const info = (networks, spaceId = 'work', isSyncing = neverSyncing, me = ME) =>
  spaceNetworkInfo(networks, spaceId, isSyncing, me);

describe('spaceNetworkInfo (F8 space-chip status)', () => {
  it('returns undefined for a space in no network', () => {
    assert.equal(info([net({ spaces: ['other'] })]), undefined);
    assert.equal(info([]), undefined);
  });

  it('idle: member of a network with nothing happening', () => {
    const i = info([net()]);
    assert.deepEqual(i.networks, [{ id: 'n1', label: 'Braintree', type: 'braintree' }]);
    assert.equal(i.networkStatus, 'idle');
  });

  it('syncing: a cycle is in flight for the space network', () => {
    assert.equal(info([net()], 'work', alwaysSyncing).networkStatus, 'syncing');
  });

  it('degraded only at/above the consecutive-failure threshold (not a single blip)', () => {
    const below = net({ members: [member(DEGRADE_THRESHOLD - 1)] });
    assert.equal(info([below]).networkStatus, 'idle',
      'a couple of retried failures must not read as degraded');
    const at = net({ members: [member(DEGRADE_THRESHOLD)] });
    assert.equal(info([at]).networkStatus, 'degraded');
  });

  // ── Actionable vote ────────────────────────────────────────────────────────
  it('vote: an open round awaiting our own cast', () => {
    assert.equal(info([net({ pendingRounds: [round()] })]).networkStatus, 'vote');
  });

  it('NOT vote: a round we have already cast in (busy network stays quiet)', () => {
    const voted = net({ pendingRounds: [round({ votes: [{ instanceId: ME, vote: 'yes' }] })] });
    assert.equal(info([voted]).networkStatus, 'idle',
      'once we vote, the chip must stop nudging');
  });

  it('NOT vote: a round restricted to other required voters', () => {
    const notMine = net({ pendingRounds: [round({ requiredVoters: ['someone-else'] })] });
    assert.equal(info([notMine]).networkStatus, 'idle');
    const mine = net({ pendingRounds: [round({ requiredVoters: [ME, 'other'] })] });
    assert.equal(info([mine]).networkStatus, 'vote');
  });

  it('ignores concluded rounds', () => {
    assert.equal(info([net({ pendingRounds: [round({ concluded: true })] })]).networkStatus, 'idle');
  });

  it('ignores a round past its deadline that nothing has concluded yet: nobody can vote on it', () => {
    for (const deadline of ['2020-01-01T00:00:00.000Z', 'whenever', '', undefined]) {
      assert.equal(info([net({ pendingRounds: [round({ deadline })] })]).networkStatus, 'idle',
        `a round with deadline ${JSON.stringify(deadline)} still asked the operator to vote`);
    }
  });

  it('a space-scoped round only affects its own space', () => {
    const other = net({ pendingRounds: [round({ spaceId: 'other' })] });
    assert.equal(info([other], 'work').networkStatus, 'idle',
      "a space_deletion/meta_change round for another space must not blue this one");
    const mine = net({ pendingRounds: [round({ spaceId: 'work' })] });
    assert.equal(info([mine], 'work').networkStatus, 'vote');
  });

  it('a network-wide round (no spaceId) awaits our vote on every member space', () => {
    const wide = net({ spaces: ['work', 'other'], pendingRounds: [round()] });
    assert.equal(info([wide], 'work').networkStatus, 'vote');
    assert.equal(info([wide], 'other').networkStatus, 'vote');
  });

  // ── Priority: degraded > syncing > vote > idle ─────────────────────────────
  it('priority: degraded > syncing > vote > idle', () => {
    // All three conditions true at once → degraded wins.
    const all = net({ members: [member(DEGRADE_THRESHOLD)], pendingRounds: [round()] });
    assert.equal(info([all], 'work', alwaysSyncing).networkStatus, 'degraded');
    // Syncing + awaiting vote, no degrade → syncing (vote nudge sits below the
    // transient sync state).
    const syncVote = net({ pendingRounds: [round()] });
    assert.equal(info([syncVote], 'work', alwaysSyncing).networkStatus, 'syncing');
    // Degraded + awaiting vote, not syncing → degraded (a persistent failure is
    // not masked by the retry in flight, and outranks the vote nudge).
    const degVote = net({ members: [member(DEGRADE_THRESHOLD)], pendingRounds: [round()] });
    assert.equal(info([degVote]).networkStatus, 'degraded');
  });

  it('aggregates across multiple networks the space belongs to', () => {
    const a = net({ id: 'a', label: 'A', spaces: ['work'] });
    const b = net({ id: 'b', label: 'B', spaces: ['work'], pendingRounds: [round()] });
    const i = info([a, b], 'work');
    assert.equal(i.networks.length, 2);
    assert.equal(i.networkStatus, 'vote', 'an open round awaiting us on any of the space networks counts');
  });
});
