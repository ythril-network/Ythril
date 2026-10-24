/**
 * A tombstone a relay received is served to every hop below it, and a later deletion of the same id replaces the stored one without
 * handing it a new issuer (bundle-81, Q-238; design rev 8 §6c, decisions 1, 13 and 31; §9 test 4).
 *
 * ## The defect
 *
 * A relayed brain tombstone kept its issuer's seq and was served by that seq. A hop C that had already pulled this instance's
 * tombstones through a mark above that seq never asked for it again, and the prune (`brain/tombstone-prune.ts`, floor
 * `served-watermark.ts`) deleted it once every member's served mark passed it: the deletion never reached C, and was gone from the
 * relay before anyone could ask. The apply also took a second deletion of the same id as "already held" and stored nothing, so a
 * later deletion was never re-served.
 *
 * ## The rules (6.0)
 *
 * 1. A relayed tombstone takes a position at RECEIPT, as a relayed file tombstone does: above every served mark, while its seq stays
 *    the issuer's and its `instanceId` stays the issuer's text.
 * 2. The prune, which reads positions against `lastPosServed`, does not take it before C has been served it; C, asking from its
 *    mark, is served it.
 * 3. A re-delivery at a HIGHER seq replaces the stored tombstone (seq, deletedAt, a fresh position) and keeps its `instanceId`,
 *    `storedVia` and `issuedHere`: a peer's text never changes who issued a deletion. It is served from its new position.
 * 4. A re-delivery at an equal or lower seq writes nothing: the stored document is exactly as it was, position included.
 * 5. A duplicate key (a concurrent insert of the same id through the other door, parked between the apply's read and its write) is
 *    counted `already_newer`, is not a failure, and the page's other tombstones land (decision 13). A page whose ONLY slice fails
 *    this way is the same answer, not an error (decision 31: the failure arrives wrapped in `SlicedBulkWriteError.failures[]` and is
 *    classified per inner error).
 *
 * The marks the case needs are put under both of their names (`lastSeqServed`, the 5.x one a carried instance still has, and
 * `lastPosServed`), so the prune of the build under test reads the one it reads.
 *
 * ## Red at 9a7ab3f7
 *
 * Rule 1 fails (a stored relayed tombstone has no `pos`); rule 2 fails (the prune takes the tombstone at seq 5 under a served mark of
 * 1000: the Q-238 symptom); rule 3 fails (the stored seq stays 10); rule 5 fails on the missing `already_newer` outcome, since base
 * has no duplicate-key path to classify. Rule 4 PASSES at base, by construction (nothing is written on a re-delivery today): it is a
 * guard on the fix, which must not write a position for a copy that is not newer.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/q238-a-relayed-tombstone-reaches-every-hop-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { parkWrites } from './_write-faults.mjs';
import { idsIn, setMark, clearPositionMarks, positionedTombstone } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'q238space';
/** Where C (the fake peer, a member below this relay) has been served through, in the units of each mark's era. */
const C_SERVED = 1000;
const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';
const RELAY = peerToken('q238-relay-b');

let door, proto, park, metrics, pruneAllTombstones;

const stored = (id) => door.coll(S, 'tombstones').findOne({ _id: id });
const deliver = (tombstones) => door.push('/tombstones', { tombstones }, { spaceId: S, token: RELAY });
const served = async (afterPos) => idsIn(await door.pull('/tombstones', { spaceId: S, afterPos: String(afterPos) }));

/** The count of `already_newer` outcomes the apply has counted so far, over every label set. */
async function alreadyNewer() {
  const { values } = await metrics.syncTombstonesAppliedTotal.get();
  return values.filter(v => v.labels.outcome === 'already_newer').reduce((n, v) => n + v.value, 0);
}

/** A tombstone of a fact, as a relay receives it from an issuer that is not the deliverer. */
const arriving = (id, seq, extra = {}) => build.tombstone(S, id, 'fact', seq, { instanceId: 'q238-origin-a', deletedAt: T0, ...extra });

