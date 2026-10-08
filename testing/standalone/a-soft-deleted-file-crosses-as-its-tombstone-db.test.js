/**
 * With `softDeleteFileMeta` on, a deleted file's DELETION travels as the file tombstone it already writes, and the flagged
 * metadata row it leaves is this instance's own audit record: it is never offered to a peer, never hashed, and never
 * given a seq of its own (bundle-48, `Q-257`; plan D4).
 *
 * ## The defect
 *
 * `softDeleteFileMeta` keeps a deleted file's row, flagged `deletedAt`, and stamps it with a NEW seq so it pages to
 * peers "so a peer sees the flag" (`markFileMetaDeleted`). It does not: `deletedAt` is not a wire key
 * (`fileMetaForWire` takes only what `IncomingFileMetaDoc` declares), so the push sends the row stripped of its flag and
 * it lands LIVE on the peer, removing the tombstone the peer holds for the file. The row's seq also outranks the
 * tombstone's `rowSeq`, so the file comes back on a third peer. The flag-on-the-wire alternative was rejected for the same
 * seq reason and because it would impose the sender's setting on the receiver. So the rule is the other way round:
 *
 *  1. **A flagged row is on no wire.** The push never offers it; `GET /filemeta` and `GET /filemeta/:id` never serve it —
 *     for a single file's delete and a directory's.
 *  2. **The deletion crosses as a file tombstone** — one per file for a directory delete (the plan's `P7`) — and the
 *     receiver applies it by ITS OWN setting (flag on: flagged, flag off: removed), holds the tombstone and keeps it.
 *  3. **`deletedAt` is local state**: flagging stamps no `seq` and no `updatedAt` (a local seq on a peer's row would
 *     outrank the publisher's next edit once bytes revive it).
 *  4. **Flagged rows are outside the space hash** (`P8`): local audit state is not replicated, so it is not compared. A
 *     publisher that kept a flagged row and a receiver that removed it hold the same data.
 *  5. **A restore keeps the flag** an export carries (a files-only carry in the import writer, which takes wire keys only).
 *
 * Not asserted, on purpose: what happens when an OLDER sender pushes a flagged row stripped of its flag. It cannot be told
 * from a re-creation, so it keeps landing live until that sender upgrades — a documented limit, not a promise.
 *
 * ## Seen red on the base (2693450b)
 *
 * The flagged row is pushed and served (1), is stamped with a seq and an `updatedAt` (3), changes the space hash (4), and a
 * restore drops the flag (5). The tombstone halves (2) and the directory tombstones (`P7`) hold today and are pinned.
 *
 * Run: node --test testing/standalone/a-soft-deleted-file-crosses-as-its-tombstone-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'softdel';
/** The second space on the door: the receiver whose copy a flagged row is compared with. */
const R = 'softdel-r';
const T_OLD = '2026-09-01T00:00:00.000Z';
const KEEP = 'keep/a.txt';
/** Poison: a row's own seq and `updatedAt` before the delete — a flag that stamps either moves them. */
const SEQ_BEFORE = 7;

let door, files, importMod, merkleMod, deleteHandler, ME;

const rowIn = (space, id) => door.coll(space, 'files').findOne({ _id: id });
const row = (id) => rowIn(S, id);
const tombstoneRows = (space = S) => door.coll(space, 'file_tombstones').find({}).toArray();

