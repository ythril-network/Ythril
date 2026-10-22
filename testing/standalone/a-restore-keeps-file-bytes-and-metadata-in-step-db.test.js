/**
 * After a restore, the report names every file whose bytes and metadata no longer agree (bundle-157 Q-557 confirmed it; bundle-111 closes it
 * by REPORTING, design rev 3 step 9 and the owner decision parked as D-55).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * A backup carries the database only; the bytes under `<DATA_ROOT>/files` are not in it. A restore therefore puts back the metadata of the
 * backup's moment over the bytes of THIS moment, and the two halves of one file disagree in three ways:
 *
 * - a file REWRITTEN after the backup: the row says the old size and sha256, the bytes are the new ones (`stale_row`);
 * - a file DELETED after the backup: the row comes back, the bytes do not exist (`row_without_bytes`);
 * - a file CREATED after the backup: the restore removed its row and left its bytes (`missing_row`).
 *
 * Nothing errored at any point, and the disagreement was found by whoever opened the file (this file's first version, a2d92e3a, was red on
 * 99083860 by asserting the consistency itself). What the restore now owes is to SAY which files: the per-space report of
 * `GET /api/admin/data/restore` names each by class and path. Making them consistent waits on the owner's decision (report only, restore
 * the bytes with the database, or reconcile), so the consistency assertions of the first version are not here.
 *
 * ## What is asserted
 *
 * Through the server's own tool door (`write_file`, `delete_file`: bytes and metadata written together), `keep.json` and `gone.json` are
 * written, the database is backed up, then `keep.json` is rewritten, `gone.json` deleted and `new.json` written, and the backup is restored
 * THROUGH THE RESTORE ACT (`db/restore-act.ts`; `restoreDatabase` of `db/restore.ts` is the migrate's now, not the online door). Then the
 * disagreements are DERIVED from the space's rows and the files under its directory, by the three rules above, and the space's `files`
 * report must equal them, class by class, path by path: a fourth file in the fixture is judged too, and a report that names too much
 * fails as surely as one that names too little. The derivation must find at least the three the fixture made.
 *
 * Run: `node --test testing/standalone/a-restore-keeps-file-bytes-and-metadata-in-step-db.test.js` (a Mongo the harness accepts; a prior
 * `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, resetRunnerForTest } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreThenReport, spaceRowsOfReport, classOf, FILE_CLASSES } from './_restore-act.mjs';

const skip = await mongoSkipReason();

const SUITE = 'restorefilesstep';
const SPACE = 'restorefiles';

/** Every file under `dir`, as a path relative to it with forward slashes. */
function walk(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]));
}

describe('a restore reports where a file\'s bytes and its metadata disagree', { skip }, () => {
  let door, mods, filesDir, body;

  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: [{ id: SPACE, label: SPACE, folders: [] }] });
    mods = await restoreModules();
    filesDir = join(process.env['DATA_ROOT'], 'files', SPACE);

    const ok = async (name, args) => {
      const r = await door.call(name, { space: SPACE, ...args });
      assert.equal(r.status, 200, `the fixture's ${name} ${args.path} was refused: ${r.text}`);
    };
    // The backup's moment: two files, bytes and metadata written together by the server's own path.
    await ok('write_file', { path: 'keep.json', content: '{"one":1}' });
    await ok('write_file', { path: 'gone.json', content: '{"bravo":"bravo"}' });
    const backup = await takeBackup(SUITE, `step${Date.now().toString(36)}`);

    // After it: one file rewritten, one deleted, one new.
    await ok('write_file', { path: 'keep.json', content: '{"two":"and a good deal longer than before"}' });
    await ok('delete_file', { path: 'gone.json' });
    await ok('write_file', { path: 'new.json', content: '{"written":"after the backup"}' });

    body = await restoreThenReport(mods, backup.id);
  });

  after(async () => {
    try { resetRunnerForTest(mods.runner); clearActEntries(mods.loader); } catch { /* never loaded */ }
    await door?.close();
  });

  /** The metadata rows that name bytes of their own (a chunk or a derived record has no file of its own). */
  const rows = async () => await door.coll(SPACE, 'files').find({ parentFileId: { $exists: false } }).toArray();

  /** What disagrees, by class, from the rows and the disk alone. */
  async function derived() {
    const byPath = new Map((await rows()).map(r => [r.path, r]));
    const out = Object.fromEntries(FILE_CLASSES.map(c => [c, []]));
    const onDisk = walk(filesDir);
    for (const p of onDisk) {
      const r = byPath.get(p);
      if (!r) out.missing_row.push(p);
      else if (r.deletedAt !== undefined) out.soft_deleted_with_bytes.push(p);
      else if (createHash('sha256').update(readFileSync(join(filesDir, p))).digest('hex') !== r.sha256) out.stale_row.push(p);
    }
    for (const [p, r] of byPath) if (r.deletedAt === undefined && r.sha256 !== undefined && !onDisk.includes(p)) out.row_without_bytes.push(p);
    return out;
  }

  it('control: the restore ran through the act and finished, and the fixture left the three disagreements it is about', async () => {
    assert.equal(body.state, 'completed', JSON.stringify(body));
    assert.equal(spaceRowsOfReport(body)[SPACE]?.state, 'done');
    assert.deepEqual(walk(filesDir).sort(), ['keep.json', 'new.json'], 'the fixture is wrong: keep.json and new.json are the files left on disk');
    assert.ok((await rows()).length >= 1, 'the restore left no metadata row at all: the derivation below would pass over nothing');
    const row = (await rows()).find(r => r.path === 'keep.json');
    assert.notEqual(statSync(join(filesDir, 'keep.json')).size, row?.sizeBytes, 'the fixture is wrong: keep.json\'s row should describe the bytes of the backup\'s moment');
    const d = await derived();
    assert.deepEqual([d.stale_row, d.row_without_bytes, d.missing_row], [['keep.json'], ['gone.json'], ['new.json']], `the fixture's disagreements: ${JSON.stringify(d)}`);
  });

  it('the space\'s report names each disagreement by class and path, and nothing else', async () => {
    const f = spaceRowsOfReport(body)[SPACE]?.files;
    assert.ok(f && typeof f === 'object', `the report of space '${SPACE}' carries no files: ${JSON.stringify(spaceRowsOfReport(body)[SPACE])}`);
    assert.equal(f.checked, true, JSON.stringify(f));
    const want = await derived();
    for (const cls of FILE_CLASSES) {
      assert.deepEqual([...classOf(f, cls).paths].sort(), want[cls].sort(), `class ${cls}: the report is ${JSON.stringify(f)}`);
      assert.equal(classOf(f, cls).count, want[cls].length, `class ${cls} counts ${classOf(f, cls).count}`);
    }
  });
});
