/**
 * From the completion write of a migrate until the process ends, every write is refused on every door, an instance admin's included
 * (bundle-157, Q-564 F4).
 *
 * ## The defect this holds
 *
 * A migrate's completion is ONE config write: every `migrate` entry leaves (which lifts every space's write gate) and the new URI is
 * saved (`saveTargetUri`). Only then does `onMigrateEnd` put the process in maintenance and send it SIGTERM, and the shutdown drains.
 * In that window this process is still connected to the OLD database, and nothing refuses a write: an instance admin passes
 * maintenance, a sync pull already in flight, an embed job and a housekeeping pass all write - to the old database, which the instance
 * is about to leave. Every one of those writes is missing from the new database, silently.
 *
 * ## The rule
 *
 * The write gate is closed for every space in the SAME synchronous step that lifts the migrate entries, and it stays closed until the
 * process ends: a write answers `409` with `code: 'space_being_migrated'` (the code `SPACE_ACT_KINDS.migrate.writeRefusalCode` names) on
 * every door, and stores nothing. Reads are not this rule's business.
 *
 * ## How it is driven
 *
 * As `migrate-db.test.js` drives a migrate: in-process, `NODE_ENV=test` (so `onMigrateEnd` does not end the test process), the target
 * addressed by a hostname `dns.lookup` is patched to resolve to the harness Mongo, the source URI in the config and not the environment.
 * The migrate is run to completion (the config holds the target URI and no migrate entry stands). Then three doors are asked for one
 * write each, as an instance admin (and, at the first turn of the event loop the completion write is visible, the gate is read, so a
 * closure made after an await is seen open): the writer itself (`saveFact`), REST through the real `createApp()` on loopback, and MCP
 * (`save_fact` through `callTool`). Each must be refused with the migrate's code, and the OLD database (the one this process still
 * writes to) must hold none of them.
 *
 * ## Seen red
 *
 * On 38738096 every door takes the write once the completion write has lifted the entries: the writer resolves, REST answers 201 and MCP
 * answers a saved fact, and each record lands in the old database.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/no-write-lands-after-a-migrate-completes-db.test.js` (a prior
 * `npx tsc -p server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { emptyTarget } from './_migrate-target.mjs';
import { mongoSkipReason, testMongoUri, TEST_MONGO_HOST } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, entriesOf, resetRunnerForTest } from './_space-act-harness.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['NODE_ENV'] = 'test';
process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
delete process.env['YTHRIL_MONGO_INFRA_MANAGED'];

const T = { timeout: 120_000 };
const SUITE = 'migrateclosed';
const S = 'mc-a';
const TARGET_HOST = 'ythril-closed-target.test';
const TARGET_DB = 'ythril_migrate_closed_target';
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

describe('no write lands after a migrate completes, on any door (real MongoDB)', { skip }, () => {
  let door, loader, runner, maintenance, gate, fixture, target, server, adminKey, wantCode;
  /** What the gate said at the first turn the completion write was visible (undefined: never seen). */
  let gateAtCompletion;

  const migrateEntries = () => entriesOf(loader).filter(e => e.kind === 'migrate');
  /** Facts in the OLD database whose text is `text`: where this process still writes. */
  const inOldDatabase = (text) => fixture.db(SOURCE_DB).collection(`${S}_facts`).countDocuments({ fact: text });

  before(async () => {
    patchDns();
    door = await openToolDoor({ suite: SUITE, spaces: [{ id: S, label: S, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } }] });
    loader = await import('../../server/dist/config/loader.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    maintenance = await import('../../server/dist/maintenance.js');
    gate = await import('../../server/dist/spaces/space-write-gate.js');
    const { SPACE_ACT_KINDS } = await import('../../server/dist/config/types-space-acts.js');
    wantCode = SPACE_ACT_KINDS?.migrate?.writeRefusalCode;
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
    const { MongoClient } = await import('mongodb');
    fixture = new MongoClient(SOURCE_URI);
    target = new MongoClient(testMongoUri(TARGET_DB));
    await Promise.all([fixture.connect(), target.connect()]);
    await emptyTarget(target, TARGET_DB);

    resetRunnerForTest(runner);
    clearActEntries(loader);
    maintenance.setMaintenanceActive(false);
    delete process.env['MONGO_URI'];
    loader.mutateConfig(cfg => { cfg.mongo = { uri: SOURCE_URI }; });
    await door.coll(S, 'facts').insertOne({ _id: `${S}-f1`, spaceId: S, fact: 'before the migrate', tags: [], seq: 1 });

    const { dataRouter } = await import('../../server/dist/api/data.js');
    const out = await door.request(door.routeHandler(dataRouter, 'post', '/migrate'), { body: { uri: TARGET_URI } });
    assert.ok(out.status >= 200 && out.status < 300, `the migrate was refused: ${out.status} ${JSON.stringify(out.body)}`);
    // Polled every turn of the event loop, and at the FIRST turn the completion write is visible the gate is read synchronously: a
    // closure made after an await in the end hook leaves a turn where the URI is saved and the gate is open, and this sees it. The bound
    // is turns, about 30 s of them (every fiftieth a 15 ms timer): a whole copy with its indexes outlasted 4000 turns on the harness.
    // waits-differently: a waitFor probes every 50 ms at best and would miss the one turn this must read the gate on
    for (let i = 0; i < 100_000; i++) {
      if (loader.getConfig().mongo?.uri === TARGET_URI && migrateEntries().length === 0) {
        gateAtCompletion = gate.spaceWriteRefusal(S);
        break;
      }
      await new Promise(resolve => (i % 50 === 49 ? setTimeout(resolve, 15) : setImmediate(resolve)));
    }
    assert.equal(loader.getConfig().mongo?.uri, TARGET_URI, 'the migrate never completed: the rows below would judge a standing migrate, not a completed one');
    assert.deepEqual(migrateEntries(), [], 'a migrate entry outlived the completion');
  });
  after(async () => {
    dns.lookup = realLookup;
    try { resetRunnerForTest(runner); clearActEntries(loader); maintenance.setMaintenanceActive(false); } catch { /* never loaded */ }
    await server?.close?.();
    await target?.db(TARGET_DB).dropDatabase().catch(() => {});
    await Promise.all([fixture?.close(), target?.close()]);
    await door?.close();
  });

  it('control: the migrate code is a string, and the record written before the migrate is in the old database', T, async () => {
    assert.equal(typeof wantCode, 'string', 'SPACE_ACT_KINDS.migrate has no writeRefusalCode');
    assert.equal(await inOldDatabase('before the migrate'), 1);
  });

  it('the gate was already closed at the first turn the completion write was visible (closed in its step, never after an await)', T, () => {
    assert.equal(typeof gateAtCompletion, 'string', `at the first turn the migrate's completion write was visible the gate gave ${JSON.stringify(gateAtCompletion)}: writes were open between the entries leaving and the closure`);
  });

  it('the writer refuses a write after the completion write, with the migrate\'s code, and stores nothing', T, async () => {
    const text = 'writer after the migrate completed';
    const fact = await import('../../server/dist/brain/fact.js');
    let err = null;
    try { await fact.saveFact(S, text, [], [], undefined, undefined, 'note'); } catch (e) { err = e; }
    assert.ok(err && gate.isSpaceNotWritable(err), `a write was taken after the migrate's completion write: ${err?.message ?? 'no refusal'}`);
    assert.equal(err.code, wantCode, `the write was refused with '${err.code}', not the migrate's '${wantCode}'`);
    assert.equal(await inOldDatabase(text), 0, 'the write landed in the old database the instance is leaving');
  });

  it('REST (an instance admin, through the real app) answers 409 with the migrate\'s code, and stores nothing', T, async () => {
    const text = 'rest after the migrate completed';
    const res = await fetch(`${server.url}/api/brain/spaces/${S}/facts`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fact: text, tags: [] }), signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 409, `REST answered ${res.status} ${JSON.stringify(body).slice(0, 240)}: an admin's write after the completion write was taken`);
    assert.equal(body.code, wantCode);
    assert.equal(await inOldDatabase(text), 0, 'the REST write landed in the old database the instance is leaving');
  });

  it('MCP (save_fact, an instance admin) answers 409 with the migrate\'s code, and stores nothing', T, async () => {
    const text = 'mcp after the migrate completed';
    const out = await door.call('save_fact', { space: S, fact: text });
    assert.equal(out.status, 409, `MCP answered ${out.status} ${out.text.slice(0, 240)}: an admin's write after the completion write was taken`);
    assert.equal(out.structured?.code, wantCode);
    assert.equal(await inOldDatabase(text), 0, 'the MCP write landed in the old database the instance is leaving');
  });

  it('a read still answers: the closure is of writes only', T, async () => {
    const res = await fetch(`${server.url}/api/brain/spaces/${S}/stats`, {
      headers: { Authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(20_000),
    });
    assert.equal(res.status, 200, `a read after the migrate answered ${res.status}`);
  });
});
