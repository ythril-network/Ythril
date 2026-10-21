/**
 * A migrate whose TARGET stops answering mid-copy ends its attempt within the per-operation bound, as retryable, and can then be
 * abandoned (bundle-157, Q-564 round 3).
 *
 * ## The defect this holds
 *
 * The re-drive at d274d51e stopped the target mongod while a migrate was copying. The running attempt hung: once for about five minutes
 * (the operation bound) before the set became owed, once for more than eleven minutes with no retry until the server was restarted. For
 * all that time `POST /api/admin/data/migrate/abandon` answered `409 migrate_act_running` ("copying right now"), so the operator could
 * not end it. The rule: every operation the migrate body makes against the target runs under the act's per-operation bound (the
 * bounded client options and the shorter connect and server-selection timeouts), so a target that stops answering ends the attempt as
 * retryable within a handful of bounds - never one bound per collection, never unbounded - and the abandon is then accepted.
 *
 * ## How it is driven, deterministically
 *
 * The target is the harness Mongo reached through a TCP relay (`_tcp-relay.mjs`, the one relay module) under a hostname `dns.lookup`
 * resolves to loopback, as `migrate-db.test.js` addresses its target. The relay FREEZES - drops every byte both ways, keeps every
 * socket open, the way a stopped or paused server looks to a client that has not been told - at the first command the copy sends that
 * names one of the seeded space collections: the copy has started, and the target goes silent mid-copy. The act's per-operation bound is
 * set short (`SPACE_ACT_OP_MS`), so "within the bound" is seconds, and the attempt must end - its entries owed, attempts counted, the
 * runner idle - within {@link ENDS_WITHIN_BOUNDS} bounds. Then the abandon answers 200 and the URI is unchanged.
 *
 * The wait for the end is time-boxed by the clock (`waits-differently`): a hang is the defect, so the row fails at the box rather than
 * hanging the run, and the box names how long it waited.
 *
 * ## Seen red
 *
 * On d274d51e the attempt ends about 25 s after the target went silent, at a bound of 1.5 s. Measured operation by operation against the
 * same frozen relay with the client options the migrate gives the target (`boundedClientOptions` inside the act's bound), every
 * OPERATION is bounded - drop, createCollection, insertMany and listCollections each end at 1.5 s with a timeout - and two things are not:
 *
 * - `client.close()` on the target took 25.5 s: it is awaited in `restoreDatabase`'s `finally` and carries no bound at all;
 * - `restoreDatabase` swallows every failure of `drop()` and `createCollection()` (`.catch(() => {})`, meant for "ns not found"), so a
 *   timed-out drop is followed by a create and then a load, each paying a full bound: three bounds where one failure should end the
 *   attempt. At the default bound of five minutes that is the drive's "more than eleven minutes".
 *
 * So the box is {@link ENDS_WITHIN_BOUNDS} bounds: one operation timing out, plus the close, plus the runner's bookkeeping. A fix of the
 * close alone still pays the three swallowed bounds and stays red.
 *
 * Run: the test stack's harness Mongo (`npm run test:up`, or `docker compose -p ythril-test -f testing/docker-compose.test.yml up -d
 * --wait ythril-mongo-a`), then `node --test testing/standalone/a-migrate-whose-target-stops-answering-ends-its-attempt-within-the-bound-db.test.js`
 * (a prior `npx tsc -p server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { mongoSkipReason, testMongoUri, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { startTcpRelay } from './_tcp-relay.mjs';
import { clearActEntries, entriesOf, resetRunnerForTest } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['NODE_ENV'] = 'test';
process.env['YTHRIL_DB_MIGRATION_ENABLED'] = 'true';
delete process.env['YTHRIL_MONGO_INFRA_MANAGED'];

const SUITE = 'migratetargetdies';
const SPACES = ['mt-a', 'mt-b'];
const TARGET_HOST = 'ythril-dying-target.test';
const TARGET_DB = 'ythril_migrate_dying_target';
const SOURCE_URI = testMongoUri(`ythril_harness_${SUITE}`);
/** The act's per-operation bound for this test, ms. */
const OP_MS = 2_000;
/**
 * How many bounds the attempt may take to end once the target froze: the one operation that timed out, a bounded close and the runner's
 * bookkeeping. Three swallowed operations alone are three bounds, so a copy that carries on past a store failure cannot fit.
 */
const ENDS_WITHIN_BOUNDS = 3;
const T = { timeout: 180_000 };

const realLookup = dns.lookup;
function patchDns() {
  dns.lookup = function lookup(hostname, options, cb) {
    if (hostname !== TARGET_HOST) return realLookup.call(this, hostname, options, cb);
    if (typeof options === 'function') { cb = options; options = {}; }
    return options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  };
}

