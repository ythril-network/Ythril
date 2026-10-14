/**
 * A directory deleted where a stopped move put it takes the records it left at its source — in a number of commands that does not
 * grow with the files it holds (Q-345).
 *
 * ## The rule
 *
 * A move a store failure stopped after its bytes leaves the directory's files at the destination and their records at the source,
 * with the move's marker. Deleting the directory at the destination removes those records too, or the source lists files that have
 * no bytes anywhere and no delete reaches. The removal is the directory delete's own, by prefix: the jobs, the conversion artefacts
 * and the cached hashes of the whole subtree, then its rows — a statement per kind of leaving, not per file.
 *
 * ## What is asserted
 *
 * - Every record at the source is gone afterwards (the stopped move held one record per file), and so are the destination's.
 * - The commands the delete issues do not grow with the number of files the directory holds.
 * - A store failure in that removal fails the delete (`503`) with the bytes where they were, and the retry then completes it: the
 *   delete stays deletable, which is what the cascade's `failure: 'throw'` means.
 * - (Q-464) Every file holds a link this instance wrote, and the delete removes them with the records — at the source and at the
 *   destination — and clears the move's marker. The commands still do not grow with the files: the links go through the one batched
 *   remover, a command per chunk (`READ_CHUNK` ids) and never one per file; a directory of more files than one chunk holds is
 *   asserted on its own, because a remover that is bounded only below its chunk passes every smaller case.
 *
 * Run: node --test testing/standalone/a-directory-deleted-where-a-move-put-it-takes-its-source-records-in-bounded-commands-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';
import fs from 'node:fs';
import path from 'node:path';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'dirowedmove';
const FILES = `${S}_files`;

let acts, F, faults, tombstones, markerMod, READ_CHUNK;

const row = (p) => acts.door.coll(S, 'files').findOne({ _id: p });
const body = (a) => JSON.stringify(a.body ?? a.text);
const names = (dir, n) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.txt`);

/**
 * A directory move a store failure stopped after its bytes: `n` files at `to`, their records still at `from`, the marker kept.
 * The failure is in the records' re-key, so every step before it ran.
 */
async function directoryMoveStoppedAfterItsBytes(from, to, n) {
  for (const f of names(from, n)) await acts.seed(f);
  // A link of this instance's from each file: what a delete has to take with the record, a command per chunk and not per file.
  await acts.links.putMany(names(from, n), 'e1', 'self');
  faults.fail('deleteMany', FILES, F.storeGone.single);
  const a = await acts.move('REST', from, to);
  assert.equal(acts.statusOf(a), 503, `the move was not stopped by the store: ${body(a)}`);
  faults.clear();
  assert.ok(names(to, n).every(f => acts.onDisk(f)) && !acts.onDisk(from), 'the bytes did not move — the case is not the one a stopped move leaves');
  for (const f of names(from, n)) assert.ok(await row(f), `the record of ${f} is not at the source — the case is not the one a stopped move leaves`);
}

