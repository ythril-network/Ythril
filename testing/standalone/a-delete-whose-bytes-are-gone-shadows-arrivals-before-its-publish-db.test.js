/**
 * A delete whose bytes are already gone shadows what it erased AT ONCE, before its tombstone is published (bundle-71,
 * Q-348).
 *
 * ## The defect
 *
 * A file delete writes its tombstone PENDING, unlinks the bytes, and only then publishes it
 * (`files/tombstones.ts`). Every arrival door asks the PUBLISHED tombstones only (`heldFileTombstones` reads
 * `PUBLISHED`), so in the window between the unlink and the publish — a parked or failed publish, a store that is slow, a
 * restart before the TTL settle — a peer that still holds the deleted file is asked nothing: the manifest pull downloads
 * its bytes, the upload door stores them, and the file the owner deleted is live again, with the tombstone published a
 * moment later beside it.
 *
 * ## The rule (design D2)
 *
 * A PENDING tombstone whose act has already removed the path's bytes here is a deletion that HAPPENED and is only waiting
 * to be published. It shadows exactly as a published one would — by content hash for bytes — at every door: the manifest
 * download does not fetch the bytes, and a PEER's upload (single or chunked) is answered `200 { tombstoned: true }` with
 * nothing stored. A pending row whose path STILL has bytes shadows nothing: its act has not happened, or failed.
 *
 * ## What is asserted
 *
 *  - the manifest pull: with the delete's publish parked behind a gate (the unlink done, the tombstone still pending) a
 *    peer advertising the erased content is not downloaded from, and still is not once the publish has landed. Controls:
 *    a pending row whose bytes are still here does not block a different version, and a pending-and-gone row does not
 *    block DIFFERENT bytes at the path.
 *  - the byte door, single and chunked, for a PEER: `200 { tombstoned: true }` and nothing stored. Controls: a person's
 *    upload always stores; a pending row whose bytes are still here does not stop a peer's upload; **the chunked door never
 *    deletes a live file** (local bytes present + pending + an identical chunked upload: the file is still there).
 *  - a door that cannot LOOK at the path (a failure that is not "it does not exist") fails closed: a retryable `503`, and
 *    nothing stored — never a guess in either direction.
 *
 * Every park and every fault armed here is asserted REACHED. Run:
 * node --test testing/standalone/a-delete-whose-bytes-are-gone-shadows-arrivals-before-its-publish-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { openByteDoor, USER_TOKEN } from './_byte-door.mjs';
import { postWhole, postInHalves } from './_byte-door-uploads.mjs';
import { parkWrites, settleWithin } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'gonedel';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ERASED = 'the content the owner deleted';
const OTHER = 'different bytes at the same path';
const T0 = '2026-09-01T00:00:00.000Z';

let door, bytes, cascade, tombstones, LOCAL;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const tombstonesOf = (p) => door.coll(S, 'file_tombstones').find({ path: p }).toArray();
const downloaded = () => door.state.fileDownloads.map(x => x.path).sort();
const stored = ok => ok.code === 201 || ok.code === 202;

/**
 * A pending tombstone as an act writes it before its irreversible step: `pending`, and what the act knew of the version it
 * erases. The bytes are NOT touched: the caller says whether they are here.
 */
const pending = (p, { contentHash = sha(ERASED), rowSeq = 5 } = {}) => door.coll(S, 'file_tombstones').insertOne({
  _id: `pending-${p}`, spaceId: S, path: p, deletedAt: new Date().toISOString(), pending: true,
  issuer: door.instanceId, ...(rowSeq !== undefined ? { rowSeq } : {}), ...(contentHash !== undefined ? { contentHash } : {}),
});

/** The file row an upload or an earlier arrival left for `p`, with the version and hash a tombstone records. */
const fileRow = (p, content) => door.coll(S, 'files').insertOne(
  build.filemeta(S, p, 5, { author: LOCAL, sizeBytes: Buffer.byteLength(content), sha256: sha(content), createdAt: T0, updatedAt: T0 }));

/**
 * Delete `p` through the real cascade with its PUBLISH parked: the pending tombstone is written, the bytes are unlinked, and
 * the confirm's bulk write waits behind a gate. Returns once the park is reached, with the state the window is about —
 * the bytes gone, the tombstone still pending — asserted rather than assumed.
 */
