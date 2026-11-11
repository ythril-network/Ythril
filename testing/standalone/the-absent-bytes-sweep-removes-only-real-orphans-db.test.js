/**
 * The absent-bytes sweep removes the record of a file whose bytes are gone — here, with no tombstone — only when the design's due rule
 * holds, and never otherwise (bundle-70, Q-337, slice S4; owner, 2026-11-11: "Remove meta with the file").
 *
 * ## What it prevents
 *
 * A record whose bytes are gone is counted but cannot be listed, so a person cannot delete it. The owner's answer is that it goes with the
 * bytes. The danger is the record that only LOOKS like an orphan: a metadata-first arrival whose bytes a peer has yet to deliver, a record
 * a restore brought back, a file a re-upload or a same-hash arrival has just put there, a record a move still carries, a delete in flight,
 * every file of a space whose volume is unmounted. A sweep that removes one of those destroys a record somebody still needed, with no way
 * back, and a removal that wrote a TOMBSTONE would make every peer delete its own good copy (convention-ythril-my-instance-is-my-data).
 *
 * ## What is held, one case each
 *
 *  - **stamp**: a pass stamps `bytesAbsentSince` (the pass's `now`) on a row whose bytes are absent, writing nothing else to it (no `seq`, no
 *    `updatedAt`: it is local bookkeeping), and clears the stamp of a row whose bytes are back.
 *  - **removal**: after the window, a pass retires the row — a feed marker carrying `retiredBy: 'bytes-lost'`, or with soft delete the flagged
 *    row carrying it — and the rows derived from it; **no tombstone** is written, none is served or pushed to a peer, **no `file.deleted` webhook** fires,
 *    the file change feed says `{ deleted: true, reason: 'bytes_lost' }` (an explicit delete's item carries no reason).
 *  - **the window**: 1 day for a row with a sha256; a row with NO sha256 (its bytes may still be arriving) waits WAIT_DAYS.
 *  - **mass loss**: a space whose every row is absent, or more than half, removes nothing; exactly half is removed; every recorded row under one
 *    top-level directory absent AND the directory gone (an unmounted volume) removes nothing there, while the same rows in a directory that exists go.
 *  - **holds**: a tombstone at the path (pending or published) and a move that still owes the record keep the row.
 *  - **the race**: a re-upload, or a same-hash arrival, landing between the check and the retire survives it; the audit lists only rows really retired;
 *    a retire that fails for a reason that is not the store's counts nothing.
 *  - **the regression pin**: an explicit delete of an orphan (a person's own act) still writes its tombstone.
 *
 * ## How it is driven
 *
 * Through `sweepExpired(now)` with a later `now` for each pass (`_absent-bytes-sweep.mjs`): never a sleep. The pure rule is
 * `an-absent-bytes-row-is-due-by-one-predicate`. Every case seeds HEALTHY rows beside the orphans, because a space whose every row is absent is held.
 *
 * Red on 8ee92312: nothing stamps, nothing is removed by the sweep, the seam and the operation do not exist; each case asserts the first thing the
 * design does that the base does not (the stamp), so no case is red for an import error.
 *
 * Run: node --test testing/standalone/the-absent-bytes-sweep-removes-only-real-orphans-db.test.js
 * (requires a prior `npm run build -w @ythril/server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { NOW, DAY, WAIT_DAYS, after as at, SHA_ORPHAN, SHA_PRESENT, THE_TWO_PASSES, runPass, passesAt, sweepSteps, resetSweepSteps, sweepOperation, orphan, retired } from './_absent-bytes-sweep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'absentsweep';
const STAMP = NOW.toISOString();
const PEER = Object.freeze({ instanceId: 'absent-peer', instanceLabel: 'Absent peer' });
const JSON_BODY = { 'content-type': 'application/json' };

let acts, loader, meta, files, knownKeys, operation;
const rows = () => acts.door.coll(S, 'files');
const rowOf = (p) => rows().findOne({ _id: p });
const auditRows = () => acts.door.mongo.getDb().collection('audit_log').find({ spaceId: S, operation }).toArray();
const entryOf = async () => (await import('../../server/dist/config/loader.js')).getConfig().spaces.find(s => s.id === S);

/** `n` healthy files: bytes on disk and a row with a hash. Exactly half the recorded rows absent is not mass loss, so a case seeds at least as many as it loses. */
async function healthy(n, prefix = 'ok') {
  for (let i = 0; i < n; i++) await acts.seed(`${prefix}${i}.txt`, { sha256: SHA_PRESENT, seq: 1 });
}
/** Records whose bytes are gone: a row and no file. */
async function lose(...paths) {
  for (const p of paths) await rows().insertOne(orphan(S, p));
}
/** A pass sequence that may throw inside the sweep without failing the case on the way (the case asserts what the rows say). */
const settle = async (...instants) => { try { await passesAt(...instants); } catch { /* a step's failure is read from the rows */ } };

