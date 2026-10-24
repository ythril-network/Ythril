/**
 * A sync cycle whose only content is a tombstone moves the marks, on both doors: the next cycle sends nothing and pulls nothing
 * (bundle-81, Q-394; design rev 8 §6 "Marks and watermark", §9 test 3).
 *
 * ## The defect
 *
 * A tombstone never raised a watermark: `resolveWatermark` took the candidate from the record families and passed tombstones as
 * `alsoCheck`, which may only LOWER it (`sync/space-exchange.ts:254-262`, `:315-322`). A space whose only change was a deletion
 * therefore left `lastSeqReceived` and `lastSeqPushed` where they were, and EVERY cycle re-sent the same tombstones to the peer
 * and re-pulled the same ones from it, for ever.
 *
 * ## The rule (6.0)
 *
 * Brain tombstones are an ordinary transfer in the same position stream, so a cycle that moved only tombstones moves
 * `lastPosPushed` (push door) and `lastPosReceived` (pull door) to what the transfer is complete through.
 *
 * ## What each case asserts, and in which order
 *
 * 1. The cycle moved the tombstone at all (a control: the fixture reaches the peer, and the peer's answer is read off the wire).
 * 2. The NEXT cycle moves no tombstone, either way. This is the symptom, and it is asserted first so the red output names it.
 * 3. The mark started at a SENTINEL, below the tombstone, and now sits above it, as a finite integer: not unchanged, not NaN.
 * 4. Positive control, in the same case: a record written AFTER the tombstone-only cycle is carried by the next cycle and
 *    identified by id, and the tombstone is not carried with it. Without it "nothing was sent" could be a cycle that sends nothing
 *    at all.
 *
 * The space is asserted ready before the cycle (design rev 8 §3: an unready space answers `positions_building` and moves no mark).
 *
 * ## Red at 9a7ab3f7
 *
 * Case 2 fails in both cases: the tombstone is served and pushed again by the second cycle, because no mark moved. The readiness
 * case fails on the missing module `sync/positions-owed.js` (created by this bundle). The marks are asserted under their 6.0 names,
 * which nothing writes at base, so case 3 fails as well, after case 2 has named the reason.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/q394-a-tombstone-only-cycle-moves-the-marks-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { openWireProxy } from './_b81b-wire.mjs';
import { idsIn, readMark, setMark, clearPositionMarks, positioned, positionedTombstone } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'q394space';
/** A mark's starting value: below every fixture position, and not 0 (which is also what "absent" reads as). */
const SENTINEL = 3;
const TOMBSTONE_SEQ = 50;
const RECORD_SEQ = 60;

let door, proxy, ME;
/** The ids of every tombstone the peer's answers named during the current cycle. */
let served = [];

/** One cycle; what the peer served (tombstones) and what it was sent (tombstones, record ids) during it. */
async function cycle() {
  served = [];
  const sentTombstones = door.state.received.length;
  const sentRecords = door.state.pushedRecords.length;
  await door.sync();
  return {
    served: [...served],
    tombstonesSent: door.state.received.slice(sentTombstones).map(t => t._id),
    recordsSent: door.state.pushedRecords.slice(sentRecords).map(r => r._id),
  };
}

const finiteMark = (kind) => {
  const v = readMark(door, kind, S);
  assert.ok(Number.isSafeInteger(v), `the ${kind} mark is ${String(v)}, not a finite integer`);
  return v;
};

