/**
 * An operator can see a restore's progress and outcome, can abandon one that cannot finish, and the instance stays in maintenance -
 * admins excepted, backups refused - until the last restore act ends (bundle-157, Q-552/Q-554; design rev 4 R4.1, R4.2, R4.3, R4.7;
 * rev 5 R5.3, R5.4, R5.5, R5.7).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * Once a restore answers 202 its work happens in acts, so the answer can no longer carry the outcome. The rules:
 *
 * - `GET /api/admin/data/restore` reports the restore in progress (or the last one) per space: `state` owed / running / done, `attempts`,
 *   a `lastError` that is OUR sentence (never the driver's text: no `E11000`, no URI), and the index results (`edgeIndexes`,
 *   `vectorIndexes`) that used to be in the POST answer;
 * - `POST /api/admin/data/restore/abandon` lifts the holds of the acts not done, lists those spaces as possibly half restored, and writes
 *   one `data.restore.abandoned` audit row naming the backup;
 * - maintenance is DERIVED from "an instance-wide act stands" (manual OR derived), so it holds until the last restore act ends and
 *   survives a restart; an instance-admin token still passes it on any path, every other caller gets the 503; a backup (scheduled or
 *   manual, `runBackupNow`) is refused while a restore stands, so it never dumps a half-restored database.
 *
 * ## How it is driven
 *
 * Two spaces. `r-done`'s act is parked in `beforeComplete` (body done, completion pending: running) and then released; `r-owed`'s throws
 * there with a driver-shaped message (a duplicate-key text carrying a credentialed URI), so it is owed with that failure. The GET is read
 * while `r-done` is parked, after it completed, and after the abandon. The maintenance row stands a `restore` entry up by hand
 * (`seedActEntry`) so it judges the derivation alone.
 *
 * ## Seen red
 *
 * On 14005a5c `GET /restore` does not exist, `POST /restore` answers 200, and maintenance is an in-memory flag nothing derives.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/the-restore-report-and-abandon-db.test.js` (a prior
 * `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { seedActEntry, clearActEntries, deferred, resetRunnerForTest, auditRowsOf } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreAsActs, callDataDoor, restoreEntries, startRestoreActs } from './_restore-act.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'restorereport';
const T = { timeout: 90_000 };
const DRIVER_TEXT = 'E11000 duplicate key error collection: ythril.r-owed_edges index: from_1 mongodb://admin:hunter2@db.internal:27017';

let door, mods, maintenance, scheduler;

/** The per-space rows of a GET /restore answer, by space id, whether the answer keys them or lists them. */
function perSpace(body) {
  const spaces = body?.spaces ?? body?.restore?.spaces;
  if (Array.isArray(spaces)) return Object.fromEntries(spaces.filter(s => s && typeof s === 'object').map(s => [s.id ?? s.spaceId ?? s.localId, s]));
  return spaces && typeof spaces === 'object' ? spaces : {};
}
const report = async () => {
  const answer = await callDataDoor(mods.dataRouter, 'get', '/restore');
  assert.equal(answer.status, 200, `GET /restore answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
};

/** The maintenance middleware's verdict on one request: 'next' or the status it answered. */
function throughMaintenance(rights) {
  let verdict = 'next';
  const res = { status(c) { verdict = c; return this; }, json() { return this; } };
  maintenance.maintenanceMiddleware({ path: '/api/brain/spaces/r-done/facts', method: 'POST', authToken: { id: 't', name: 't', rights } }, res, () => {});
  return verdict;
}

describe('the restore report, its abandon, and maintenance while a restore stands (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: ['r-done', 'r-owed'].map(id => ({ id, label: id, folders: [] })) });
    mods = await restoreModules();
    maintenance = await import('../../server/dist/maintenance.js');
    scheduler = await import('../../server/dist/db/backup-scheduler.js');
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(() => { resetRunnerForTest(mods.runner); clearActEntries(mods.loader); maintenance.setMaintenanceActive(false); });

  it('maintenance is derived from a standing restore act: it holds across a restart, admins pass, others get 503, a backup is refused', T, async () => {
    assert.equal(maintenance.isMaintenanceActive(), false, 'control: maintenance is on with nothing standing');
    await seedActEntry(mods.loader, { kind: 'restore', localId: 'r-done' });
    assert.equal(maintenance.isMaintenanceActive(), true, 'a standing restore act does not put the instance in maintenance');
    await mods.loader.flushConfig(); mods.runner.reopenSpaceActsForTest(); mods.loader.loadConfig();
    assert.equal(maintenance.isMaintenanceActive(), true, 'after a restart a standing restore act no longer holds maintenance');
    assert.equal(throughMaintenance(door.ADMIN), 'next', 'an instance-admin token was stopped by maintenance during a restore');
    assert.equal(throughMaintenance({ perSpace: {}, floor: {} }), 503, 'a non-admin caller passed maintenance during a restore');
    await assert.rejects(scheduler.runBackupNow(), 'a backup ran while a restore stands: it would dump a half-restored database');
    clearActEntries(mods.loader);
    assert.equal(maintenance.isMaintenanceActive(), false, 'maintenance outlived the last restore act');
  });

  it('GET /restore reports running, done and owed with a sanitised lastError and the index results; abandon lifts the holds, lists the half-restored space and is audited', T, async () => {
    for (const s of ['r-done', 'r-owed']) {
      await door.coll(s, 'facts').deleteMany({});
      await door.coll(s, 'facts').insertOne({ _id: `${s}-1`, spaceId: s, fact: s, tags: [], seq: 1 });
    }
    const backup = await takeBackup(SUITE, `report-${Date.now()}`);
    const park = deferred();
    mods.runner.setSpaceActHooksForTest({
      beforeComplete: async (e) => {
        if (e.localId === 'r-done') { park.arrive(); await park.promise; }
        if (e.localId === 'r-owed') throw new Error(DRIVER_TEXT);
      },
    });
    await restoreAsActs(mods, { backupId: backup.id });
    const runs = startRestoreActs(mods.runner, mods.loader);
    await park.reached;

    let rows = perSpace(await report());
    assert.equal(rows['r-done']?.state, 'running', `a restore act in its body is not reported running: ${JSON.stringify(rows)}`);
    assert.notEqual(rows['r-owed']?.state, 'done', 'a space whose act has not run is reported done');
    assert.equal(maintenance.isMaintenanceActive(), true, 'the instance is not in maintenance while a restore runs');

    park.release();
    await Promise.all(runs);
    const body = await report();
    rows = perSpace(body);
    assert.equal(rows['r-done']?.state, 'done', `a completed restore act is not reported done: ${JSON.stringify(rows)}`);
    assert.ok(rows['r-done']?.edgeIndexes !== undefined && rows['r-done']?.vectorIndexes !== undefined, `the index results are not in the report: ${JSON.stringify(rows['r-done'])}`);
    assert.equal(rows['r-owed']?.state, 'owed', `a failed restore act is not reported owed: ${JSON.stringify(rows)}`);
    assert.ok(rows['r-owed'].attempts >= 1, 'the failed attempt is not counted in the report');
    assert.equal(typeof rows['r-owed'].lastError, 'string', 'the owed space carries no lastError');
    assert.doesNotMatch(rows['r-owed'].lastError, /E11000|mongodb:\/\/|hunter2/, `the report carries the driver's text: ${rows['r-owed'].lastError}`);
    assert.equal(maintenance.isMaintenanceActive(), true, 'maintenance ended while a restore act is still owed');

    const abandoned = await callDataDoor(mods.dataRouter, 'post', '/restore/abandon');
    assert.equal(abandoned.status, 200, `abandon answered ${abandoned.status}: ${JSON.stringify(abandoned.body)}`);
    assert.match(JSON.stringify(abandoned.body), /r-owed/, 'the abandon does not list the space it left possibly half restored');
    assert.doesNotMatch(JSON.stringify(abandoned.body?.halfRestored ?? abandoned.body?.spaces ?? []), /r-done/, 'the abandon lists a space whose restore completed');
    assert.deepEqual(restoreEntries(mods.loader), [], 'the abandon left restore acts standing');
    const writers = { fact: await import('../../server/dist/brain/fact.js') };
    assert.ok(await writers.fact.saveFact('r-owed', 'after the abandon', [], [], undefined, undefined, 'note'), 'the abandon did not lift the hold');
    assert.equal(maintenance.isMaintenanceActive(), false, 'maintenance outlived the abandoned restore');
    assert.equal(perSpace(await report())['r-owed']?.state, 'restore_abandoned', 'the report does not say the space\'s restore was abandoned');
    const audit = await auditRowsOf(door.mongo, 'data.restore.abandoned');
    assert.ok(audit.some(r => JSON.stringify(r).includes(backup.id)), `no data.restore.abandoned audit row names the backup: ${JSON.stringify(audit)}`);
  });
});