describe('a migrate whose target stops answering mid-copy ends its attempt within the bound (real MongoDB)', { skip }, () => {
  let door, loader, runner, maintenance, dataRouter, relay, targetUri;
  let frozen = false; let frozeAt = 0; let droppedToServer = 0;

  const migrateEntries = () => entriesOf(loader).filter(e => e.kind === 'migrate');
  const attemptEnded = () => {
    const es = migrateEntries();
    return es.length > 0 && es.every(e => e.state === 'owed' && (e.attempts ?? 0) >= 1) && runner.spaceActsRunning() === 0;
  };

  before(async () => {
    patchDns();
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    maintenance = await import('../../server/dist/maintenance.js');
    ({ dataRouter } = await import('../../server/dist/api/data.js'));
    resetRunnerForTest(runner);
    clearActEntries(loader);
    maintenance.setMaintenanceActive(false);
    delete process.env['MONGO_URI'];
    loader.mutateConfig(cfg => { cfg.mongo = { uri: SOURCE_URI }; });
    for (const s of SPACES) {
      await door.coll(s, 'facts').insertMany([1, 2, 3].map(i => ({ _id: `${s}-f${i}`, spaceId: s, fact: `fact ${i}`, tags: [], seq: i })));
    }
    // The target: the harness Mongo through a relay that goes silent at the copy's first command naming a seeded space collection.
    const names = SPACES.map(s => Buffer.from(`${s}_`));
    relay = await startTcpRelay({
      host: TEST_MONGO_HOST, port: TEST_MONGO_PORT,
      clientToServer: (forward) => (chunk) => {
        if (!frozen && names.some(n => chunk.includes(n))) { frozen = true; frozeAt = Date.now(); }
        if (frozen) { droppedToServer += chunk.length; return; }
        forward(chunk);
      },
      serverToClient: (forward) => (chunk) => { if (!frozen) forward(chunk); },
    });
    const viaRelay = testMongoUri(TARGET_DB, { port: relay.port });
    targetUri = viaRelay.replace(`@${TEST_MONGO_HOST}:`, `@${TARGET_HOST}:`).replace(`//${TEST_MONGO_HOST}:`, `//${TARGET_HOST}:`);
    const { MongoClient } = await import('mongodb');
    const direct = new MongoClient(testMongoUri(TARGET_DB));
    await direct.connect(); await direct.db(TARGET_DB).dropDatabase(); await direct.close();
  });
  after(async () => {
    dns.lookup = realLookup;
    frozen = false;
    await relay?.close();
    try { runner.setSpaceActHooksForTest(null); resetRunnerForTest(runner); clearActEntries(loader); maintenance.setMaintenanceActive(false); } catch { /* never loaded */ }
    await door?.close();
  });

  it('the attempt ends as retryable within the bound once the target goes silent mid-copy, and the abandon is then accepted', T, async () => {
    runner.setSpaceActKnobsForTest({ SPACE_ACT_OP_MS: OP_MS });
    const started = await door.request(door.routeHandler(dataRouter, 'post', '/migrate'), { body: { uri: targetUri } });
    assert.ok(started.status >= 200 && started.status < 300, `the migrate was refused: ${started.status} ${JSON.stringify(started.body)}`);

    // waits-differently: a clock box, not turns - the defect is a hang, and the box is what turns it into a failure that names its length.
    const box = 90_000;
    const t0 = Date.now();
    while (!frozen && Date.now() - t0 < box) await new Promise(r => setTimeout(r, 25));
    assert.ok(frozen, `the copy never sent a command naming a seeded collection to the target within ${box} ms: the relay froze nothing`);
    while (!attemptEnded() && Date.now() - frozeAt < box) await new Promise(r => setTimeout(r, 50));
    const took = Date.now() - frozeAt;
    assert.ok(droppedToServer > 0, 'the frozen target was sent nothing: the freeze happened after the copy, not during it');
    assert.ok(attemptEnded(), `the attempt had not ended ${took} ms after the target went silent (bound ${OP_MS} ms): `
      + `entries ${JSON.stringify(migrateEntries().map(e => [e.localId, e.state, e.attempts]))}, running ${runner.spaceActsRunning()}`);
    assert.ok(took <= ENDS_WITHIN_BOUNDS * OP_MS, `the attempt ended ${took} ms after the target went silent: more than ${ENDS_WITHIN_BOUNDS} bounds of ${OP_MS} ms`);
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'a failed attempt saved the target URI');

    let handler;
    try { handler = door.routeHandler(dataRouter, 'post', '/migrate/abandon'); } catch { /* asserted below */ }
    assert.ok(handler, 'there is no abandon route');
    const out = await door.request(handler);
    assert.equal(out.status, 200, `abandon after the attempt ended answered ${out.status} ${JSON.stringify(out.body)}`);
    assert.deepEqual(migrateEntries(), [], 'the abandon left migrate entries standing');
    assert.equal(loader.getConfig().mongo?.uri, SOURCE_URI, 'the abandon changed the saved URI');
    assert.equal(maintenance.isMaintenanceActive(), false, 'maintenance outlived the abandoned migrate');
  });
});
