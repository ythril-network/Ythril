/**
 * A change-feed cursor older than the history the space still keeps is refused, never answered with a silent gap (bundle-255; plan
 * `design-final.md` item 3, vet-returns challenge 4, vet-returns data integrity and reliability).
 *
 * ## The defect it prevents
 *
 * A client that keeps the last cursor and comes back after the markers of the files it knew were purged (or after the whole space was
 * wiped or restored) would be answered "nothing changed" about files that are gone: a silent gap, the one thing the board answer
 * (`a89cd611`) ruled out: "one older than what is kept is refused with an answer telling you to re-list, never a silent gap".
 *
 * ## The rule
 *
 * The space keeps a FLOOR: the highest position of any marker that was removed outright, or the head at a wipe or a restore. A cursor
 * below the floor answers **`410`, code `cursor_expired`** on the route and an error carrying the same `code` on the tool, saying to
 * start again with no cursor; a cursor at or above it is served.
 *
 *  1. PURGE: the Files-window purge of a flagged row (the TTL sweep) raises the floor to the purged marker's position.
 *  2. FOLDER HARD DELETE: a folder delete erases the earlier markers under the folder outright, so it raises the floor first.
 *  3. WIPE and RESTORE raise the floor to the head: every older cursor re-lists, one taken after is served.
 *  4. EXACTLY AT THE FLOOR: the cursor a client holds after reading the purged marker is AT the floor and is served; one taken before
 *     the deletion is below it and refused.
 *  5. A restore of a backup taken before a purge (a lower floor) leaves every cursor below the purge's floor refused: the floor lives
 *     outside every restored collection.
 *  6. Each refusal on BOTH doors, and a control read (no cursor) that always answers.
 *
 * Not built here, left for implement (reported): a space RENAME carrying the floor. Whether a cursor minted under the old name is
 * "from another space" or "below the floor" after a rename is the implementation's choice of what a cursor binds; the plan fixes the
 * floor's document (carried by rename), not that. The case belongs with that choice.
 *
 * Database `ythril_harness_ffloor`.
 *
 * Run: node --test testing/standalone/a-file-change-cursor-below-the-floor-is-refused-db.test.js
 * (requires the harness Mongo and a prior `npm run build -w server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFeedDoors, DOORS, pathsOf } from './_file-change-feed.mjs';
import { restoreModules, takeBackup, restoreToTheEnd } from './_restore-act.mjs';

const skip = await mongoSkipReason();
const S = 'ffloor';
const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const enc = encodeURIComponent;

let d, ttl, lifecycle, loader, restoreMods, seq = 0;
const spaceConfig = () => loader.getConfig().spaces.find(s => s.id === S);

const upload = async (p) => {
  const a = await d.rest(d.admin.key, 'POST', `/api/files/${S}?path=${enc(p)}`, { content: `content of ${p}` });
  assert.ok(a.status >= 200 && a.status < 300, `fixture: upload of ${p} answered ${a.status}: ${a.text.slice(0, 200)}`);
};
const remove = async (p, confirm = false) => {
  const a = await d.rest(d.admin.key, 'DELETE', `/api/files/${S}?path=${enc(p)}`, confirm ? { confirm: true } : undefined);
  assert.ok(a.status >= 200 && a.status < 300, `fixture: delete of ${p} answered ${a.status}: ${a.text.slice(0, 200)}`);
};
/** The cursor a client holds after paging the whole space from the start. */
const cursorNow = async (via, prefix) => (await d.drain(via, { space: S, prefix })).cursor;

/** The refusal a stale cursor meets: `410`, `cursor_expired`, and a sentence that says to start again. */
function assertExpired(a, via, what) {
  assert.ok(a.failed, `${via}: ${what} was served (${JSON.stringify(a.body)?.slice(0, 160)}) - a silent gap`);
  if (via === 'REST') assert.equal(a.status, 410, `REST: ${what} answered ${a.status}, want 410`);
  assert.equal(a.code, 'cursor_expired', `${via}: ${what} answered code ${JSON.stringify(a.code)}: ${String(a.text).slice(0, 200)}`);
  assert.match(String(a.error || a.text), /cursor/i, `${via}: the refusal does not say what to do`);
}

