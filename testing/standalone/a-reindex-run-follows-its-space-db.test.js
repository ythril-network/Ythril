/**
 * A reindex run document is one of its SPACE's collections: it moves on a rename and goes with a wipe.
 *
 * ## Why it is in the registry and not beside it
 *
 * Q-99 part 2 persists a run as `<space>_reindex_run` so a restart can resume it. A collection named by hand
 * would be one the derived gates cannot see: `one-name-for-a-spaces-collection.test.js` reads every
 * `${...}_suffix` in the tree against `SPACE_COLLECTIONS`, and rename / delete select a space's collections by
 * prefix. Registered as the kind `reindexRun`, the run is covered by all of them without a list naming it.
 *
 * ## What each case adds over the prefix match
 *
 * - **Rename.** The collection moves by prefix already; what a prefix cannot move is the CONTENT. The document
 *   carries `spaceId` and `members`, and a resumed run walks `members` — so a run renamed with `members: [old]`
 *   would walk a space that no longer exists and never finish, holding `needsReindex` asserted for ever.
 * - **Wipe.** A full `wipeSpace` takes every record the run was rebuilding. A run left behind would hold the
 *   per-space guard (409) over an empty space and keep the gauge counting it.
 * - **Delete.** `dropSpaceData` drops by prefix; asserted so the registry entry and the drop agree.
 *
 * Run: `npm run test:up` first, then (after `npm run build` in server/)
 *      node --test testing/standalone/a-reindex-run-follows-its-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-reindex-run-follows-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const SPACES = ['before-name', 'wiped', 'doomed', 'bystander'];

let mongo, loader, lifecycle, rename, registry;

const runDoc = (space) => ({
  _id: 'run', spaceId: space, members: [space], flagged: true,
  target: { model: 'm', dimensions: 8, prefixScheme: 'none' },
  startedAt: new Date().toISOString(), cursor: null, sweepComplete: false,
});

describe('the reindex run document follows its space (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'reindex-follows', instanceLabel: 'test', tokens: [], networks: [],
      spaces: SPACES.map(id => ({ id, label: id, folders: [] })),
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('reindexrunfollows');
    registry = await import('../../server/dist/db/space-collection.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    rename = await import('../../server/dist/spaces/rename.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the space-collection registry has the reindexRun kind', () => {
    assert.ok('reindexRun' in registry.SPACE_COLLECTIONS,
      'without a registry entry the run is a hand-named collection the derived gates cannot see');
    assert.equal(registry.spaceCollection('work', 'reindexRun'), `work_${registry.SPACE_COLLECTIONS.reindexRun}`);
  });

  it('a rename moves the run, and the run then names its space by the NEW id', async () => {
    const from = registry.spaceCollection('before-name', 'reindexRun');
    await mongo.col(from).insertOne(runDoc('before-name'));

    const errors = await rename.moveSpaceData('before-name', 'after-name');
    assert.deepEqual(errors, []);

    assert.equal(await mongo.col(from).countDocuments({}), 0, 'nothing may stay under the old id');
    const moved = await mongo.col(registry.spaceCollection('after-name', 'reindexRun')).findOne({ _id: 'run' });
    assert.ok(moved, 'the run must exist under the new id');
    assert.equal(moved.spaceId, 'after-name', 'the run must name its space by the new id');
    assert.deepEqual(moved.members, ['after-name'],
      'a resumed run walks `members` — left at the old id it walks a space that no longer exists, and never ends');
  });

  it('a full wipe removes the run, and leaves another space\'s alone', async () => {
    await mongo.col(registry.spaceCollection('wiped', 'reindexRun')).insertOne(runDoc('wiped'));
    await mongo.col(registry.spaceCollection('bystander', 'reindexRun')).insertOne(runDoc('bystander'));

    await lifecycle.wipeSpace('wiped');

    assert.equal(await mongo.col(registry.spaceCollection('wiped', 'reindexRun')).countDocuments({}), 0,
      'a run over a wiped space would hold its 409 guard and the gauge for records that no longer exist');
    assert.equal(await mongo.col(registry.spaceCollection('bystander', 'reindexRun')).countDocuments({}), 1,
      'a wipe is scoped to its space');
  });

  it('deleting the space drops the run with it', async () => {
    const name = registry.spaceCollection('doomed', 'reindexRun');
    await mongo.col(name).insertOne(runDoc('doomed'));
    await lifecycle.dropSpaceData('doomed');
    const left = await mongo.getDb().listCollections({ name }).toArray();
    assert.deepEqual(left, [], 'the run collection outlived its space');
  });
});