async function deleteWithPublishParked(p, content) {
  door.writeLocalFile(S, p, content);
  await fileRow(p, content);
  const park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
  // The PUBLISH is the bulk write that carries an `updateOne` (the upsert that clears `pending`). The driver may run the
  // pending write's `insertMany` through `bulkWrite` too, and parking that one would stop the act before its unlink.
  const gate = park.arm(`${S}_file_tombstones`,
    { when: (method, [ops]) => method === 'bulkWrite' && Array.isArray(ops) && ops.some(op => op.updateOne) });
  const act = cascade.deleteFileCascade(S, p);
  const hit = await settleWithin(gate.reached, 10_000);
  if (!hit.settled) { gate.release(); park.restore(); await act.catch(() => undefined); }
  assert.ok(hit.settled, 'the delete never reached the publish — the park is not in the window the test is about');
  assert.ok(!door.localFileExists(S, p), 'the bytes were still on disk when the publish was reached — the window is not the one under test');
  const rows = await tombstonesOf(p);
  assert.ok(rows.length === 1 && rows[0].pending === true && rows[0].contentHash === sha(content),
    `the window holds one pending tombstone carrying the erased hash: ${JSON.stringify(rows)}`);
  return {
    /** Let the publish through and wait for the act to finish. */
    async publish() { gate.release(); try { await act; } finally { park.restore(); await tombstones.whenPendingFileTombstoneDropsSettle(); } },
    /** Abandon the park on a failing assertion, so the next test starts clean. */
    async abandon() { gate.release(); park.restore(); await act.catch(() => undefined); },
  };
}

/** Make a look at `p` fail with something that is not "it does not exist"; `hits` says the fault was reached. */
function cannotLook(p) {
  const real = fsp.lstat;
  // By the tail of the path (`/files/<space>/<p>`), case-folded: the server may spell the data root another way than the test.
  const tail = `/files/${S}/${p}`.toLowerCase();
  const hits = [];
  fsp.lstat = async function lookRefused(...args) {
    if (String(args[0]).replace(/\\/g, '/').toLowerCase().endsWith(tail)) {
      hits.push(String(args[0]));
      throw Object.assign(new Error(`EACCES: permission denied, lstat '${args[0]}'`), { code: 'EACCES', syscall: 'lstat' });
    }
    return real.apply(this, args);
  };
  return { hits, restore() { fsp.lstat = real; } };
}

