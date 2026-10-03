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
 * ## Metadata first (`Q-250`, 5.6.3)
 *
 * The metadata of a peer's file can arrive BEFORE its bytes, through the arrival writer (`ingestFileMeta`). That
 * upsert created the row with no `_expireAt`, and the bytes landing afterwards found the row already there, so
 * `recordArrivedFile`'s insert-only stamp never ran: a file the space should expire never did, on whichever
 * instance happened to receive the metadata first. So the row the metadata creates takes this instance's file
 * window; a later copy of the metadata and the bytes never re-slide it; and with no window there is no `_expireAt`
 * key at all (an explicit null would read as "stamped, never expires" to a reader that checks presence).
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
const NO_WINDOW = 'arrived-fm-nowindow';
const WINDOW_DAYS = 30;
const PEER = { instanceId: 'arrived-peer', instanceLabel: 'Peer' };
const DAY_MS = 86_400_000;

let door, recordArrivedFile;
const stored = (id) => door.coll(SPACE, 'files').findOne({ _id: id });

describe('a file whose bytes arrive is live here and takes this instance\'s retention', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'arrivedfm',
      spaces: [
        { id: SPACE, label: 'Arrived', folders: [], recordTtlDays: { file: WINDOW_DAYS } },
        { id: NO_WINDOW, label: 'Arrived, no window', folders: [] },
      ],
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

  it('an expiry already stored is never re-slid by arriving bytes', async () => {
    const kept = new Date('2027-01-01T00:00:00.000Z');
    await door.coll(SPACE, 'files').insertOne({ ...build.filemeta(SPACE, 'kept.md', 7, { author: PEER }), _expireAt: kept });
    await recordArrivedFile(SPACE, 'kept.md', 10, 'hash-kept', PEER);
    assert.equal((await stored('kept.md'))?._expireAt?.toISOString(), kept.toISOString());
  });

  /** Push a peer's file metadata through the real door: the arrival writer, then `ingestFileMeta`. */
  async function pushMeta(space, id, seq, extra = {}) {
    const res = await door.push('/batch-upsert', { filemeta: [build.filemeta(space, id, seq, extra)] }, { spaceId: space });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    return res;
  }

  it('Q-250: metadata first, then bytes: the row takes this instance\'s file window once, and nothing re-slides it', async () => {
    const before = Date.now();
    await pushMeta(SPACE, 'meta-first.md', 20, { description: 'described upstream' });
    const first = (await stored('meta-first.md'))?._expireAt;
    assert.ok(first instanceof Date,
      `the row file metadata created has no _expireAt in a space with a ${WINDOW_DAYS}-day file window, and the bytes `
      + 'arriving later find the row already there, so nothing ever stamps it: the file never expires');
    const days = (first.getTime() - before) / DAY_MS;
    assert.ok(Math.abs(days - WINDOW_DAYS) < 1, `expires in ${days.toFixed(2)} days, not this instance's ${WINDOW_DAYS}`);

    await pushMeta(SPACE, 'meta-first.md', 21, { description: 'edited upstream' });
    assert.equal((await stored('meta-first.md'))?._expireAt?.toISOString(), first.toISOString(),
      'a later copy of the metadata re-slid the expiry');
    await recordArrivedFile(SPACE, 'meta-first.md', 10, 'hash-meta-first', PEER);
    const d = await stored('meta-first.md');
    assert.equal(d?._expireAt?.toISOString(), first.toISOString(), 'the bytes arriving re-slid the expiry');
    assert.equal(d?.description, 'edited upstream', 'the metadata did not land, so the row proves nothing');
  });

  it('Q-250, control: with no file window, metadata first then bytes leaves no _expireAt key at all', async () => {
    await pushMeta(NO_WINDOW, 'no-window.md', 20);
    await recordArrivedFile(NO_WINDOW, 'no-window.md', 10, 'hash-no-window', PEER);
    const d = await door.coll(NO_WINDOW, 'files').findOne({ _id: 'no-window.md' });
    assert.ok(d, 'the metadata did not land');
    assert.equal(Object.hasOwn(d, '_expireAt'), false, `a space with no window stored _expireAt: ${JSON.stringify(d._expireAt)}`);
  });
});
