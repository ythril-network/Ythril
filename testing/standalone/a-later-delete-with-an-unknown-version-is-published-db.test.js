/**
 * A delete whose version could not be read is published, never dropped on the strength of a clock (bundle-88, Q-414).
 *
 * ## The defect
 *
 * `covers()` (`files/tombstones.ts`) lets an own PUBLISHED tombstone replace a pending one written before it. When both name a
 * version of the file (`rowSeq`) the published one must not be below the pending one's; when either named none, it covered on
 * clock order alone. A pending tombstone names no version for two reasons that were not told apart: the path had no row, or the
 * read of the rows FAILED. So: delete v1 (pending t1), upload v2, delete again with the row read failing (t2, no version);
 * t1 is published first; t2 then finds an own publication written after it and is dropped. The file's v2 is gone here, no peer is
 * ever told, and a peer that holds v2 keeps it for good.
 *
 * ## The rule this file states
 *
 * Per pending candidate `c` and own publication `p` written after it: a candidate whose version read failed is always published;
 * both versioned, `p` covers when it is not below `c`; `c` versioned and `p` not, `p` does not cover; neither versioned (the path
 * had no row on either side, so no version was uploaded in between), `p` covers. Asked through `confirmFileTombstones`, the way the
 * act's own publish asks it; `covers` stays private.
 *
 * ## Seen red
 *
 * On the base (1e430410c): the unknown-version delete and the versioned-over-unversioned delete are dropped (one tombstone served
 * where two are owed).
 *
 * Run: node --test testing/standalone/a-later-delete-with-an-unknown-version-is-published-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'unknownver';
const FILES = `${S}_files`;

let acts, tombstones, cursorProto, realToArray, readFailsOnce;

const unlink = (p) => fs.rmSync(path.join(acts.root(), p), { force: true });
const servedFor = async (p) => (await acts.served()).filter(t => t.path === p);
const pendingFor = async (p) => (await acts.raw()).filter(t => t.pending && t.path === p);

describe('a delete whose version could not be read is published', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'unknownver', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
    let proto = Object.getPrototypeOf(acts.door.mongo.col('probe').find({}));
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'toArray')) proto = Object.getPrototypeOf(proto);
    assert.ok(proto, 're-anchor: no prototype of a find cursor defines toArray');
    cursorProto = proto;
    realToArray = proto.toArray;
    // The next read of the space's file rows fails, as a read the store could not answer does.
    cursorProto.toArray = async function failing(...args) {
      if (readFailsOnce && this.namespace?.collection === FILES) {
        readFailsOnce = false;
        throw Object.assign(new Error('read of the file rows failed (test fault)'), { code: 'EIO' });
      }
      return realToArray.apply(this, args);
    };
  });
  after(async () => {
    if (cursorProto) cursorProto.toArray = realToArray;
    await acts?.close();
  });
  beforeEach(async () => { readFailsOnce = false; await acts.reset(); });
  afterEach(() => { readFailsOnce = false; });

  it('delete v1, upload v2, delete again with the row read failing: the later delete is published beside the first', async () => {
    await acts.seed('a.txt', { seq: 1 });
    const first = await tombstones.writePendingFileTombstones(S, ['a.txt']);
    assert.equal(first.docs[0]?.rowSeq, 1, 'the first delete did not read the version it erases — not the case');
    unlink('a.txt');
    // The path is uploaded again as v2 and deleted again, and this delete cannot read the row.
    await acts.door.coll(S, 'files').updateOne({ _id: 'a.txt' }, { $set: { seq: 2 } });
    await acts.files.writeFile(S, 'a.txt', 'uploaded again');
    readFailsOnce = true;
    const later = await tombstones.writePendingFileTombstones(S, ['a.txt']);
    assert.equal(readFailsOnce, false, 'the row read was never reached — the fault injected nothing');
    assert.equal(later.docs[0]?.rowSeq, undefined, 'the failed read still produced a version');
    unlink('a.txt');

    // The first delete is published after the later one was written; then the later one is.
    await tombstones.confirmFileTombstones(first);
    await tombstones.confirmFileTombstones(later);

    const served = await servedFor('a.txt');
    assert.equal(served.length, 2,
      `the later delete (of v2, version unread) was dropped on clock order: a peer holding v2 is never told (${JSON.stringify(served.map(t => t.rowSeq))})`);
    assert.deepEqual(await pendingFor('a.txt'), [], 'a pending tombstone was left behind');
  });

  it('neither delete names a version (the path had no row): the later one is still covered, one tombstone', async () => {
    await acts.files.writeFile(S, 'n.txt', 'no row');
    const first = await tombstones.writePendingFileTombstones(S, ['n.txt']);
    const later = await tombstones.writePendingFileTombstones(S, ['n.txt']);
    assert.equal(first.docs[0]?.rowSeq, undefined);
    assert.equal(later.docs[0]?.rowSeq, undefined);
    unlink('n.txt');
    await tombstones.confirmFileTombstones(first);
    await tombstones.confirmFileTombstones(later);
    assert.equal((await servedFor('n.txt')).length, 1, 'two deletes of a path that had no row on either side were both published');
    assert.deepEqual(await pendingFor('n.txt'), []);
  });

  it('the later delete names a version and the published one names none: the later one is published', async () => {
    await acts.files.writeFile(S, 'v.txt', 'no row yet');
    const first = await tombstones.writePendingFileTombstones(S, ['v.txt']);
    assert.equal(first.docs[0]?.rowSeq, undefined);
    unlink('v.txt');
    // A version of the file now exists, and is deleted.
    await acts.seed('v.txt', { seq: 3 });
    const later = await tombstones.writePendingFileTombstones(S, ['v.txt']);
    assert.equal(later.docs[0]?.rowSeq, 3);
    unlink('v.txt');
    await tombstones.confirmFileTombstones(first);
    await tombstones.confirmFileTombstones(later);
    const served = await servedFor('v.txt');
    assert.equal(served.length, 2, 'a delete of a version the published one never named was dropped on clock order');
    assert.ok(served.some(t => t.rowSeq === 3));
  });

  it('both versioned: a published delete at or above the later one covers it, one below does not', async () => {
    await acts.seed('w.txt', { seq: 5 });
    const high = await tombstones.writePendingFileTombstones(S, ['w.txt']);
    unlink('w.txt');
    await acts.door.coll(S, 'files').updateOne({ _id: 'w.txt' }, { $set: { seq: 4 } });
    const low = await tombstones.writePendingFileTombstones(S, ['w.txt']);
    assert.equal(high.docs[0]?.rowSeq, 5);
    assert.equal(low.docs[0]?.rowSeq, 4);
    await tombstones.confirmFileTombstones(high);
    await tombstones.confirmFileTombstones(low);
    assert.equal((await servedFor('w.txt')).length, 1, 'a delete of v4 was published beside a published delete of v5');
  });
});
