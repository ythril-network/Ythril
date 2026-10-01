/**
 * Which priority lane a claim tries first: `claimOrder(n)`, the pure half of the embed queue's lanes.
 *
 * ## The rule (Q-99 part 2, design v3 item 5)
 *
 * The embed queue carries three lanes: 0 = a local write, 1 = a sync arrival or a reembed backfill, 2 = a
 * reindex rebuild. A claim walks the lanes in the order `claimOrder(n)` gives for the n-th claim:
 *
 *  - normally `[0, 1, 2]`, so a write somebody is waiting to search for goes first;
 *  - `n % 8 === 3` gives `[1, 2, 0]` and `n % 8 === 7` gives `[2, 0, 1]`.
 *
 * ## Why the rotation is a rule and not a tuning knob
 *
 * Strict priority starves. Under a saturating stream of local writes a sync arrival would never be embedded,
 * and a reindex would never finish — which keeps `needsReindex` asserted and recall refused for the whole
 * space. Every fourth claim leading with the next background lane guarantees each of them at least one claim in
 * eight, whatever the write rate. The property is asserted over EVERY window of eight consecutive claims, not
 * over one, because "at least once per eight" is the promise and a window starting at 0 is only one of them.
 *
 * Run: node --test testing/standalone/embed-claim-order.test.js   (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { claimOrder } = await import('../../server/dist/brain/embed-queue.js');

describe('claimOrder: which lane a claim tries first', () => {
  it('is exported as a function', () => {
    assert.equal(typeof claimOrder, 'function',
      'brain/embed-queue.ts must export claimOrder(n) — the lane order is a pure decision and is tested as one');
  });

  it('is [0, 1, 2] on an ordinary claim', () => {
    for (const n of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 16, 1000]) {
      assert.deepEqual(claimOrder(n), [0, 1, 2], `claim ${n} is not a rotation slot, so local writes lead`);
    }
  });

  it('leads with lane 1 when n % 8 === 3', () => {
    for (const n of [3, 11, 19, 803]) assert.deepEqual(claimOrder(n), [1, 2, 0], `claim ${n}`);
  });

  it('leads with lane 2 when n % 8 === 7', () => {
    for (const n of [7, 15, 23, 807]) assert.deepEqual(claimOrder(n), [2, 0, 1], `claim ${n}`);
  });

  it('every order names each lane exactly once', () => {
    // A lane missing from an order is a lane that claim can never reach.
    for (let n = 0; n < 64; n++) {
      assert.deepEqual([...claimOrder(n)].sort(), [0, 1, 2], `claim ${n} must try all three lanes`);
    }
  });

  it('over ANY eight consecutive claims, lanes 1 and 2 each lead at least once', () => {
    for (let start = 0; start < 64; start++) {
      const leaders = Array.from({ length: 8 }, (_, i) => claimOrder(start + i)[0]);
      assert.ok(leaders.includes(1), `claims ${start}..${start + 7} never lead with lane 1: a sync arrival can starve`);
      assert.ok(leaders.includes(2), `claims ${start}..${start + 7} never lead with lane 2: a reindex can starve`);
      assert.ok(leaders.filter(l => l === 0).length >= 6,
        `claims ${start}..${start + 7}: local writes must still lead at least six claims in eight`);
    }
  });

  it('is pure: the same n gives the same order', () => {
    for (let n = 0; n < 16; n++) assert.deepEqual(claimOrder(n), claimOrder(n));
  });
});
