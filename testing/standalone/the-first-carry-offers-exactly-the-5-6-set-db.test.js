/**
 * The first 6.0 start carries 5.6's marks by identity, and the first pull and push after it offer EXACTLY the set 5.6 would have
 * offered above those marks (bundle-81 test 8; design rev 8 section 3 "First carry" and section 3a, vet decisions 1, 7, 9).
 *
 * ## The claim, and why every row of it is a way to get it wrong
 *
 * Positions take over from seqs without a re-read. A legacy row's position is its seq (`pos = posAtSeq = seq`, the identity band, which
 * lies below every clock value); every mark is carried to its new name unchanged (`lastSeqPushed` to `lastPosPushed`, `lastSeqReceived`
 * to `lastPosReceived`, `lastSeqServed` to `lastPosServed`; the 5.x keys stay, frozen, for a rollback). So at every holder the set
 * `{pos <= m}` equals 5.6's `{seq <= m}`, ties included, and the first 6.0 cycle offers what 5.6's next cycle would have, no more
 * and no less. A carry that re-offered everything is Q-278's cure worse than the disease (resurrected deletions); one that skipped
 * above the mark is a silent loss.
 *
 * ## What it holds, from a 5.6-shaped database
 *
 * Rows with a seq and no `pos`, a counter doc with neither marker field, a member with `lastSeq*` marks and no `lastPos*`, no
 * `positionsSince`: what 5.6 leaves. Then the first start's detector pass and one tick of the owed job, then ONE real sync cycle with the
 * fake peer (the real engine, the real family handler over the peer's own storage, `_pull-door.mjs`):
 *
 * - every row, tombstones included, has `pos = posAtSeq = seq`; the space is ready, not owing; `positionsSince` is written;
 * - the three marks are carried as numbers, identity by identity, and the frozen 5.x keys are exactly as 5.6 left them;
 * - **push:** the records the cycle sends are EXACTLY the ones authored here above the mark: nothing at or below it, ties at the mark
 *   included (three rows share the mark's seq), no relayed row (a peer's delivery is not "written here"), and a record written after the
 *   carry is sent (the positive control, identified by id);
 * - **no resurrection:** a record that was deleted and whose tombstone was pruned is not re-sent (nothing of it exists to send), and a
 *   pre-6.0 tombstone carries NO `issuedHere` (nothing stored before 6.0 proves who issued it) and is therefore not pushed on this mesh;
 * - **pull:** the request asks `afterPos` = the carried mark, and the rows that land are exactly the peer's rows above it, ties at the mark
 *   excluded;
 * - the scanner's cursor is carried to the new field: the position it reads after is the seq it had stopped at.
 *
 * What triggers the carry is not named by the plan; `_b81d-owed-driver.mjs` is the one place that assumes it. The plan's `cursorPos :=
 * cursorSeq` meets today's `cursorPos`, an object `{seq, id}`: the scanner assertion accepts a number or that object's `seq`.
 *
 * Run: node --test testing/standalone/the-first-carry-offers-exactly-the-5-6-set-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { owedDriver, CLOCK_BAND } from './_b81d-owed-driver.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'b81carry';
const PUSHED = 30; const RECEIVED = 25; const SERVED = 20;
const SENTINEL = 99_999_999;

describe('the first carry offers exactly the 5.6 set', { skip }, () => {
  let door; let owed; let SELF; let ME;
  before(async () => {
    door = await openPullDoor({ suite: 'b81tD_carry', spaces: [S], type: 'closed', direction: 'both' });
    owed = await owedDriver();
    SELF = door.instanceId; ME = { instanceId: SELF, instanceLabel: 'self' };
  });
  after(async () => { await door?.close(); });

  const mine = (id, seq) => build.fact(S, id, seq, { author: { ...ME } });
  const relayed = (id, seq) => build.fact(S, id, seq, { author: { ...PEER_AUTHOR }, deliveredBy: PEER });
  const counters = () => door.mongo.col('ythril_counters');

  /** What 5.6 leaves: no `pos`, no `writtenHere`, a counter doc with only `seq`, `lastSeq*` marks, no `lastPos*`, no `positionsSince`. */
  async function fiveSixState() {
    await door.reset();
    delete door.config().positionsSince;
    const m = door.member();
    for (const k of ['lastPosPushed', 'lastPosReceived', 'lastPosServed']) delete m[k];
    m.lastSeqPushed = { [S]: PUSHED }; m.lastSeqReceived = { [S]: RECEIVED }; m.lastSeqServed = { [S]: SERVED };
    await door.coll(S, 'facts').insertMany([
      mine('a10', 10), mine('a20', 20), mine('t1', PUSHED), mine('t2', PUSHED), mine('t3', PUSHED), mine('a40', 40), mine('a50', 50),
      relayed('r15', 15), relayed('r45', 45),
    ]);
    // A deletion this instance issued before 6.0 (no `issuedHere` could have been stamped), above the pushed mark.
    await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'gone', 'facts', 35, { instanceId: SELF }));
    await counters().replaceOne({ _id: S }, { _id: S, seq: 60 }, { upsert: true });
    await door.mongo.col('ythril_dupe_scan_state').replaceOne({ _id: 'b81-scan' }, { _id: 'b81-scan', cursorSeq: 40 }, { upsert: true });
    // The peer's side: rows in ITS legacy band (pos = seq), ready, with a tie at the received mark. The real handler serves them.
    const peer = (id, seq) => ({ ...build.fact(S, id, seq, { author: { ...PEER_AUTHOR } }), pos: seq, posAtSeq: seq });
    await door.seedPeerRecords(S, 'facts', [peer('p5', 5), peer('p25a', RECEIVED), peer('p25b', RECEIVED), peer('p26', 26), peer('p40', 40)]);
    await counters().updateOne({ _id: door.peerSide(S) }, { $set: { seqSeenBy6: 40, positionsReadyAt: '2026-10-01T00:00:00.000Z' }, $unset: { positionsOwed: '' } });
    door.state.family = door.serveFamily;
  }

  it('carries every row to pos = posAtSeq = seq, every mark by identity, and the scanner cursor; the space ends ready', async () => {
    await fiveSixState();
    await owed.detectReupgrade();
    await owed.tick();
    for (const part of ['facts', 'tombstones']) {
      for (const row of await door.coll(S, part).find({}).toArray()) {
        assert.equal(row.pos, row.seq, `${part} ${row._id}: pos ${row.pos}, seq ${row.seq}: the identity band was not carried`);
        assert.equal(row.posAtSeq, row.seq, `${part} ${row._id}: posAtSeq ${row.posAtSeq} does not name the seq ${row.seq}`);
        assert.ok(row.pos < CLOCK_BAND, `${part} ${row._id}: a legacy row took a clock position`);
      }
    }
    const written = Object.fromEntries((await door.coll(S, 'facts').find({}).toArray()).map(r => [r._id, r.writtenHere]));
    for (const id of ['a10', 'a20', 't1', 't2', 't3', 'a40', 'a50']) assert.equal(written[id], true, `${id}: authored here and delivered by nobody, so written here`);
    for (const id of ['r15', 'r45']) assert.equal(written[id], false, `${id}: delivered by a peer, so not written here whatever its author says`);
    const counter = await counters().findOne({ _id: S });
    assert.ok(counter.positionsReadyAt && counter.positionsOwed === undefined, `the space is not ready after its carry: ${JSON.stringify(counter)}`);
    assert.ok(door.config().positionsSince, 'positionsSince was not written by the first carry');
    const m = door.member();
    assert.deepEqual([m.lastPosPushed?.[S], m.lastPosReceived?.[S], m.lastPosServed?.[S]], [PUSHED, RECEIVED, SERVED], 'the marks were not carried by identity');
    assert.deepEqual([m.lastSeqPushed[S], m.lastSeqReceived[S], m.lastSeqServed[S]], [PUSHED, RECEIVED, SERVED], 'the frozen 5.x marks moved: a rollback could not find them');
    const scan = await door.mongo.col('ythril_dupe_scan_state').findOne({ _id: 'b81-scan' });
    const at = typeof scan.cursorPos === 'number' ? scan.cursorPos : scan.cursorPos?.seq;
    assert.equal(at, 40, `the scanner cursor was not carried: ${JSON.stringify(scan)}`);
  });

  it('the first cycle pushes exactly what 5.6 would have above the mark, and pulls exactly the peer rows above its mark', async () => {
    await fiveSixState();
    await owed.detectReupgrade();
    await owed.tick();
    // The positive control: a record written after the carry, at a clock position, authored here.
    await door.coll(S, 'facts').insertOne({ ...mine('post', 61), pos: CLOCK_BAND + 1, posAtSeq: 61, writtenHere: true });
    await door.raiseVersionTo(S, 61);
    await door.sync();
    const sent = door.state.pushedRecords.filter(d => d.key === 'facts').map(d => d._id).sort();
    assert.deepEqual(sent, ['a40', 'a50', 'post'], 'the push offered other than what 5.6 offers above the mark (ties at it included) plus the record written after the carry');
    assert.ok(!door.state.received.some(t => t._id === 'gone'), 'a pre-6.0 tombstone was pushed on the mesh as this instance\'s own, though nothing proves it issued it');
    assert.ok(!door.state.received.some(t => t._id === 'pruned') && !door.state.pushedRecords.some(d => d._id === 'pruned'), 'a deleted record whose tombstone was pruned was sent again');
    assert.equal(await door.coll(S, 'tombstones').countDocuments({ _id: 'gone', issuedHere: { $exists: true } }), 0, 'a pre-6.0 tombstone carries issuedHere');
    const asked = door.state.familyRequests.filter(r => r.family === 'facts');
    assert.ok(asked.length >= 1, 'the cycle never asked the peer for facts');
    assert.equal(Number(asked[0].afterPos), RECEIVED, `the first pull asked for afterPos ${asked[0].afterPos}, not the carried mark ${RECEIVED}`);
    assert.equal(asked[0].sinceSeq, undefined, 'the first pull still pages by sinceSeq');
    const landed = (await door.coll(S, 'facts').find({ 'author.instanceId': PEER }).toArray()).map(r => r._id).filter(id => id.startsWith('p')).sort();
    assert.deepEqual(landed, ['p26', 'p40'], 'the pull landed other than the peer rows above the mark (nothing at or below it, the tie at the mark included)');
  });
});
