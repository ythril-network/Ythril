/**
 * A delete's tombstone is settled from the disk once its links are gone, and its second link pass is bounded by an instant taken BEFORE its rows
 * go (bundle-113 pre-ship sweep, S1 and S2/DI-3).
 *
 * ## The defects it closes
 *
 *  - **S1: the single file's tombstone was confirmed on the strength of the unlink.** The link step runs between the unlink and the tombstone's
 *    publication, and it is a database round trip; a file uploaded at the path in that window has bytes again, and a tombstone published over
 *    them tells every peer to delete a live file. The directory cascade settled its sidecars' tombstones from the disk; the single file's did not.
 *    Now the tombstone is published for a path still without bytes and DROPPED for one that has them.
 *  - **S2: the second link pass read its bound AFTER the row's removal returned.** A re-upload's link can only be written after the row went,
 *    so a stamp taken after the removal is later than that link, and the pass took it. Taken immediately before the removal, the stamp is
 *    earlier than any link the re-upload writes, for one file and for a directory.
 *
 * ## How the windows are reached
 *
 * `setDeleteStepsForTest({ afterLinks, afterRow })` on `files/delete-cascade.ts`: `afterLinks` runs after the delete's links went and before its
 * tombstone is settled (the interval a re-upload bytes can land in), `afterRow` runs once the row (the rows) went and before the second link pass
 * (the interval a re-upload's first link can land in). Production passes none.
 *
 * Run: node --test testing/standalone/a-delete-settles-its-tombstone-from-the-disk-and-stamps-before-its-rows-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'deletewindows';
const nowIso = () => new Date().toISOString();
const later = () => new Promise(r => setTimeout(r, 15));

let acts, cascade;

describe('a delete\'s windows: the tombstone from the disk, the stamp before the rows (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'deletewindows', space: S });
    cascade = await import('../../server/dist/files/delete-cascade.js');
  });
  after(async () => { cascade?.setDeleteStepsForTest?.(null); await acts?.close(); });
  beforeEach(async () => { await acts.reset(); await acts.links.reset(); });
  afterEach(() => { cascade.setDeleteStepsForTest(null); });

  it('control: an ordinary delete publishes its tombstone', async () => {
    await acts.seed('plain.txt');
    const a = await acts.rest('DELETE', { path: 'plain.txt' });
    assert.ok(!acts.failed(a), `the delete was refused: ${JSON.stringify(a.body)}`);
    assert.deepEqual((await acts.published()).served, ['plain.txt'], 'a delete with no race did not publish its tombstone');
  });

  it('S1: a file uploaded at the path while the links were being removed keeps its bytes, and no peer is told the path is deleted', async () => {
    await acts.seed('raced.txt');
    await acts.links.put('raced.txt', 'e1', 'self');
    let reached = false;
    cascade.setDeleteStepsForTest({
      afterLinks: async ({ path }) => { reached = true; await acts.files.writeFile(S, path, 'the file uploaded again'); },
    });

    await acts.rest('DELETE', { path: 'raced.txt' });

    assert.equal(reached, true, 'fixture: the seam after the link step was never reached');
    assert.equal(acts.onDisk('raced.txt'), true, 'fixture: the re-upload\'s bytes are gone');
    const published = await acts.published();
    assert.deepEqual(published.served, [], 'a tombstone was served for a path that has bytes again: a peer deletes the live file');
    assert.deepEqual(published.pushed, [], 'a tombstone was pushed for a path that has bytes again');
    assert.deepEqual((await acts.raw()).filter(t => t.path === 'raced.txt' && !t.pending), [], 'a published tombstone is stored for a path that has bytes');
  });

  it('S2: a link a re-upload writes after the file\'s row went is not taken by the second pass', async () => {
    await acts.seed('again.txt');
    const old = await acts.links.put('again.txt', 'e-old', 'self');
    let fresh;
    cascade.setDeleteStepsForTest({
      afterRow: async ({ path }) => { await later(); fresh = await acts.links.put(path, 'e-new', 'self', nowIso()); },
    });

    const a = await acts.rest('DELETE', { path: 'again.txt' });

    assert.ok(!acts.failed(a), `the delete was refused: ${JSON.stringify(a.body)}`);
    assert.ok(fresh, 'fixture: the seam after the row was never reached');
    assert.deepEqual(await acts.links.idsUnder('again.txt'), [fresh], 'the second pass took the link the re-upload wrote after the row went (or left the one the delete owed)');
    assert.ok(!(await acts.links.idsUnder('again.txt')).includes(old), 'the link written before the delete stayed');
  });

  it('S2, a directory: a link written for a file of the directory after the rows went is not taken either', async () => {
    await acts.seed('dir/a.txt');
    await acts.seed('dir/b.txt');
    const old = await acts.links.put('dir/a.txt', 'e-old', 'self');
    let fresh;
    cascade.setDeleteStepsForTest({
      afterRow: async () => { await later(); fresh = await acts.links.put('dir/a.txt', 'e-new', 'self', nowIso()); },
    });

    const a = await acts.rest('DELETE', { path: 'dir' }, { confirm: true });

    assert.ok(!acts.failed(a), `the delete was refused: ${JSON.stringify(a.body)}`);
    assert.ok(fresh, 'fixture: the seam after the rows was never reached');
    const left = await acts.links.idsUnder('dir');
    assert.ok(!left.includes(old), 'the link written before the delete stayed');
    assert.deepEqual(left, [fresh], 'the directory\'s second pass took the link written after its rows went');
  });
});
