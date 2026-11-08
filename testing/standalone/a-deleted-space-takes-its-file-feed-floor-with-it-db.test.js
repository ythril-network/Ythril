/**
 * Deleting a space deletes its file feed floor document, and a space created again under the same id does not serve an old client's cursor as if
 * nothing was lost (bundle-255 lens sweep; the feed's promise is "never a silent gap").
 *
 * ## The defect
 *
 * The feed keeps one document per space in `ythril_file_feed_floors` (`files/file-feed-floor.ts`): the space's STREAM tag, which every cursor carries, and
 * its floor. The collection is instance-wide, keyed by the space id, so `dropSpaceData`'s prefix drop cannot reach it (the same gap `space_activity`, the read
 * spills and the scan cursors each closed in their own step, 2b to 2d). Left behind, a space created again under the id finds the old stream tag: a client
 * that kept its cursor from the deleted space is answered 200 "nothing changed" about files that no longer exist, a silent gap.
 *
 * ## The rule
 *
 * Removing a space removes its floor document, so the space created again starts a NEW stream (the tag is made on first ask) and the old cursor is refused as
 * one from another stream (`400 invalid_cursor`, on both doors). It is a step of `dropSpaceData`, the one function every delete and every RESUMED delete
 * runs, so a delete that is run twice, or finished at the next boot, leaves no document either. A sibling whose id only starts with the deleted one's keeps its
 * own.
 *
 * "Seen red" on the base: the old cursor is served, and the document is still there.
 *
 * Database `ythril_harness_ffgone`.
 *
 * Run: node --test testing/standalone/a-deleted-space-takes-its-file-feed-floor-with-it-db.test.js
 * (requires the harness Mongo and a prior `npm run build -w server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFeedDoors, DOORS } from './_file-change-feed.mjs';

const skip = await mongoSkipReason();
const SPACES = ['ffgone-rest', 'ffgone-mcp', 'ffgone-archive', 'ffgone-resumed'];
const enc = encodeURIComponent;

let d, lifecycle, mongoMod, floorMod;
const floorDocs = (id) => mongoMod.col(floorMod.FILE_FEED_FLOORS).find({ _id: id }).toArray();

const upload = async (space, p) => {
  const a = await d.rest(d.admin.key, 'POST', `/api/files/${space}?path=${enc(p)}`, { content: `content of ${p}` });
  assert.ok(a.status >= 200 && a.status < 300, `fixture: upload of ${p} answered ${a.status}: ${a.text.slice(0, 200)}`);
};

describe('a deleted space takes its file feed floor with it (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openFeedDoors({ suite: 'ffgone', spaces: SPACES });
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    mongoMod = await import('../../server/dist/db/mongo.js');
    floorMod = await import('../../server/dist/files/file-feed-floor.js');
  });
  after(async () => { await d?.close(); });

  for (const via of DOORS) {
    it(`${via}: a cursor read from the deleted space is refused by the space created again under its id, never served`, { timeout: 120_000 }, async () => {
      const SPACE = `ffgone-${via.toLowerCase()}`;
      await upload(SPACE, `${via}/a.md`);
      const old = (await d.drain(via, { space: SPACE })).cursor;
      assert.equal(typeof old, 'string', 'fixture: no cursor to keep');
      assert.equal((await floorDocs(SPACE)).length, 1, 'fixture: the read did not make the space\'s feed document');
      assert.equal(await lifecycle.removeSpace(SPACE), true, 'the delete did not complete');
      assert.deepEqual(await floorDocs(SPACE), [], 'the deleted space\'s floor document is still in ythril_file_feed_floors');
      await lifecycle.createSpace({ id: SPACE, label: SPACE }, { tokenId: null });
      const a = await d.read(via, { space: SPACE, cursor: old });
      assert.ok(a.failed, `${via}: the old cursor was served by the re-created space (${JSON.stringify(a.body)?.slice(0, 160)}) - a silent gap`);
      if (via === 'REST') assert.equal(a.status, 400, `REST: answered ${a.status}, want 400`);
      assert.equal(a.code, 'invalid_cursor', `${via}: answered code ${JSON.stringify(a.code)}: ${String(a.text).slice(0, 200)}`);
      await d.page(via, { space: SPACE });       // a read with no cursor still lists
      fs.rmSync(join(process.env['DATA_ROOT'], 'files', SPACE), { recursive: true, force: true });
    });
  }

  it('a delete that is run twice (dropSpaceData alone, as a resumed delete runs it) leaves no floor document, and a sibling keeps its own', { timeout: 120_000 }, async () => {
    await upload('ffgone-resumed', 'r.md');
    await upload('ffgone-archive', 's.md');
    await d.drain('REST', { space: 'ffgone-resumed' });
    await d.drain('REST', { space: 'ffgone-archive' });
    assert.equal((await floorDocs('ffgone-resumed')).length, 1, 'fixture: no document to drop');
    for (let run = 1; run <= 2; run += 1) {
      const errors = await lifecycle.dropSpaceData('ffgone-resumed');
      assert.deepEqual(errors, [], `run ${run} reported errors: ${errors.join(' | ')}`);
      assert.deepEqual(await floorDocs('ffgone-resumed'), [], `run ${run} left the floor document behind`);
    }
    assert.equal((await floorDocs('ffgone-archive')).length, 1, 'the sibling\'s document went with the deleted space\'s');
  });
});
