/**
 * A relay forwards a record it received to the instance that PULLS from it, whatever the record's seq (Q-278, doneWhen 1 and 2).
 *
 * ## The rule
 *
 * Every record that lands at a relay reaches the instances below it, whatever its seq is compared with what the relay has
 * already delivered. Here the leg under test is the PULL: C pulls from M. M never runs a cycle in these cases, so nothing M
 * pushes can carry the record, and X reaches M by the ROOT's push. The set the rule governs is every topology that relays
 * (`TOPOLOGIES`: braintree and pub/sub) and both orderings Q-278's doneWhen 1 names (`moreFirst`, `pushedBetween`), each
 * built on a fresh chain.
 *
 * ## Why it is red on 5.6-shaped paging and what turns it green
 *
 * A relay's pull mark for the member below it moves only with the relay's OWN records (`pullFamily`'s author guard, the
 * `highSeq` of `sync/pull-family.ts`), and a record keeps its author's seq. Once M has written more than A, A's next record
 * has a seq at or below C's mark and C asks for seqs above it. bundle-81 pages by a position the receiver takes at landing.
 * The companion, `q278-a-relay-pushes-what-it-received`, is the push leg.
 *
 * The controls are inside each case (`moreFirst`, `pushedBetween` in `_b81a-relay-chain.mjs`): the chain carries what M
 * wrote, and M holds the record it is asked to forward, so a red here names the relay and not the chain.
 *
 * Run: node --test testing/sync/q278-a-relay-forwards-what-it-pulled.test.js
 * Pre-requisite: the test stack up and `node testing/sync/setup.js a b c`
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TOPOLOGIES, buildChain, moreFirst, pushedBetween, holdings } from './_b81a-relay-chain.mjs';

const LEG = 'pull';

describe('a relay forwards what it received to the instance that pulls from it', () => {
  before(() => {
    assert.ok(TOPOLOGIES.length >= 2, `the rule is held on braintree and on pub/sub, found ${TOPOLOGIES.join(',')}`);
  });

  for (const type of TOPOLOGIES) {
    describe(type, () => {
      let chain;
      before(async () => { chain = await buildChain(type); });
      after(async () => { await chain?.remove(); });

      it('M writes more than the root first, then the root writes X: C pulls X from M', async () => {
        const { x, mine } = await moreFirst(chain, LEG);
        assert.equal(await chain.holds(chain.C, x.id), true,
          `C must hold X (seq ${x.seq}) after A pushed it to M and C pulled from M: ${JSON.stringify(await holdings(chain, { X: x.id, M1: mine[0] }))}`);
      });
    });

    describe(`${type}, the other ordering`, () => {
      let chain;
      before(async () => { chain = await buildChain(type); });
      after(async () => { await chain?.remove(); });

      it('M pushes a local write between the root\'s two writes: C pulls the second from M', async () => {
        const { x1, l, x2 } = await pushedBetween(chain, LEG);
        assert.equal(await chain.holds(chain.C, x2.id), true,
          `C must hold X2 (seq ${x2.seq}, the seq of M's local write ${l.seq}): ${JSON.stringify(await holdings(chain, { X1: x1.id, L: l.id, X2: x2.id }))}`);
      });
    });
  }
});
