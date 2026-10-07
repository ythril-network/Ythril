/**
 * The repair that goes with the upstream's deletion authority: a tombstone this instance DECLINED before it had the
 * rule is applied by a ONE-TIME re-read of each upstream's tombstones (bundle-51 plan §4), after a ONE-TIME back-fill of
 * the stamp the rule reads (§1).
 *
 * ## Why a repair at all
 *
 * The receive watermark (`lastSeqReceived`) moved past a tombstone the old rule declined, so no ordinary cycle will ever
 * ask for it again: the record stayed on the subscriber, and the publisher's deletion was lost for good. Deleting them
 * now needs the deletions the upstream STILL HOLDS, re-read from 0 — once (`tombstoneRereadAt[space]`: absent = owed,
 * `'done'` = never again) — through the same apply, with one extra bound only a re-read needs: a re-read tombstone deletes a
 * row only if the row's seq is not above the tombstone's, so a record RE-CREATED after the deletion survives.
 *
 * ## The rules, on the real engine against a fake peer serving the real tombstone handler
 *
 *  1. A declined tombstone the upstream still holds is applied by the re-read on the next cycle; the record watermark is
 *     NOT moved by it, and a record re-created at a higher seq survives (one at an equal seq does not).
 *  2. It is once: a second cycle asks for no read from 0. A member whose first ordinary pull already read from 0 is marked
 *     done without a second full read.
 *  3. A re-read that fails stays owed and is its own outcome: the record watermark the ordinary pull earned in that same
 *     cycle is kept (a re-read must not hold what it is not part of), and the next cycle finishes it.
 *  4. Only an UPSTREAM is re-read: every network type (derived, `_network-topologies.mjs`) is run, and the re-read, and the
 *     deletion it brings, happen exactly where the peer is the upstream.
 *  5. **The back-fill**: a row stored before the stamp existed is stamped ONCE per space, in the sync cycle and before the
 *     repair — with the upstream's id when the space is carried here only by directional networks with that one upstream and
 *     the row's author is someone else, and `''` otherwise (a space also carried by a club network, this instance's own
 *     record, an author-less one). A row that arrives unstamped after that is NOT stamped: from then on the stored stamp is
 *     the only rule.
 *
 * ## Why the back-fill rows are one test
 *
 * The back-fill is once per space, and the door has one config and no way to un-mark a space: so every unstamped row is
 * seeded before the door's first cycle and read after it, and the later rows seed an explicit stamp.
 *
 * ## Seen red
 *
 * On the base (abc4cc57) there is no re-read: the declined tombstone stays declined, no request reads from 0, nothing is
 * stamped and the state is never written.
 *
 * Run: node --test testing/standalone/a-declined-upstream-tombstone-is-applied-by-a-one-time-re-read-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { topologies, peerIsUpstream } from './_network-topologies.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const R = 'tsrepair';       // the repair space: carried by the upstream's network only
const BF1 = 'tsbackfill1';  // carried by the upstream's network only
const BF2 = 'tsbackfill2';  // carried by the upstream's network AND a club network
const THIRD = 'third-party-author';

let door, ME, upstreamOf, register;

const fact = (space, id, seq, author, stamp) => {
  const d = build.fact(space, id, seq);
  if (author === undefined) delete d.author; else d.author = { instanceId: author, instanceLabel: String(author) };
  if (stamp !== undefined) d.deliveredBy = stamp;
  return d;
};
const tomb = (space, id, seq, issuer = THIRD) => build.tombstone(space, id, 'fact', seq, { instanceId: issuer });
const here = async (space, id) => door.coll(space, 'facts').findOne({ _id: id });
/**
 * Requests the receiver made that read the peer's tombstones of the REPAIR space from the very beginning (a re-read, or a
 * first read). The other spaces of the network sync in the same cycle, and a member that has read nothing of them reads
 * from 0 as it always did — which is not what these rows ask.
 */
const readsFromZero = () => door.state.requests.filter(q => q.spaceId === R && String(q.sinceSeq) === '0');
/** What the member holds for the one-time re-read of a space. */
const rereadState = (space) => door.member().tombstoneRereadAt?.[space];