describe('a delete whose bytes are gone shadows arrivals before its publish', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'gonedel', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
    cascade = await import('../../server/dist/files/delete-cascade.js');
    tombstones = await import('../../server/dist/files/tombstones.js');
    LOCAL = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  describe('the manifest pull', () => {
    it('does not download what a delete erased while its publish is parked, nor after the publish lands', async () => {
      door.seedPeerFile(S, 'gone.txt', ERASED);
      const parked = await deleteWithPublishParked('gone.txt', ERASED);
      try {
        await door.sync();
        assert.deepEqual(downloaded(), [],
          'the pull fetched the bytes of a file deleted here a moment ago: its tombstone is pending, and only a published one was asked');
        assert.ok(!door.localFileExists(S, 'gone.txt'), 'the erased bytes are back on disk');
      } catch (err) { await parked.abandon(); throw err; }
      await parked.publish();
      const [published] = await tombstonesOf('gone.txt');
      assert.ok(published && published.pending === undefined, `the act's publish did not land: ${JSON.stringify(published)}`);
      await door.sync();
      assert.deepEqual(downloaded(), [], 'the pull fetched the erased bytes once the tombstone was published');
      assert.ok(!door.localFileExists(S, 'gone.txt'));
    });

    it('control: a pending row whose bytes are still here shadows nothing — a different version is fetched', async () => {
      door.writeLocalFile(S, 'live.txt', 'the version that is still here');
      await pending('live.txt', { contentHash: sha('the version that is still here') });
      door.seedPeerFile(S, 'live.txt', OTHER);
      await door.sync();
      assert.ok(downloaded().includes('live.txt'), 'a pending tombstone for a path that still has bytes blocked a different version');
    });

    it('control: a pending-and-gone row shadows by CONTENT — different bytes at the path are fetched', async () => {
      await pending('other.txt');
      door.seedPeerFile(S, 'other.txt', OTHER);
      await door.sync();
      assert.deepEqual(downloaded(), ['other.txt'], 'a pending tombstone for other content blocked a download');
      assert.ok(door.localFileExists(S, 'other.txt'));
    });
  });

  describe('the byte door', () => {
    const nothingStored = async (p) => ({ onDisk: door.localFileExists(S, p), row: (await row(p)) !== null });
    const peer = () => peerToken(PEER);

    it('a PEER\'s single upload of the erased bytes is answered 200 { tombstoned: true } and stores nothing', async () => {
      await pending('b-single.txt');
      const res = await postWhole(bytes, { space: S, path: 'b-single.txt', content: ERASED, token: peer() });
      assert.deepEqual([res.code, res.body], [200, { tombstoned: true }],
        'the erased bytes of a delete awaiting its publish were stored, or refused with a status the sender repeats for ever');
      assert.deepEqual(await nothingStored('b-single.txt'), { onDisk: false, row: false });
    });

    it('a PEER\'s chunked upload of the erased bytes is answered 200 { tombstoned: true } and stores nothing', async () => {
      await pending('b-chunked.txt');
      const { first, last } = await postInHalves(bytes, { space: S, path: 'b-chunked.txt', content: ERASED, token: peer() });
      assert.equal(first.code, 202, `the first half: ${JSON.stringify(first)}`);
      assert.deepEqual([last.code, last.body], [200, { tombstoned: true }]);
      assert.deepEqual(await nothingStored('b-chunked.txt'), { onDisk: false, row: false });
    });

    it('after a REAL delete with its publish parked, a peer\'s upload of the erased bytes leaves its row as it was', async () => {
      const parked = await deleteWithPublishParked('real.txt', ERASED);
      try {
        const before = await row('real.txt');
        const res = await postWhole(bytes, { space: S, path: 'real.txt', content: ERASED, token: peer() });
        assert.deepEqual([res.code, res.body], [200, { tombstoned: true }]);
        assert.ok(!door.localFileExists(S, 'real.txt'), 'the erased bytes were stored');
        assert.deepEqual(await row('real.txt'), before, 'the arrival rewrote the row of the file being deleted');
      } finally { await parked.abandon(); }
    });

    it('control: a PERSON\'s upload of the same bytes stores, single and chunked, while the delete is pending', async () => {
      await pending('u-single.txt');
      await pending('u-chunked.txt');
      const one = await postWhole(bytes, { space: S, path: 'u-single.txt', content: ERASED, token: USER_TOKEN });
      assert.ok(stored(one) && one.body.tombstoned === undefined, `a person's upload was refused: ${JSON.stringify(one)}`);
      const { last } = await postInHalves(bytes, { space: S, path: 'u-chunked.txt', content: ERASED, token: USER_TOKEN });
      assert.ok(stored(last) && last.body.tombstoned === undefined, `a person's chunked upload was refused: ${JSON.stringify(last)}`);
      assert.deepEqual([await nothingStored('u-single.txt'), await nothingStored('u-chunked.txt')],
        [{ onDisk: true, row: true }, { onDisk: true, row: true }]);
    });

    it('control: a pending row whose bytes are still here shadows nothing — a PEER\'s upload stores', async () => {
      door.writeLocalFile(S, 'here.txt', 'an older version still on disk');
      await pending('here.txt');
      const res = await postWhole(bytes, { space: S, path: 'here.txt', content: ERASED, token: peer() });
      assert.ok(stored(res) && res.body.tombstoned === undefined, `an act that has not happened shadowed an arrival: ${JSON.stringify(res)}`);
      assert.equal(await fsp.readFile(path.join(door.localFilesRoot(S), 'here.txt'), 'utf8'), ERASED);
    });

    it('control: a pending-and-gone row does not shadow DIFFERENT bytes from a peer', async () => {
      await pending('diff.txt');
      const res = await postWhole(bytes, { space: S, path: 'diff.txt', content: OTHER, token: peer() });
      assert.ok(stored(res) && res.body.tombstoned === undefined, JSON.stringify(res));
      assert.deepEqual(await nothingStored('diff.txt'), { onDisk: true, row: true });
    });

    it('control: the chunked door never deletes a LIVE file — local bytes present, a pending row, an identical chunked upload', async () => {
      door.writeLocalFile(S, 'alive.txt', ERASED);
      await fileRow('alive.txt', ERASED);
      await pending('alive.txt');
      const { last } = await postInHalves(bytes, { space: S, path: 'alive.txt', content: ERASED, token: peer() });
      assert.ok(stored(last) && last.body.tombstoned === undefined, `the upload over a live file was answered ${JSON.stringify(last)}`);
      assert.deepEqual(await nothingStored('alive.txt'), { onDisk: true, row: true }, 'a live file was deleted by the door that shadowed it');
      assert.equal(await fsp.readFile(path.join(door.localFilesRoot(S), 'alive.txt'), 'utf8'), ERASED);
    });

    describe('a door that cannot look at the path', () => {
      it('answers a retryable 503 for a single upload and stores nothing', async () => {
        await pending('cl-single.txt');
        const fault = cannotLook('cl-single.txt');
        let res;
        try { res = await postWhole(bytes, { space: S, path: 'cl-single.txt', content: ERASED, token: peer() }); } finally { fault.restore(); }
        assert.equal(res.code, 503, `a door that cannot tell whether the delete happened answered ${JSON.stringify(res)}`);
        assert.equal(res.body?.tombstoned, undefined, 'the sender was told the path is tombstoned, and will not retry');
        assert.deepEqual(await nothingStored('cl-single.txt'), { onDisk: false, row: false });
        assert.ok(fault.hits.length > 0, 'the path was never looked at — the fault is not reached');
      });

      it('answers a retryable 503 at the last chunk and stores nothing', async () => {
        await pending('cl-chunked.txt');
        const fault = cannotLook('cl-chunked.txt');
        let out;
        try { out = await postInHalves(bytes, { space: S, path: 'cl-chunked.txt', content: ERASED, token: peer() }); } finally { fault.restore(); }
        assert.equal(out.last.code, 503, `a door that cannot tell whether the delete happened answered ${JSON.stringify(out.last)}`);
        assert.equal(out.last.body?.tombstoned, undefined);
        assert.deepEqual(await nothingStored('cl-chunked.txt'), { onDisk: false, row: false });
        assert.ok(fault.hits.length > 0, 'the path was never looked at — the fault is not reached');
      });
    });
  });
});
