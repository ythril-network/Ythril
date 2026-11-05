/**
 * Deleting a space deletes its scan-state rows, and a space created again under the same id inherits no cursor and no hold clock
 * (Q-697, b235 design v3 item 11; data-integrity S6).
 *
 * ## The defect
 *
 * The scanners keep their cursors in ONE instance-wide collection, `ythril_dupe_scan_state`, keyed `<space>:<type>` (the duplicate
 * scanner) and `<space>:<type>:contradiction[:nli]` (the contradiction scanner). `dropSpaceData` drops every collection with the
 * space's prefix, and the rows of a global collection are not among them: the same gap `space_activity` and the read spills each
 * closed in their own step (2b, 2c). A row left behind is read by a space created later under the same id, which starts its first scan
 * from the old position (records below it are never scanned) and, with Q-697, inherits the old `heldSince`, so its first ordinary
 * hold is warned as one that has lasted weeks.
 *
 * ## The rule
 *
 * Removing a space removes the rows of its cursors, every one whose `_id` starts `<spaceId>:` - the colon is the boundary: a sibling
 * space whose id merely STARTS with the deleted one's (`victim-archive` beside `victim`) keeps its rows, as does every other space.
 * It is a step of `dropSpaceData`, the one function every delete and every RESUMED delete runs, so a delete that crashed after the
 * collections were dropped and finishes at the next boot still removes them.
 *
 * "Seen red" on the base: the rows of the deleted space are all still there.
 *
 * Needs a MongoDB (`npm run test:up`).
 *
 * Run: node --test testing/standalone/a-deleted-space-takes-its-scan-state-with-it-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-scanstate-delete-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const SPACES = ['victim', 'victim-archive', 'keeper', 'ghost'];
const space = id => ({ id, label: id, folders: [], completeLinkage: true });
/** Every kind of cursor row a space can own: the dupe scanner's, and the contradiction scanner's two passes, for each scanned type. */
const KEYS = ['fact', 'entity', 'chrono'].flatMap(t => [`:${t}`, `:${t}:contradiction`, `:${t}:contradiction:nli`]);
const rowsOf = (id) => KEYS.map(k => ({ _id: `${id}${k}`, spaceId: id, type: k.split(':')[1], cursorSeq: 3, updatedAt: '2026-11-01T00:00:00.000Z', heldSince: '2026-10-01T00:00:00.000Z' }));

describe('a deleted space takes its scan state with it', { skip }, () => {
  let mongo, lifecycle, cursorMod;

  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'scanstate-delete', instanceLabel: 'test', tokens: [], networks: [], spaces: SPACES.map(space),
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    mongo = await openTestMongo('scanstatedelete');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    cursorMod = await import('../../server/dist/brain/scan-cursor.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    const state = mongo.col('ythril_dupe_scan_state');
    await state.deleteMany({});
    await state.insertMany(SPACES.flatMap(rowsOf));
    for (const id of SPACES) {
      await mongo.col(`${id}_facts`).updateOne({ _id: `${id}-f` }, { $set: { spaceId: id, fact: 'x' } }, { upsert: true });
      await fsp.mkdir(path.join(process.env['DATA_ROOT'], 'files', id), { recursive: true });
    }
  });

  const idsLeft = async () => (await mongo.col('ythril_dupe_scan_state').find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id);
  const startsWith = (ids, id) => ids.filter(i => i.startsWith(`${id}:`));

  it('removing a space removes every cursor row it owns and no row of any other space, a sibling that shares its prefix included', async () => {
    const before = await idsLeft();
    assert.equal(startsWith(before, 'victim').length, KEYS.length, 'the fixture did not plant the rows it is about');
    assert.equal(await lifecycle.removeSpace('victim'), true, 'the delete did not complete');
    const left = await idsLeft();
    assert.deepEqual(startsWith(left, 'victim'), [], 'the deleted space\'s cursors are still in ythril_dupe_scan_state: a space created again under the id would scan from the old position, and inherit the old hold clock');
    for (const other of SPACES.filter(s => s !== 'victim')) {
      assert.equal(startsWith(left, other).length, KEYS.length, `${other}'s cursors were removed with the deleted space's (the prefix has no boundary)`);
    }
  });

  it('a space created again under the id starts from the beginning: no position, no clock', async () => {
    assert.equal(await lifecycle.removeSpace('ghost'), true);
    assert.deepEqual(await cursorMod.readScanStart('ghost:fact'), { pos: 0 }, 'a re-created space resumes from the deleted one\'s position');
    assert.equal(await mongo.col('ythril_dupe_scan_state').findOne({ _id: 'ghost:fact:contradiction:nli' }), null);
  });

  it('a delete that is RESUMED (dropSpaceData alone, as the boot runs it) removes them too', async () => {
    const errors = await lifecycle.dropSpaceData('keeper');
    assert.deepEqual(errors, [], `the drop reported errors: ${errors.join(' | ')}`);
    const left = await idsLeft();
    assert.deepEqual(startsWith(left, 'keeper'), [], 'a resumed delete left the scan state behind');
    assert.equal(startsWith(left, 'victim-archive').length, KEYS.length, 'the sibling\'s rows went with it');
  });
});
