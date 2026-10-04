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
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-arrived-file-is-live-and-takes-this-instances-retention-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();
const SPACE = 'arrived-fm';
const WINDOW_DAYS = 30;
const PEER = { instanceId: 'arrived-peer', instanceLabel: 'Peer' };
const DAY_MS = 86_400_000;

let door, recordArrivedFile;
const stored = (id) => door.coll(SPACE, 'files').findOne({ _id: id });

describe('a file whose bytes arrive is live here and takes this instance\'s retention', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'arrivedfm',
      spaces: [{ id: SPACE, label: 'Arrived', folders: [], recordTtlDays: { file: WINDOW_DAYS } }],
    });
    ({ recordArrivedFile } = await import('../../server/dist/files/file-meta.js'));
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