describe('a declined upstream tombstone is applied by a one-time re-read, after a one-time back-fill', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsrepair', spaces: [R, BF1, BF2], lateral: [BF2] });
    ME = door.instanceId;
    ({ upstreamOf } = await import('../../server/dist/networks/network-spaces.js'));
    ({ register } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  // MUST run before any test that syncs: it is the door's one chance to see unstamped rows.
  describe('5. the back-fill stamps a row stored before the stamp existed, once per space', () => {
    it('the upstream\'s id for a single-route space and a foreign author; the empty string otherwise; never again', async () => {
      await door.coll(BF1, 'facts').insertMany([
        fact(BF1, 'bf1-third', 3, THIRD),
        fact(BF1, 'bf1-self', 3, ME),
        fact(BF1, 'bf1-empty-author', 3, ''),
        fact(BF1, 'bf1-no-author', 3, undefined),
        fact(BF1, 'bf1-stamped', 3, THIRD, 'an-existing-stamp'),
        fact(BF1, 'bf1-doomed', 3, THIRD),
      ]);
      await door.coll(BF2, 'facts').insertMany([fact(BF2, 'bf2-third', 3, THIRD), fact(BF2, 'bf2-doomed', 3, THIRD)]);
      // The upstream still holds the deletions of the two "doomed" rows, behind the receive watermark.
      await door.seedPeer(BF1, [tomb(BF1, 'bf1-doomed', 10)]);
      await door.seedPeer(BF2, [tomb(BF2, 'bf2-doomed', 10)]);
      door.member().lastSeqReceived = { [BF1]: 10, [BF2]: 10, [R]: 0 };

      await door.sync();

      const stamps = Object.fromEntries(await Promise.all(['bf1-third', 'bf1-self', 'bf1-empty-author', 'bf1-no-author', 'bf1-stamped', 'bf2-third']
        .map(async id => [id, (await here(id.startsWith('bf2') ? BF2 : BF1, id))?.deliveredBy])));
      assert.deepEqual(stamps, {
        'bf1-third': PEER,                  // only directional, one upstream, a foreign author: the upstream's
        'bf1-self': '',                     // this instance wrote it
        'bf1-empty-author': '',
        'bf1-no-author': '',
        'bf1-stamped': 'an-existing-stamp', // a stamped row is never touched
        'bf2-third': '',                    // a club network carries the space too: the delivery cannot be told
      }, 'the back-fill stamped a row wrongly (or not at all) — every row stored before the stamp would then be undeletable by its publisher, or deletable by the wrong peer');

      assert.equal(await here(BF1, 'bf1-doomed'), null,
        'the back-fill did not run BEFORE the re-read: a tombstone the old rule declined stayed declined because the row it names carried no stamp');
      assert.ok(await here(BF2, 'bf2-doomed'), 'a row in a space a club network also carries was deleted on the upstream\'s say-so');

      // Once per space: a row that arrives unstamped LATER is not judged by a second rule.
      await door.coll(BF1, 'facts').insertOne(fact(BF1, 'bf1-late', 3, THIRD));
      await door.sync();
      assert.equal('deliveredBy' in (await here(BF1, 'bf1-late')), false, 'the back-fill ran again: a stamp is now decided by a second, live rule');
    });
  });

  describe('1. a declined tombstone the upstream still holds is applied by the re-read', () => {
    /** The earlier release declined it and moved the watermark to 10 past it: the record is here, stamped by the upstream. */
    async function declinedEarlier(id, { seq = 3, tombSeq = 10 } = {}) {
      await door.coll(R, 'facts').insertOne(fact(R, id, seq, THIRD, PEER));
      await door.seedPeer(R, [tomb(R, id, tombSeq)]);
      door.member().lastSeqReceived = { [R]: 10 };
    }

    it('deletes it on the next cycle, stores the tombstone for relay, and leaves the record watermark where it was', async () => {
      await declinedEarlier('rep-1');
      await door.sync();
      assert.equal(await here(R, 'rep-1'), null, 'the deletion the upstream still holds was never applied: the old release declined it and the watermark passed it');
      assert.equal((await door.coll(R, 'tombstones').findOne({ _id: 'rep-1' }))?.storedVia, PEER, 'the repaired tombstone is not stored for a middle node to relay');
      assert.equal(door.member().lastSeqReceived[R], 10, 'the re-read moved the record watermark: a tombstone seq is not a position in the data stream');
      assert.equal(rereadState(R), 'done');
      assert.ok(readsFromZero().length >= 1, 'no request read the tombstones from 0');
    });

    it('a record re-created at a higher seq survives; one at the tombstone\'s own seq does not', async () => {
      await door.coll(R, 'facts').insertMany([fact(R, 'rep-recreated', 20, THIRD, PEER), fact(R, 'rep-equal', 10, THIRD, PEER)]);
      await door.seedPeer(R, [tomb(R, 'rep-recreated', 10), tomb(R, 'rep-equal', 10)]);
      door.member().lastSeqReceived = { [R]: 25 };
      await door.sync();
      assert.ok(await here(R, 'rep-recreated'), 'the re-read deleted a record re-created AFTER the deletion (its seq is above the tombstone\'s)');
      assert.equal(await here(R, 'rep-equal'), null, 'the re-read kept a record that is not newer than the tombstone');
    });

    it('2. it is once: a second cycle reads nothing from 0', async () => {
      await declinedEarlier('rep-once');
      await door.sync();
      assert.equal(rereadState(R), 'done', 'fixture: the first cycle did not complete the repair');
      door.state.requests = [];
      await door.sync();
      assert.deepEqual(readsFromZero().map(q => q.cursor), [], 'a completed repair read the upstream\'s tombstones from 0 again, every cycle');
    });

    it('2. a member whose first ordinary pull read from 0 is marked done without a second full read', async () => {
      await door.coll(R, 'facts').insertOne(fact(R, 'rep-fresh', 3, THIRD, PEER));
      await door.seedPeer(R, [tomb(R, 'rep-fresh', 10)]);
      await door.sync();
      assert.equal(await here(R, 'rep-fresh'), null, 'the ordinary pull from 0 did not apply the upstream\'s deletion');
      assert.equal(rereadState(R), 'done', 'a member whose first read already covered everything is still owed a re-read');
      assert.equal(readsFromZero().length, 1, `the cycle read from 0 ${readsFromZero().length} times: the second is the full read the first made unnecessary`);
    });

    it('3. a failing re-read stays owed, keeps the record watermark the ordinary pull earned, and the next cycle finishes it', async () => {
      await declinedEarlier('rep-fail');
      // Authored by the PEER pulled from: the record watermark advances only over the pulled peer's OWN records (`highSeq` in
      // `pull-family.ts` counts a record whose author is the member), so a relayed third author's would leave it at 10.
      door.state.records[R] = { facts: [fact(R, 'fresh-15', 15, PEER)] };
      // Only the read from 0 fails: the ordinary pull (from 10) and the record pages are served.
      door.state.tamper = (_body, asked) => { if (String(asked.sinceSeq) === '0') throw new Error('scripted failure of the re-read'); };
      await door.logsDuring(() => door.sync());
      assert.ok(await here(R, 'rep-fail'), 'fixture: the re-read was not the failing step');
      assert.notEqual(rereadState(R), 'done', 'a failed re-read was marked done: the declined deletion is never retried');
      assert.equal(door.member().lastSeqReceived[R], 15,
        'a failed re-read held the record watermark: it is its own outcome and is not part of the ordinary pull\'s completeness');
      door.state.tamper = null;
      await door.sync();
      assert.equal(await here(R, 'rep-fail'), null, 'the next cycle did not finish the repair');
      assert.equal(rereadState(R), 'done');
    });

    it('the owed re-reads are counted: the gauge exists', async () => {
      assert.ok((await register.getMetricsAsJSON()).some(m => m.name === 'ythril_sync_tombstone_rereads_owed'),
        'ythril_sync_tombstone_rereads_owed is not registered — an operator cannot tell whether the repair is pending');
    });
  });

  describe('4. only an upstream is re-read, on every network type', () => {
    for (const top of topologies(PEER)) {
      it(top.name, async () => {
        door.configure(top.set);
        const upstream = peerIsUpstream(door, upstreamOf, PEER, R);
        await door.coll(R, 'facts').insertOne(fact(R, 'rep-topo', 3, THIRD, PEER));
        await door.seedPeer(R, [tomb(R, 'rep-topo', 10)]);
        door.member().lastSeqReceived = { [R]: 10 };
        await door.sync();
        assert.equal(readsFromZero().length >= 1, upstream,
          upstream ? 'the upstream\'s tombstones were not re-read' : 'a peer that is no upstream was re-read from 0');
        assert.equal((await here(R, 'rep-topo')) === null, upstream, upstream
          ? 'the upstream\'s deletion was not applied by the repair' : 'a peer that is no upstream deleted a record by being re-read');
        assert.equal(rereadState(R) === 'done', upstream, `the repair state is ${JSON.stringify(rereadState(R))} for a peer that ${upstream ? 'is' : 'is not'} the upstream`);
      });
    }
  });
});
