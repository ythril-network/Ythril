/**
 * The tombstones of a case-only rename are published once the move's RECORDS have been carried — never by a settle that reads the
 * disk's answer for the old spelling (bundle-44, D-29, Q-437; rulings 40 and 41). This case runs on every file system, the Linux CI runner
 * included.
 *
 * ## The rule
 *
 * On a case-insensitive file system `a.txt` and `A.txt` are one directory entry, so "do bytes answer at the old spelling" says yes whether the
 * rename happened or not. The settle (the act's own, and the stale sweep's) read that as "the act did not remove the path" for a rename that
 * had happened (so a peer kept `a.txt` beside `A.txt`), and as "the act removed it" for any alias (so a peer deleted a live file when the rename
 * failed). For a pair that IS one entry under two spellings the settle asks what the entry is CALLED and, once it has the new name, the MOVE:
 *
 *  - still the old spelling: the rename did not happen, the path is still here, the tombstone is dropped and the move is not owed;
 *  - the new spelling, and something of the file (a live record, a link row, a job) is still at the old id: the records have not been carried, so
 *    nothing is published and nothing is dropped; the move is owed and the next run of it, or housekeeping, finishes it and publishes;
 *  - the new spelling, and nothing of the file is at the old id: the records left, so the old ids are published.
 *
 * What the entry is called is the disk's to say, and a case-sensitive runner cannot say it, so this file answers it through the seam
 * (`setPairReaderForTest`, `files/move-marker-reads.ts`) and holds what the settle DOES with the answer. Without the call, a settle of a pair whose
 * old spelling still answers drops the tombstone (the generic rule: the path still has bytes), which is the first assertion below failing. The cases
 * that read a real entry off NTFS are `a-case-only-rename-is-owed-until-its-records-carry-db`.
 *
 * Run: node --test testing/standalone/a-case-only-settle-is-decided-by-the-move-not-the-disk-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'caseonlysettle';
const T0 = '2026-09-01T00:00:00.000Z';
const DAY = 24 * 3_600_000;
const FROM = 'case.txt';
const TO = 'Case.txt';
const SIDECAR = '_converted/case.txt.md';

let acts, reads, tombstones;
const files = () => acts.door.coll(S, 'files');
const record = (id) => ({ _id: id, spaceId: S, path: id, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0 });
const pendingPaths = async () => (await acts.raw()).filter(r => r.pending).map(r => r.path).sort();
const publishedPaths = async () => (await acts.raw()).filter(r => !r.pending).map(r => r.path).sort();
const both = [SIDECAR, FROM].sort();

/**
 * What a case-only rename that has begun leaves, made by hand: the bytes and a sidecar answering at the OLD spelling (which, on a
 * case-insensitive disk, is what they do whether or not the rename happened), and the marker's pending tombstones for both ids.
 */
async function aCaseOnlyMoveBegun({ recordsAt }) {
  await acts.files.writeFile(S, FROM, 'content');
  await acts.files.writeFile(S, SIDECAR, '# converted');
  await files().insertOne(record(recordsAt));
  const identity = await reads.bytesIdentityAt(S, FROM);
  await tombstones.writePendingFileTombstones(S, [FROM, SIDECAR], { from: FROM, to: TO, ...identity });
}

describe('the settle of a case-only rename asks the move, not the disk (real MongoDB, every file system)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'caseonlysettle', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    reads = await import('../../server/dist/files/move-marker-reads.js');
    assert.equal(typeof reads.setPairReaderForTest, 'function', 'files/move-marker-reads.ts exports no setPairReaderForTest: the settle\'s question has no seam');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
  });
  afterEach(() => { reads?.setPairReaderForTest(null); });

  it('one entry that has the NEW spelling, records NOT carried: nothing is published and nothing is dropped, by the act\'s settle and by the stale sweep', async () => {
    reads.setPairReaderForTest(async () => 'one-entry-new-spelling');
    await aCaseOnlyMoveBegun({ recordsAt: FROM });

    await tombstones.settleBegunMove(S, FROM, TO);
    assert.deepEqual(await pendingPaths(), both, 'a pending tombstone of a move whose records are still at the old id was published or dropped by the disk\'s answer');
    assert.deepEqual(await publishedPaths(), [], 'a tombstone for a file that is still live here was published: a peer would delete it');

    await tombstones.settleStalePendingFileTombstones(S, new Date(Date.now() + DAY));
    assert.deepEqual(await pendingPaths(), both, 'the stale sweep published or dropped what the move still owes');
    assert.deepEqual(await publishedPaths(), []);
    assert.deepEqual(await acts.published(), { served: [], pushed: [] }, 'a peer learned of the old ids before the records left them');
    assert.equal((await files().findOne({ _id: FROM }))?._id, FROM, 'the record at the old id was touched');
  });

  it('one entry with the NEW spelling, records CARRIED: both old ids are published', async () => {
    reads.setPairReaderForTest(async () => 'one-entry-new-spelling');
    await aCaseOnlyMoveBegun({ recordsAt: TO });

    await tombstones.settleBegunMove(S, FROM, TO);

    assert.deepEqual(await publishedPaths(), both, 'the old ids were not published although the move\'s records are at the new one');
    assert.deepEqual(await pendingPaths(), []);
    assert.deepEqual(await acts.published(), { served: both, pushed: both }, 'a peer is not told the old ids are gone');
  });

  it('one entry that still has the OLD spelling (the rename did not happen): the tombstones are dropped, nothing is published, and the move is not owed', async () => {
    reads.setPairReaderForTest(async () => 'one-entry-old-spelling');
    await aCaseOnlyMoveBegun({ recordsAt: FROM });

    await tombstones.settleBegunMove(S, FROM, TO);

    assert.deepEqual(await pendingPaths(), [], 'a tombstone of a rename that did not happen was kept');
    assert.deepEqual(await publishedPaths(), [], 'a tombstone was published for a file that was never renamed: a peer would delete it');
  });

  it('two entries (a case-sensitive file system, a different file): the disk decides as it always did, so a path that still has bytes is dropped', async () => {
    reads.setPairReaderForTest(async () => 'apart');
    await aCaseOnlyMoveBegun({ recordsAt: FROM });

    await tombstones.settleBegunMove(S, FROM, TO);

    assert.deepEqual(await pendingPaths(), [], 'a pending tombstone of paths that still have bytes was kept');
    assert.deepEqual(await publishedPaths(), [], 'a tombstone was published for a path that still has its bytes');
  });

  it('a move to ANOTHER name never asks what the entry is called: the reader is not consulted', async () => {
    let asked = 0;
    reads.setPairReaderForTest(async () => { asked++; return 'one-entry-new-spelling'; });
    await acts.files.writeFile(S, 'one.txt', 'content');
    await files().insertOne(record('one.txt'));
    await tombstones.writePendingFileTombstones(S, ['one.txt'], { from: 'one.txt', to: 'two.txt' });

    await tombstones.settleBegunMove(S, 'one.txt', 'two.txt');

    assert.equal(asked, 0, 'a move between two different names was judged as a possible rename of one entry');
    assert.deepEqual(await pendingPaths(), [], 'the path still has its bytes, so the act did not remove it: its tombstone is dropped');
  });
});
