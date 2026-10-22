/**
 * A migrate that cannot finish can be abandoned, as a restore can: `POST /api/admin/data/migrate/abandon` (bundle-157, Q-564 F5).
 *
 * ## The defect this holds
 *
 * `migrateInstance` rethrows a store-side failure and an operation timeout - of this database or of the target - as retryable, so a
 * migrate whose target never answers is owed for ever: no member reaches `needsAbandon`, every space stays held and the instance stays
 * in maintenance. The restore has a way out (`POST /api/admin/data/restore/abandon`); the migrate had none, so the only remedy was to
 * edit `config.json` by hand.
 *
 * ## The rule, and its three answers
 *
 * `POST /api/admin/data/migrate/abandon`, built on the same abandon as the restore's (the instance-wide kinds share it):
 *
 * - no migrate standing: `404` with `code: 'no_migrate_standing'`;
 * - the set's body is running: `409` with `code: 'migrate_act_running'`, and nothing changes (an abandon never cuts a body);
 * - otherwise `200` naming the released spaces (`released`) and the set (`migrateId`): every migrate entry leaves in one write, the
 *   holds and the maintenance lift, the saved URI is UNCHANGED (nothing is saved), the report reads `migrate_abandoned` per space, and
 *   the end is audited as an abandoned migrate set already is (`data.migrate.failed`, its path naming the set).
 *
 * ## How it is driven
 *
 * As `migrate-db.test.js` drives a migrate (in-process, `NODE_ENV=test`, the target a hostname resolved to the harness Mongo, the source
 * URI in the config). The body's run is parked in `beforeComplete` (a latch; no sleep) for the running row - inside the
 * run, since `afterDrain` is before the body starts - then released to throw there: the set is owed, as a target that keeps timing out
 * leaves it.
 *
 * ## Seen red
 *
 * On 38738096 there is no `POST /migrate/abandon` route on the data router: every row that asks it fails on its absence.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-standing-migrate-can-be-abandoned-db.test.js` (a prior
 * `npx tsc -p server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { emptyTarget } from './_migrate-target.mjs';
import { mongoSkipReason, testMongoUri, TEST_MONGO_HOST } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, entriesOf, resetRunnerForTest, deferred, untilRunnerIdle, auditRowsOf } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['NODE_ENV'] = 'test';
process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
delete process.env['YTHRIL_MONGO_INFRA_MANAGED'];

const T = { timeout: 120_000 };
const SUITE = 'migrateabandon';
const SPACES = ['ma-a', 'ma-b'];
const TARGET_HOST = 'ythril-abandon-target.test';
const TARGET_DB = 'ythril_migrate_abandon_target';
const SOURCE_DB = `ythril_harness_${SUITE}`;
const TARGET_URI = testMongoUri(TARGET_DB).replace(`@${TEST_MONGO_HOST}:`, `@${TARGET_HOST}:`).replace(`//${TEST_MONGO_HOST}:`, `//${TARGET_HOST}:`);
const SOURCE_URI = testMongoUri(SOURCE_DB);

const realLookup = dns.lookup;
function patchDns() {
  dns.lookup = function lookup(hostname, options, cb) {
    if (hostname !== TARGET_HOST) return realLookup.call(this, hostname, options, cb);
    if (typeof options === 'function') { cb = options; options = {}; }
    return options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  };
}

describe('a standing migrate can be abandoned (real MongoDB)', { skip }, () => {
  let door, loader, runner, maintenance, dataRouter, target, MIGRATE_FAILED;

  const migrateEntries = () => entriesOf(loader).filter(e => e.kind === 'migrate');
  /** POST /migrate/abandon as an admin; a router without the route is answered `{ status: 'no route' }`, so each row fails on it by name. */
  async function abandon() {
    let handler;
    try { handler = door.routeHandler(dataRouter, 'post', '/migrate/abandon'); } catch { return { status: 'no route', body: null }; }
    return door.request(handler);
  }

  before(async () => {
    patchDns();
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    maintenance = await import('../../server/dist/maintenance.js');
    ({ dataRouter } = await import('../../server/dist/api/data.js'));
    ({ MIGRATE_FAILED_OPERATION: MIGRATE_FAILED } = await import('../../server/dist/audit/act-set-operations.js'));
    const { MongoClient } = await import('mongodb');
    target = new MongoClient(testMongoUri(TARGET_DB));
    await target.connect();
    await emptyTarget(target, TARGET_DB);
    resetRunnerForTest(runner);
    clearActEntries(loader);
    maintenance.setMaintenanceActive(false);
    delete process.env['MONGO_URI'];
    loader.mutateConfig(cfg => { cfg.mongo = { uri: SOURCE_URI }; });
    for (const s of SPACES) await door.coll(s, 'facts').insertOne({ _id: `${s}-f1`, spaceId: s, fact: 'kept', tags: [], seq: 1 });
  });
  after(async () => {
    dns.lookup = realLookup;
    try { runner.setSpaceActHooksForTest(null); resetRunnerForTest(runner); clearActEntries(loader); maintenance.setMaintenanceActive(false); } catch { /* never loaded */ }
    await target?.db(TARGET_DB).dropDatabase().catch(() => {});
    await target?.close();
    await door?.close();
  });

  it('with no migrate standing it answers 404 no_migrate_standing', T, async () => {
    const out = await abandon();
    assert.equal(out.status, 404, `abandon with nothing standing answered ${out.status} ${JSON.stringify(out.body)}`);
    assert.equal(out.body?.code, 'no_migrate_standing');
  });

  it('while the body runs it answers 409 migrate_act_running and changes nothing; once owed it answers 200, keeps the URI and lifts every hold', T, async () => {
    const park = deferred();
    let parked = false;
    runner.setSpaceActHooksForTest({
      // Parked INSIDE the body's run (after the copy, before the completion): `afterDrain` is before the body starts, where an abandon is
      // allowed and the body then finds no entry to run. Released, it throws: a target that keeps timing out leaves the set owed, and a
      // throw at the completion is that, without waiting for a real timeout.
      beforeComplete: async (e) => {
        if (e.kind !== 'migrate') return;
        if (!parked) { parked = true; park.arrive(); await park.promise; }
        throw new Error('the target did not answer in time');
      },
    });
    const started = await door.request(door.routeHandler(dataRouter, 'post', '/migrate'), { body: { uri: TARGET_URI } });
    assert.ok(started.status >= 200 && started.status < 300, `the migrate was refused: ${started.status} ${JSON.stringify(started.body)}`);
    const migrateId = started.body?.migrateId;
    await park.reached;

    const running = await abandon();
    assert.equal(running.status, 409, `abandon while the body runs answered ${running.status} ${JSON.stringify(running.body)}`);
    assert.equal(running.body?.code, 'migrate_act_running');
    assert.equal(migrateEntries().length, SPACES.length, 'an abandon refused while the body ran still removed migrate entries');

    park.release();
    await untilRunnerIdle(runner, loader);
    assert.ok(migrateEntries().length > 0 && migrateEntries().every(e => e.state === 'owed'), `the migrate is not owed: ${JSON.stringify(migrateEntries().map(e => [e.localId, e.state]))}`);
    assert.equal(maintenance.isMaintenanceActive(), true, 'control: a standing migrate holds maintenance');

    const out = await abandon();
    assert.equal(out.status, 200, `abandon of an owed migrate answered ${out.status} ${JSON.stringify(out.body)}`);
    assert.equal(out.body?.migrateId, migrateId, `the answer does not name the set: ${JSON.stringify(out.body)}`);
    assert.deepEqual([...(out.body?.released ?? [])].sort(), [...SPACES].sort(), `the answer does not name the released spaces: ${JSON.stringify(out.body)}`);
    assert.deepEqual(migrateEntries(), [], 'the abandon left migrate entries standing');
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'the abandon changed the saved URI: nothing may be saved');
    assert.equal(maintenance.isMaintenanceActive(), false, 'maintenance outlived the abandoned migrate');
    const fact = await import('../../server/dist/brain/fact.js');
    assert.ok(await fact.saveFact(SPACES[0], 'after the abandon', [], [], undefined, undefined, 'note'), 'the abandon did not lift the hold');

    const report = await door.request(door.routeHandler(dataRouter, 'get', '/migrate'));
    const rows = report.body?.migrate?.spaces ?? report.body?.spaces ?? [];
    assert.ok(rows.length >= SPACES.length && rows.every(r => r.state === 'migrate_abandoned'), `the report does not read migrate_abandoned per space: ${JSON.stringify(rows)}`);
    const audit = await auditRowsOf(door.mongo, MIGRATE_FAILED);
    assert.ok(audit.some(r => JSON.stringify(r).includes(migrateId)), `no ${MIGRATE_FAILED} audit row names the abandoned set: ${JSON.stringify(audit)}`);

    const again = await abandon();
    assert.equal(again.status, 404, 'an abandoned migrate still answered as standing');
    assert.equal(again.body?.code, 'no_migrate_standing');
  });
});
