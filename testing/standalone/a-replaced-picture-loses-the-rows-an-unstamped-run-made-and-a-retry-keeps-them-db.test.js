/**
 * A picture written with OTHER bytes loses the derived rows that carry no `sourceSha256`, in the write that records the new bytes; a
 * same-bytes write and a retry keep them (bundle-236, Q-698, pre-ship residual 1).
 *
 * ## The defect that bought it
 *
 * Rows made before the stamp existed carry no `sourceSha256`, and the run's own clear (`clearRowsOfOtherBytes`) counts such a row as the
 * same bytes as any run. After the upgrade a picture replaced by other bytes therefore kept its caption and its surplus face rows for good.
 * The write door removes them: `replaceContent`, for NEW bytes of a media file with a hash known, after the write that revoked the old run's
 * claim. It is safe by construction (the old run's writes are fenced, every row the new run writes is stamped), and it must NOT run on a
 * same-bytes write or a retry, where an unstamped row may hold a person's face label.
 *
 * ## The rules
 *
 *  1. New bytes onto a finished picture: its unstamped caption and face rows are gone when the write returns.
 *  2. Same bytes again onto a failed job (the write the dispatcher does not skip): the unstamped rows are kept.
 *  3. A manual retry: the unstamped rows are kept.
 *  4. `retryFailedJobs` resets every failed job when there are more than one page of them (the ids are read a page at a time).
 *
 * ## Seen red
 *
 * On d010ec3da case 1 fails (the rows are still stored after the write) and case 4 is green (it states what the paging must keep holding);
 * cases 2 and 3 are green and guard the fix from deleting too much.
 *
 * Run: node --test testing/standalone/a-replaced-picture-loses-the-rows-an-unstamped-run-made-and-a-retry-keeps-them-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openReplacedBytesDoor } from './_replaced-bytes-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'unstampedrows';
const FILE = 'photo.png';
const BYTES = (n) => `the bytes of version ${n} of the picture`;

let d;

/** A first version written and its run ended, with the rows an earlier release left under it (no stamp, one carrying a person's label). */
async function finishedWithLegacyRows(status = 'complete') {
  await d.put(FILE, BYTES(1));
  await d.settle(FILE, status);
  const ids = await d.seedDerived(FILE);
  await d.files().updateOne({ _id: ids[1] }, { $set: { faceEntityId: 'person-1' } });
  assert.deepEqual(await d.derivedIds(FILE), [...ids].sort(), 'fixture check');
  return ids;
}

describe('a replaced picture loses its unstamped rows; a same-bytes write and a retry keep them (real MongoDB)', { skip }, () => {
  before(async () => { d = await openReplacedBytesDoor({ suite: 'unstampedrows', space: SPACE }); });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); });

  it('new bytes: the unstamped caption and face rows are gone right after the write', async () => {
    await finishedWithLegacyRows();
    await d.put(FILE, BYTES(2));
    assert.deepEqual(await d.derivedIds(FILE), [],
      'the rows of the replaced picture are still stored: the run over the new bytes counts a row with no stamp as its own, so they stay for good');
  });

  it('new bytes: a row the old bytes made WITH a stamp is left to the new run\'s clear (the door removes only what that clear cannot judge)', async () => {
    await d.put(FILE, BYTES(1));
    await d.settle(FILE, 'complete');
    const [caption] = await d.seedDerived(FILE, { sourceSha256: 'o'.repeat(64) });
    await d.put(FILE, BYTES(2));
    assert.ok(await d.files().findOne({ _id: caption }), 'the door removed a stamped row, which the run\'s own clear (under its claim) is for');
  });

  it('the same bytes written again onto a failed job: the unstamped rows are kept', async () => {
    const ids = await finishedWithLegacyRows('failed');
    await d.put(FILE, BYTES(1));
    assert.equal((await d.jobs().findOne({ _id: FILE })).status, 'pending', 'fixture check: the write reset the failed job');
    assert.deepEqual(await d.derivedIds(FILE), [...ids].sort(), 'a same-bytes write removed rows that may hold a person\'s label');
  });

  it('a manual retry keeps the unstamped rows', async () => {
    const ids = await finishedWithLegacyRows('failed');
    assert.equal(await d.queue.retryJob(SPACE, FILE), 'ok');
    assert.deepEqual(await d.derivedIds(FILE), [...ids].sort(), 'a retry removed rows that may hold a person\'s label');
  });

  it('retryFailedJobs resets every failed job when they are more than one page', async () => {
    const T0 = '2026-09-01T00:00:00.000Z';
    const n = 1_105;
    await d.jobs().insertMany(Array.from({ length: n }, (_, i) => ({
      _id: `bulk/${String(i).padStart(5, '0')}.png`, spaceId: SPACE, filePath: `bulk/${String(i).padStart(5, '0')}.png`, mimeType: 'image/png',
      mediaType: 'image', status: 'failed', attempts: 3, maxAttempts: 3, lastError: 'gave up', claimedAt: null, claimableAfter: null, createdAt: T0, updatedAt: T0,
    })));
    assert.equal(await d.queue.retryFailedJobs(SPACE), n);
    assert.equal(await d.jobs().countDocuments({ status: 'failed' }), 0, 'a failed job was left behind by the paged walk');
    assert.equal(await d.jobs().countDocuments({ status: 'pending' }), n);
  });
});
