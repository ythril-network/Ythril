/**
 * A file tombstone tells peers a path is gone, so no peer is told until it IS gone here: the tombstone is written
 * pending before the irreversible step and published only once the step happened (bundle-30 I15, preship-3 P3-1 and
 * P3-3).
 *
 * ## The defect
 *
 * I13 wrote the tombstone before the bytes went, and I14 withdrew it when the act then failed — a `deleteMany`, retried
 * in memory. Meanwhile the tombstone was a published one: a sync cycle pushed it (`sync/file-sync.ts` pushes all of
 * them), the peer deleted its copy, STORED the tombstone and served it back, and this instance's pull then deleted its
 * own copy — the only one — of a file whose delete or move had FAILED. A restart dropped the withdrawal outright. And a
 * delete whose unlink failed for a reason that is not the store's (a directory, a permission) never withdrew at all;
 * the TTL sweep wrote another such tombstone every cycle.
 *
 * ## What is asserted
 *
 * "Published" is what a peer can learn: the `GET /api/sync/file-tombstones` door, and the push a sync cycle makes
 * (`syncFiles` against a fake peer that records what it is sent).
 *
 * - An act that did not happen publishes nothing — a move whose tombstone write was reported failed but landed, a move
 *   whose bytes could not move, a delete whose unlink failed, the TTL sweep over a file it cannot unlink — and that
 *   holds with the act's own clean-up never run, which is what a restart between the two leaves.
 * - Such a leftover is settled by the TTL sweep once stale, by what the disk holds: dropped while the path still has
 *   its bytes, published once it has none.
 * - Every other reader leaves it alone too: the prune does not remove it as delivered, and the stray-metadata drain
 *   does not take it for a deletion.
 * - A delete or a move that happened publishes exactly one tombstone per path, carrying only the four fields a
 *   tombstone has on the wire.
 *
 * Run: node --test testing/standalone/a-file-tombstone-is-published-only-once-its-act-happened-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { build } from './_push-door.mjs';
import { openFileActDoors, NOTHING, WIRE_KEYS } from './_file-act-doors.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tombpub';
const T0 = '2026-09-01T00:00:00.000Z';

let acts, door, files, tombstones, ttl, cascade, drainStrayFileMeta, pruneFileTombstonesToFloor;
let F, faults;

const root = () => acts.root();
const onDisk = (p) => acts.onDisk(p);
const raw = () => acts.raw();
const seed = (p, extra) => acts.seed(p, extra);
/** A directory with a file in it, at `p` — what an unlink of `p` fails on, for a reason that is not the store's. */
const directoryAt = (p) => fs.mkdirSync(path.join(root(), p, 'inside'), { recursive: true });

/** The act's own clean-up of its tombstone never runs — what a restart between the act and its clean-up leaves. */
const cleanUpNeverRuns = () => faults.fail('deleteMany', `${S}_file_tombstones`,
  new Error('the clean-up never ran: the process restarted'), { times: Infinity });
const cleanUpsSettled = () => tombstones.whenPendingFileTombstoneDropsSettle?.();

const served = () => acts.served();
const pushed = () => acts.pushed();
const published = () => acts.published();
const mcp = (tool, args) => acts.mcp(tool, args);
const move = (via, src, dst) => acts.move(via, src, dst);
const del = (via, p) => acts.del(via, p);
const failed = (a) => acts.failed(a);

