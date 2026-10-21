/**
 * An operator can see a migrate, find what it came to in the audit log, and trust that a hung database operation of its copy ends the
 * attempt instead of holding every space for ever (bundle-157 slice I4a; design rev 4 R4.2-R4.3, rev 5 R5.1, R5.7).
 *
 * ## The defect
 *
 * A migrate answers 202 and does its work in an act set, so the answer can no longer carry the outcome - and nothing else did: a failed
 * migrate left its reason only on the set record in the config file and in the log. There was no `GET /migrate`, no outcome audit row
 * (the request's row was `data.migrate`, the same name a request and an outcome would share), and the copy ran on clients of its own,
 * outside the one door (`getDb`) the runner's per-operation bound reaches, so one insert the target never answered held the set, and with
 * it every space and maintenance, for as long as the socket stayed open.
 *
 * ## Rows (each red today for the reason in its own message)
 *
 * 1. **The report door.** `GET /api/admin/data/migrate` answers `{ migrate: null }` before any migrate, and after one the restore report's
 *    shape for kind `migrate`: `migrateId`, `state`, `done`/`total`, per space `state`, `attempts`, `completedAt`, and the backup the copy
 *    went through. It never carries the target URI. Red: the router has no `GET /migrate`.
 * 2. **The audit rows.** The request is `data.migrate.requested`, the report read is `data.migrate.report`, and a completed migrate writes
 *    `data.migrate.completed` into the TARGET's `audit_log` (the database the instance continues with), naming the migrate and the
 *    backup, never the URI. Red: the request is `data.migrate` and no outcome row is written anywhere.
 * 3. **A failed copy is reported and audited.** The target refuses an insert as a duplicate (an input failure: never retried): the report
 *    says `abandoned` with our sentence naming the backup (no driver text, no URI), and `data.migrate.failed` lands in the database being
 *    kept (the old one). Red: no report door, no row.
 * 4. **The copy is bounded.** The target holds one insert without answering (a `failCommand` that blocks the connection) and the act's
 *    per-operation bound is 1 s: the attempt fails within the bound, the act is owed with a retry time (a store outage, not an input
 *    failure: the set stands, the URI is unchanged), and once the target answers again the act comes due and completes. Red: the act is
 *    still running past the bound, because the copy's client carries none.
 *
 * ## How it is driven
 *
 * In-process, past auth, as `migrate-db.test.js` drives it: the target is addressed by a hostname patched to resolve to the harness Mongo
 * (the route refuses loopback addresses), and its URI names an `appName` so a `failCommand` fail point matches the copy's target client
 * and nothing else. The fail point needs a mongod started with `enableTestCommands=1`; without it rows 3 and 4 fail naming that.
 *
 * Run: node --test testing/standalone/a-migrate-is-reported-audited-and-bounded-db.test.js (a Mongo the harness accepts; a prior
 * `npx tsc -p server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { mongoSkipReason, testMongoUri, TEST_MONGO_HOST } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, entriesOf, resetRunnerForTest } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['NODE_ENV'] = 'test';
process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
delete process.env['YTHRIL_MONGO_INFRA_MANAGED'];

const T = { timeout: 90_000 };
const SUITE = 'migratereport';
const SPACES = ['mr-a', 'mr-b'];
const TARGET_HOST = 'ythril-report-target.test';
const TARGET_DB = 'ythril_migrate_report_target';
const SOURCE_DB = `ythril_harness_${SUITE}`;
const APP = 'ythril-migrate-report-target';
const TARGET_URI = testMongoUri(TARGET_DB, { query: `&appName=${APP}` })
  .replace(`@${TEST_MONGO_HOST}:`, `@${TARGET_HOST}:`).replace(`//${TEST_MONGO_HOST}:`, `//${TARGET_HOST}:`);
const SOURCE_URI = testMongoUri(SOURCE_DB);
const DRIVER_TEXT = /E11000|MongoServerError|MongoNetworkError|MongoOperationTimeoutError|ECONN|ENOTFOUND/;

const realLookup = dns.lookup;
function patchDns() {
  dns.lookup = function lookup(hostname, options, cb) {
    if (hostname !== TARGET_HOST) return realLookup.call(this, hostname, options, cb);
    if (typeof options === 'function') { cb = options; options = {}; }
    return options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  };
}

/** Bounded by turns of the event loop and a wall clock; THROWS naming `what` when `holds` never answers true. */
async function until(holds, what, ms = 30_000) {
  const end = Date.now() + ms;
  for (let i = 0; Date.now() < end; i++) {
    if (await holds()) return;
    await new Promise(resolve => (i % 50 === 49 ? setTimeout(resolve, 15) : setImmediate(resolve)));
  }
  throw new Error(`never: ${what}`);
}

