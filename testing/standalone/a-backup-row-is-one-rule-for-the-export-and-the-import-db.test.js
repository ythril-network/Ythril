/**
 * The rows of a space's files collection a backup holds are decided by ONE rule, `backupRow`, which the export queries with and the import drops
 * by; the export carries no chunk, no face row and no legacy spill (bundle-40 slice b, `Q-226`; plan 2R R2).
 *
 * ## The rules this file holds
 *
 *  1. **`backupRow` is exported by `sync/local-only-fields`** as `{ filter, predicate }`: `filter` a MongoDB filter the export's cursor takes, `predicate(doc)`
 *     true for a row that belongs in a backup. Today the export streams every row of the collection and the import drops what it derives or what is a
 *     legacy spill, so the export and the import disagree about what a backup is (a conversion chunk and a face descriptor travel for nothing, and
 *     an export over 10 MB is mostly them).
 *  2. **The filter and the predicate agree** on a seeded set that covers each row kind: a conversion chunk, a face chunk, `parentFileId` null and a
 *     number (a live row, not derived), a legacy read spill in its forward-slash, leading-slash and backslash forms, a flagged (soft-deleted) row
 *     and a live row; and a look-alike that is a user's file (a `_tmp` folder that is not at the root, a spill name without a uuid).
 *  3. **The export carries no chunk, face or spill row, and every other row** (a flagged row is exported on purpose, `Q-257`).
 *  4. **PIN: the import lands exactly the rows a backup holds** and drops the rest.
 *
 * Derived rows are `typeof parentFileId === 'string'`; a spill is `_tmp/graph-<uuid>.json` or `_tmp/results-<uuid>.json` at the root (`spillIdFromPath`),
 * whichever way the separators and the leading slash are spelled.
 *
 * ## What is red on the base, and what is a PIN
 *
 * `backupRow` does not exist on 6c64a7112 (rules 1 and 2 fail at "does not export `backupRow`") and the export streams every row (rule 3 red). Rule 4
 * is a PIN: the import already drops derived rows and spills, and the rewrite onto one rule must not lose it.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-backup-row-is-one-rule-for-the-export-and-the-import-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openImportDoor, exportText } from './_import-door.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { untilRunnerIdle } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'backuprow';
const T = { timeout: 60_000 };
const T0 = '2026-06-01T00:00:00.000Z';
const UUID = '0b8f0c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e';

/** One file row of the seeded set: `keep` says whether a backup holds it. A FIXTURE, literal on purpose. */
const ROWS = [
  { _id: 'live.md', keep: true, why: 'a live row' },
  { _id: 'flagged.md', keep: true, why: 'a soft-deleted (flagged) row, exported on purpose (Q-257)', over: { deletedAt: T0 } },
  { _id: 'parent-null.md', keep: true, why: 'parentFileId null is not derived', over: { parentFileId: null } },
  { _id: 'parent-number.md', keep: true, why: 'parentFileId a number is not derived', over: { parentFileId: 7 } },
  { _id: `notes/_tmp/graph-${UUID}.json`, keep: true, why: 'a user file in a _tmp folder that is not at the root' },
  { _id: '_tmp/graph-not-a-uuid.json', keep: true, why: 'a root _tmp file whose name is not a spill\'s' },
  { _id: 'doc.md#chunk0', keep: false, why: 'a conversion chunk', over: { parentFileId: 'doc.md', chunkIndex: 0 } },
  { _id: 'img.png#face-chunk0', keep: false, why: 'a face chunk', over: { parentFileId: 'img.png', faceEmbedding: [0.1] } },
  { _id: `_tmp/graph-${UUID}.json`, keep: false, why: 'a legacy read spill, forward slash' },
  { _id: `_tmp/results-${UUID}.json`, keep: false, why: 'a legacy read spill (results), forward slash' },
  { _id: `/_tmp/graph-${UUID}.json`, keep: false, why: 'a legacy read spill with a leading slash' },
  { _id: `_tmp\\graph-${UUID}.json`, keep: false, why: 'a legacy read spill, backslash' },
  { _id: `\\_tmp\\results-${UUID}.json`, keep: false, why: 'a legacy read spill, leading backslash' },
];
const rowOf = (r, space = SPACE) => ({
  _id: r._id, spaceId: space, path: r._id, tags: [], author: { instanceId: 'origin', instanceLabel: 'Origin' }, seq: 5, createdAt: T0, updatedAt: T0, ...(r.over ?? {}),
});
const KEPT = ROWS.filter(r => r.keep).map(r => r._id).sort();

