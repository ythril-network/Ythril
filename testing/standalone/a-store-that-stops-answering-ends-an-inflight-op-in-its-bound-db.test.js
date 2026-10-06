/**
 * A store that accepts a connection and then stops answering ends an in-flight operation inside the bound the options
 * state, and the error it ends with is one the walks stop on (`Q-329`, `Q-330` connect side, bundle-53 G6).
 *
 * ## The defect
 *
 * `connectMongo` built its client with `{ serverSelectionTimeoutMS: 10_000 }` and nothing else. The driver's own defaults
 * for the rest (connect 30 s, heartbeat 10 s) stood, so a store that FROZE - the connection stays open, nothing comes
 * back, which is what `docker pause`, a stalled disk or a failover that drops packets looks like - was noticed only when
 * the monitor's own heartbeat timed out. Measured on the stack: 40-50 s before an in-flight read learned the store was
 * gone. A housekeeping walk over forty spaces paid that per space.
 *
 * ## What is asserted
 *
 * The REAL boot path (`connectMongo`, URI in `MONGO_URI`) over the freezable relay (`_freezable-relay.mjs`), with the
 * scaled constants carried in the relay's URI - `connectTimeoutMS=1000&heartbeatFrequencyMS=500&serverSelectionTimeoutMS=1500`
 * - which also proves a URI that names an option WINS over the module's default. A read is started on a frozen store at
 * five offsets inside one heartbeat window (0, 0.2, 0.5, 0.8, 1.1 heartbeats after the last one the monitor made): it
 * must settle within `inFlightBoundMs(effective options)` plus a slack derived from the same constants, and with an error
 * `isStoreUnreachable` accepts. A bound measured at one phase of the heartbeat passes for a phase that is lucky.
 *
 * And the other half of the promise: a HEALTHY slow read - one the server takes 4 s to answer, longer than connect plus
 * heartbeat - through the same relay, nothing frozen, completes with its result. Detection options that cut a slow
 * healthy read would be worse than the wait they replace.
 *
 * Red on the unchanged base: `connectMongo` hands `serverSelectionTimeoutMS: 10_000` over the URI's 1500, so the same relay
 * measures the bound as connect + heartbeat + 10 s.
 *
 * The write bound's own promise (a write the bound ended is a store timeout) is held by
 * `a-planned-write-the-bound-ended-is-a-store-timeout-db`; it is not restated here.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-store-that-stops-answering-ends-an-inflight-op-in-its-bound-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { startFreezableRelay } from './_freezable-relay.mjs';
import { settleWithin, withStalledReads } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-inflight-bound-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ instanceId: 'inflight-bound-test', instanceLabel: 'test', tokens: [], networks: [], spaces: [] }), { mode: 0o600 });

const DB = 'ythril_harness_g6inflight';
/** The scaled constants, as an operator would put them in `MONGO_URI`. */
const QUERY = '&connectTimeoutMS=1000&heartbeatFrequencyMS=500&serverSelectionTimeoutMS=1500';
/** Fractions of one heartbeat after the last one the monitor made, at which the store freezes. */
const OFFSETS = [0, 0.2, 0.5, 0.8, 1.1];

let relay, mongo, clientOptions, storeCondition;

/** Boot the server's own connection through `uri` and return the module and the heartbeat the monitor last made. */
async function boot(uri) {
  process.env['MONGO_URI'] = uri;
  mongo._resetDbName?.();
  await mongo.connectMongo();
  const beats = { at: 0, count: 0 };
  mongo.getMongo().on('serverHeartbeatSucceeded', () => { beats.at = Date.now(); beats.count++; });
  return beats;
}

