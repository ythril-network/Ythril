/**
 * A restore drops the conversion run and its items: no run resumes toward the restored records (Q-746, bundle-284 design r5 sections 5.2 "A
 * restore" and 6, finding S10).
 *
 * ## The rule
 *
 * The restore act drops every collection of the space and loads the ones its backup names, except the run document's and the items'
 * (`schema_convert_run`, `schema_convert_items`): they describe the records as they were before the restore, toward a fingerprint and with
 * versions the restored records do not have. After a restore neither exists, and the boot resume finds no run to continue.
 *
 * ## What was wrong
 *
 * A backup taken mid-run carried the run document; restored, it resumed and rewrote the restored records toward a schema the operator had just
 * restored away from (S10).
 *
 * Seen red on 14af4644: the backup's run document and item come back with the restore (no collection of those names is the space's yet, so
 * the restore neither drops nor skips them).
 *
 * Run: node --test testing/standalone/a-restore-drops-the-conversion-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { clearActEntries, resetRunnerForTest } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreAsActs, settleRestoreActs } from './_restore-act.mjs';
import { moduleOrNull } from './_b81c-door.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b284restoredrop';
const S = 'restore-convert';
const OLD_FP = 'e'.repeat(64);

describe('a restore drops the conversion (real MongoDB)', { skip }, () => {
  let door, mods;
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    mods = await restoreModules();
  });
  after(async () => {
    try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ }
    (await moduleOrNull('spaces/schema-convert-run.js'))?.stopSchemaConvertWatcher?.();
    await door?.close();
  });

  it('after a restore the run document and the items are gone, and no run resumes', async () => {
    resetRunnerForTest(mods.runner);
    clearActEntries(mods.loader);
    await door.coll(S, 'entities').insertOne(build.entity(S, 'r-1', 5, { type: 'person', properties: {} }));
    await door.setCounter(S, 5);
    // A run part-way and one item, as a backup taken mid-run holds them. Named as the collections are named, so the base build (which has no such
    // kinds) still stores them and the backup carries them.
    await door.mongo.col(`${S}_schema_convert_run`).insertOne({
      _id: 'run', toFp: OLD_FP, types: [{ kind: 'entity', type: 'person', done: false }], steps: [], stepsRefused: [], splitDeclared: {},
      sources: [{ kind: 'act', at: '2026-11-18T10:00:00.000Z' }], owed: false, syncedFirst: { asked: 0, answered: 0 },
      startedAt: '2026-11-18T10:00:00.000Z', cursor: null, counts: { stamped: 0, rewritten: 0, unconverted: 1, moved: 0, edgesRestamped: 0 },
      state: 'running', failures: 0, sweepLeaseAt: 0,
    });
    await door.mongo.col(`${S}_schema_convert_items`).insertOne({ _id: 'item-1', kind: 'entity', recordId: 'r-1', type: 'person', seq: 5,
      fromFp: null, toFp: OLD_FP, reason: 'not_conforming', violations: [], proposed: { set: [], unset: [] }, status: 'open', detectedAt: '2026-11-18T10:00:00.000Z' });

    const backup = await takeBackup(SUITE, `convert-${Date.now()}`);
    assert.ok(backup.manifest.collections.some(c => c.name === `${S}_schema_convert_run`), 'precondition: the backup carries the run document');

    await restoreAsActs(mods, { backupId: backup.id });
    for (const r of await settleRestoreActs(mods.runner, mods.loader)) assert.equal(r.ok, true, `the restore act did not complete: ${JSON.stringify(r)}`);

    assert.equal(await door.mongo.col(`${S}_schema_convert_run`).findOne({ _id: 'run' }), null, 'the run document came back with the restore');
    assert.equal(await door.mongo.col(`${S}_schema_convert_items`).countDocuments({}), 0, 'the items came back with the restore');
    assert.ok(await door.coll(S, 'entities').findOne({ _id: 'r-1' }), 'precondition: the records were restored');

    const run = await moduleOrNull('spaces/schema-convert-run.js');
    assert.ok(run, 'server/src/spaces/schema-convert-run.ts is not built');
    await run.resumeSchemaConvertRuns();
    assert.equal(await door.mongo.col(`${S}_schema_convert_run`).findOne({ _id: 'run' }), null, 'a run resumed after the restore');
  });
});