describe('a migrate is reported, audited and bounded like a restore', { skip }, () => {
  let door, loader, runner, dataRouter, maintenance, audit, fixture, target, admin, postMigrate;

  before(async () => {
    patchDns();
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    maintenance = await import('../../server/dist/maintenance.js');
    audit = await import('../../server/dist/audit/middleware.js');
    ({ dataRouter } = await import('../../server/dist/api/data.js'));
    postMigrate = door.routeHandler(dataRouter, 'post', '/migrate');
    const { MongoClient } = await import('mongodb');
    fixture = new MongoClient(SOURCE_URI);
    target = new MongoClient(testMongoUri(TARGET_DB));
    admin = new MongoClient(testMongoUri('admin'));
    await Promise.all([fixture.connect(), target.connect(), admin.connect()]);
  });
  after(async () => {
    dns.lookup = realLookup;
    await failPoint('off').catch(() => {});
    try { resetRunnerForTest(runner); } catch { /* the runner never loaded */ }
    await target?.db(TARGET_DB).dropDatabase().catch(() => {});
    await Promise.all([fixture?.close(), target?.close(), admin?.close()]);
    await door?.close();
  });

  beforeEach(async () => {
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    resetRunnerForTest(runner);
    clearActEntries(loader);
    maintenance.setMaintenanceActive(false);
    delete process.env['MONGO_URI'];
    loader.mutateConfig(cfg => { cfg.mongo = { uri: SOURCE_URI }; delete cfg.spaceActSets; });
    for (const s of SPACES) {
      await door.coll(s, 'facts').deleteMany({});
      await door.coll(s, 'facts').insertMany([1, 2, 3].map(i => ({ _id: `${s}-f${i}`, spaceId: s, fact: `fact ${i}`, tags: [], seq: i })));
    }
    await target.db(TARGET_DB).dropDatabase();
  });
  afterEach(async () => {
    await failPoint('off').catch(() => {});
    try { clearActEntries(loader); maintenance.setMaintenanceActive(false); resetRunnerForTest(runner); } catch { /* best effort */ }
  });

  /** Set the `failCommand` fail point on the target's inserts (matched by the target URI's appName), or turn it off. */
  async function failPoint(mode, data = {}) {
    try {
      await admin.db('admin').command({ configureFailPoint: 'failCommand', mode, ...(mode === 'off' ? {} : { data: { failCommands: ['insert'], appName: APP, ...data } }) });
    } catch (err) {
      throw new Error(`the harness mongod refuses failCommand (start it with --setParameter enableTestCommands=1): ${err.message}`);
    }
  }

  const migrate = () => door.request(postMigrate, { body: { uri: TARGET_URI } });
  const migrateEntries = () => entriesOf(loader).filter(e => e.kind === 'migrate');
  const migrated = () => loader.getConfig().mongo?.uri === TARGET_URI && migrateEntries().length === 0;
  const report = async () => {
    const layer = dataRouter.stack.find(l => l.route?.path === '/migrate' && l.route.methods?.get);
    assert.ok(layer, 'the data router has no GET /migrate: a migrate\'s progress and outcome are reported nowhere an operator can ask');
    const out = await door.request(layer.route.stack.at(-1).handle);
    assert.equal(out.status, 200, `GET /migrate answered ${out.status}: ${JSON.stringify(out.body)}`);
    return out.body;
  };
  const auditRows = async (client, db, operation) => client.db(db).collection('audit_log').find({ operation }).toArray();

  it('row 1: GET /migrate answers null before any migrate, then the set in the restore report\'s shape, without the target URI', T, async () => {
    assert.deepEqual(await report(), { migrate: null }, 'before any migrate the report must say there is none');
    const out = await migrate();
    assert.equal(out.status, 202, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
    await until(migrated, 'the migrate completed');
    const body = await report();
    assert.equal(body.migrateId, out.body.migrateId, `the report names another set: ${JSON.stringify(body)}`);
    assert.equal(body.state, 'completed');
    assert.equal(body.total, SPACES.length);
    assert.equal(body.done, SPACES.length);
    assert.ok(typeof body.backupId === 'string' && body.backupId.length > 0, `the report does not name the backup the copy went through: ${JSON.stringify(body)}`);
    assert.deepEqual(body.spaces.map(s => s.id).sort(), [...SPACES].sort());
    for (const s of body.spaces) {
      assert.equal(s.state, 'done', `space ${s.id}: ${JSON.stringify(s)}`);
      assert.equal(typeof s.attempts, 'number');
      assert.ok(typeof s.completedAt === 'string', `space ${s.id} has no completedAt`);
    }
    const said = JSON.stringify(body);
    assert.ok(!said.includes(TARGET_HOST) && !said.includes('mongodb://'), `the report carries the target URI: ${said}`);
    // The restore's door is the same report for its own kind, and still answers.
    const restoreLayer = dataRouter.stack.find(l => l.route?.path === '/restore' && l.route.methods?.get);
    const restore = await door.request(restoreLayer.route.stack.at(-1).handle);
    assert.equal(restore.status, 200);
    assert.ok(restore.body?.restore === null || typeof restore.body?.restoreId === 'string', `GET /restore lost its contract: ${JSON.stringify(restore.body)}`);
  });

  it('row 2: the request, the read and the completion each have their own audit operation; the completion lands in the TARGET', T, async () => {
    assert.equal(audit.resolveOperation('POST', '/api/admin/data/migrate')?.operation, 'data.migrate.requested',
      'the request of a migrate is audited under a name an outcome would share');
    const read = audit.resolveOperation('GET', '/api/admin/data/migrate');
    assert.equal(read?.operation, 'data.migrate.report', 'the report read is not audited');
    assert.equal(read?.read, true);

    const out = await migrate();
    assert.equal(out.status, 202, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
    await until(migrated, 'the migrate completed');
    const rows = await auditRows(target, TARGET_DB, 'data.migrate.completed');
    assert.equal(rows.length, 1, `the target's audit log holds ${rows.length} completion row(s): the database the instance continues with does not say it was migrated into`);
    const { backupId } = await report();
    assert.ok(rows[0].path.includes(out.body.migrateId), `the row does not name the migrate: ${rows[0].path}`);
    assert.ok(rows[0].path.includes(backupId), `the row does not name the backup: ${rows[0].path}`);
    assert.ok(!JSON.stringify(rows[0]).includes(TARGET_HOST) && !JSON.stringify(rows[0]).includes('mongodb://'), 'the row carries the URI');
    assert.deepEqual(await auditRows(fixture, SOURCE_DB, 'data.migrate.completed'), [],
      'the completion row was written to the database the instance left, where nobody reads it');
  });

  it('row 3: a copy the target refuses is reported abandoned in our words naming the backup, and audited in the database kept', T, async () => {
    await failPoint({ times: 1 }, { errorCode: 11000 });
    const out = await migrate();
    assert.equal(out.status, 202, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
    await until(() => migrateEntries().length === 0, 'the failed migrate ended');
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'a failed migrate changed the saved URI');
    const body = await report();
    assert.equal(body.state, 'abandoned', `the report: ${JSON.stringify(body)}`);
    assert.ok(typeof body.backupId === 'string' && body.backupId.length > 0, `the report names no backup: ${JSON.stringify(body)}`);
    assert.ok(typeof body.lastError === 'string' && body.lastError.includes(body.backupId), `the report's lastError does not name the backup: ${JSON.stringify(body)}`);
    assert.ok(!DRIVER_TEXT.test(body.lastError) && !body.lastError.includes(TARGET_HOST), `the report carries driver text or the URI: ${body.lastError}`);
    for (const s of body.spaces) assert.equal(s.state, 'migrate_abandoned', `space ${s.id}: ${JSON.stringify(s)}`);
    await until(async () => (await auditRows(fixture, SOURCE_DB, 'data.migrate.failed')).length > 0, 'a data.migrate.failed row in the database kept', 10_000);
    const [row] = await auditRows(fixture, SOURCE_DB, 'data.migrate.failed');
    assert.ok(row.path.includes(out.body.migrateId) && row.path.includes(body.backupId), `the failure row names neither the migrate nor the backup: ${row.path}`);
    assert.ok(!JSON.stringify(row).includes(TARGET_HOST), 'the failure row carries the URI');
  });

  it('row 4: a target that holds an insert unanswered fails the attempt within the bound, the act stays owed, and comes due again', T, async () => {
    runner.setSpaceActKnobsForTest({ SPACE_ACT_OP_MS: 1_000 });
    const BLOCK_MS = 6_000;
    await failPoint({ times: 1 }, { blockConnection: true, blockTimeMS: BLOCK_MS });
    const started = Date.now();
    const out = await migrate();
    assert.equal(out.status, 202, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
    const owed = () => { const es = migrateEntries(); return es.length > 0 && es.every(e => e.state === 'owed' && e.retryAt && !e.needsAbandon); };
    try {
      await until(owed, 'the act owed with a retry time', 4_000);
    } catch {
      assert.fail(`the copy's insert was not bounded: ${Date.now() - started} ms after the request the migrate entries are `
        + `${JSON.stringify(migrateEntries().map(e => [e.localId, e.state, e.lastError ?? null]))} and the set is `
        + `${JSON.stringify(loader.getConfig().spaceActSets?.find(s => s.kind === 'migrate')?.outcome ?? 'standing')}`);
    }
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'a timed-out copy saved the URI');
    assert.ok(!loader.getConfig().spaceActSets?.find(s => s.kind === 'migrate')?.endedAt, 'a timed-out copy ended the set: a store outage is retried, not abandoned');
    const [e] = migrateEntries();
    assert.ok(!DRIVER_TEXT.test(e.lastError ?? ''), `the owed act's lastError carries driver text: ${e.lastError}`);

    // The held insert is released and lands (or fails) on the server; then the act comes due and replaces what it copied.
    await failPoint('off');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, BLOCK_MS + 500 - (Date.now() - started))));
    runner.setSpaceActKnobsForTest(null);
    await runner.resumeSpaceActs(Date.now() + 3_600_000);
    await until(migrated, 'the retried migrate completed');
    const ids = async (client, db) => (await client.db(db).collection('mr-a_facts').find({}, { projection: { _id: 1 } }).toArray()).map(d => String(d._id)).sort();
    assert.deepEqual(await ids(target, TARGET_DB), await ids(fixture, SOURCE_DB));
  });
});