let door, runner;

describe('one rule says which file rows a backup holds (real MongoDB, real routes)', { skip }, () => {
  before(async () => {
    door = await openImportDoor({ suite: 'backuprow', spaces: [{ id: SPACE, label: 'Row', folders: [] }] });
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(SPACE); });

  it('fixture check: the seeded set holds rows a backup keeps and rows it leaves out, each id once', () => {
    assert.ok(ROWS.length >= 12 && ROWS.some(r => r.keep) && ROWS.some(r => !r.keep), 'the seeded set is too small to say anything');
    assert.equal(new Set(ROWS.map(r => r._id)).size, ROWS.length, 'a seeded id repeats');
  });

  it('backupRow is exported by sync/local-only-fields as { filter, predicate }', async () => {
    const mod = needModule(await loadDistModule('../../server/dist/sync/local-only-fields.js', import.meta.url), ['backupRow'], 'one row rule for export and import');
    assert.equal(typeof mod.backupRow?.predicate, 'function', 'backupRow.predicate is not a function');
    assert.equal(typeof mod.backupRow?.filter, 'object', 'backupRow.filter is not a MongoDB filter object');
  });

  it('the filter and the predicate agree on every row kind, and both keep exactly the rows a backup holds', async () => {
    const { backupRow } = needModule(await loadDistModule('../../server/dist/sync/local-only-fields.js', import.meta.url), ['backupRow'], 'one row rule for export and import');
    await door.coll(SPACE, 'files').insertMany(ROWS.map(r => rowOf(r)));
    const byFilter = new Set((await door.coll(SPACE, 'files').find(backupRow.filter, { projection: { _id: 1 } }).toArray()).map(d => d._id));
    const stored = await door.coll(SPACE, 'files').find({}).toArray();
    assert.equal(stored.length, ROWS.length, 'fixture check: the seeded rows were not all stored');
    const disagree = stored.filter(d => byFilter.has(d._id) !== (backupRow.predicate(d) === true)).map(d => d._id);
    assert.deepEqual(disagree, [], 'the filter the export queries with and the predicate the import drops by disagree about these rows');
    assert.deepEqual([...byFilter].sort(), KEPT, `the rule keeps the wrong rows: ${ROWS.filter(r => r.keep !== byFilter.has(r._id)).map(r => `${r._id} (${r.why})`).join('; ')}`);
  });

  it('the export carries no chunk, face or legacy spill row, and every other row, flagged rows included', async () => {
    await door.coll(SPACE, 'files').insertMany(ROWS.map(r => rowOf(r)));
    const out = await door.exportSpace(SPACE);
    assert.equal(out.status, 200, `export answered ${out.status}`);
    const exported = (out.json?.files ?? []).map(d => d._id).sort();
    assert.deepEqual(exported, KEPT, `the export of the files collection holds ${exported.length} rows, not the ${KEPT.length} a backup holds: extra ${JSON.stringify(exported.filter(i => !KEPT.includes(i)))}, missing ${JSON.stringify(KEPT.filter(i => !exported.includes(i)))}`);
  });

  it('PIN: the import lands exactly the rows a backup holds and drops chunks, face rows and legacy spills', async () => {
    const body = exportText({ files: ROWS.map(r => rowOf(r, 'elsewhere')) }, { envelope: { instanceId: door.instanceId(), spaceId: SPACE } });
    const res = await door.post(SPACE, body);
    assert.ok(res.status === 200 || res.status === 202, `the import answered ${res.status}: ${res.text.slice(0, 200)}`);
    await untilRunnerIdle(runner, door.loader);
    const landed = (await door.coll(SPACE, 'files').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
    assert.deepEqual(landed, KEPT, 'the import landed a row a backup does not hold, or dropped one it does');
  });
});
