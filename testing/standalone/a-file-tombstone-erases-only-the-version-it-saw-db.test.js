/**
 * A peer's file tombstone erases the VERSION of the file it saw, never a newer one (bundle-51 Q-242).
 *
 * ## The loop it ends
 *
 * A file tombstone carries `rowSeq`: the seq of the file row the deletion erased on the instance that issued it. The old
 * apply carried no version at all and deleted whatever lived at the path. The pull reads EVERY held tombstone every cycle (an
 * unfiltered read, so none is missed), so a file re-created at a deleted path was deleted again on the next cycle, downloaded
 * again by the next manifest pull, deleted again by the next tombstone read — for as long as the tombstone was held, with no
 * error anywhere. The version closes it: a row whose seq is ABOVE the tombstone's `rowSeq` is a re-creation, the tombstone is
 * about an older file, and the row and its bytes stay.
 *
 *  1. a row whose seq is above `rowSeq` is kept — bytes and row — and stays kept on every later cycle
 *  2. a row at the tombstone's `rowSeq`, or below it, is the version the deletion saw and goes
 *  3. a tombstone with no `rowSeq` (an older peer's) is today's behaviour: the file at the path goes
 *
 * Held on the push door and the pull door.
 *
 * Run: node --test testing/standalone/a-file-tombstone-erases-only-the-version-it-saw-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'ftver';
let door;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
async function seedFile(p, seq) {
  door.writeLocalFile(S, p, `bytes of ${p}`);
  await door.coll(S, 'files').insertOne(build.filemeta(S, p, seq, { author: PEER_AUTHOR, sizeBytes: 11 }));
}
const tomb = (p, extra = {}) => ({ _id: `ft-${p}`, spaceId: S, path: p, deletedAt: '2026-09-01T00:00:05.000Z', issuer: PEER, ...extra });

const DOORS = {
  push: {
    async deliver(tombstones) { return door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) }); },
    async again() { return door.push('/file-tombstones', { spaceId: S, tombstones: this.last }, { spaceId: S, token: peerToken(PEER) }); },
  },
  pull: {
    async deliver(tombstones) {
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: t.deletedAt })));
      return door.sync();
    },
    async again() { return door.sync(); },
  },
};

describe('a peer file tombstone erases only the version it saw', { skip }, () => {
  before(async () => { door = await openPullDoor({ suite: 'ftversion', spaces: [S], files: true }); });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(`${name} door`, () => {
      it('the version cut: above rowSeq is kept, at it and below it go — every offset around the boundary', async () => {
        const rowSeq = 10;
        const cases = [[-5, true], [-1, true], [0, true], [1, false], [5, false]];
        for (const [off] of cases) await seedFile(`v${off}.txt`, rowSeq + off);
        d.last = cases.map(([off]) => tomb(`v${off}.txt`, { rowSeq }));
        await d.deliver(d.last);
        const wrong = [];
        for (const [off, goes] of cases) {
          const gone = (await row(`v${off}.txt`)) === null, bytesGone = !door.localFileExists(S, `v${off}.txt`);
          if (gone !== goes || bytesGone !== goes) {
            wrong.push(`row seq ${rowSeq + off}: row ${gone ? 'gone' : 'kept'}, bytes ${bytesGone ? 'gone' : 'kept'}; want ${goes ? 'gone' : 'kept'}`);
          }
        }
        assert.deepEqual(wrong, [], 'a deletion erased a version it never saw, or kept the version it saw');
      });

      it('a re-created file stays on every later cycle (the delete / re-download loop)', async () => {
        await seedFile('loop.txt', 9);
        d.last = [tomb('loop.txt', { rowSeq: 5 })];
        for (let cycle = 1; cycle <= 3; cycle++) {
          if (cycle === 1) await d.deliver(d.last); else await d.again();
          assert.ok(await row('loop.txt'), `cycle ${cycle}: the re-created file's row was deleted by a tombstone for an older version`);
          assert.ok(door.localFileExists(S, 'loop.txt'), `cycle ${cycle}: the re-created file's bytes were deleted`);
        }
      });

      it('a tombstone with no rowSeq (an older peer\'s) deletes the file at the path, as before', async () => {
        await seedFile('legacy.txt', 500);
        await d.deliver([tomb('legacy.txt')]);
        assert.equal(await row('legacy.txt'), null);
        assert.ok(!door.localFileExists(S, 'legacy.txt'));
      });
    });
  }
});
