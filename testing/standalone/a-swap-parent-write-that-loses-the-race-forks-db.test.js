/**
 * A parent swap that finds the stored copy changed under it is not made, and no text is lost (Q-324).
 *
 * ## The swap and its guard
 *
 * An arriving copy that wins the tie at an equal seq replaces the stored copy at the SAME seq. A write at an equal seq cannot ride the usual `seq < s`
 * guard, so it rides `equalSeqSwapGuard`: the stored copy the verdict rested on, named by its id, its seq and every body field as it was read. The loser
 * fork is written first, then the parent.
 *
 * ## The two ways the stored copy can move in the gap, each parked on a gate
 *
 *  - **a local edit** stamps a higher seq: the swap's guard fails, the stored (edited) copy stays and the push is `skipped`; the displaced text is already
 *    stored as a fork, so nothing was lost either way;
 *  - **another body lands at the SAME seq** (a racing push of a third copy): `seq` alone would have been satisfied, and the swap would have replaced a
 *    version the planner never saw. The guard names the body, so the swap is refused, the divergence is not retried as a swap, and the arriving copy is kept as a
 *    fork under the id its body derives: three bodies, all stored.
 *
 * The write is parked as the first `bulkWrite` carrying the swap's filter (a `seq` key, which the ordinary guard has none of), after the planner read and
 * after the loser fork landed, so the interleaving is the race's own, without sleeps. Seen red by removing `seq` and the body fields from the guard: the local
 * edit is overwritten, and the third body is stored nowhere.
 *
 * Run: node --test testing/standalone/a-swap-parent-write-that-loses-the-race-forks-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { parkWrites } from './_write-faults.mjs';
import { FORK_FIXTURE, forkingFamilies, copyOf, copyBeating, splitByTie } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();

const S = 'swaprace';
const ID = 'f';
const SEQ = 5;
let door, park, FAMILIES;

/** Park the first `bulkWrite` of `<S>_<family>` whose operation filter names a `seq`: the swap's, and no ordinary write's. */
function parkTheSwap(family) {
  park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
  const { reached, release } = park.arm(`${S}_${family}`, { when: (method, args) => method === 'bulkWrite' && args[0]?.[0]?.updateOne?.filter?.seq === SEQ });
  return { parked: reached, release };
}

const bodiesOf = async (family) => {
  const field = FORK_FIXTURE[family].field;
  const rows = await door.coll(S, family).find({ $or: [{ _id: ID }, { forkOf: ID }] }).toArray();
  return { parent: rows.find(r => r._id === ID), forks: rows.filter(r => r.forkOf === ID).map(r => r[field]).sort() };
};

describe('a parent swap that loses the race keeps every text (Q-324)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'swaprace', spaces: [{ id: S, label: 'Swap race', folders: [], meta: {} }] });
    FAMILIES = await forkingFamilies();
  });
  afterEach(() => { park?.restore(); park = undefined; });
  after(async () => { park?.restore(); await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  for (const interference of ['a local edit', 'a third body at the same seq']) {
    it(`${interference}: the swap is refused, the stored copy stays, and every text is stored`, async () => {
      const failures = [];
      for (const family of FAMILIES) {
        await door.wipe(S);
        const field = FORK_FIXTURE[family].field;
        const stored = copyOf(family, S, ID, SEQ, 'the stored body');
        // The arriving copy WINS the tie against the stored one (searched for: the order is the server's), so the push plans a swap.
        const arriving = await copyBeating(family, S, ID, SEQ, stored, 'the arriving body');
        const { parent } = await splitByTie(family, arriving, stored);
        if (parent !== arriving) { failures.push(`${family}: fixture check: the arriving copy does not win the tie`); continue; }
        await door.coll(S, family).insertOne(stored);
        const { parked, release } = parkTheSwap(family);
        const push = door.push('/batch-upsert', { [family]: [arriving] }, { spaceId: S });
        await parked;
        // The stored copy moves while the swap is parked.
        if (interference === 'a local edit') {
          await door.coll(S, family).updateOne({ _id: ID }, { $set: { seq: SEQ + 1, [field]: 'a local edit' } });
        } else {
          await door.coll(S, family).updateOne({ _id: ID }, { $set: { [field]: 'a third body' } });
        }
        release();
        const answer = await push;
        park.restore(); park = undefined;
        if (answer.code !== 200) { failures.push(`${family}: the push answered ${answer.code} ${JSON.stringify(answer.body)}`); continue; }
        await door.settled();
        const { parent: held, forks } = await bodiesOf(family);
        if (interference === 'a local edit') {
          if (held?.[field] !== 'a local edit') failures.push(`${family}: the swap overwrote a local edit: the parent says ${JSON.stringify(held?.[field])}`);
          if (!forks.includes('the stored body')) failures.push(`${family}: the displaced stored text is a fork nowhere: ${JSON.stringify(forks)}`);
        } else {
          if (held?.[field] !== 'a third body') failures.push(`${family}: the swap replaced a version the planner never saw: the parent says ${JSON.stringify(held?.[field])}`);
          if (!forks.includes(arriving[field])) failures.push(`${family}: the arriving text is stored nowhere: forks ${JSON.stringify(forks)}`);
          if (!forks.includes('the stored body')) failures.push(`${family}: the displaced stored text is stored nowhere: forks ${JSON.stringify(forks)}`);
        }
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
    });
  }
});
