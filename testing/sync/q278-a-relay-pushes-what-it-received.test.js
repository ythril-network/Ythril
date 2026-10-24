/**
 * A relay pushes a record it received to the instance below it, whatever the record's seq (Q-278, doneWhen 1 and 2).
 *
 * ## The rule
 *
 * Every record that lands at a relay reaches the instances below it, whatever its seq is compared with what the relay has
 * already delivered. Here the leg under test is the PUSH: M pushes to C. C never runs a cycle in these cases, so nothing C
 * pulls can carry the record, and X reaches M by the ROOT's push. Both orderings Q-278's doneWhen 1 names are cases of their
 * own (`moreFirst`, `pushedBetween`), on every topology that relays (`TOPOLOGIES`: braintree and pub/sub), each on a fresh
 * chain.
 *
 * ## Why it is red on 5.6-shaped paging and what turns it green
 *
 * A relay's push mark for a member moves only with the relay's OWN records (`pushFamily`'s `localMaxSeq`,
 * `sync/push-family.ts`), and a record keeps its author's seq. The ordering `pushedBetween` is the sharp one: M's arrival
 * of X1 moves M's counter, M's local write takes the next seq and moves the push mark to it, and the root's next write
 * takes that same seq, so the push selects `seq > mark` and never offers it. bundle-81 pages by a position the receiver
 * takes at landing, and an arrival no longer moves the counter. The companion, `q278-a-relay-forwards-what-it-pulled`, is
 * the pull leg.
 *
 * The controls are inside each case (`_b81a-relay-chain.mjs`): the chain carries what M wrote by this leg, and M holds the
 * record it is asked to forward, so a red here names the relay and not the chain.
 *
 * Run: node --test testing/sync/q278-a-relay-pushes-what-it-received.test.js
 * Pre-requisite: the test stack up and `node testing/sync/setup.js a b c`
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TOPOLOGIES, buildChain, moreFirst, pushedBetween, holdings } from './_b81a-relay-chain.mjs';

const LEG = 'push';

describe('a relay pushes what it received to the instance below it', () => {
  before(() => {
    assert.ok(TOPOLOGIES.length >= 2, `the rule is held on braintree and on pub/sub, found ${TOPOLOGIES.join(',')}`);
  });

  for (const type of TOPOLOGIES) {
    describe(type, () => {
      let chain;
      before(async () => { chain = await buildChain(type); });
      after(async () => { await chain?.remove(); });

      it('M writes more than the root first, then the root writes X: M pushes X to C', async () => {
        const { x, mine } = await moreFirst(chain, LEG);
        assert.equal(await chain.holds(chain.C, x.id), true,
          `C must hold X (seq ${x.seq}) after A pushed it to M and M pushed to C: ${JSON.stringify(await holdings(chain, { X: x.id, M1: mine[0] }))}`);
      });
    });

    describe(`${type}, the other ordering`, () => {
      let chain;
      before(async () => { chain = await buildChain(type); });
      after(async () => { await chain?.remove(); });

      it('M pushes a local write between the root\'s two writes: M pushes the second to C', async () => {
        const { x1, l, x2 } = await pushedBetween(chain, LEG);
        assert.equal(await chain.holds(chain.C, x2.id), true,
          `C must hold X2 (seq ${x2.seq}, the seq of M's local write ${l.seq}): ${JSON.stringify(await holdings(chain, { X1: x1.id, L: l.id, X2: x2.id }))}`);
      });
    });
  }
});
