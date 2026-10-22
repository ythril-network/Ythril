/**
 * A restore counts the files it found out of step, by class: `ythril_restore_files_out_of_step_total{class}` (bundle-111, Q-557, V-S11).
 *
 * ## The rule this holds
 *
 * The files report of a restore (`GET /api/admin/data/restore`) is read once, by whoever opens the page. The counter is what an alert reads:
 * a restore that left files out of step moves the series of exactly their classes by exactly their counts, and no series is labelled by space
 * (a space id is a label value an operator chooses, and the report names the spaces).
 *
 * - every class has its series at 0 before any restore (a counter that appears at its first event cannot be told from one that is not
 *   wired), derived from the classifier's own class list and never typed here, with a floor;
 * - after a restore of a space holding one file of each of three classes (rewritten, deleted and created after the backup), those three
 *   series moved by one and the other two did not, and no sample carries a `space` label;
 * - the counter moves by the report's COUNT, not by the capped list of paths: it is compared with the classes the report carries.
 *
 * Seen red on the commit before the counter existed: the registry has no such series, so the first case fails on the missing metric name.
 *
 * Run: `node --test testing/standalone/a-restore-counts-the-files-out-of-step-db.test.js` (a Mongo the harness accepts; a prior
 * `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, resetRunnerForTest } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreThenReport, spaceRowsOfReport, classOf } from './_restore-act.mjs';

const skip = await mongoSkipReason();

const SUITE = 'restorefilescounter';
const SPACE = 'restorecounted';
const NAME = 'ythril_restore_files_out_of_step_total';

/** The samples of the counter in a scrape: `{ class, space?, value }` each. */
async function samples(register) {
  const metric = (await register.getMetricsAsJSON()).find(m => m.name === NAME);
  return (metric?.values ?? []).map(v => ({ ...v.labels, value: v.value }));
}
const valueOf = (all, cls) => all.find(s => s.class === cls)?.value;

describe('a restore counts the files out of step, by class (real MongoDB)', { skip }, () => {
  let door, mods, register, classes, before0, after0, report;

  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: [{ id: SPACE, label: SPACE, folders: [] }] });
    mods = await restoreModules();
    ({ register } = await import('../../server/dist/metrics/registry.js'));
    ({ FILE_MISMATCH_CLASSES: classes } = await import('../../server/dist/files/file-mismatch-classes.js'));
    before0 = await samples(register);

    const filesDir = join(process.env['DATA_ROOT'], 'files', SPACE);
    const put = async (path, content) => {
      const r = await door.call('write_file', { space: SPACE, path, content });
      assert.equal(r.status, 200, `the fixture's write_file ${path} was refused: ${r.text}`);
    };
    await put('keep.json', '{"one":1}');
    await put('gone.json', '{"bravo":"bravo"}');
    const backup = await takeBackup(SUITE, `counted${Date.now().toString(36)}`);
    mkdirSync(dirname(join(filesDir, 'new.json')), { recursive: true });
    writeFileSync(join(filesDir, 'keep.json'), '{"one":1,"and":"longer"}');   // stale_row
    unlinkSync(join(filesDir, 'gone.json'));                                   // row_without_bytes
    writeFileSync(join(filesDir, 'new.json'), '{"after":"backup"}');           // missing_row
    resetRunnerForTest(mods.runner); clearActEntries(mods.loader);
    report = spaceRowsOfReport(await restoreThenReport(mods, backup.id))[SPACE];
    after0 = await samples(register);
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });

  it('every class has its series at 0 before any restore, derived from the class list', () => {
    assert.ok(classes.length >= 5, `the derivation found ${classes.length} classes: too few to mean anything`);
    for (const cls of classes) assert.ok(valueOf(before0, cls) !== undefined, `no series for class ${cls} before the restore`);
  });

  it('a restore moves the series of the classes it found, by their counts, and no other', () => {
    assert.equal(report?.files?.checked, true, `the space was not checked: ${JSON.stringify(report)}`);
    const moved = Object.fromEntries(classes.map(c => [c, (valueOf(after0, c) ?? 0) - (valueOf(before0, c) ?? 0)]));
    for (const c of classes) assert.equal(moved[c], classOf(report.files, c).count, `class ${c} moved by ${moved[c]}, the report counts ${classOf(report.files, c).count}`);
    assert.deepEqual(['missing_row', 'row_without_bytes', 'stale_row'].map(c => moved[c]), [1, 1, 1], `the fixture's three files: ${JSON.stringify(moved)}`);
    assert.equal(moved['unprocessed'] + moved['soft_deleted_with_bytes'], 0);
  });

  it('no sample carries a space label', () => {
    assert.ok(after0.length >= classes.length);
    for (const s of after0) assert.deepEqual(Object.keys(s).filter(k => k !== 'value').sort(), ['class'], `a sample has labels ${Object.keys(s).join(', ')}`);
  });
});