/** The REST file router's own `DELETE` handler, past rate limit and auth. */
async function restDelete(p, body = {}) {
  const req = { method: 'DELETE', params: { spaceId: S }, query: { path: p }, body, authToken: { name: 'test' }, get: () => undefined, headers: {} };
  const res = { code: 200, body: undefined, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await deleteHandler(req, res);
  assert.ok(res.code >= 200 && res.code < 300, `the delete of ${p} answered ${res.code}: ${JSON.stringify(res.body)}`);
}

/** A file in a space: its bytes and its metadata row, authored by `author`, at a poisoned seq and `updatedAt`. */
async function seedFile(space, p, { author = ME, seq = SEQ_BEFORE, content = `bytes of ${p}` } = {}) {
  await files.writeFile(space, p, content);
  await door.mongo.col(`${space}_files`).insertOne({
    _id: p, spaceId: space, path: p, sizeBytes: content.length, tags: ['t'], author: { ...author },
    createdAt: T_OLD, updatedAt: T_OLD, seq,
  });
  await door.bumpSeq(space, seq);
}

/** What the engine pushed to the fake peer for the files family of the space, ids only. */
const pushedMetaIds = () => door.state.pushedRecords.filter(r => r.key === 'filemeta' && r.spaceId === S).map(d => d._id).sort();
/** What `GET /filemeta` serves a peer pulling this space. */
const servedMetaIds = async () => (await door.pull('/filemeta', { spaceId: S })).items.map(d => d._id).sort();

/** Both ways a peer learns of a file: pushed by a cycle, and served on a pull of this space. */
async function publish() {
  door.configure({ direction: 'push' });
  await door.sync();
  return { pushed: pushedMetaIds(), served: await servedMetaIds() };
}

/** The deletes: each seeds a live control and the files it deletes, and says which paths were deleted. */
const ACTS = {
  'a file delete': {
    gone: ['gone/b.txt'],
    async run() { await restDelete('gone/b.txt'); },
  },
  'a directory delete': {
    gone: ['dir/one.txt', 'dir/two.txt'],
    async run() { await restDelete('dir', { confirm: true }); },
  },
};

describe('with softDeleteFileMeta, a deletion travels as its tombstone and the flagged row stays here', { skip }, () => {
  before(async () => {
    // `lateral`: this instance serves the spaces onward (a club member beside the publisher), so a peer's file tombstone is
    // KEPT here to be relayed. A leaf applies a tombstone and keeps nothing (`a-peer-file-tombstone-is-kept-only-to-be-served-onward-db`).
    door = await openPullDoor({ suite: 'softdel', spaces: [S, R], files: true, lateral: true });
    files = await import('../../server/dist/files/files.js');
    importMod = await import('../../server/dist/api/admin-import.js');
    merkleMod = await import('../../server/dist/brain/merkle.js');
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods.delete);
    assert.ok(layer, 'no DELETE /:spaceId on the file router — re-anchor this test');
    deleteHandler = layer.route.stack.at(-1).handle;
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => {
    delete door?.config().softDeleteFileMeta;
    await door?.close();
  });
  beforeEach(async () => {
    await door.reset();
    door.config().softDeleteFileMeta = true;
  });

  for (const [name, act] of Object.entries(ACTS)) {
    describe(name, () => {
      /** The control is live and offered; every path the act deleted is flagged here and has its tombstone. */
      async function deleted() {
        await seedFile(S, KEEP);
        for (const p of act.gone) await seedFile(S, p);
        await act.run();
        for (const p of act.gone) {
          const r = await row(p);
          assert.ok(r?.deletedAt, `fixture: ${p} was not flagged by the delete (softDeleteFileMeta is on): ${JSON.stringify(r)}`);
        }
        assert.deepEqual((await tombstoneRows()).map(t => t.path).sort(), [...act.gone].sort(),
          'fixture: the delete did not write exactly one file tombstone per deleted path');
      }

      it('the deletion is published as a file tombstone per path, and as nothing else', async () => {
        await deleted();
        door.configure({ direction: 'push' });
        await door.sync();
        assert.deepEqual([...new Set(door.state.fileTombstonesReceived.map(t => t.path))].sort(), [...act.gone].sort(),
          'a peer is told of a deleted file by its tombstone: every deleted path needs one on the wire');
      });

      it('the push never offers a flagged row as metadata (it lands live on the peer and removes its tombstone)', async () => {
        await deleted();
        const { pushed } = await publish();
        assert.ok(pushed.includes(KEEP), `the live control was not pushed either, so the wire carried nothing to compare: ${JSON.stringify(pushed)}`);
        assert.deepEqual(pushed.filter(id => act.gone.includes(id)), [],
          'a soft-deleted file was pushed as live metadata, stripped of the flag that says it is gone');
      });

      it('GET /filemeta never serves a flagged row, and GET /filemeta/:id answers not found', async () => {
        await deleted();
        const served = await servedMetaIds();
        assert.ok(served.includes(KEEP), `the live control was not served either: ${JSON.stringify(served)}`);
        assert.deepEqual(served.filter(id => act.gone.includes(id)), [], 'a peer pulling this space is served a deleted file\'s audit row');
        for (const id of act.gone) {
          const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
          await door.handler('get', '/filemeta/:id')({ method: 'GET', query: { spaceId: S }, params: { id }, authToken: { rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: 'push-door-peer' }, get: () => undefined }, res);
          assert.equal(res.code, 404, `GET /filemeta/${id} served a flagged row: ${JSON.stringify(res.body)}`);
        }
      });

      it('flagging stamps no seq and no updatedAt (deletedAt is local state)', async () => {
        await seedFile(S, KEEP);
        for (const p of act.gone) await seedFile(S, p);
        await act.run();
        for (const p of act.gone) {
          const r = await row(p);
          assert.ok(r?.deletedAt, `fixture: ${p} was not flagged`);
          assert.equal(r.seq, SEQ_BEFORE, `${p}: the flag took a seq of its own (${r.seq}): it would outrank the publisher's next edit once bytes revive the path`);
          assert.equal(r.updatedAt, T_OLD, `${p}: the flag stamped updatedAt, which is hashed and replicated`);
        }
        const kept = await row(KEEP);
        assert.equal(kept.seq, SEQ_BEFORE, 'the control file was touched');
      });
    });
  }

  describe('a RECEIVER applies the deletion by its own setting, and keeps the tombstone', () => {
    const GONE = 'recv/gone.txt';
    const tomb = { _id: `ft-${GONE}`, path: GONE, deletedAt: '2026-09-02T00:00:01.000Z', issuer: PEER, rowSeq: SEQ_BEFORE };

    for (const soft of [true, false]) {
      it(`softDeleteFileMeta ${soft ? 'on' : 'off'} on the receiver: the file is ${soft ? 'flagged without a seq of its own' : 'removed'}, the tombstone is held and kept, and nothing flagged is served onward`, async () => {
        door.config().softDeleteFileMeta = soft;
        await seedFile(S, GONE, { author: PEER_AUTHOR });
        await seedFile(S, KEEP, { author: PEER_AUTHOR });
        await door.seedPeerFileTombstones(S, [{ ...tomb, spaceId: door.peerSide(S), positionAt: tomb.deletedAt }]);
        await door.sync();
        assert.equal(door.localFileExists(S, GONE), false, 'the bytes were not removed by the peer\'s tombstone');
        const after = await row(GONE);
        if (soft) {
          assert.ok(after?.deletedAt, `the receiver's own setting is on and the row is not flagged: ${JSON.stringify(after)}`);
          assert.equal(after.seq, SEQ_BEFORE, 'the flag took a seq of its own on the receiver');
          assert.equal(after.updatedAt, T_OLD, 'the flag stamped updatedAt on the receiver');
        } else {
          assert.equal(after, null, 'the receiver\'s own setting is off and the row was kept');
        }
        assert.deepEqual((await tombstoneRows()).map(t => t.path), [GONE], 'the receiver does not hold the tombstone');
        // Kept: more cycles with the peer still serving it change nothing.
        await door.sync();
        await door.sync();
        assert.deepEqual((await tombstoneRows()).map(t => t.path), [GONE], 'the tombstone was dropped by a later cycle');
        assert.equal(door.localFileExists(S, GONE), false, 'the file came back');
        assert.deepEqual((await servedMetaIds()).filter(id => id === GONE), [],
          'this instance serves the deleted file\'s audit row to ITS subscribers: the deletion is theirs through the tombstone');
        assert.ok((await servedMetaIds()).includes(KEEP), 'the live control was not served, so the page proves nothing');
      });
    }
  });

  describe('the space hash', () => {
    it('does not include a flagged row: publisher (flag on) and receiver (row removed) hold the same data', async () => {
      // Publisher: a live file, and one deleted with the flag on. Receiver: the live file only — it retired the other by
      // ITS OWN setting (off). Bytes and rows are identical where they are held, so any difference is the flagged row.
      await seedFile(S, KEEP, { content: 'the same bytes' });
      await seedFile(R, KEEP, { content: 'the same bytes' });
      await seedFile(S, 'gone/b.txt');
      await restDelete('gone/b.txt');
      assert.ok((await row('gone/b.txt'))?.deletedAt, 'fixture: the file was not flagged');
      assert.equal((await rowIn(R, 'gone/b.txt')), null, 'fixture: the receiver holds the file');
      const mine = await merkleMod.computeMerkleRoot(S);
      const theirs = await merkleMod.computeMerkleRoot(R);
      assert.equal(mine.root, theirs.root,
        'a deleted file\'s audit row changes the space hash, so a network with merkle:true reports a divergence for ever between a publisher that keeps the row and a receiver that removed it');
    });

    it('does not move when a row is flagged, and a live row does move it (the control)', async () => {
      // Rows only: the manifest half of the hash reads bytes, and this case is about the record half.
      await door.coll(S, 'files').insertOne({ _id: KEEP, spaceId: S, path: KEEP, tags: [], author: { ...ME }, createdAt: T_OLD, updatedAt: T_OLD, seq: SEQ_BEFORE });
      const before = await merkleMod.computeMerkleRoot(S);
      await door.coll(S, 'files').insertOne({ _id: 'flag/me.txt', spaceId: S, path: 'flag/me.txt', tags: [], author: { ...ME }, createdAt: T_OLD, updatedAt: T_OLD, seq: SEQ_BEFORE + 1 });
      const live = await merkleMod.computeMerkleRoot(S);
      assert.notEqual(live.root, before.root, 'fixture: a live row does not move the hash, so the case below proves nothing');
      await door.coll(S, 'files').updateOne({ _id: 'flag/me.txt' }, { $set: { deletedAt: T_OLD } });
      const flagged = await merkleMod.computeMerkleRoot(S);
      assert.equal(flagged.root, before.root, 'a flagged row is hashed: local audit state is compared between instances');
    });
  });

  describe('a RESTORE keeps the flag a soft delete left', () => {
    const FILE = 'restored/gone.txt';
    const flagged = (extra = {}) => ({ ...build.filemeta(S, FILE, 40, { author: { ...PEER_AUTHOR }, ...extra }), deletedAt: '2026-09-03T00:00:00.000Z' });

    it('a backup row that carries deletedAt is restored flagged, over a copy that was live and over nothing', async () => {
      for (const stored of [true, false]) {
        await door.coll(S, 'files').deleteMany({});
        if (stored) await door.coll(S, 'files').insertOne({ ...build.filemeta(S, FILE, 39, { author: { ...PEER_AUTHOR } }) });
        const out = await importMod.importDocuments(S, { files: [flagged()] });
        assert.equal(out.results.files.errors, 0, `the restore refused the row: ${JSON.stringify(out.results.files)}`);
        const now = await row(FILE);
        assert.equal(now?.seq, 40, `the backup row did not land (stored copy: ${stored})`);
        assert.equal(now.deletedAt, '2026-09-03T00:00:00.000Z',
          `the restore dropped the flag (stored copy: ${stored}): every soft-deleted file comes back as a live row with no bytes`);
      }
    });

    it('and the restored flagged row is on no wire', async () => {
      await importMod.importDocuments(S, { files: [flagged(), build.filemeta(S, KEEP, 41, { author: { ...ME } })] });
      assert.ok((await row(FILE))?.deletedAt, 'fixture: the flag did not survive the restore');
      const served = await servedMetaIds();
      assert.ok(served.includes(KEEP), 'the live control was not served');
      assert.ok(!served.includes(FILE), 'a restored audit row is served to peers as live metadata');
    });
  });
});