describe('a file tombstone is published only once its act happened', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'tombpub', space: S });
    ({ door, files } = acts);
    F = await driverWriteFailures('ythril_harness_tombpub');
    tombstones = await import('../../server/dist/files/tombstones.js');
    cascade = await import('../../server/dist/files/delete-cascade.js');
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    ({ drainStrayFileMeta } = await import('../../server/dist/sync/stray-filemeta-drain.js'));
    ({ pruneFileTombstonesToFloor } = await import('../../server/dist/brain/tombstone-prune.js'));
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), ['insertMany', 'deleteMany']);
  });
  after(async () => {
    faults?.restore();
    await acts?.close();
  });
  beforeEach(async () => {
    faults.clear();
    await acts.reset();
  });
  afterEach(() => { faults.clear(); });

  it('the act\'s clean-up can be awaited', () => {
    assert.equal(typeof tombstones.whenPendingFileTombstoneDropsSettle, 'function',
      'files/tombstones.js exports no whenPendingFileTombstoneDropsSettle — a test cannot wait for a failed act\'s clean-up');
  });

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a move whose tombstone write is reported failed but landed publishes nothing, its clean-up never run`, async () => {
      await seed('src.txt');
      cleanUpNeverRuns();
      faults.fail('insertMany', `${S}_file_tombstones`, F.storeGone.bulk, { land: true });
      const a = await move(via, 'src.txt', 'dst.txt');
      assert.equal('code' in a ? a.code : a.status, 503, `the move: ${JSON.stringify(a.body ?? a.text)}`);
      assert.ok(onDisk('src.txt') && !onDisk('dst.txt'), 'the file did not stay where it was');
      await cleanUpsSettled();
      assert.ok((await raw()).length > 0, 'the insert never landed — this is not the case the drive saw');
      assert.deepEqual(await published(), NOTHING,
        'a peer is told to delete a file that is still here, and serves the tombstone back to delete our only copy');
    });

    it(`${via}: a move whose bytes cannot move publishes nothing, its clean-up never run`, async () => {
      await seed('stay.txt');
      directoryAt('occupied');
      cleanUpNeverRuns();
      const a = await move(via, 'stay.txt', 'occupied');
      assert.ok(failed(a), `a move onto a directory that holds a file succeeded: ${JSON.stringify(a.body ?? a.text)}`);
      assert.ok(onDisk('stay.txt'), 'the file left its path');
      await cleanUpsSettled();
      assert.deepEqual(await published(), NOTHING, 'a failed move published a tombstone for the path it did not leave');
    });
  }

  it('a delete whose unlink fails for a reason that is not the store\'s publishes nothing, on the cascade and MCP', async () => {
    directoryAt('adir');
    cleanUpNeverRuns();
    await assert.rejects(cascade.deleteFileCascade(S, 'adir'), 'unlinking a directory succeeded — the case is not reached');
    const m = await mcp('delete_file', { path: 'adir' });
    assert.ok(m.isError, `MCP delete_file of a directory succeeded: ${m.text}`);
    assert.ok(onDisk('adir/inside'), 'the directory went');
    await cleanUpsSettled();
    assert.deepEqual(await published(), NOTHING, 'a delete that removed nothing published a tombstone');
  });

  it('the TTL sweep publishes no tombstone for a file it cannot unlink, however many cycles run', async () => {
    directoryAt('tdir');
    await door.coll(S, 'files').insertOne({ _id: 'tdir', spaceId: S, path: 'tdir', sizeBytes: 1, tags: [],
      createdAt: T0, updatedAt: T0, _expireAt: new Date('2026-01-01T00:00:00Z') });
    await ttl.sweepExpired(new Date());
    await ttl.sweepExpired(new Date());
    await cleanUpsSettled();
    assert.ok(onDisk('tdir/inside'), 'the sweep removed what it was asked to');
    assert.deepEqual(await published(), NOTHING, 'every sweep cycle published another tombstone for a file still here');
  });

  it('a stale leftover is settled by the TTL sweep from the disk: dropped while its path has bytes, published once not', async () => {
    directoryAt('occupied');
    await seed('kept.txt');
    await seed('gone.txt');
    cleanUpNeverRuns();
    assert.ok(failed(await move('REST', 'kept.txt', 'occupied')));
    assert.ok(failed(await move('REST', 'gone.txt', 'occupied')));
    await cleanUpsSettled();
    faults.clear();
    fs.rmSync(path.join(root(), 'gone.txt'));   // the path lost its bytes after all
    assert.deepEqual(await published(), NOTHING, 'a leftover was published before it was settled');
    await ttl.sweepExpired(new Date(Date.now() + 24 * 3_600_000));
    const after = await published();
    assert.deepEqual(after, { served: ['gone.txt'], pushed: ['gone.txt'] },
      'the sweep did not settle the leftovers by the disk: kept.txt still has its bytes, gone.txt has none');
    assert.deepEqual((await raw()).filter(t => t.path === 'kept.txt'), [], 'the leftover for a file still here was kept');
  });

  it('no other reader takes a leftover for a deletion: the prune keeps it, the stray-metadata drain waits', async () => {
    directoryAt('occupied');
    await files.writeFile(S, 'held.txt', 'bytes with no metadata row');
    cleanUpNeverRuns();
    assert.ok(failed(await move('REST', 'held.txt', 'occupied')));
    await cleanUpsSettled();
    faults.clear();
    assert.ok((await raw()).some(t => t.path === 'held.txt'), 'the failed move left no record at all — the case is not reached');

    await door.coll(S, 'filemeta').insertOne({ ...build.filemeta(S, 'held.txt', 5), sizeBytes: 26, sha256: 'peer-hash' });
    await drainStrayFileMeta();
    assert.ok(await door.coll(S, 'filemeta').findOne({ _id: 'held.txt' }),
      'the drain discarded a record as "the file was deleted" on a tombstone for a move that never happened');

    await pruneFileTombstonesToFloor(S, { prune: true, upTo: '9999-12-31T23:59:59.999Z' });
    assert.ok((await raw()).some(t => t.path === 'held.txt'),
      'the prune removed a tombstone no peer was ever sent, as though every peer had acknowledged it');
  });

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a delete and a move that happened each publish exactly one tombstone per path, in its wire shape`, async () => {
      await seed('gone.txt');
      await seed('from.txt');
      const d = await del(via, 'gone.txt');
      assert.ok(!failed(d), `the delete: ${JSON.stringify(d.body ?? d.text)}`);
      const m = await move(via, 'from.txt', 'to.txt');
      assert.ok(!failed(m), `the move: ${JSON.stringify(m.body ?? m.text)}`);
      await cleanUpsSettled();
      for (const [door, list] of [['served', await served()], ['pushed', await pushed()]]) {
        assert.deepEqual(list.map(t => t.path).sort(), ['from.txt', 'gone.txt'], `${door}: not one tombstone per path`);
        for (const t of list) {
          assert.deepEqual(Object.keys(t).sort(), WIRE_KEYS, `${door}: a tombstone carries fields that are not on the wire`);
        }
      }
    });
  }
});