describe('a relayed tombstone reaches every hop', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b81tB_q238', spaces: [S], direction: 'both' });
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    metrics = await import('../../server/dist/metrics/registry.js');
    ({ pruneAllTombstones } = await import('../../server/dist/brain/tombstone-prune.js'));
  });
  after(async () => { park?.restore(); await door?.close(); });
  beforeEach(async () => {
    park?.restore();
    park = parkWrites(proto);
    await door.reset({ direction: 'both' });
    clearPositionMarks(door);
    await door.coll(S, 'tombstones').deleteMany({});
    // C has been served every tombstone through C_SERVED: the mark the prune reads and the mark C asks from.
    door.member().lastSeqServed = { [S]: C_SERVED };
    setMark(door, 'served', S, C_SERVED);
  });

  it('a tombstone relayed below C\'s mark takes a position at receipt, above that mark, and keeps its seq and its issuer', async () => {
    const t = arriving('q238-below', 5);
    const answer = await deliver([t]);
    assert.equal(answer.code, 200, JSON.stringify(answer.body));
    const row = await stored(t._id);
    assert.ok(row, 'the relayed tombstone was not stored');
    assert.equal(row.seq, 5, 'a relayed tombstone keeps its issuer\'s seq as its version');
    assert.equal(row.instanceId, 'q238-origin-a', 'a relayed tombstone keeps its issuer\'s text');
    assert.ok(Number.isSafeInteger(row.pos) && row.pos > C_SERVED,
      `the relayed tombstone carries pos ${String(row.pos)}: with no position at receipt it is served by seq ${row.seq}, below the mark ${C_SERVED} C has been served through, and C never asks for it`);
  });

  it('is not pruned before C has been served it, and C asking from its mark is served it', async () => {
    const t = arriving('q238-pruned', 5);
    assert.equal((await deliver([t])).code, 200);
    await pruneAllTombstones();
    assert.ok(await stored(t._id),
      `the prune took the tombstone (seq 5) under the served mark ${C_SERVED}: it was relayed here below what C had been served, so C never saw it`);
    assert.ok((await served(C_SERVED)).includes(t._id), 'C, asking from its mark, was not served the relayed tombstone');
  });

  it('a re-delivery at a higher seq replaces the stored tombstone, keeps its issuer, storedVia and issuedHere, and is served from its new position', async () => {
    const held = positionedTombstone(S, 'q238-higher', 'fact', 10, { instanceId: 'q238-origin-a', deletedAt: T0, storedVia: 'q238-upstream', issuedHere: false });
    await door.coll(S, 'tombstones').insertOne({ ...held });
    await door.bumpSeq(S, 10);
    const answer = await deliver([arriving('q238-higher', 20, { instanceId: 'q238-someone-else', deletedAt: T1 })]);
    assert.equal(answer.code, 200, JSON.stringify(answer.body));
    const row = await stored('q238-higher');
    assert.equal(row.seq, 20, `the stored tombstone is still at seq ${row.seq}: a later deletion of the same id was never stored, so it is never re-served`);
    assert.equal(row.deletedAt, T1, 'the replace did not take the newer deletion\'s time');
    assert.equal(row.instanceId, 'q238-origin-a', 'a peer\'s text changed who issued the deletion');
    assert.equal(row.storedVia, 'q238-upstream', 'the replace cleared the upstream it is stored for');
    assert.equal(row.issuedHere, false, 'the replace changed issuedHere');
    assert.ok(row.pos > held.pos, `the replaced tombstone kept pos ${row.pos}: it has to be served from a fresh position`);
    assert.ok((await served(held.pos)).includes('q238-higher'), 'a puller asking from the old position was not served the replaced tombstone');
  });

  it('a re-delivery at an equal or lower seq writes nothing: the stored document is exactly as it was', async () => {
    const held = positionedTombstone(S, 'q238-same', 'fact', 20, { instanceId: 'q238-origin-a', deletedAt: T0, storedVia: 'q238-upstream', issuedHere: false });
    await door.coll(S, 'tombstones').insertOne({ ...held });
    await door.bumpSeq(S, 20);
    const before = await stored('q238-same');
    for (const seq of [20, 15]) {
      const answer = await deliver([arriving('q238-same', seq, { instanceId: 'q238-someone-else', deletedAt: T1 })]);
      assert.equal(answer.code, 200, JSON.stringify(answer.body));
      assert.deepEqual(await stored('q238-same'), before, `a re-delivery at seq ${seq} changed the stored tombstone (positions are not spent on a copy that is not newer)`);
    }
  });

  describe('a duplicate key is "already newer here", and never a failure', () => {
    /** Park the apply's first write to the space's tombstones, let `race` insert through the other door, then release. */
    async function raceAgainst(page, race) {
      const gate = park.arm(`${S}_tombstones`, { when: (m) => m !== 'insertOne' && m !== 'insertMany' });
      const applying = deliver(page);
      await gate.reached;
      await race();
      gate.release();
      return applying;
    }

    it('the page\'s other tombstones land, the duplicate is counted already_newer, and the answer is a success', async () => {
      const before = await alreadyNewer();
      const dup = arriving('q238-dup', 40);
      const other = arriving('q238-other', 41);
      const answer = await raceAgainst([dup, other], async () => {
        // The same id, one version higher, inserted by the other door while the apply was between its read and its write.
        await door.coll(S, 'tombstones').insertOne({ ...positionedTombstone(S, dup._id, 'fact', 99, { instanceId: 'q238-origin-a', deletedAt: T0 }) });
      });
      assert.equal(answer.code, 200, `the page was answered ${answer.code}: ${JSON.stringify(answer.body)} — one stale tombstone must not fail every other on it`);
      assert.ok(await stored(other._id), 'the page\'s other tombstone did not land');
      assert.equal((await stored(dup._id)).seq, 99, 'the apply overwrote the newer tombstone the other door had inserted');
      assert.equal(await alreadyNewer() - before, 1, 'the duplicate was not counted ythril_sync_tombstones_applied_total{outcome="already_newer"}');
    });

    it('a page whose only slice fails is unwrapped from SlicedBulkWriteError.failures[] and classified the same (decision 31)', async () => {
      const before = await alreadyNewer();
      const only = arriving('q238-only', 42);
      const answer = await raceAgainst([only], async () => {
        await door.coll(S, 'tombstones').insertOne({ ...positionedTombstone(S, only._id, 'fact', 99, { instanceId: 'q238-origin-a', deletedAt: T0 }) });
      });
      assert.equal(answer.code, 200, `a page of one stale tombstone was answered ${answer.code}: ${JSON.stringify(answer.body)} — the slice's failure was not read as already-newer`);
      assert.equal(await alreadyNewer() - before, 1, 'the only tombstone of the page was a duplicate key and was not counted already_newer');
      assert.equal((await stored(only._id)).seq, 99, 'the newer tombstone was overwritten');
    });
  });
});
