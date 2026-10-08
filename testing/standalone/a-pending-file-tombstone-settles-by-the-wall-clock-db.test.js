/**
 * A pending file tombstone is a TIMER, and a timer is read against the wall clock (bundle-71 lens fix).
 *
 * ## The defect it prevents
 *
 * A pending tombstone carries `settleAt`, the instant the TTL settle compares with `now - STALE_AFTER_MS` to decide the row has
 * outlived its act. It was stamped from the space's POSITION clock (`tick`), which never goes backwards and is seeded from the
 * highest position stored. A clock seeded from a position above the wall clock (a stored position from a wall clock that has
 * since stepped back, or one that stepped forward once) stamped every new pending row in the future, so the settle did not
 * select it until wall time caught up: the deletion of a file that is gone was not published to peers for as long as the clock
 * was ahead.
 *
 * ## The rule
 *
 * `settleAt` is what the settle selects by, so it is the WALL clock at the write. `writtenAt` stays on the position clock: it is
 * never compared with the wall, only with positions (`covers`), and the one-per-path rule needs its stamps to order.
 *
 * ## How the case is reached
 *
 * A published tombstone whose position is a day ahead of the wall is stored BEFORE the space's clock is first read, so the clock
 * seeds from it. A pending row is then written by the module (`writePendingFileTombstones`) for a path with no bytes, and the settle
 * runs at a wall instant past the stale age.
 *
 * Run: node --test testing/standalone/a-pending-file-tombstone-settles-by-the-wall-clock-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'settlewall';
const DAY_MS = 24 * 3_600_000;

let acts, tombstones;

describe('a pending file tombstone is settled by the wall clock', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'settlewall', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
  });
  after(async () => { await acts?.close(); });

  it('a row written while the position clock is ahead of the wall is settled once it is stale by the wall', async () => {
    await acts.reset();
    const ahead = new Date(Date.now() + DAY_MS).toISOString();
    // A position above the wall, stored before the space's clock is first read: the clock seeds from it.
    await acts.door.coll(S, 'file_tombstones').insertOne({
      _id: 'ahead', spaceId: S, path: 'ahead.txt', deletedAt: ahead, positionAt: ahead, origin: 'own' });

    const { docs } = await tombstones.writePendingFileTombstones(S, ['gone.txt']);
    assert.equal(docs.length, 1, 'the pending row was not written — the case is not reached');
    assert.ok(docs[0].writtenAt > new Date(Date.now() + DAY_MS / 2).toISOString(),
      'the position clock was not ahead of the wall when the row was written — the case is not reached');

    const settled = await tombstones.settleStalePendingFileTombstones(S, new Date(Date.now() + 11 * 60_000));
    assert.equal(settled.confirmed, 1,
      'a pending tombstone written while the position clock was ahead was not settled: its settle instant is not the wall clock\'s');
    assert.ok((await acts.served()).some(t => t.path === 'gone.txt'), 'the settled tombstone was not published to peers');
  });
});
