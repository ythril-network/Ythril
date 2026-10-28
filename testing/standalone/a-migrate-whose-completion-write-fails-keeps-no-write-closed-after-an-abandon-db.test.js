/**
 * A migrate whose completion write fails does not close every write for good (bundle-159, Q-569).
 *
 * ## The defect this holds
 *
 * The completion of a migrate saves the target URI and closes every write of the process until it exits (`closeEveryWriteUntilExit`).
 * The close was asked inside the config write's callback, before the write: `saveConfig` sets the in-memory config, then writes
 * `config.json.tmp` and renames it. A write that fails there (a full disk, a permission) threw out of the completion with the close
 * already made, so the act was recorded as owed - and an abandon, the operator's way out, lifted the entries but not the process-wide
 * closure: every space answered `409 space_being_migrated` until a restart.
 *
 * ## The rule
 *
 * The closure is made only once the completion write has succeeded (the set's end), so a failed write leaves it open, and an abandon of
 * the owed set leaves every write admitted.
 *
 * ## How it is driven
 *
 * As `a-standing-migrate-can-be-abandoned-db.test.js` drives a migrate. A `beforeComplete` hook arms ONE failure of the config file's
 * temporary write (`fs.writeFileSync` of `config.json.tmp`, the call the loader makes), so the completion write is the one that fails.
 *
 * ## Seen red
 *
 * Before the closure moved, the abandon answered 200 and the entries were gone, yet `spaceWriteRefusal` still answered
 * `space_being_migrated` and a fact write was refused.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-migrate-whose-completion-write-fails-keeps-no-write-closed-after-an-abandon-db.test.js`
 * (a prior `npx tsc -p server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import { emptyTarget } from './_migrate-target.mjs';
import { mongoSkipReason, testMongoUri, TEST_MONGO_HOST } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, entriesOf, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['NODE_ENV'] = 'test';
process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
delete process.env['YTHRIL_MONGO_INFRA_MANAGED'];

const T = { timeout: 120_000 };
const SUITE = 'migratewritefail';
const SPACES = ['mw-a', 'mw-b'];
const TARGET_HOST = 'ythril-writefail-target.test';
const TARGET_DB = 'ythril_migrate_writefail_target';
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

describe('a migrate whose completion write fails keeps no write closed after an abandon (real MongoDB)', { skip }, () => {
  let door, loader, runner, maintenance, dataRouter, gate, target;

  const migrateEntries = () => entriesOf(loader).filter(e => e.kind === 'migrate');

  before(async () => {
    patchDns();
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    maintenance = await import('../../server/dist/maintenance.js');
    gate = await import('../../server/dist/spaces/space-write-gate.js');
    ({ dataRouter } = await import('../../server/dist/api/data.js'));
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
    fs.writeFileSync = realWrite;
    dns.lookup = realLookup;
    try { runner.setSpaceActHooksForTest(null); resetRunnerForTest(runner); clearActEntries(loader); maintenance.setMaintenanceActive(false); } catch { /* never loaded */ }
    await target?.db(TARGET_DB).dropDatabase().catch(() => {});
    await target?.close();
    await door?.close();
  });

  it('a failed completion write leaves the act owed and the URI unsaved, and an abandon leaves every write admitted', T, async () => {
    let armed = false;
    let failed = 0;
    runner.setSpaceActHooksForTest({
      // At the completion, after the copy: the next write of the config file's temporary copy fails once - the completion's own.
      beforeComplete: (e) => {
        if (e.kind !== 'migrate' || armed) return;
        armed = true;
        fs.writeFileSync = function failOnce(file, ...rest) {
          if (String(file).endsWith('config.json.tmp') && failed === 0) { failed++; fs.writeFileSync = realWrite; throw new Error('ENOSPC: simulated full disk'); }
          return realWrite.call(this, file, ...rest);
        };
      },
    });
    const started = await door.request(door.routeHandler(dataRouter, 'post', '/migrate'), { body: { uri: TARGET_URI } });
    assert.ok(started.status >= 200 && started.status < 300, `the migrate was refused: ${started.status} ${JSON.stringify(started.body)}`);
    await untilRunnerIdle(runner, loader);
    fs.writeFileSync = realWrite;

    assert.equal(failed, 1, 'the completion write never failed: the hook did not reach the config write');
    assert.ok(migrateEntries().length > 0 && migrateEntries().every(e => e.state === 'owed'), `the migrate is not owed: ${JSON.stringify(migrateEntries().map(e => [e.localId, e.state]))}`);
    assert.equal(loader.reloadConfig().mongo?.uri, SOURCE_URI, 'a failed completion write still saved the target URI on disk');

    const out = await door.request(door.routeHandler(dataRouter, 'post', '/migrate/abandon'));
    assert.equal(out.status, 200, `abandon of an owed migrate answered ${out.status} ${JSON.stringify(out.body)}`);
    assert.deepEqual(migrateEntries(), [], 'the abandon left migrate entries standing');
    assert.equal(maintenance.isMaintenanceActive(), false, 'maintenance outlived the abandoned migrate');
    for (const s of SPACES) {
      assert.equal(gate.spaceWriteRefusal(s), null, `after the abandon, space ${s} still refuses writes: ${gate.spaceWriteRefusal(s)}`);
    }
    const fact = await import('../../server/dist/brain/fact.js');
    assert.ok(await fact.saveFact(SPACES[0], 'after the abandon', [], [], undefined, undefined, 'note'), 'a write after the abandon was refused');
  });
});
