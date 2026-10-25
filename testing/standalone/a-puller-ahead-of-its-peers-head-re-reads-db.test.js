/**
 * A puller whose mark for a member is ABOVE that member's `head` forgets the mark and reads the member again, skipping what it holds by version
 * (bundle-81, design rev 8 §4 "The head guard stays as the detector for the one residual", the parent's decision 53).
 *
 * ## The defect it guards
 *
 * Every page a 6.0 peer answers says `head` — its settled cap less one, the highest position it can have handed out and settled. A peer whose
 * database was restored with the wall clock set back across a start that also lost its stored maximum numbers its NEW records below the marks its
 * pullers hold, so a puller that trusted its mark would never ask for them. The guard is the one detector: a first request from a mark above the
 * peer's `head` means the peer's positions went backwards. Nothing else can say it (a mark is a bare number).
 *
 * ## The rule
 *
 * 1. The puller forgets the mark for that member, space and network and reads the member from 0 (a capped read, like the D-20 re-read: nothing is
 *    a member failure for it).
 * 2. What it already holds is skipped by version (an equal copy is `skipped`, never a fork or a second write); what it lacks is pulled.
 * 3. The event is counted `ythril_sync_position_behind_total{network}`, once per forgotten mark.
 * 4. The mark after the cycle is the peer's own (`through` of the re-read), at or below the peer's head: never the stale number above it.
 * 5. **Positive control:** a mark at or below the head is not forgotten, and nothing is counted.
 *
 * The peer is the shared fake (`_pull-door.mjs`) with the real page handlers over its own storage, so `head` is the one the code under test serves.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-puller-ahead-of-its-peers-head-re-reads-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { clearPositionMarks, readMark, setMark, positioned } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'headguard';
/** A position far above anything a peer settled by now: a mark a restore with the clock set back leaves behind. */
const AHEAD = Date.now() * 1000 + 3_600_000_000;

let door, engine, behindTotal;

const behindCount = async () => {
  const { values } = await behindTotal.get();
  return values.filter(v => v.labels.network === door.NET).reduce((n, v) => n + v.value, 0);
};
const held = (id) => door.coll(S, 'facts').findOne({ _id: id });
const peerHead = async () => {
  const page = await door.pull('/facts', { spaceId: door.peerSide(S), afterPos: '0', limit: '1' });
  return page.head ?? page.body?.head;
};

describe('a puller ahead of its peer\'s head re-reads', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b81_headguard', spaces: [S], direction: 'pull' });
    engine = await import('../../server/dist/sync/engine.js');
    ({ syncPositionBehindTotal: behindTotal } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'pull' });
    clearPositionMarks(door);
    door.member().consecutiveFailures = 0;
    door.state.family = door.serveFamily;
    // The peer holds three facts (carried positions, the legacy band); this instance already holds the first, at its version.
    const mk = (n) => positioned(build.fact(S, `hg-${n}`, 10 + n, { author: PEER_AUTHOR }));
    await door.seedPeerRecords(S, 'facts', [mk(1), mk(2), mk(3)]);
    await door.coll(S, 'facts').insertOne({ ...mk(1) });
    await door.raiseVersionTo(S, 11);
  });

  const cycle = async () => { await engine.runSyncForNetwork(door.NET); await door.settled(); };

  it('control: a mark below the peer\'s head is kept, nothing is counted, and the missing records are pulled from it', async () => {
    const before = await behindCount();
    setMark(door, 'received', S, 11);
    await cycle();
    assert.equal(await behindCount() - before, 0, 'a mark below the head was counted as the peer going backwards');
    assert.ok(await held('hg-2') && await held('hg-3'), 'control: the records above the mark were not pulled');
    assert.ok(readMark(door, 'received', S) >= 11, 'control: the mark went backwards');
  });

  it('a mark above the head is forgotten and counted once, the member is read from 0, and what is held is skipped by version', async () => {
    const before = await behindCount();
    const head = await peerHead();
    assert.ok(Number.isSafeInteger(head) && head < AHEAD, `fixture: the peer's head ${String(head)} is not below the stale mark ${AHEAD}`);
    const mine = await held('hg-1');
    setMark(door, 'received', S, AHEAD);

    await cycle();

    assert.equal(await behindCount() - before, 1, 'the forgotten mark was not counted ythril_sync_position_behind_total{network} exactly once');
    assert.ok(await held('hg-2') && await held('hg-3'), 'the records the peer holds below the stale mark were never pulled: the puller trusted a mark above the peer\'s head');
    assert.deepEqual(await held('hg-1'), mine, 'a record already held at the same version was written again by the re-read');
    const mark = readMark(door, 'received', S);
    // The head is the peer's settled cap less one and the cap follows its clock, so it only ever moves up: the mark is held to the head read AFTER the
    // cycle (the one before it is lower by the time the cycle took, which a page's own `through` legitimately exceeds).
    const headAfter = await peerHead();
    assert.ok(Number.isSafeInteger(mark) && mark <= headAfter, `the mark after the re-read is ${String(mark)}, above the peer's head ${headAfter}: the stale number stands`);
    assert.equal(door.member().consecutiveFailures ?? 0, 0, 'a re-read was counted as a failed member');
  });

  it('a second cycle from the peer\'s own mark forgets nothing', async () => {
    setMark(door, 'received', S, AHEAD);
    await cycle();
    const counted = await behindCount();
    await cycle();
    assert.equal(await behindCount(), counted, 'the next cycle counted the peer going backwards again: the mark was not replaced by the peer\'s own');
  });
});
