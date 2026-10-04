/**
 * Standalone tests: vote-round retention (P14)
 *
 * `concludeRoundIfReady` marks a round `concluded` but never removes it from
 * `pendingRounds`, so without pruning the array grows for the life of the network.
 * `pruneExpiredRounds` drops rounds that are concluded AND past their deadline — those
 * can no longer influence any decision (every peer concludes them independently once the
 * deadline passes) and need no further propagation. These tests pin the retention rule:
 * open rounds and within-deadline concluded rounds are always kept; only concluded +
 * expired rounds are removed; a malformed deadline is kept (never prune on doubt).
 *
 * Run: node --test testing/standalone/vote-round-prune.test.js  (requires server build)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let isRoundPrunable, pruneExpiredRounds;

const NOW = 1_000_000_000_000; // fixed reference instant for deterministic tests
const past = new Date(NOW - 60_000).toISOString();   // 1 min ago
const future = new Date(NOW + 3_600_000).toISOString(); // 1 h ahead

const round = (over) => Object.assign(
  { roundId: 'r', type: 'remove', subjectInstanceId: 's', deadline: future, concluded: false, votes: [] },
  over,
);

describe('vote-round retention — isRoundPrunable', () => {
  before(async () => {
    ({ isRoundPrunable, pruneExpiredRounds } = await import('../../server/dist/sync/vote-round-retention.js'));
  });

  it('concluded AND past deadline → prunable', () => {
    assert.equal(isRoundPrunable(round({ concluded: true, deadline: past }), NOW), true);
  });

  it('concluded but within deadline → kept (a concluding cast may still need to propagate)', () => {
    assert.equal(isRoundPrunable(round({ concluded: true, deadline: future }), NOW), false);
  });

  it('open (not concluded) and past deadline → kept (still live governance)', () => {
    assert.equal(isRoundPrunable(round({ concluded: false, deadline: past }), NOW), false);
  });

  it('open and within deadline → kept', () => {
    assert.equal(isRoundPrunable(round({ concluded: false, deadline: future }), NOW), false);
  });

  it('malformed deadline → kept (never prune on doubt)', () => {
    assert.equal(isRoundPrunable(round({ concluded: true, deadline: 'not-a-date' }), NOW), false);
  });
});

describe('vote-round retention — pruneExpiredRounds', () => {
  before(async () => {
    ({ isRoundPrunable, pruneExpiredRounds } = await import('../../server/dist/sync/vote-round-retention.js'));
  });

  it('removes only concluded+expired rounds and returns the count', () => {
    const net = { pendingRounds: [
      round({ roundId: 'keep-open-future', concluded: false, deadline: future }),
      round({ roundId: 'keep-open-past', concluded: false, deadline: past }),
      round({ roundId: 'keep-concluded-future', concluded: true, deadline: future }),
      round({ roundId: 'drop-concluded-past-1', concluded: true, deadline: past }),
      round({ roundId: 'drop-concluded-past-2', concluded: true, deadline: past }),
    ] };
    const removed = pruneExpiredRounds(net, NOW);
    assert.equal(removed, 2);
    const ids = net.pendingRounds.map(r => r.roundId).sort();
    assert.deepEqual(ids, ['keep-concluded-future', 'keep-open-future', 'keep-open-past']);
  });

  it('is a no-op (returns 0, array identity unchanged) when nothing is expired', () => {
    const rounds = [round({ concluded: true, deadline: future }), round({ concluded: false, deadline: past })];
    const net = { pendingRounds: rounds };
    const removed = pruneExpiredRounds(net, NOW);
    assert.equal(removed, 0);
    assert.equal(net.pendingRounds, rounds, 'array is not reassigned when nothing changes');
  });

  it('handles an empty / missing pendingRounds safely', () => {
    assert.equal(pruneExpiredRounds({ pendingRounds: [] }, NOW), 0);
    assert.equal(pruneExpiredRounds({}, NOW), 0);
  });
});
