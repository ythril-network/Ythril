/**
 * A restore that carries a file's derived rows leaves that file with exactly those rows — `Q-251`, 5.6.3.
 *
 * ## The defect
 *
 * A file's derived rows (its chunks, `parentFileId` naming it) live in `<space>_files` beside the file row. The admin
 * import restores by REPLACE (`writeArrivals(…, { restore: true })`), one row per id — so a stored file that had been
 * chunked into more pieces than the backup holds kept the extra chunks after the restore: chunks of text the restored
 * file no longer has, still matched by recall and still pointing at the file.
 *
 * ## The rule, and its edges
 *
 *  - **A file the backup carries, with derived rows**: after the restore its derived rows are exactly the backup's.
 *  - **A file the backup carries with NO derived rows at all** (a parents-only payload, which a hand-made backup can
 *    be): its stored derived rows are left alone — the payload says nothing about them, so it never wipes them.
 *  - **A file the backup does not carry**: not the restore's to change; its rows are left alone.
 *  - **A write that fails**: nothing is deleted. The cleanup follows only what landed.
 *
 * Driven through `importDocuments`, the importer the admin route calls.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-restore-replaces-a-files-derived-rows-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'restore-chunks';
let door, importDocuments;

const file = (id, seq = 5) => build.filemeta(S, id, seq);
const chunk = (parent, n, seq = 5) => ({ ...build.filemeta(S, `${parent}#chunk-${n}`, seq), parentFileId: parent });
/** The ids of every derived row stored for `parent`, sorted. */
const derivedOf = async (parent) =>
  (await door.coll(S, 'files').find({ parentFileId: parent }, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
const ids = (rows) => rows.map(r => r._id).sort();

describe('a restore leaves a file it carries with exactly the backup\'s derived rows', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'restorechunks', spaces: [{ id: S, label: 'Restore chunks', folders: [] }] });
    ({ importDocuments } = await import('../../server/dist/api/admin-import.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('a stored file with more chunks than the backup holds keeps exactly the backup\'s chunks', async () => {
    await door.coll(S, 'files').insertMany([file('f.md'), ...[0, 1, 2, 3].map(n => chunk('f.md', n))]);
    const backupChunks = [chunk('f.md', 0, 9), chunk('f.md', 1, 9)];
    const res = await importDocuments(S, { files: [file('f.md', 9), ...backupChunks] });
    assert.equal(res.results.files.errors, 0, JSON.stringify(res.results.files));
    assert.deepEqual(await derivedOf('f.md'), ids(backupChunks),
      'the restored file kept chunks the backup does not hold: text the file no longer has, still matched and still '
      + 'pointing at it');
    assert.equal((await door.coll(S, 'files').findOne({ _id: 'f.md' }))?.seq, 9, 'the file row was not restored');
  });

  it('control: a backup file whose payload carries no derived rows at all leaves the stored chunks alone', async () => {
    const stored = [0, 1, 2].map(n => chunk('p.md', n));
    await door.coll(S, 'files').insertMany([file('p.md'), ...stored]);
    await importDocuments(S, { files: [file('p.md', 9)] });
    assert.deepEqual(await derivedOf('p.md'), ids(stored), 'a parents-only payload wiped the file\'s chunks');
  });

  it('control: a file the backup does not carry is not the restore\'s to change', async () => {
    const other = [0, 1].map(n => chunk('other.md', n));
    await door.coll(S, 'files').insertMany([file('f.md'), chunk('f.md', 0), file('other.md'), ...other]);
    await importDocuments(S, { files: [file('f.md', 9), chunk('f.md', 0, 9)] });
    assert.deepEqual(await derivedOf('other.md'), ids(other), 'the restore deleted rows of a file it does not carry');
  });

  it('control: a restore whose write fails deletes nothing', async () => {
    const stored = [0, 1, 2].map(n => chunk('w.md', n));
    await door.coll(S, 'files').insertMany([file('w.md'), ...stored]);
    // Every write to the files collection fails below the driver API, with an error that is not the document's.
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const originals = { bulkWrite: proto.bulkWrite, updateOne: proto.updateOne, replaceOne: proto.replaceOne };
    let injected = 0;
    for (const m of Object.keys(originals)) {
      proto[m] = function faulty(...args) {
        if (this.collectionName !== `${S}_files`) return originals[m].apply(this, args);
        injected++;
        return Promise.reject(new Error(`injected: ${S}_files ${m} failed`));
      };
    }
    let res;
    try {
      res = await importDocuments(S, { files: [file('w.md', 9), chunk('w.md', 0, 9)] });
    } finally { Object.assign(proto, originals); }
    assert.ok(injected > 0, 'fixture check: no write to the files collection was attempted, so none failed');
    assert.ok(res.results.files.errors > 0, `fixture check: the write did not fail: ${JSON.stringify(res.results.files)}`);
    assert.deepEqual(await derivedOf('w.md'), ids(stored), 'a restore whose write failed deleted the file\'s chunks');
  });
});