describe('a change-feed cursor below the floor is refused (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openFeedDoors({ suite: 'ffloor', spaces: [S] });
    loader = d.loader;
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    restoreMods = await restoreModules();
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => {
    await d.door.coll(S, 'files').deleteMany({});
    fs.rmSync(join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true });
  });
  afterEach(() => { loader.getConfig().softDeleteFileMeta = false; delete spaceConfig().recordTtlDays; });

  it('fixture: the purge, the restore and the wipe the cases below drive all run (green on any build)', { timeout: 120_000 }, async () => {
    loader.getConfig().softDeleteFileMeta = true;
    await upload('fx/keep.md');
    await upload('fx/gone.md');
    const backup = await takeBackup('ffloor', 'ffloor-fixture');
    await remove('fx/gone.md');
    spaceConfig().recordTtlDays = { file: WINDOW_DAYS };
    await ttl.sweepExpired(new Date(Date.now() + (WINDOW_DAYS + 1) * DAY));
    delete spaceConfig().recordTtlDays;
    assert.equal(await d.door.coll(S, 'files').countDocuments({ _id: 'fx/gone.md' }), 0, 'the sweep did not purge the flagged row');
    assert.equal(await d.door.coll(S, 'files').countDocuments({ _id: 'fx/keep.md' }), 1, 'the sweep touched the live row');
    await upload('fx/later.md');
    await restoreToTheEnd(restoreMods, { backupId: backup.id });
    assert.equal(await d.door.coll(S, 'files').countDocuments({ _id: 'fx/later.md' }), 0, 'the restore kept a row written after the backup');
    assert.equal(await d.door.coll(S, 'files').countDocuments({ _id: 'fx/gone.md', deletedAt: { $exists: false } }), 1, 'the restore did not bring back the backup\'s row');
    await lifecycle.wipeSpace(S);
    assert.equal(await d.door.coll(S, 'files').countDocuments({}), 0, 'the wipe left file rows');
  });

  for (const via of DOORS) {
    it(`${via}: a read with no cursor is always answered (control), whatever was purged`, async () => {
      await upload(`ctl-${via}/a.md`);
      const body = await d.page(via, { space: S });
      assert.ok(Array.isArray(body.items));
      assert.equal(typeof body.nextCursor, 'string');
    });

    it(`${via}: the purge of a flagged row (soft delete on, the Files window passed) raises the floor: a cursor from before the deletion is refused, the one at the purged marker is served`, async () => {
      loader.getConfig().softDeleteFileMeta = true;
      const base = `purge-${via}-${++seq}`;
      await upload(`${base}/keep.md`);
      await upload(`${base}/gone.md`);
      const before = await cursorNow(via);          // sees both files live
      await remove(`${base}/gone.md`);              // the flagged row takes the highest position there is
      const at = await cursorNow(via);              // has read the deletion: AT the position the purge will take the floor to
      assert.deepEqual(pathsOf((await d.page(via, { space: S, cursor: before })).items), [`${base}/gone.md`], `${via}: fixture: the deletion is not in the feed before the purge`);
      spaceConfig().recordTtlDays = { file: WINDOW_DAYS };   // set AFTER the uploads, so no live row carries an expiry the sweep would act on
      await ttl.sweepExpired(new Date(Date.now() + (WINDOW_DAYS + 1) * DAY));
      assert.equal(await d.door.coll(S, 'files').countDocuments({ _id: `${base}/gone.md` }), 0, 'fixture: the sweep did not purge the flagged row');
      assertExpired(await d.read(via, { space: S, cursor: before }), via, 'a cursor from before a purged deletion');
      const served = await d.read(via, { space: S, cursor: at });
      assert.ok(!served.failed, `${via}: a cursor exactly at the floor was refused: ${String(served.text).slice(0, 200)}`);
      assert.equal(served.body.items.length, 0);
      await d.page(via, { space: S });              // and a read with no cursor still lists
    });

    it(`${via}: a folder hard delete erases the markers under it and raises the floor`, async () => {
      loader.getConfig().softDeleteFileMeta = false;
      const base = `folder-${via}-${++seq}`;
      await upload(`${base}/dir/x.md`);
      await upload(`${base}/dir/y.md`);
      const before = await cursorNow(via);
      await remove(`${base}/dir/x.md`);             // leaves a marker the folder delete below erases
      assert.deepEqual(pathsOf((await d.page(via, { space: S, cursor: before })).items), [`${base}/dir/x.md`], `${via}: fixture: no marker for the first delete`);
      await remove(`${base}/dir`, true);
      assertExpired(await d.read(via, { space: S, cursor: before }), via, 'a cursor from before a marker the folder delete erased');
      const after = await d.page(via, { space: S, prefix: `${base}/` });
      assert.ok(after.items.some(i => i.path === `${base}/dir/y.md` && i.deleted === true), `${via}: the folder delete's own deletion is not listed`);
    });

    it(`${via}: a wipe raises the floor to the head: every older cursor re-lists, one taken after is served`, async () => {
      const base = `wipe-${via}-${++seq}`;
      await upload(`${base}/a.md`);
      const old = await cursorNow(via);             // at the head, and the file it knows is about to vanish unreported
      await lifecycle.wipeSpace(S);
      assertExpired(await d.read(via, { space: S, cursor: old }), via, 'a cursor from before a wipe');
      const fresh = await cursorNow(via);
      const served = await d.read(via, { space: S, cursor: fresh });
      assert.ok(!served.failed, `${via}: a cursor taken after the wipe was refused: ${String(served.text).slice(0, 200)}`);
      await upload(`${base}/b.md`);
      assert.deepEqual(pathsOf((await d.page(via, { space: S, cursor: fresh })).items), [`${base}/b.md`], `${via}: the walk after a wipe missed a write`);
    });

    it(`${via}: a restore raises the floor to the head, and a restore of a backup from before a purge leaves the purge's floor in force`, { timeout: 120_000 }, async () => {
      loader.getConfig().softDeleteFileMeta = true;
      const base = `restore-${via}-${++seq}`;
      await upload(`${base}/keep.md`);
      await upload(`${base}/gone.md`);
      const backup = await takeBackup('ffloor', `ffloor-${via}-${seq}`);
      const beforePurge = await cursorNow(via);
      await remove(`${base}/gone.md`);
      spaceConfig().recordTtlDays = { file: WINDOW_DAYS };
      await ttl.sweepExpired(new Date(Date.now() + (WINDOW_DAYS + 1) * DAY));
      delete spaceConfig().recordTtlDays;
      assertExpired(await d.read(via, { space: S, cursor: beforePurge }), via, 'fixture: a cursor from before the purge, before any restore');
      const afterPurge = await cursorNow(via);      // taken after the purge: valid now
      await upload(`${base}/later.md`);
      await restoreToTheEnd(restoreMods, { backupId: backup.id });
      assertExpired(await d.read(via, { space: S, cursor: beforePurge }), via, 'a cursor below the purge floor, after a restore of a backup that predates the purge');
      assertExpired(await d.read(via, { space: S, cursor: afterPurge }), via, 'a cursor from before a restore (the restore removed a file the client was told of)');
      const fresh = await cursorNow(via);
      assert.ok(!(await d.read(via, { space: S, cursor: fresh })).failed, `${via}: a cursor taken after the restore was refused`);
    });
  }
});
