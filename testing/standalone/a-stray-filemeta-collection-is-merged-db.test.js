/**
 * File metadata a 4.0-5.6.1 pull stored in `<space>_filemeta` is merged into `<space>_files` and the stray collection
 * is dropped — `Q-219`.
 *
 * ## The defect it repairs
 *
 * From P-32 (4.0) to 5.6.1 the pull wrote a peer's file metadata to `${spaceId}_${payloadKey}`, and the payload key
 * of that family is `filemeta`, not `files`. Nothing reads that collection, and the receive watermark had passed the
 * records, so they were never pulled again: a publisher's descriptions and tags never reached its subscribers' files.
 * Live instances hold such collections (counted 2026-10-02), so the rows are recovered rather than discarded.
 *
 * ## The rule, row by row
 *
 *  - a stray record NEWER than the stored file record is merged: its authored keys land, and the receiver's own
 *    size and hash stand, because they describe the bytes this instance holds;
 *  - a stray record OLDER than the stored one changes nothing (the seq-guarded accept every arrival takes);
 *  - a stray record with no stored file record is NOT stored: a stray record is old, and a file whose record is gone
 *    was usually deleted since, so storing it would bring back a deleted file as a row with no bytes;
 *  - a chunk is never stored as a file;
 *  - the stray collection is gone afterwards, and a second cycle is a no-op.
 *
 * Driven through the TTL sweep cycle (`sweepExpired`), the call site that runs it, so a drain nothing calls fails.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stray-filemeta-collection-is-merged-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();
const SPACE = 'stray-fm';
const PEER = { instanceId: 'stray-peer', instanceLabel: 'Peer' };

let door, sweepExpired;

const stored = (id) => door.coll(SPACE, 'files').findOne({ _id: id });
const strayExists = async () =>
  (await door.mongo.getDb().listCollections({ name: `${SPACE}_filemeta` }).toArray()).length > 0;

describe('file metadata a 4.0-5.6.1 pull left in <space>_filemeta is merged into the space files', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'strayfm', spaces: [{ id: SPACE, label: 'Stray', folders: [] }] });
    ({ sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js'));

    const files = door.coll(SPACE, 'files');
    const stray = door.coll(SPACE, 'filemeta');
    // The receiver's own copies, holding the bytes it has.
    await files.insertMany([
      { ...build.filemeta(SPACE, 'newer.md', 10, { author: PEER }), sizeBytes: 11, sha256: 'receiver-hash' },
      { ...build.filemeta(SPACE, 'older.md', 50, { author: PEER, description: 'the later edit' }), sizeBytes: 22, sha256: 'receiver-hash-2' },
    ]);
    // What the old pull stored: the sender's whole record, its size and hash included.
    await stray.insertMany([
      { ...build.filemeta(SPACE, 'newer.md', 20, { author: PEER, description: 'described upstream', tags: ['onboarding'] }),
        sizeBytes: 999, sha256: 'sender-hash' },
      { ...build.filemeta(SPACE, 'older.md', 40, { author: PEER, description: 'the earlier edit' }), sizeBytes: 999, sha256: 'sender-hash' },
      { ...build.filemeta(SPACE, 'deleted-since.md', 30, { author: PEER, description: 'a file deleted since' }) },
      { ...build.filemeta(SPACE, 'newer.md#chunk-0', 31, { author: PEER }), parentFileId: 'newer.md' },
    ]);
    assert.ok(await strayExists(), 'fixture: the stray collection exists before the cycle');
    await sweepExpired();
  });
  after(async () => { await door?.close(); });

  it('a newer stray record lands its authored keys, and the receiver keeps its own size and hash', async () => {
    const d = await stored('newer.md');
    assert.equal(d?.description, 'described upstream');
    assert.deepEqual(d?.tags, ['onboarding']);
    assert.equal(d?.seq, 20);
    assert.equal(d?.sizeBytes, 11, 'the sender\'s size describes bytes this instance may not hold');
    assert.equal(d?.sha256, 'receiver-hash');
  });

  it('an older stray record does not overwrite a later edit', async () => {
    const d = await stored('older.md');
    assert.equal(d?.description, 'the later edit');
    assert.equal(d?.seq, 50);
  });

  it('a stray record with no stored file does not bring the file back, and a chunk is not stored as a file', async () => {
    assert.equal(await stored('deleted-since.md'), null, 'a deleted file came back as a record with no bytes');
    assert.equal(await stored('newer.md#chunk-0'), null);
  });

  it('the stray collection is dropped, and the next cycle changes nothing', async () => {
    assert.equal(await strayExists(), false, 'the stray collection is still there');
    const before = await door.coll(SPACE, 'files').find({}).sort({ _id: 1 }).toArray();
    await sweepExpired();
    assert.deepEqual(await door.coll(SPACE, 'files').find({}).sort({ _id: 1 }).toArray(), before);
  });
});
