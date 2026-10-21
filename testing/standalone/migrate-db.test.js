/**
 * Migrating to a second database copies the data BEFORE the URI is saved, refuses what would lose data, keeps the receive marks and
 * resumes after a crash (bundle-157 plan rev 2 Q-553, rev 3 R3.4, rev 4 R4.4, rev 5 R5.4; the owner's design is a `migrate` act).
 *
 * ## The defect
 *
 * Today `POST /api/admin/data/migrate` dumps the old database to `<data>/migration-backup`, writes a marker file, SAVES the new URI and exits.
 * Nothing is copied to the new database in the process: the copy is meant to happen at the next boot, by a step that has to run in the
 * right place among the boot migrations, that re-runs on a marker that outlives its use, and that a `MONGO_URI` set to anything (the
 * compose default is an empty string) silently bypasses. The new design copies ONLINE, under holds, and saves the URI in the
 * completion write.
 *
 * ## Rows (each red today for the reason in its own message)
 *
 * 1. **An environment-sourced URI is refused.** A real `MONGO_URI` value is the infrastructure's, so the route answers 409 `INFRA_MANAGED` and
 *    registers nothing. (An EMPTY `MONGO_URI` is unset everywhere - rev 4 R4.4, the coordinator's ruling - so it is not this row; it is
 *    `one-uri-rule.test.js`.) Red: the route proceeds.
 * 2. **A non-empty target is refused, without naming its collections or driver text.** 4xx, nothing registered, maintenance off, the
 *    target untouched, the URI unchanged. Red: the route proceeds.
 * 3. **A migrate into an empty second database carries every record and keeps the receive marks.** Every collection of the source arrives with
 *    the same ids, the URI is saved only then, the network members' six marks are as they were (the data is the same), no migrate entry
 *    stands. Red: the target is empty - the copy waits for a boot that this process never makes.
 * 4. **The migrate dump is a normal backup under `backupsRoot()`** (`<data>/backups/<id>/manifest.json`), not a `migration-backup` of its
 *    own. Red: it is written to `migration-backup`.
 * 5. **A crash before the URI is saved resumes and overwrites a partly filled target.** The completion's own hook throws once; the copy is
 *    on the target and the old URI still stands; the target is then damaged by hand (an extra record, a missing one); the resumed act
 *    replaces what it copies, so the target equals the source again, and only then is the URI saved. Red: nothing is copied.
 *
 * ## How it reaches the route
 *
 * In-process, past auth, through the door's `routeHandler` / `request`. `NODE_ENV=test` keeps the route from exiting the test process,
 * as the route's own comment says. The target is addressed by a HOSTNAME (`ythril-target.test`) that `dns.lookup` is patched to resolve to the
 * harness Mongo, because the route refuses loopback and private addresses (`isSsrfSafeMongoUri`) and a refused address is not what is
 * under test. `MONGO_URI` is removed after the harness connects and the harness URI is put in the config, so the effective source is the
 * config, which is the only one a migrate may start from.
 *
 * Run: node --test testing/standalone/migrate-db.test.js (a Mongo the harness accepts; a prior `npx tsc -p server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { emptyTarget } from './_migrate-target.mjs';
import { mongoSkipReason, testMongoUri, TEST_MONGO_HOST } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, entriesOf, resetRunnerForTest, netFixture, untilRunnerIdle } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['NODE_ENV'] = 'test';
process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
delete process.env['YTHRIL_MONGO_INFRA_MANAGED'];

const T = { timeout: 90_000 };
const SUITE = 'migrate';
const SPACES = ['m-a', 'm-b'];
const TARGET_HOST = 'ythril-target.test';
const TARGET_DB = 'ythril_migrate_target';
const SOURCE_DB = `ythril_harness_${SUITE}`;
const TARGET_URI = testMongoUri(TARGET_DB).replace(`@${TEST_MONGO_HOST}:`, `@${TARGET_HOST}:`).replace(`//${TEST_MONGO_HOST}:`, `//${TARGET_HOST}:`);
const SOURCE_URI = testMongoUri(SOURCE_DB);
const MARKS = ['lastSeqReceived', 'lastSeqPushed', 'lastSeqServed', 'lastFileTombstoneAckedAt', 'tombstoneRereadAt', 'fileMetaRereadAt'];

const realLookup = dns.lookup;
function patchDns() {
  dns.lookup = function lookup(hostname, options, cb) {
    if (hostname !== TARGET_HOST) return realLookup.call(this, hostname, options, cb);
    if (typeof options === 'function') { cb = options; options = {}; }
    return options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  };
}

const member = () => ({
  instanceId: 'peer-1', label: 'peer-1', url: 'http://peer-1.invalid', tokenHash: 'x', joinedAt: '2026-01-01T00:00:00.000Z',
  lastSeqReceived: { 'm-a': 9 }, lastSeqPushed: { 'm-a': 8 }, lastSeqServed: { 'm-a': 7 },
  lastFileTombstoneAckedAt: { 'm-a': '2026-02-02T00:00:00.000Z' }, tombstoneRereadAt: { 'm-a': 'done' }, fileMetaRereadAt: { 'm-a': 'done' },
});

describe('migrate copies before it saves the URI, refuses what would lose data and keeps the marks', { skip }, () => {
  let door, loader, runner, dataRouter, maintenance, fixture, target, handler, DATA_ROOT;

  before(async () => {
    patchDns();
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    maintenance = await import('../../server/dist/maintenance.js');
    ({ dataRouter } = await import('../../server/dist/api/data.js'));
    handler = door.routeHandler(dataRouter, 'post', '/migrate');
    DATA_ROOT = process.env['DATA_ROOT'];
    const { MongoClient } = await import('mongodb');
    fixture = new MongoClient(SOURCE_URI);
    target = new MongoClient(testMongoUri(TARGET_DB));
    await Promise.all([fixture.connect(), target.connect()]);
  });
  after(async () => {
    dns.lookup = realLookup;
    try { resetRunnerForTest(runner); } catch { /* the runner never loaded */ }
    await target?.db(TARGET_DB).dropDatabase().catch(() => {});
    await Promise.all([fixture?.close(), target?.close()]);
    await door?.close();
  });

  /** A known state: the harness URI in the config (never in the environment), marks on a member, records in two spaces, an empty target. */
  beforeEach(async () => {
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    resetRunnerForTest(runner);
    clearActEntries(loader);
    maintenance.setMaintenanceActive(false);
    delete process.env['MONGO_URI'];
    loader.mutateConfig(cfg => {
      cfg.mongo = { uri: SOURCE_URI };
      cfg.networks = [{ ...netFixture('n-mig', { spaces: ['m-a'] }), members: [member()] }];
    });
    for (const f of ['migration-marker.json']) fs.rmSync(path.join(DATA_ROOT, f), { force: true });
    fs.rmSync(path.join(DATA_ROOT, 'migration-backup'), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_ROOT, 'backups'), { recursive: true, force: true });
    for (const s of SPACES) {
      await door.coll(s, 'facts').deleteMany({});
      await door.coll(s, 'facts').insertMany([1, 2, 3].map(i => ({ _id: `${s}-f${i}`, spaceId: s, fact: `fact ${i}`, tags: [], seq: i })));
    }
    await emptyTarget(target, TARGET_DB);
  });
  afterEach(() => { try { clearActEntries(loader); maintenance.setMaintenanceActive(false); resetRunnerForTest(runner); } catch { /* best effort */ } });

  const migrate = () => door.request(handler, { body: { uri: TARGET_URI } });
  const targetCollections = async () => (await target.db(TARGET_DB).listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort();
  const idsOf = async (client, db, name) => (await client.db(db).collection(name).find({}, { projection: { _id: 1 } }).toArray()).map(d => String(d._id)).sort();
  const migrateEntries = () => entriesOf(loader).filter(e => e.kind === 'migrate');
  /** Until the config holds the target URI and no migrate entry stands, bounded by turns of the event loop; THROWS when it never does. */
  async function untilMigrated() {
    for (let i = 0; i < 4000; i++) {
      if (loader.getConfig().mongo?.uri === TARGET_URI && migrateEntries().length === 0) return;
      await new Promise(resolve => (i % 50 === 49 ? setTimeout(resolve, 15) : setImmediate(resolve)));
    }
    throw new Error(`the migrate never completed: uri=${loader.getConfig().mongo?.uri}, entries=${JSON.stringify(migrateEntries().map(e => [e.localId, e.state]))}`);
  }
  const sourceCollections = async () => (await fixture.db(SOURCE_DB).listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort();

  it('row 1: an environment-sourced URI is refused with INFRA_MANAGED and nothing is registered', T, async () => {
    process.env['MONGO_URI'] = SOURCE_URI; // a real value: the infrastructure's
    const out = await migrate();
    delete process.env['MONGO_URI'];
    assert.equal(out.status, 409, `a URI the environment supplies must not be migrated by the API: ${JSON.stringify(out.body)}`);
    assert.equal(out.body?.code, 'INFRA_MANAGED');
    assert.deepEqual(entriesOf(loader), [], 'a refused migrate registered an act');
    assert.equal(maintenance.isMaintenanceActive(), false, 'a refused migrate left the instance in maintenance');
    assert.deepEqual(await targetCollections(), [], 'a refused migrate wrote to the target');
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'a refused migrate changed the saved URI');
  });

  it('row 2: a non-empty target is refused without naming its collections or driver text, and is left as it was', T, async () => {
    const stray = 'someone_elses_collection_7f3a';
    await target.db(TARGET_DB).collection(stray).insertOne({ _id: 'theirs', keep: true });
    const out = await migrate();
    assert.ok(out.status >= 400 && out.status < 500, `a target that holds data was accepted: ${out.status} ${JSON.stringify(out.body)}`);
    const said = JSON.stringify(out.body);
    assert.ok(!said.includes(stray), `the refusal names the target's collection: ${said}`);
    assert.ok(!/MongoServerError|MongoNetworkError|E11000|ECONN|ENOTFOUND/.test(said), `the refusal carries driver text: ${said}`);
    assert.deepEqual(entriesOf(loader), [], 'a refused migrate registered an act');
    assert.equal(maintenance.isMaintenanceActive(), false);
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'a refused migrate changed the saved URI');
    assert.deepEqual(await targetCollections(), [stray], 'a refused migrate touched the target');
    assert.deepEqual(await idsOf(target, TARGET_DB, stray), ['theirs']);
  });

  describe('a migrate into an empty second database', () => {
    let answered;
    before(async () => { /* the run is made in the first row's body, once, so each row below reads the same outcome */ answered = undefined; });

    const runOnce = async () => {
      if (answered) return answered;
      const out = await migrate();
      let completed = true; let why = '';
      if (out.status >= 200 && out.status < 300) { try { await untilMigrated(); } catch (err) { completed = false; why = String(err.message); } }
      // What the run left on disk, read NOW: the suite's beforeEach empties the backups directory before every later row.
      const root = path.join(DATA_ROOT, 'backups');
      const onDisk = {
        root,
        backups: fs.existsSync(root) ? fs.readdirSync(root).filter(n => fs.existsSync(path.join(root, n, 'manifest.json'))) : [],
        migrationBackup: fs.existsSync(path.join(DATA_ROOT, 'migration-backup')),
        marker: fs.existsSync(path.join(DATA_ROOT, 'migration-marker.json')),
      };
      answered = { out, completed, why, onDisk };
      return answered;
    };

    it('row 3: carries every record of every collection, keeps the receive marks, saves the URI only then', T, async () => {
      const { out, completed, why } = await runOnce();
      assert.ok(out.status >= 200 && out.status < 300, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
      const sources = await sourceCollections();
      assert.ok(sources.length >= 2, `the source holds ${sources.length} collections: the fixture seeded nothing`);
      assert.ok(sources.includes('m-a_facts') && sources.includes('m-b_facts'), `the source lacks the seeded collections: ${sources}`);
      for (const name of sources) {
        assert.deepEqual(await idsOf(target, TARGET_DB, name), await idsOf(fixture, SOURCE_DB, name),
          `collection ${name} did not arrive on the target with the same records (the copy waits for a boot that never comes)`);
      }
      assert.ok(completed, why);
      assert.equal(loader.getConfig().mongo?.uri, TARGET_URI);
      const m = loader.getConfig().networks.find(n => n.id === 'n-mig').members[0];
      assert.deepEqual(MARKS.filter(k => JSON.stringify(m[k]) !== JSON.stringify(member()[k])), [], 'a migrate moved or forgot a receive mark: the data is the same, so the marks are too');
      assert.deepEqual(migrateEntries(), [], 'a migrate entry outlived the completion');
    });

    it('row 4: the dump is a normal backup under backupsRoot, not a migration-backup of its own', T, async () => {
      const { onDisk } = await runOnce();
      assert.ok(onDisk.backups.length >= 1, `no backup with a manifest under ${onDisk.root}: the migrate's dump is somewhere a backup list never shows`);
      assert.equal(onDisk.migrationBackup, false, 'a migration-backup directory was written beside the backups');
      assert.equal(onDisk.marker, false, 'a migration marker was written: the copy is online, there is nothing to resume at boot');
    });
  });

  it('row 5: a crash before the URI is saved resumes, and the resumed act overwrites a partly filled target', T, async () => {
    let crashed = 0;
    runner.setSpaceActHooksForTest({ beforeComplete: (entry) => { if (entry.kind === 'migrate' && crashed === 0) { crashed++; throw new Error('simulated crash before the completion write'); } } });
    const out = await migrate();
    assert.ok(out.status >= 200 && out.status < 300, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
    // The act runs in the background: wait until the hook has fired (the copy is on the target by then) and the runner has settled.
    for (let i = 0; i < 4000 && crashed === 0; i++) await new Promise(resolve => (i % 50 === 49 ? setTimeout(resolve, 15) : setImmediate(resolve)));
    assert.equal(crashed, 1, 'the migrate act never reached its completion: it ran no body');
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'the URI was saved before the completion write');
    assert.deepEqual(await idsOf(target, TARGET_DB, 'm-a_facts'), ['m-a-f1', 'm-a-f2', 'm-a-f3'], 'the copy had not reached the target when the crash came');

    // The target is partly filled and wrong: one record extra, one missing. A resume must REPLACE what it copies.
    await target.db(TARGET_DB).collection('m-a_facts').insertOne({ _id: 'm-a-stray', spaceId: 'm-a', fact: 'stray', tags: [], seq: 99 });
    await target.db(TARGET_DB).collection('m-a_facts').deleteOne({ _id: 'm-a-f2' });
    assert.ok(migrateEntries().length >= 1, 'the crashed migrate left no entry to resume');

    await untilRunnerIdle(runner, loader, { now: Date.now() + 3_600_000 }).catch(() => {});
    await runner.resumeSpaceActs(Date.now() + 3_600_000);
    await untilMigrated();
    assert.deepEqual(await idsOf(target, TARGET_DB, 'm-a_facts'), await idsOf(fixture, SOURCE_DB, 'm-a_facts'), 'the resumed act left the damaged target as it found it');
    assert.equal(loader.getConfig().mongo?.uri, TARGET_URI);
  });
});