describe('the absent-bytes sweep removes only real orphans (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'absentsweep', space: S });
    loader = await import('../../server/dist/config/loader.js');
    meta = await import('../../server/dist/files/file-meta.js');
    files = acts.files;
    knownKeys = Object.keys(await entryOf());
  });
  after(async () => { await resetSweepSteps(); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    await acts.door.mongo.getDb().collection('audit_log').deleteMany({ spaceId: S }).catch(() => {});
    const entry = await entryOf();
    for (const k of Object.keys(entry).filter(k => !knownKeys.includes(k))) delete entry[k];   // the cursors the last case's passes wrote: this case's scan starts afresh
    loader.getConfig().softDeleteFileMeta = false;
    operation ??= await sweepOperation().catch(() => 'file.absent_bytes.sweep');
  });
  afterEach(async () => { await resetSweepSteps(); loader.getConfig().softDeleteFileMeta = false; });

  describe('the stamp', () => {
    it('a pass stamps a row whose bytes are absent with its own now and writes nothing else to it; a row whose bytes are present is not stamped, and a stale stamp on one is cleared', async () => {
      await healthy(2);
      await rows().updateOne({ _id: 'ok1.txt' }, { $set: { bytesAbsentSince: '2026-01-01T00:00:00.000Z' } });   // bytes are here; the stamp is stale
      await lose('gone.txt');
      const before = await rowOf('gone.txt');

      await runPass(NOW);

      const after = await rowOf('gone.txt');
      assert.equal(after?.bytesAbsentSince, STAMP, `the row whose bytes are gone carries ${JSON.stringify(after?.bytesAbsentSince)}, not the pass's now: the sweep does not stamp`);
      assert.deepEqual({ seq: after.seq, updatedAt: after.updatedAt }, { seq: before.seq, updatedAt: before.updatedAt }, 'the stamp took a seq or an updatedAt: it is local bookkeeping, not an authored write');
      assert.equal((await rowOf('ok0.txt')).bytesAbsentSince, undefined, 'a row whose bytes are present was stamped');
      assert.equal((await rowOf('ok1.txt')).bytesAbsentSince, undefined, 'a stamp on a row whose bytes are present was not cleared');
    });
  });

  describe('the removal', () => {
    it('after the window a pass retires the row and the rows derived from it, leaves the healthy files, and writes NO tombstone: none stored, none served, none pushed', async () => {
      await healthy(3);
      await lose('gone.txt');
      await rows().insertOne({ _id: 'gone.txt#chunk0', spaceId: S, path: 'gone.txt#chunk0', parentFileId: 'gone.txt', tags: [], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' });

      await runPass(NOW);
      assert.equal((await rowOf('gone.txt'))?.bytesAbsentSince, STAMP, 'the first pass did not stamp the row');
      assert.ok(!retired(await rowOf('gone.txt')), 'the row went in the pass that stamped it: no window');
      await runPass(THE_TWO_PASSES[1]);

      const left = await rowOf('gone.txt');
      assert.ok(retired(left), `the record of a file whose bytes are gone is still there a day and an hour after its stamp: ${JSON.stringify(left)}`);
      assert.equal(left.feedMarker, true, 'soft delete is off: the retired row is exactly a feed marker');
      assert.equal(left.retiredBy, 'bytes-lost', 'the marker does not say why the row went (a reader of the feed would take it for a person\'s delete)');
      assert.equal(await rowOf('gone.txt#chunk0'), null, 'the row derived from the removed file stayed');
      for (const p of ['ok0.txt', 'ok1.txt', 'ok2.txt']) {
        assert.ok(!retired(await rowOf(p)) && acts.onDisk(p), `the healthy file ${p} was touched`);
      }
      assert.deepEqual((await acts.raw()).filter(t => t.path === 'gone.txt'), [], 'a tombstone was stored: every peer would delete its own copy');
      const published = await acts.published();
      assert.deepEqual([...published.served, ...published.pushed].filter(p => p === 'gone.txt'), [], 'the removal was published to a peer as a delete');
    });

    it('with soft delete on the row is flagged, stripped, and carries retiredBy bytes-lost, never taken for a person\'s delete', async () => {
      loader.getConfig().softDeleteFileMeta = true;
      await healthy(3);
      await rows().insertOne(orphan(S, 'gone.txt', { description: 'what a person wrote', embeddingStatus: 'complete' }));

      await passesAt(...THE_TWO_PASSES);

      const left = await rowOf('gone.txt');
      assert.ok(left && typeof left.deletedAt === 'string', `the row is not flagged: ${JSON.stringify(left)}`);
      assert.equal(left.retiredBy, 'bytes-lost');
      assert.equal(left.sha256, undefined, 'the flagged row keeps a fingerprint of bytes that are gone');
      assert.equal(left.description, 'what a person wrote', 'a person\'s description was stripped');
      assert.deepEqual((await acts.raw()).filter(t => t.path === 'gone.txt'), [], 'a tombstone was stored');
    });

    it('the change feed says deleted with reason bytes_lost for the swept row, and an explicit delete\'s item carries no reason', async () => {
      const { readFileChanges } = await import('../../server/dist/files/file-changes.js');
      await healthy(3);
      await lose('swept.txt');
      await acts.seed('explicit.txt', { sha256: SHA_PRESENT, seq: 1 });
      await passesAt(...THE_TWO_PASSES);
      assert.ok(retired(await rowOf('swept.txt')), 'fixture: the sweep did not remove the row');
      const gone = await acts.mcp('delete_file', { path: 'explicit.txt' });
      assert.ok(!gone.isError, `fixture: the explicit delete was refused: ${gone.text}`);

      const out = await readFileChanges(S, {});
      assert.ok(out.ok, JSON.stringify(out));
      const item = (p) => out.body.items.find(i => i.path === p);
      assert.deepEqual({ deleted: item('swept.txt')?.deleted, reason: item('swept.txt')?.reason }, { deleted: true, reason: 'bytes_lost' },
        `the feed item of the swept row is ${JSON.stringify(item('swept.txt'))}: a client mirroring the space would delete its own copy, maybe the last one`);
      assert.equal(item('explicit.txt')?.deleted, true);
      assert.equal(item('explicit.txt')?.reason, undefined, 'a person\'s delete carries a reason it must not');
    });

    it('fires no file.deleted webhook and no live event for the removal (the control, a person\'s delete, is the only one announced)', async () => {
      const cap = await acts.webhooks();
      try {
        await healthy(3);
        await lose('quiet.txt');
        await passesAt(...THE_TWO_PASSES);
        assert.ok(retired(await rowOf('quiet.txt')), 'fixture: the sweep did not remove the row');

        const control = await cap.control();
        assert.deepEqual(await cap.pathsOf('file.deleted'), [control], 'a file.deleted webhook named a path other than the control delete: the sweep announced its removal');
        assert.deepEqual(cap.busPathsOf('file.deleted').filter(p => p !== control), [], 'the live bus announced the removal');
      } finally { await cap.close(); }
    });

    it('the audit entry of a batch lists the paths it retired, and a pass that retired nothing writes none', async () => {
      await healthy(3);
      await runPass(NOW);                                   // nothing is absent
      await elapse(300, 'absence window: no audit entry for a pass that removed nothing (the positive control follows in this case)');
      assert.deepEqual(await auditRows(), [], 'a pass that removed nothing was audited');
      await lose('one.txt', 'two.txt');
      await passesAt(NOW, THE_TWO_PASSES[1]);

      await waitFor(async () => (await auditRows()).length >= 1, 5000, 50, 'no audit entry', { what: 'the sweep\'s audit entry' }).catch(() => {});
      const audit = await auditRows();
      assert.equal(audit.length, 1, `a batch that retired rows wrote ${audit.length} audit entries: ${JSON.stringify(audit)}`);
      const said = JSON.stringify(audit[0]);
      assert.ok(said.includes('one.txt') && said.includes('two.txt'), `the audit entry names no paths: ${said}`);
      assert.ok(!audit[0].tokenId, 'the entry names a token: the instance did this work, no request asked');
    });
  });

  describe('the window', () => {
    it('a row with a sha256 is kept at 23 hours and removed after a day', async () => {
      await healthy(2);
      await lose('a.txt');
      await passesAt(NOW, at(DAY - 3_600_000));
      assert.equal((await rowOf('a.txt'))?.bytesAbsentSince, STAMP, 'fixture: the row was not stamped');
      assert.ok(!retired(await rowOf('a.txt')), 'the row went an hour before the window ended');

      await runPass(at(2 * DAY));
      assert.ok(retired(await rowOf('a.txt')), 'the row was not removed two days after its stamp');
    });

    it('a row with NO sha256 (bytes may still be arriving) is not removed at one day or at 29 days, and is removed after WAIT_DAYS', async () => {
      await healthy(2);
      await rows().insertOne(orphan(S, 'arriving.txt'));
      await rows().updateOne({ _id: 'arriving.txt' }, { $unset: { sha256: '' } });

      await passesAt(NOW, at(DAY + 3_600_000));
      assert.equal((await rowOf('arriving.txt'))?.bytesAbsentSince, STAMP, 'fixture: the metadata-first row was not stamped');
      assert.ok(!retired(await rowOf('arriving.txt')), 'a row that never recorded bytes was removed at one day: it is an arrival still waiting for them');
      await runPass(at(29 * DAY));
      assert.ok(!retired(await rowOf('arriving.txt')), 'a row that never recorded bytes was removed at 29 days');
      await runPass(at((WAIT_DAYS + 1) * DAY));
      assert.ok(retired(await rowOf('arriving.txt')), 'a row that never recorded bytes was still there past WAIT_DAYS');
    });
  });

  describe('mass loss', () => {
    it('a space whose every recorded row is absent removes nothing, however long it waits (an unmounted volume reads as every file gone)', async () => {
      await lose('a.txt', 'b.txt', 'c.txt');
      await settle(NOW, at(2 * DAY), at(33 * DAY), at(66 * DAY));
      for (const p of ['a.txt', 'b.txt', 'c.txt']) assert.equal((await rowOf(p))?.bytesAbsentSince, STAMP, `fixture: ${p} was not stamped by the first pass`);
      for (const p of ['a.txt', 'b.txt', 'c.txt']) assert.ok(!retired(await rowOf(p)), `${p} was removed from a space with no file left`);
    });

    it('a one-row space whose row is absent is held', async () => {
      await lose('only.txt');
      await settle(NOW, at(2 * DAY), at(33 * DAY));
      assert.equal((await rowOf('only.txt'))?.bytesAbsentSince, STAMP, 'fixture: the row was not stamped');
      assert.ok(!retired(await rowOf('only.txt')), 'the one row of a space was removed');
    });

    it('more than half absent removes nothing (2 of 3), and exactly half removes them (2 of 4)', async () => {
      await healthy(1);
      await lose('a.txt', 'b.txt');
      await settle(...THE_TWO_PASSES, at(40 * DAY));
      assert.equal((await rowOf('a.txt'))?.bytesAbsentSince, STAMP, 'fixture: the rows were not stamped');
      assert.ok(!retired(await rowOf('a.txt')) && !retired(await rowOf('b.txt')), 'rows were removed from a space that lost more than half');

      await acts.reset();
      const entry = await entryOf();
      for (const k of Object.keys(entry).filter(k => !knownKeys.includes(k))) delete entry[k];
      await healthy(2);
      await lose('c.txt', 'd.txt');
      await passesAt(...THE_TWO_PASSES);
      assert.ok(retired(await rowOf('c.txt')) && retired(await rowOf('d.txt')), 'exactly half absent was held: the boundary is "more than half"');
    });

    it('every recorded row under one top-level directory absent with the directory gone is held as a unit, while the same rows in a directory that exists are removed', async () => {
      await healthy(6);
      await lose('vol/a.txt', 'vol/b.txt', 'vol/c.txt', 'keep/a.txt', 'keep/b.txt', 'keep/c.txt');
      fs.mkdirSync(path.join(acts.rootOf(S), 'keep'), { recursive: true });   // the directory is there; its files are not
      await settle(...THE_TWO_PASSES, at(5 * DAY));

      assert.equal((await rowOf('vol/a.txt'))?.bytesAbsentSince, STAMP, 'fixture: the rows were not stamped');
      for (const p of ['vol/a.txt', 'vol/b.txt', 'vol/c.txt']) assert.ok(!retired(await rowOf(p)), `${p} went though its whole directory is gone (a missing mount)`);
      for (const p of ['keep/a.txt', 'keep/b.txt', 'keep/c.txt']) assert.ok(retired(await rowOf(p)), `${p} was kept though its directory exists and only its files are gone`);
    });
  });

  describe('the holds', () => {
    const tombstoneAt = (p, extra = {}) => ({ _id: `ts-${p}-${Object.keys(extra).join('')}`, spaceId: S, path: p, deletedAt: '2026-08-01T00:00:00.000Z', positionAt: '2026-08-01T00:00:00.000Z', writtenAt: '2026-08-01T00:00:00.000Z', origin: 'relayed', issuer: 'someone', storedVia: 'someone', ...extra });

    it('a published tombstone at the path, and a pending one, keep the row (a delete in flight owns it)', async () => {
      await healthy(4);
      await lose('held.txt', 'pending.txt', 'free.txt');
      await acts.door.coll(S, 'file_tombstones').insertMany([tombstoneAt('held.txt'), tombstoneAt('pending.txt', { pending: true })]);

      await passesAt(...THE_TWO_PASSES);

      assert.equal((await rowOf('free.txt'))?.feedMarker, true, 'fixture: the row with no tombstone was not removed');
      assert.ok(!retired(await rowOf('held.txt')), 'a row with a published tombstone at its path was removed');
      assert.ok(!retired(await rowOf('pending.txt')), 'a row with a pending tombstone at its path was removed');
    });

    it('a move that still owes the record keeps the row at its source', async () => {
      const { pathsCarriedByOwedMoves } = await import('../../server/dist/files/move-markers.js');
      await healthy(4);
      await acts.seed('dest.txt', { sha256: SHA_PRESENT, seq: 1 });         // the moved bytes are at the destination
      await lose('src.txt', 'free.txt');                                   // the record is still at the source
      await acts.door.coll(S, 'file_tombstones').insertOne(tombstoneAt('src.txt', { move: { from: 'src.txt', to: 'dest.txt' } }));
      assert.ok((await pathsCarriedByOwedMoves(S, ['src.txt'])).has('src.txt'), 'fixture: the move is not owed, so the case would hold nothing');

      await passesAt(...THE_TWO_PASSES);

      assert.equal((await rowOf('free.txt'))?.feedMarker, true, 'fixture: the row with no move was not removed');
      assert.ok(!retired(await rowOf('src.txt')), 'a record a begun move still owes its destination was removed');
    });
  });

  describe('the race between the check and the retire', () => {
    it('a re-upload at the path in that interval survives, and the audit lists only the row that was retired', async () => {
      await healthy(3);
      await lose('raced.txt', 'plain.txt');
      let upload;
      (await sweepSteps())({
        beforeRemove: async () => {
          if (upload) return;
          upload = await acts.post('upload', { query: { path: 'raced.txt' }, body: { content: 'a brand new file' }, headers: JSON_BODY });
        },
      });

      await passesAt(...THE_TWO_PASSES);

      assert.ok(upload && upload.code < 300, `fixture: the re-upload inside the interval did not land: ${JSON.stringify(upload?.body)}`);
      const raced = await rowOf('raced.txt');
      assert.ok(!retired(raced), `a file uploaded between the check and the retire was removed with the orphan: ${JSON.stringify(raced)}`);
      assert.ok(acts.onDisk('raced.txt'), 'the re-uploaded bytes are gone');
      assert.ok(retired(await rowOf('plain.txt')), 'fixture: the row nobody touched was not removed');
      await waitFor(async () => (await auditRows()).length >= 1, 5000, 50, 'no audit entry', { what: 'the sweep\'s audit entry' }).catch(() => {});
      const said = JSON.stringify(await auditRows());
      assert.ok(said.includes('plain.txt'), `the audit entry misses the row that was retired: ${said}`);
      assert.ok(!said.includes('raced.txt'), `the audit entry lists a row that survived: ${said}`);
    });

    it('bytes of the SAME hash that a peer delivers in that interval save the row (the arrival writes no new row, so it must clear the stamp)', async () => {
      await healthy(3);
      await lose('arrived.txt');
      let arrived = false;
      (await sweepSteps())({
        beforeRemove: async () => {
          if (arrived) return;
          arrived = true;
          await files.writeFile(S, 'arrived.txt', 'bytes of the recorded hash');
          await meta.recordArrivedFile(S, 'arrived.txt', 12, SHA_ORPHAN, PEER);
        },
      });

      await passesAt(...THE_TWO_PASSES);

      assert.ok(arrived, 'fixture: the arrival inside the interval never ran (the sweep never reached the retire)');
      assert.ok(!retired(await rowOf('arrived.txt')), 'a record whose bytes arrived between the check and the retire was removed');
      assert.ok(acts.onDisk('arrived.txt'), 'the arrived bytes are gone');
    });

    it('a retire that fails for a reason that is not the store\'s counts nothing: the row stays and the audit names no path', async () => {
      await healthy(3);
      await lose('stuck.txt');
      const proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
      const ops = ['deleteOne', 'deleteMany', 'updateOne', 'updateMany', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete', 'replaceOne'];
      const originals = Object.fromEntries(ops.map(op => [op, proto[op]]));
      let broken = false;
      (await sweepSteps())({
        beforeRemove: async () => {
          broken = true;
          for (const op of ops) proto[op] = function broke(...args) { if (this.collectionName === `${S}_files`) throw new Error('a failure that is not the store\'s'); return originals[op].apply(this, args); };
        },
      });
      try { await settle(...THE_TWO_PASSES); } finally { for (const op of ops) proto[op] = originals[op]; }

      assert.ok(broken, 'fixture: the sweep never reached the retire, so no write was broken');
      assert.ok(!retired(await rowOf('stuck.txt')), 'fixture: the row went though every write to the collection was broken');
      await elapse(300, 'absence window: the audit write is not awaited by the pass');
      assert.ok(!JSON.stringify(await auditRows()).includes('stuck.txt'), 'the audit entry counts a row the retire never took');
    });
  });

  describe('regression pin: an explicit delete of an orphan keeps its tombstone', () => {
    it('delete_file of a record whose bytes are gone writes the tombstone peers read (the person\'s own act; only the sweep is silent)', async () => {
      await healthy(2);
      await lose('mine.txt');

      const gone = await acts.mcp('delete_file', { path: 'mine.txt' });

      assert.ok(!gone.isError, `the explicit delete of an orphan was refused: ${gone.text}`);
      assert.ok(retired(await rowOf('mine.txt')));
      assert.equal((await acts.raw()).filter(t => t.path === 'mine.txt').length, 1, 'an explicit delete of an orphan wrote no tombstone: a peer would restore the file');
    });
  });
});
