/**
 * A migrate that is retried leaves ONE dump of its database, and a dump that fails leaves no directory (bundle-159, Q-566).
 *
 * ## The defect this holds
 *
 * `migrateInstance` dumps the whole database as a normal backup on EVERY attempt, and the set records only the latest dump's id. A
 * migrate whose target keeps failing is retried on a backoff of a minute to an hour, so it wrote a full dump per attempt, named
 * nowhere once the next was noted, and removed by no retention (the scheduled backup is refused while a migrate stands, and the local
 * count only runs when `keepLocal` is set). A dump that failed part-way left its directory too: `pruneBackups` counts only directories
 * with a manifest, which the dump writes last, so a partial dump was never removed.
 *
 * ## The rule
 *
 * - A retried copy dumps again (the instance collections written between attempts must reach the target) and removes the dump its
 *   earlier attempt took, so the migrate leaves exactly the backup its report names.
 * - A dump that throws removes its own directory before it rethrows.
 *
 * ## How it is driven
 *
 * As `migrate-db.test.js` row 5 drives a crashed copy: a `beforeComplete` hook throws once, the runner is resumed past its backoff,
 * and the migrate completes. The directories under `<DATA_ROOT>/backups` are read when it has.
 *
 * ## Seen red
 *
 * The retried migrate left two directories with a manifest (one per attempt) and the failed dump left its directory behind.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-retried-migrate-leaves-one-dump-of-its-set-db.test.js`
 * (a prior `npx tsc -p server`).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { emptyTarget } from './_migrate-target.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';
import { mongoSkipReason, testMongoUri, TEST_MONGO_HOST } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, entriesOf, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['NODE_ENV'] = 'test';
process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
delete process.env['YTHRIL_MONGO_INFRA_MANAGED'];

const T = { timeout: 90_000 };
const COPY_MS = 30_000;
const SUITE = 'migrateonedump';
const SPACES = ['od-a', 'od-b'];
const TARGET_HOST = 'ythril-onedump-target.test';
const TARGET_DB = 'ythril_migrate_onedump_target';
const SOURCE_DB = `ythril_harness_${SUITE}`;
const TARGET_URI = testMongoUri(TARGET_DB).replace(`@${TEST_MONGO_HOST}:`, `@${TARGET_HOST}:`).replace(`//${TEST_MONGO_HOST}:`, `//${TARGET_HOST}:`);
const SOURCE_URI = testMongoUri(SOURCE_DB);

const realLookup = dns.lookup;
const realWrite = fs.writeFileSync;
function patchDns() {
  dns.lookup = function lookup(hostname, options, cb) {
    if (hostname !== TARGET_HOST) return realLookup.call(this, hostname, options, cb);
    if (typeof options === 'function') { cb = options; options = {}; }
    return options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  };
}

describe('a retried migrate leaves one dump of its set, and a failed dump leaves none (real MongoDB)', { skip }, () => {
  let door, loader, runner, dataRouter, maintenance, target, scheduler, DATA_ROOT;

  before(async () => {
    patchDns();
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    maintenance = await import('../../server/dist/maintenance.js');
    scheduler = await import('../../server/dist/db/backup-scheduler.js');
    ({ dataRouter } = await import('../../server/dist/api/data.js'));
    DATA_ROOT = process.env['DATA_ROOT'];
    const { MongoClient } = await import('mongodb');
    target = new MongoClient(testMongoUri(TARGET_DB));
    await target.connect();
  });
  after(async () => {
    fs.writeFileSync = realWrite;
    dns.lookup = realLookup;
    try { runner?.setSpaceActHooksForTest(null); resetRunnerForTest(runner); clearActEntries(loader); maintenance.setMaintenanceActive(false); } catch { /* never loaded */ }
    await target?.db(TARGET_DB).dropDatabase().catch(() => {});
    await target?.close();
    await door?.close();
  });

  beforeEach(async () => {
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    resetRunnerForTest(runner);
    clearActEntries(loader);
    maintenance.setMaintenanceActive(false);
    delete process.env['MONGO_URI'];
    loader.mutateConfig(cfg => { cfg.mongo = { uri: SOURCE_URI }; });
    fs.rmSync(path.join(DATA_ROOT, 'backups'), { recursive: true, force: true });
    for (const s of SPACES) {
      await door.coll(s, 'facts').deleteMany({});
      await door.coll(s, 'facts').insertOne({ _id: `${s}-f1`, spaceId: s, fact: 'kept', tags: [], seq: 1 });
    }
    await emptyTarget(target, TARGET_DB);
  });
  afterEach(() => {
    fs.writeFileSync = realWrite;
    try { runner.setSpaceActHooksForTest(null); clearActEntries(loader); maintenance.setMaintenanceActive(false); resetRunnerForTest(runner); } catch { /* best effort */ }
  });

  const migrateEntries = () => entriesOf(loader).filter(e => e.kind === 'migrate');
  const backupDirs = () => {
    const root = path.join(DATA_ROOT, 'backups');
    return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
  };

  it('a copy retried after a failure removes its earlier dump, so exactly the backup the report names is left', T, async () => {
    let failed = 0;
    runner.setSpaceActHooksForTest({ beforeComplete: (entry) => { if (entry.kind === 'migrate' && failed === 0) { failed++; throw new Error('simulated failure before the completion write'); } } });
    const out = await door.request(door.routeHandler(dataRouter, 'post', '/migrate'), { body: { uri: TARGET_URI } });
    assert.ok(out.status >= 200 && out.status < 300, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
    await holdsWithin(() => failed > 0, COPY_MS, 20, { what: 'the migrate reaching its completion' });
    await untilRunnerIdle(runner, loader).catch(() => {});
    assert.equal(failed, 1, 'the migrate never reached its completion');
    assert.equal(backupDirs().length, 1, `control: the first attempt left ${JSON.stringify(backupDirs())}`);
    assert.ok(migrateEntries().length > 0 && migrateEntries().every(e => e.state === 'owed'), 'control: the failed attempt is not owed');

    await runner.resumeSpaceActs(Date.now() + 3_600_000);
    await holdsWithin(() => loader.getConfig().mongo?.uri === TARGET_URI && migrateEntries().length === 0, COPY_MS, 20, { what: 'the retried migrate to complete' });

    const named = runner.spaceActSetOf('migrate')?.backupId;
    assert.ok(named, 'the migrate set names no backup');
    assert.deepEqual(backupDirs(), [named], `a retried migrate must leave exactly the dump its report names (${named}); the backups directory holds ${JSON.stringify(backupDirs())}`);
    assert.ok(fs.existsSync(path.join(DATA_ROOT, 'backups', named, 'manifest.json')), 'the dump the report names has no manifest');
  });

  it('a dump that throws part-way removes its own directory before it rethrows', T, async () => {
    assert.deepEqual(backupDirs(), [], 'control: the backups directory is not empty at the start');
    fs.writeFileSync = function failManifest(file, ...rest) {
      if (String(file).endsWith('manifest.json')) { fs.writeFileSync = realWrite; throw new Error('ENOSPC: simulated full disk'); }
      return realWrite.call(this, file, ...rest);
    };
    await assert.rejects(() => scheduler.runBackupNow(), /ENOSPC/);
    fs.writeFileSync = realWrite;
    assert.deepEqual(backupDirs(), [], `a failed dump left ${JSON.stringify(backupDirs())} behind: no retention counts a directory without a manifest`);
  });
});
