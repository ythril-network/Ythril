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

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'dirowedmove';
const FILES = `${S}_files`;

let acts, F, faults;

const row = (p) => acts.door.coll(S, 'files').findOne({ _id: p });
const body = (a) => JSON.stringify(a.body ?? a.text);
const names = (dir, n) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.txt`);

/**
 * A directory move a store failure stopped after its bytes: `n` files at `to`, their records still at `from`, the marker kept.
 * The failure is in the records' re-key, so every step before it ran.
 */
async function directoryMoveStoppedAfterItsBytes(from, to, n) {
  for (const f of names(from, n)) await acts.seed(f);
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
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteOne', 'deleteMany']);
  });
  after(async () => {
    faults?.restore();
    await acts?.close();
  });
  beforeEach(async () => { faults.clear(); await acts.reset(); });
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
    }
    const [few, , many] = counts;
    assert.ok(many.commands - few.commands <= 2,
      `deleting a directory of ${many.n} files issued ${many.commands} commands, one of ${few.n} issued ${few.commands}: the cost grows with the files. ${JSON.stringify(counts)}`);
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