describe('a directory deleted where a stopped move put it', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'dirowedmove', space: S, monitorCommands: true });
    F = await driverWriteFailures('ythril_harness_dirowedmove');
    tombstones = await import('../../server/dist/files/tombstones.js');
    markerMod = await import('../../server/dist/files/move-markers.js');
    ({ READ_CHUNK } = await import('../../server/dist/db/read-by-id.js'));
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteOne', 'deleteMany']);
  });
  after(async () => {
    faults?.restore();
    await acts?.close();
  });
  beforeEach(async () => {
    faults.clear();
    await acts.reset();
    await acts.links.reset();
  });
  afterEach(() => faults.clear());

  it('leaves no record at the source, and issues the same commands whatever number of files it holds', async () => {
    const counts = [];
    for (const n of [3, 12, 36]) {
      const from = `d${n}/src`;
      const to = `d${n}/dst`;
      await directoryMoveStoppedAfterItsBytes(from, to, n);
      const commands = await acts.door.commandsDuring(async () => {
        const del = await acts.rest('DELETE', { path: to }, { confirm: true });
        assert.ok(!acts.failed(del), `the delete of the directory where the move put it was refused: ${body(del)}`);
      });
      counts.push({ n, commands: commands.length });
      for (const f of names(from, n)) assert.equal(await row(f), null, `the record of ${f} is still at the source`);
      for (const f of names(to, n)) assert.equal(await row(f), null, `the record of ${f} is still at the destination`);
      assert.equal(acts.onDisk(to), false, 'the directory is still on disk');
      assert.deepEqual([await acts.links.idsUnder(from), await acts.links.idsUnder(to)], [[], []], `a link of the ${n} files is still held, at the source or the destination`);
      assert.equal(await markerMod.moveMarkerOf(S, from, to), undefined, 'the marker of the stopped move outlived the delete');
    }
    const [few, , many] = counts;
    assert.ok(many.commands - few.commands <= 2,
      `deleting a directory of ${many.n} files issued ${many.commands} commands, one of ${few.n} issued ${few.commands}: the cost grows with the files. ${JSON.stringify(counts)}`);
  });

  it('a directory of more files than one chunk holds is deleted, links and all, in commands that do not grow with the files', async () => {
    assert.ok(Number.isInteger(READ_CHUNK) && READ_CHUNK > 1, 'db/read-by-id.ts exports no READ_CHUNK: the chunk the link remover is bounded by is not found');
    const n = READ_CHUNK + 20;
    const dir = 'big';
    const paths = names(dir, n);
    // The files are placed directly (a record and its bytes each): the case is the delete, not a thousand uploads.
    fs.mkdirSync(path.join(acts.root(), dir), { recursive: true });
    for (const p of paths) fs.writeFileSync(path.join(acts.root(), p), 'x');
    await acts.door.coll(S, 'files').insertMany(paths.map(p => ({ _id: p, spaceId: S, path: p, sizeBytes: 1, tags: [],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })));
    const own = await acts.links.putMany(paths, 'e1', 'self');
    const theirs = await acts.links.putMany(paths.slice(0, 3), 'e3', 'peer');
    assert.equal((await acts.links.idsUnder(dir)).length, own.length + theirs.length, 'fixture: the links were not seeded');

    const commands = await acts.door.commandsDuring(async () => {
      const del = await acts.rest('DELETE', { path: dir }, { confirm: true });
      assert.ok(!acts.failed(del), `the delete of ${n} files was refused: ${body(del)}`);
    });

    assert.equal(acts.onDisk(dir), false, 'fixture: the directory was not deleted');
    assert.deepEqual(await acts.links.idsUnder(dir), [...theirs].sort(), 'the links this instance wrote outlived the delete (or a link another instance wrote was removed)');
    assert.deepEqual(await acts.links.tombstoned(), [...own].sort(), 'a removed link has no tombstone');
    // A remover that asks about one file at a time issues a command or more per file; one that is bounded by its chunk issues a few per
    // chunk. A tenth of the files is far above the second and far below the first.
    assert.ok(commands.length < n / 10,
      `deleting ${n} files with a link each issued ${commands.length} commands: the cost grows with the files, not with the chunks of ${READ_CHUNK}`);
  });

  it('a store failure in the removal of the source records fails the delete with the bytes in place, and the retry completes it', async () => {
    const from = 'fail/src';
    const to = 'fail/dst';
    await directoryMoveStoppedAfterItsBytes(from, to, 4);
    faults.fail('deleteMany', FILES, F.storeGone.single);
    const first = await acts.rest('DELETE', { path: to }, { confirm: true });
    assert.equal(acts.statusOf(first), 503, `the delete was not failed by the store: ${body(first)}`);
    assert.ok(names(to, 4).every(f => acts.onDisk(f)), 'the bytes went although the removal of the source records failed');
    faults.clear();
    const retry = await acts.rest('DELETE', { path: to }, { confirm: true });
    assert.ok(!acts.failed(retry), `the retry of the delete was refused: ${body(retry)}`);
    for (const f of names(from, 4)) assert.equal(await row(f), null, `the record of ${f} is still at the source`);
    assert.equal(acts.onDisk(to), false, 'the directory is still on disk');
  });
});
