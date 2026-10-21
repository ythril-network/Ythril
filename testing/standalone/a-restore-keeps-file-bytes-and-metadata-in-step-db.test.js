/**
 * After a restore, a file's metadata and its bytes agree: every metadata row has the bytes it describes, and every file's bytes have a
 * row (bundle-157, Q-557).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * A backup (`dumpDatabase`) carries the database only; the bytes under `<DATA_ROOT>/files` are not in it. A restore therefore puts back
 * the metadata of the backup's moment over the bytes of THIS moment, and the two halves of one file disagree in three ways:
 *
 * - a file REWRITTEN after the backup: the row says the old size and sha256, the bytes are the new ones;
 * - a file DELETED after the backup: the row comes back, the bytes do not exist — a file listing, a download and an embed all name it;
 * - a file CREATED after the backup: the restore removed its row and left its bytes — space the quota counts and no listing shows.
 *
 * Nothing errors at any point: the restore reports success, and the disagreement is found by whoever opens the file.
 *
 * ## What is asserted
 *
 * Through the server's own tool door (`write_file`, `delete_file`: the sequence every file door shares, bytes and metadata together),
 * `keep.txt` and `gone.txt` are written, the database is dumped, then `keep.txt` is rewritten, `gone.txt` deleted and `new.txt` written,
 * and the database is restored over the live one. Then, for the space's metadata rows (the ones that name bytes, not a chunk or other
 * derived record) and the files under the space's directory:
 *
 * - every row's bytes EXIST;
 * - every row's size and sha256 are those of the bytes on disk;
 * - every file on disk has a row.
 *
 * The rows and the disk are DERIVED (read from the collection and walked from the directory), so a fourth file in the fixture is
 * judged too. The restore's own step that closes this (an act that reconciles the two halves) is what turns these green.
 *
 * Run: `node --test testing/standalone/a-restore-keeps-file-bytes-and-metadata-in-step-db.test.js` (a Mongo the harness accepts; a prior
 * `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'restorefilestep';
const SPACE = 'restorefiles';

/** Every file under `dir`, as a path relative to it with forward slashes. */
function walk(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]));
}

describe('a restore keeps a file\'s bytes and its metadata in step', { skip }, () => {
  let door, dumpDir, filesDir;

  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: [{ id: SPACE, label: SPACE, folders: [] }] });
    filesDir = join(process.env['DATA_ROOT'], 'files', SPACE);
    const { dumpDatabase } = await import('../../server/dist/db/dump.js');
    const { restoreDatabase } = await import('../../server/dist/db/restore.js');
    const uri = testMongoUri(`ythril_harness_${SUITE}`);
    dumpDir = mkdtempSync(join(tmpdir(), 'ythril-restore-files-'));

    const ok = async (name, args) => {
      const r = await door.call(name, { space: SPACE, ...args });
      assert.equal(r.status, 200, `the fixture's ${name} ${args.path} was refused: ${r.text}`);
    };

    // The backup's moment: two files, bytes and metadata written together by the server's own path.
    await ok('write_file', { path: 'keep.txt', content: 'one' });
    await ok('write_file', { path: 'gone.txt', content: 'bravo bravo' });
    await dumpDatabase(uri, dumpDir);

    // After it: one file rewritten, one deleted, one new.
    await ok('write_file', { path: 'keep.txt', content: 'two, and a good deal longer than before' });
    await ok('delete_file', { path: 'gone.txt' });
    await ok('write_file', { path: 'new.txt', content: 'written after the backup' });

    await restoreDatabase(uri, dumpDir);
  });

  after(async () => {
    await door?.close();
    if (dumpDir && existsSync(dumpDir)) rmSync(dumpDir, { recursive: true, force: true });
  });

  /** The metadata rows that name bytes of their own (a chunk or a derived record has no file of its own). */
  const rows = async () => (await door.coll(SPACE, 'files').find({ parentFileId: { $exists: false } }).toArray());

  it('control: the bytes on disk are those the fixture left (keep.txt rewritten, new.txt added, gone.txt deleted) and a metadata row exists', async () => {
    assert.deepEqual(walk(filesDir).sort(), ['keep.txt', 'new.txt'], 'the fixture is wrong: keep.txt and new.txt are the files left on disk');
    assert.ok((await rows()).length >= 1, 'the restore left no metadata row at all: the derivation below would pass over nothing');
  });

  it('every metadata row has its bytes on disk', async () => {
    const missing = (await rows()).map(r => r.path).filter(p => !existsSync(join(filesDir, p)));
    assert.deepEqual(missing, [], `these files are listed with metadata and have no bytes: ${missing.join(', ')}`);
  });

  it('every metadata row\'s size and sha256 are those of the bytes', async () => {
    const disagree = [];
    for (const r of await rows()) {
      const abs = join(filesDir, r.path);
      if (!existsSync(abs)) continue;   // the row above says so
      const bytes = readFileSync(abs);
      if (statSync(abs).size !== r.sizeBytes) disagree.push(`${r.path}: row says ${r.sizeBytes} bytes, disk has ${statSync(abs).size}`);
      else if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) disagree.push(`${r.path}: row's sha256 is not the bytes' sha256`);
    }
    assert.deepEqual(disagree, [], `a file's row describes bytes that are not there: ${disagree.join('; ')}`);
  });

  it('every file on disk has a metadata row', async () => {
    const named = new Set((await rows()).map(r => r.path));
    const orphans = walk(filesDir).filter(p => !named.has(p));
    assert.deepEqual(orphans, [], `these bytes have no metadata row, so no listing shows them: ${orphans.join(', ')}`);
  });
});
