/**
 * A peer whose positions went BACKWARDS is read again from the start, by id and version, and that is not a member failure (bundle-81 test 11, the `head` guard;
 * design rev 8 section 4 "The `head` guard stays as the detector for the one residual", decision 53).
 *
 * ## The residual it detects
 *
 * Positions continue above everything a start has handed out (`positions-continue-above-every-start-db`), except when the wall clock is set back across a start
 * that also lost the stored maximum (a database restore with an NTP step back): the restored peer then stamps below marks other instances already hold in
 * its stream. Every page answers `head` (the peer's settled cap less one), so a puller whose receive mark for the member is ABOVE that head knows the
 * peer's numbers went backwards, and not that it is caught up.
 *
 * ## The rule
 *
 * - **The mark is forgotten and the space is read from the start**, sorting by id and version (D-48): every peer row this instance does not hold lands.
 * - **Held copies are skipped, not rewritten**: a copy held at the version the peer sends keeps the position this instance gave it (a sentinel here, so a rewrite shows).
 * - **It is counted** (`ythril_sync_position_behind_total{network}`) and it is NOT a failure: the member's failure count does not move and the cycle does not throw.
 * - **Control: a mark at or below the head is an ordinary pull.** Nothing is forgotten and nothing is counted, so the case above is the guard's doing and not every cycle's.
 *
 * The clock set back is reached as the plan says for the receiver side: the peer's head is its own settled cap, which is the wall clock; the mark is set an hour above it, the
 * state a puller is in after the peer's clock stepped back by an hour. (The records stream's own clock seam, `setPositionClockSourceForTest`, is `positions-continue-above-every-start-db`'s.)
 *
 * Run: node --test testing/standalone/a-peer-head-below-our-mark-is-re-read-by-id-and-version-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'b81head';
const HOUR_US = 3_600_000_000;
const HELD_POS = 777;

describe('a peer head below our mark is re-read by id and version', { skip }, () => {
  let door; let registry;
  before(async () => {
    door = await openPullDoor({ suite: 'b81tI3_head', spaces: [S], type: 'closed', direction: 'pull' });
    registry = await import('../../server/dist/metrics/registry.js');
  });
  after(async () => { await door?.close(); });

  const peerRow = (id, seq) => build.fact(S, id, seq, { author: { ...PEER_AUTHOR } });
  const behind = async () => {
    const m = await registry.syncPositionBehindTotal.get();
    return m.values.filter(v => v.labels.network === door.NET).reduce((n, v) => n + v.value, 0);
  };

  /** The peer holds p1, p2, p3; this instance already holds p1 at the same version, at a position of its own (the sentinel). */
  async function state(mark) {
    await door.reset();
    door.member().consecutiveFailures = 0;
    await door.seedPeerRecords(S, 'facts', [peerRow('p1', 5), peerRow('p2', 6), peerRow('p3', 7)]);
    await door.coll(S, 'facts').insertOne({ ...peerRow('p1', 5), deliveredBy: PEER, pos: HELD_POS, posAtSeq: 5 });
    door.member().lastPosReceived = { [S]: mark };
    door.state.family = door.serveFamily;
  }
  const landed = async () => (await door.coll(S, 'facts').find({ 'author.instanceId': PEER }).toArray()).map(r => r._id).sort();

  it('a mark above the peer head is forgotten: every row this instance lacks lands, the held copy is not rewritten, one count, no failure', async () => {
    await state(Date.now() * 1000 + HOUR_US);
    const before = await behind();
    await door.sync();
    assert.deepEqual(await landed(), ['p1', 'p2', 'p3'], 'the peer rows this instance did not hold did not land: the pull stayed behind the stale mark');
    assert.equal((await door.coll(S, 'facts').findOne({ _id: 'p1' })).pos, HELD_POS, 'the held copy was rewritten (it takes the position it already had)');
    assert.equal(await behind() - before, 1, 'the trip was not counted exactly once');
    assert.equal(door.member().consecutiveFailures ?? 0, 0, 'a peer whose positions went backwards was counted as a failed member');
    const mark = door.member().lastPosReceived?.[S];
    assert.ok(Number.isSafeInteger(mark) && mark < Date.now() * 1000 + HOUR_US, `the mark ${String(mark)} is still above the peer's head`);
  });

  it('control: a mark at or below the head is an ordinary pull (nothing forgotten, nothing counted)', async () => {
    await state(0);
    const before = await behind();
    await door.sync();
    assert.deepEqual(await landed(), ['p1', 'p2', 'p3']);
    assert.equal(await behind() - before, 0, 'an ordinary pull was counted as a peer whose positions went backwards');
    assert.equal(door.member().consecutiveFailures ?? 0, 0);
  });
});