describe('a store that stops answering ends an in-flight operation in its bound', { skip }, () => {
  before(async () => {
    mongo = await import('../../server/dist/db/mongo.js');
    clientOptions = await import('../../server/dist/db/client-options.js');
    storeCondition = await import('../../server/dist/db/store-condition.js');
    relay = await startFreezableRelay(DB, { query: QUERY });
  });

  after(async () => {
    relay?.thaw();
    await mongo?.closeMongo().catch(() => {});
    await relay?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the relay URI names all three options, so the effective options are the URI\'s, and the bound is their sum', () => {
    const effective = clientOptions.effectiveClientOptions(relay.uri);
    assert.deepEqual(effective.fromUri.sort(), ['connectTimeoutMS', 'heartbeatFrequencyMS', 'serverSelectionTimeoutMS']);
    assert.equal(clientOptions.inFlightBoundMs(effective), 1000 + 500 + 1500);
  });

  for (const fraction of OFFSETS) {
    it(`frozen ${fraction} heartbeats after the monitor's last one: a read in flight ends inside the bound, with the store's error`, async (t) => {
      const effective = clientOptions.effectiveClientOptions(relay.uri);
      const bound = clientOptions.inFlightBoundMs(effective);
      // One more monitor round and a flat 500 ms for timers and a busy machine: derived from the constants, not a second figure.
      const slack = effective.heartbeatFrequencyMS + 500;
      const beats = await boot(relay.uri);
      let outcome;
      try {
        assert.ok(await holdsWithin(() => beats.count >= 1, 5_000, 20), 'the monitor made no heartbeat in 5 s');
        await sleep(Math.max(0, beats.at + fraction * effective.heartbeatFrequencyMS - Date.now()));
        // Frozen first, then the read: the bytes of a read sent to a store that has just stopped are dropped, so it IS in flight.
        relay.freeze();
        outcome = await settleWithin(mongo.getDb().collection('g6_probe').findOne({}), bound + slack);
        if (!outcome.settled) {
          relay.thaw();
          await outcome.rest;
        }
      } finally {
        relay.thaw();
        await mongo.closeMongo().catch(() => {});
      }
      // The measurement, reported with the run: what the figures buy, so a later change to a default is read against it.
      t.diagnostic(`frozen at ${fraction} x heartbeat: the in-flight read ended after ${outcome.elapsedMs}ms with ${outcome.error?.name} (bound ${bound}ms, slack ${slack}ms)`);
      assert.ok(outcome.settled,
        `the read was still unanswered after ${outcome.elapsedMs}ms; the stated bound is ${bound}ms (+ ${slack}ms slack) for connect ${effective.connectTimeoutMS} + heartbeat ${effective.heartbeatFrequencyMS} + selection ${effective.serverSelectionTimeoutMS}`);
      assert.equal(outcome.ok, false, 'a read on a frozen store cannot have answered');
      assert.ok(storeCondition.isStoreUnreachable(outcome.error),
        `ended with ${outcome.error?.name}${outcome.error?.code !== undefined ? ` (${outcome.error.code})` : ''}, which isStoreUnreachable does not accept: a walk would not stop on it`);
    });
  }

  it('a healthy slow read (4 s, longer than connect + heartbeat) through the same relay completes: detection never cuts a slow read', async () => {
    await boot(relay.uri);
    try {
      const db = mongo.getDb();
      const read = await withStalledReads(db, 'g6_stalled_view', 'g6_stall_source', { ms: 4_000 }, async () => {
        const started = Date.now();
        const docs = await db.collection('g6_stalled_view').find({}).toArray();
        return { docs, tookMs: Date.now() - started };
      });
      assert.ok(read.tookMs >= 3_500, `the read took ${read.tookMs}ms: the stall was not in play, so this proves nothing`);
      assert.ok(read.docs.length >= 2, 'and it answered with its result');
    } finally {
      await mongo.closeMongo().catch(() => {});
    }
  });
});

describe('the boot line, on a real connection', { skip }, () => {
  it('connectMongo against the store states the effective options once and holds no credential', async () => {
    const uri = testMongoUri('ythril_harness_g6boot', { query: '&heartbeatFrequencyMS=2000' });
    process.env['MONGO_URI'] = uri;
    const mongoModule = await import('../../server/dist/db/mongo.js');
    mongoModule._resetDbName?.();
    const { lines } = await logLinesDuring(() => mongoModule.connectMongo());
    try {
      const optionLines = lines.filter(l => /MongoDB client options/.test(l));
      assert.equal(optionLines.length, 1, lines.join('\n'));
      assert.match(optionLines[0], /heartbeatFrequencyMS=2000 \(MONGO_URI\)/);
      assert.match(optionLines[0], /connectTimeoutMS=10000 \(default\)/);
      // The harness's own password, read where the harness reads it: a fixed literal would go on passing when the stack's changes.
      const password = (process.env['YTHRIL_TEST_MONGO_CREDS'] ?? 'ythril:ythril-test-pw').split(':')[1];
      assert.ok(password, 'the harness runs without credentials, so this case proves nothing about them');
      for (const line of lines) assert.doesNotMatch(line, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `a credential reached a log line: ${line}`);
    } finally {
      await mongoModule.closeMongo().catch(() => {});
    }
  });
});
