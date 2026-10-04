/**
 * The TTL sweep's settle reaches every stale pending file tombstone, however many it cannot look at (bundle-30 I16,
 * preship-4 P4-1).
 *
 * ## The defect
 *
 * The settle took up to its batch of stale pending tombstones per space per cycle, in NO order, and left pending —
 * where it found it — any whose path it could not look at. A batch's worth of those therefore came back first every
 * cycle and starved the rest of the space for ever: their tombstones stayed pending, and no peer was ever told of
 * files that are gone.
 *
 * ## The rule
 *
 * The settle takes the oldest first, and a tombstone whose path it cannot look at goes to the back: its staleness
 * clock restarts at the cycle that tried it, so it is tried again only once it is stale again, behind every tombstone
 * that went stale before. A batch of unresolvable paths delays the rest by one cycle, never for ever.
 *
 * ## How "cannot look" is reached
 *
 * `lstat` refuses every path under `locked/` with `EACCES` for the whole test — a permission refused, which is a
 * failure to look and not an answer.
 *
 * Run: node --test testing/standalone/the-file-tombstone-settle-reaches-every-stale-one-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'settleall';

let acts, tombstones;
const realLstat = fsp.lstat;
const looked = [];
const LOCKED = `${path.sep}locked${path.sep}`;

describe('the settle reaches every stale pending file tombstone', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'settleall', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    fsp.lstat = function (p, ...rest) {
      if (String(p).includes(LOCKED)) {
        looked.push(String(p));
        return Promise.reject(Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES', syscall: 'lstat' }));
      }
      return realLstat.call(fsp, p, ...rest);
    };
  });
  after(async () => {
    fsp.lstat = realLstat;
    await acts?.close();
  });

  it('a batch of paths it cannot look at delays the rest by one cycle, and is tried again once stale again', async () => {
    await acts.reset();
    // The batch as the code counts it — read from the module, not written here again.
    const batch = tombstones.FILE_TOMBSTONE_SETTLE_BATCH ?? 500;
    const now = Date.now();
    const at = (ms) => new Date(now + ms).toISOString();
    // A full batch it cannot look at, all older than the one it can: stored first, so an unordered read meets them first.
    await acts.door.coll(S, 'file_tombstones').insertMany(Array.from({ length: batch }, (_, i) => (
      { _id: `locked-${i}`, spaceId: S, path: `locked/${i}.txt`, deletedAt: at(-3_600_000 + i), pending: true })));
    await acts.door.coll(S, 'file_tombstones').insertOne({ _id: 'gone', spaceId: S, path: 'gone.txt', deletedAt: at(-1_800_000), pending: true });
    // Older than all of them and stored last: oldest first reaches it in the first cycle; stored order never does.
    await acts.door.coll(S, 'file_tombstones').insertOne({ _id: 'oldest', spaceId: S, path: 'oldest.txt', deletedAt: at(-7_200_000), pending: true });

    await tombstones.settleStalePendingFileTombstones(S, new Date(now));
    assert.deepEqual((await acts.served()).map(t => t.path), ['oldest.txt'],
      'the settle did not take the oldest first: the longest-waiting tombstone of a file that is gone waits behind newer ones');
    await tombstones.settleStalePendingFileTombstones(S, new Date(now + 60_000));
    assert.deepEqual(await acts.published(), { served: ['gone.txt', 'oldest.txt'], pushed: ['gone.txt', 'oldest.txt'] },
      'a batch of paths the settle cannot look at came back first every cycle, and the file that IS gone was never published');

    const pending = await acts.door.coll(S, 'file_tombstones').countDocuments({ pending: true });
    assert.equal(pending, batch, 'a tombstone the settle could not look at was dropped or published — it knows nothing about it');

    looked.length = 0;
    await tombstones.settleStalePendingFileTombstones(S, new Date(now + 24 * 3_600_000));
    assert.equal(new Set(looked).size, batch, 'once stale again, the paths it could not look at were not tried again');
    assert.equal(typeof tombstones.FILE_TOMBSTONE_SETTLE_BATCH, 'number', 'the settle\'s batch is not exported to size this case by');
  });
});
