/**
 * Bytes that ARRIVE from a peer — by this instance's pull, or by the peer's push to the upload door — make the file
 * live here and give a record new here this instance's retention (`Q-239`, from the pre-ship sweep).
 *
 * `recordArrivedFile` is the one writer both doors use. The push used to go through the upload writer
 * (`upsertFileMeta`), which did two things the arrival writer did not:
 *
 *  - it cleared `deletedAt`, so a path soft-deleted here and re-created by the publisher came back. Without it the
 *    record keeps the mark, and the listing hides a file whose bytes are on disk — the pull has had this gap since
 *    `Q-143`;
 *  - it stamped a new record's `_expireAt` from this instance's file retention window. Without it a file the space
 *    should expire never does.
 *
 * And it must still never re-slide an expiry already stored: arriving bytes are not an authored write.
 *
 * "Arrive" means LAND. Bytes a held file tombstone erased (the same hash, no newer live row) are shadowed at the upload door
 * and never reach `recordArrivedFile`: the path stays deleted, and the row's `deletedAt` stays set (bundle-51 Q-229).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-arrived-file-is-live-and-takes-this-instances-retention-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { createHash } from 'node:crypto';
import { openPushDoor, build, peerToken } from './_push-door.mjs';
import { openByteDoor } from './_byte-door.mjs';

const skip = await mongoSkipReason();
const SPACE = 'arrived-fm';
const WINDOW_DAYS = 30;
const PEER = { instanceId: 'arrived-peer', instanceLabel: 'Peer' };
const DAY_MS = 86_400_000;

let door, bytes, recordArrivedFile;
const stored = (id) => door.coll(SPACE, 'files').findOne({ _id: id });

describe('a file whose bytes arrive is live here and takes this instance\'s retention', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'arrivedfm',
      spaces: [{ id: SPACE, label: 'Arrived', folders: [], recordTtlDays: { file: WINDOW_DAYS } }],
    });
    ({ recordArrivedFile } = await import('../../server/dist/files/file-meta.js'));
    bytes = await openByteDoor();
  });
  after(async () => { await door?.close(); });

  it('a path soft-deleted here is live again when the bytes arrive', async () => {
    await door.coll(SPACE, 'files').insertOne({
      ...build.filemeta(SPACE, 'revived.md', 5, { author: PEER }), deletedAt: '2026-09-30T00:00:00.000Z',
    });
    await recordArrivedFile(SPACE, 'revived.md', 10, 'hash-revived', PEER);
    const d = await stored('revived.md');
    assert.equal(d?.deletedAt, undefined, 'the record still carries deletedAt, so the listing hides a file whose bytes are here');
    assert.equal(d?.seq, 5, 'arriving bytes must not stamp a seq');
  });

  it('a SHADOWED arrival does not make the file live: bytes a held tombstone erased leave deletedAt, size and hash as they were (Q-229)', async () => {
    // The rule above is for an arrival that LANDS. Bytes whose hash a held tombstone erased are not an arrival at all — the
    // door answers them 200 { tombstoned: true } and writes nothing — so a soft-deleted path stays deleted, which is the
    // whole point of its tombstone. The row's own flag is what the listing hides the file by.
    const content = Buffer.from('the bytes the owner deleted');
    const hash = createHash('sha256').update(content).digest('hex');
    const deletedAt = '2026-09-30T00:00:00.000Z';
    await door.coll(SPACE, 'files').insertOne({
      ...build.filemeta(SPACE, 'shadowed.md', 5, { author: PEER }), deletedAt, sizeBytes: 1, sha256: 'hash-before',
    });
    await door.coll(SPACE, 'file_tombstones').insertOne({
      _id: 'held-shadowed', spaceId: SPACE, path: 'shadowed.md', deletedAt, positionAt: deletedAt, rowSeq: 5, contentHash: hash,
    });
    const answer = await bytes.post({ space: SPACE, path: 'shadowed.md', bytes: content, token: peerToken(PEER.instanceId) });
    assert.deepEqual([answer.code, answer.body], [200, { tombstoned: true }], 'the door stored the erased bytes of a path its tombstone deleted');
    const d = await stored('shadowed.md');
    assert.deepEqual([d?.deletedAt, d?.sizeBytes, d?.sha256], [deletedAt, 1, 'hash-before'],
      'a shadowed arrival cleared deletedAt (or rewrote the size and hash): the deleted file is listed again with no bytes behind it');
  });

  it('a record new here is stamped from this instance\'s file retention window', async () => {
    const before = Date.now();
    await recordArrivedFile(SPACE, 'fresh.md', 10, 'hash-fresh', PEER);
    const d = await stored('fresh.md');
    assert.ok(d?._expireAt instanceof Date, `no _expireAt on a new arrival in a space with a ${WINDOW_DAYS}-day file window`);
    const days = (d._expireAt.getTime() - before) / DAY_MS;
    assert.ok(Math.abs(days - WINDOW_DAYS) < 1, `expires in ${days.toFixed(2)} days, not ${WINDOW_DAYS}`);
    assert.equal(d.seq, 0);
    assert.equal(d.author?.instanceId, PEER.instanceId);
  });

  it('bytes for a file this instance suppresses are not queued, and its vector goes (D3, bundle-30 I6)', async () => {
    // The bytes writer queued the file with `enqueueEmbedJob` directly, past the receiver's `record > space`
    // resolution — the shape `file-meta-write.ts` says it removed from the drain. A control file is queued.
    const queued = async (id) => !!(await door.coll(SPACE, 'embed_jobs').findOne({ _id: `file:${id}` }));
    await door.coll(SPACE, 'files').insertOne({
      ...build.filemeta(SPACE, 'quiet.md', 5, { author: PEER }), suppressEmbeddings: true,
      embedding: [0.5, 0.25], embeddingModel: 'a-model',
    });
    await door.coll(SPACE, 'files').insertOne({ ...build.filemeta(SPACE, 'loud.md', 5, { author: PEER }) });
    await recordArrivedFile(SPACE, 'quiet.md', 10, 'hash-quiet', PEER);
    await recordArrivedFile(SPACE, 'loud.md', 10, 'hash-loud', PEER);
    const quiet = await stored('quiet.md');
    assert.deepEqual({ queued: await queued('quiet.md'), embedding: quiet?.embedding, model: quiet?.embeddingModel },
      { queued: false, embedding: undefined, model: undefined },
      'a file whose own flag suppresses it was queued (claimed and discarded) or kept a vector');
    assert.equal(await queued('loud.md'), true, 'control: a file nothing suppresses is queued when its bytes land');
  });

  it('an expiry already stored is never re-slid by arriving bytes', async () => {
    const kept = new Date('2027-01-01T00:00:00.000Z');
    await door.coll(SPACE, 'files').insertOne({ ...build.filemeta(SPACE, 'kept.md', 7, { author: PEER }), _expireAt: kept });
    await recordArrivedFile(SPACE, 'kept.md', 10, 'hash-kept', PEER);
    assert.equal((await stored('kept.md'))?._expireAt?.toISOString(), kept.toISOString());
  });
});