describe('a tombstone-only cycle moves the marks', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b81tB_q394', spaces: [S], direction: 'both' });
    proxy = await openWireProxy(door.url, { mode: '6.0' });
    door.member().url = proxy.url;
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await proxy?.close(); await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'both' });
    clearPositionMarks(door);
    // The peer's answers come from the real handlers over the peer's own storage, so a mark means what it means in production.
    door.state.family = door.serveFamily;
    door.state.tamper = (body) => { served.push(...idsIn(body)); return body; };
    proxy.clear();
  });

  it('the space is positioned and owes nothing before the cycle', async () => {
    const owed = await import('../../server/dist/sync/positions-owed.js');
    assert.ok(!(await owed.positionsOwed(S)), `space ${S} owes its positions before any cycle ran`);
  });

  it('pull door: the cycle that only pulled a tombstone moves lastPosReceived, the next pulls nothing, and a later record is pulled', async () => {
    const T = positionedTombstone(S, 'q394-pull-t', 'fact', TOMBSTONE_SEQ, { instanceId: PEER });
    await door.seedPeer(S, [T]);
    setMark(door, 'received', S, SENTINEL);

    const first = await cycle();
    assert.ok(first.served.includes(T._id), `control: the peer did not serve the tombstone in the first cycle (${first.served.join(', ') || 'nothing'})`);
    assert.ok(await door.coll(S, 'tombstones').findOne({ _id: T._id }), 'control: the tombstone was not stored by the first cycle');

    const second = await cycle();
    assert.deepEqual(second.served.filter(id => id === T._id), [],
      'the second cycle pulled the tombstone AGAIN: the first moved no receive mark, because a tombstone does not raise the watermark (Q-394)');
    assert.ok(finiteMark('received') > TOMBSTONE_SEQ,
      `lastPosReceived is ${readMark(door, 'received', S)}: a tombstone-only cycle left the mark at or below the tombstone's position ${TOMBSTONE_SEQ}`);

    // Positive control: what the peer writes after the tombstone-only cycle is pulled, by id, and the tombstone is not pulled with it.
    const F = positioned(build.fact(S, 'q394-pull-f', RECORD_SEQ, { author: PEER_AUTHOR }));
    await door.seedPeerRecords(S, 'facts', [F]);
    const third = await cycle();
    assert.ok(await door.coll(S, 'facts').findOne({ _id: F._id }), 'positive control: the record the peer wrote after the cycle was not pulled');
    assert.deepEqual(third.served.filter(id => id === T._id), [], 'the cycle that pulled the later record pulled the tombstone again');
  });

  it('push door: the cycle that only pushed a tombstone moves lastPosPushed, the next sends nothing, and a later record is sent', async () => {
    const T = positionedTombstone(S, 'q394-push-t', 'fact', TOMBSTONE_SEQ, { instanceId: door.instanceId, issuedHere: true });
    await door.coll(S, 'tombstones').insertOne({ ...T });
    await door.bumpSeq(S, TOMBSTONE_SEQ);
    setMark(door, 'pushed', S, SENTINEL);

    const first = await cycle();
    assert.ok(first.tombstonesSent.includes(T._id), `control: the first cycle did not send the tombstone (${first.tombstonesSent.join(', ') || 'nothing'})`);

    const second = await cycle();
    assert.deepEqual(second.tombstonesSent.filter(id => id === T._id), [],
      'the second cycle sent the tombstone AGAIN: the first moved no push mark, because a tombstone does not raise the watermark (Q-394)');
    assert.ok(finiteMark('pushed') > TOMBSTONE_SEQ,
      `lastPosPushed is ${readMark(door, 'pushed', S)}: a tombstone-only cycle left the mark at or below the tombstone's position ${TOMBSTONE_SEQ}`);

    // Positive control: a record written here after the tombstone-only cycle is sent, identified by id, and the tombstone is not.
    const F = positioned(build.fact(S, 'q394-push-f', RECORD_SEQ, { author: ME }), { writtenHere: true });
    await door.coll(S, 'facts').insertOne({ ...F });
    await door.bumpSeq(S, RECORD_SEQ);
    const third = await cycle();
    assert.deepEqual(third.recordsSent, [F._id], 'positive control: the record written after the cycle was not sent exactly once');
    assert.deepEqual(third.tombstonesSent.filter(id => id === T._id), [], 'the cycle that sent the later record sent the tombstone again');
  });
});
