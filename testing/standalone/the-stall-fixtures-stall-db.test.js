/**
 * The stall and freeze fixtures stall, freeze and refuse for real - or they THROW (bundle-53 G0; Q-358, Q-329, Q-343).
 *
 * ## What this prevents
 *
 * A bound test asks "is a hung operation ended by its bound". Its fixture decides whether anything hung. A fixture that
 * hung nothing passes every such test, whatever the bound does - the same failure `holdDocumentLock` guards for writes
 * ("a lock that locked nothing"). Four fixtures here each carry the guard that says so:
 *
 * - `withStalledReads` - a view whose read takes at least `ms` AND that the server's own `maxTimeMS` can end. Both are
 *   asserted, because the first form written for it (`$addFields` + `$function`) stalls and cannot be interrupted: a
 *   bound that is only the server's would be "proved" on a read that never ends (probes p7b / p7c).
 * - `startFreezableRelay` - a store that stops answering with its sockets OPEN, the one condition a docker pause makes and
 *   a closed port does not. A relay whose `freeze()` is a no-op would let every "the client notices a dead store" test
 *   pass over a store that was never dead.
 * - `withCollectionAsView`'s `pipeline` - a view that FAILS its reads; the read throws only when a source document matches
 *   the reader's filter (the stage sits on the source, the reader's filter on the view).
 * - `driverWriteFailures` - the `w: 5` shapes are the driver's unsatisfiable-write-concern errors (code 100) only on a
 *   REPLICA SET; a standalone mongod refuses the command with code 2 and the code under test is handed a different error
 *   than the one the test claims. The fixture asserts the code and names the precondition.
 *
 * Each guard is exercised against a fixture that does NOT do its job (a plain view, an `ms` of 0, a non-interruptible
 * stall, a relay whose freeze is a no-op, a code-2 refusal), because a guard that has only ever passed is a claim.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-stall-fixtures-stall-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, MongoServerError } from 'mongodb';
import { mongoSkipReason, openTestMongo, closeTestMongo, testMongoUri, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import * as faults from './_write-faults.mjs';
import { startTcpRelay } from './_tcp-relay.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
// Loaded by name, so a module that is missing is a named failure in the cases that need it and not one for the whole file.
const freezable = await import('./_freezable-relay.mjs').catch((error) => ({ missing: error }));
const DB = 'ythril_harness_stallfx';

let mongo;
let db;

/** How long a raw read of `name` takes, ms; `error` when it threw. */
async function timedRead(name, options = {}) {
  const started = Date.now();
  try {
    const rows = await db.collection(name).find({}, options).toArray();
    return { ms: Date.now() - started, rows: rows.length };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

describe('the stall and freeze fixtures stall, freeze and refuse for real', { skip }, () => {
  before(async () => { mongo = await openTestMongo('stallfx'); db = mongo.getDb(); });
  after(async () => { await closeTestMongo(); });

  describe('withCollectionAsView takes the pipeline the view is made of', () => {
    it('a failing view fails the read of a source document that matches, and says which documents those are', async () => {
      await db.collection('fail_src').insertMany([{ _id: 'bad', field: 'not-a-number', keep: true }, { _id: 'ok', field: '7', keep: false }]);
      await faults.withCollectionAsView(db, 'fail_view', 'fail_src', async () => {
        // P2: `$toInt` of a string that is not a number throws at the stage, so a read that reaches the document throws.
        const reached = await timedRead('fail_view');
        assert.ok(reached.error, 'a read over a source document the stage cannot convert did not throw: the pipeline option was ignored');
        assert.match(String(reached.error.message), /\$toInt|convert|parse/i, `it threw, but not from the stage: ${reached.error.message}`);
        // The other half of the docblock's sentence: a filter on the view that excludes the bad document never reaches it.
        const rows = await db.collection('fail_view').find({ keep: false }).toArray();
        assert.deepEqual(rows.map((r) => r._id), ['ok']);
      }, { pipeline: [{ $addFields: { _x: { $toInt: '$field' } } }] });
    });

    it('with no pipeline it is still an empty one: a plain view reads its source', async () => {
      await db.collection('plain_src').insertOne({ _id: 'one' });
      await faults.withCollectionAsView(db, 'plain_view', 'plain_src', async () => {
        assert.deepEqual((await db.collection('plain_view').find({}).toArray()).map((r) => r._id), ['one']);
      });
      assert.equal((await db.listCollections({ name: 'plain_view' }).toArray())[0].type, 'collection', 'the view was not put back as a collection');
    });
  });

  describe('withStalledReads', () => {
    it('stalls a read for at least ms, lets the server end it at maxTimeMS (code 50), and puts everything back', async () => {
      assert.equal(typeof faults.withStalledReads, 'function', 'withStalledReads is not exported');
      const started = Date.now();
      const out = await faults.withStalledReads(db, 'stall_view', 'stall_src', { ms: 600, readerFilter: {} }, async () => {
        // The guard reads the view (a stall of 600 ms) before the callback is let in: a callback that arrives sooner ran
        // without it, over a stall nothing had checked.
        assert.ok(Date.now() - started >= 600, `the callback was entered after ${Date.now() - started} ms: the stall guard did not run first`);
        const slow = await timedRead('stall_view');
        assert.ok(!slow.error, `a plain read of the stalled view threw: ${slow.error?.message}`);
        assert.ok(slow.ms >= 600, `the read took ${slow.ms} ms, less than the 600 ms asked for`);
        const cut = await timedRead('stall_view', { maxTimeMS: 150 });
        assert.equal(cut.error?.code, 50, `maxTimeMS did not end the read with code 50: ${cut.error?.message ?? 'it completed'}`);
        assert.ok(cut.ms < 600, `maxTimeMS 150 ended the read after ${cut.ms} ms: it was not interrupted`);
        return 'the callback ran';
      });
      assert.equal(out, 'the callback ran', 'the callback\'s value did not come back');
      assert.equal((await db.listCollections({ name: 'stall_view' }).toArray())[0].type, 'collection', 'the stalled view was not replaced by an ordinary collection');
      assert.equal(await db.collection('stall_src').countDocuments({}), 0, 'the seed documents it needed were left in the source');
    });

    it('scales with ms: a longer stall is a longer read', async () => {
      await faults.withStalledReads(db, 'stall_view_long', 'stall_src_long', { ms: 1200, readerFilter: {} }, async () => {
        const slow = await timedRead('stall_view_long');
        assert.ok(slow.ms >= 1200, `the read took ${slow.ms} ms, less than the 1200 ms asked for`);
      });
    });

    it('THROWS for an ms that stalls nothing, and never runs the callback', async () => {
      for (const ms of [0, -5, Number.NaN, undefined]) {
        let ran = false;
        await assert.rejects(
          () => faults.withStalledReads(db, 'stall_none', 'stall_src_none', { ms, readerFilter: {} }, async () => { ran = true; }),
          /ms/, `ms ${ms} was accepted`);
        assert.equal(ran, false, `the callback ran under ms ${ms}, a stall that stalls nothing`);
      }
    });

    it('its guard THROWS for a view that does not stall at all', async () => {
      assert.equal(typeof faults.assertViewStalls, 'function', 'assertViewStalls is not exported');
      await db.collection('guard_plain_src').insertMany([1, 2, 3].map((i) => ({ _id: i })));
      await faults.withCollectionAsView(db, 'guard_plain', 'guard_plain_src', async () => {
        await assert.rejects(() => faults.assertViewStalls(db, 'guard_plain', { ms: 400 }), /took \d+ ?ms/);
      });
    });

    it('its guard THROWS for a stall the server\'s maxTimeMS cannot interrupt (the $addFields form)', async () => {
      assert.equal(typeof faults.assertViewStalls, 'function', 'assertViewStalls is not exported');
      await db.collection('guard_stuck_src').insertMany([1, 2, 3].map((i) => ({ _id: i })));
      const stall = [{ $addFields: { _s: { $function: { body: 'function(){sleep(200);return 1}', args: [], lang: 'js' } } } }];
      await faults.withCollectionAsView(db, 'guard_stuck', 'guard_stuck_src', async () => {
        await assert.rejects(() => faults.assertViewStalls(db, 'guard_stuck', { ms: 400 }), /maxTimeMS/);
      }, { pipeline: stall });
    });

    it('its guard passes for the interruptible form, so the throws above are for the right reason', async () => {
      assert.equal(typeof faults.assertViewStalls, 'function', 'assertViewStalls is not exported');
      await db.collection('guard_good_src').insertMany([1, 2, 3].map((i) => ({ _id: i })));
      const stall = [{ $match: { $expr: { $function: { body: 'function(){sleep(200);return true}', args: [], lang: 'js' } } } }];
      await faults.withCollectionAsView(db, 'guard_good', 'guard_good_src', async () => {
        await faults.assertViewStalls(db, 'guard_good', { ms: 400 });
      }, { pipeline: stall });
    });
  });

  describe('startFreezableRelay', () => {
    it('serves a client through its uri, stops answering on freeze with the sockets open, and serves again after thaw', async () => {
      assert.equal(typeof freezable.startFreezableRelay, 'function', 'startFreezableRelay is not exported');
      const relay = await freezable.startFreezableRelay(DB);
      const client = new MongoClient(relay.uri, { serverSelectionTimeoutMS: 5000, heartbeatFrequencyMS: 10_000, connectTimeoutMS: 5000 });
      try {
        assert.match(relay.address, /^127\.0\.0\.1:\d+$/);
        assert.ok(relay.uri.includes(relay.address), 'the uri does not point at the relay');
        await client.connect();
        const healthy = await client.db('admin').command({ ping: 1 });
        assert.equal(healthy.ok, 1);
        relay.freeze();
        const frozen = await faults.settleWithin(client.db('admin').command({ ping: 1 }, { timeoutMS: 1500 }), 400);
        assert.equal(frozen.settled, false, 'an op settled while the relay was frozen');
        relay.thaw();
        await frozen.rest;
        assert.ok(await holdsWithin(async () => (await client.db('admin').command({ ping: 1 }, { timeoutMS: 1000 }).catch(() => ({ ok: 0 }))).ok === 1, 15_000, 100),
          'the relay did not serve again after thaw');
      } finally {
        await client.close(true).catch(() => {});
        await relay.close();
      }
    });

    it('carries the caller\'s URI options in its uri', async () => {
      const relay = await freezable.startFreezableRelay(DB, { query: '&connectTimeoutMS=1234' });
      try {
        assert.match(relay.uri, /connectTimeoutMS=1234/);
      } finally { await relay.close(); }
    });

    it('its guard THROWS for a relay whose freeze does nothing', async () => {
      assert.equal(typeof freezable.assertRelayFreezes, 'function', 'assertRelayFreezes is not exported');
      // A test double: a real pass-through relay to the store with the freeze and thaw taken out, counting what it carries.
      const flow = { toServer: 0, toClient: 0, droppedToServer: 0, droppedToClient: 0 };
      const passthrough = await startTcpRelay({
        host: TEST_MONGO_HOST,
        port: TEST_MONGO_PORT,
        clientToServer: (forward) => (chunk) => { flow.toServer += chunk.length; forward(chunk); },
        serverToClient: (forward) => (chunk) => { flow.toClient += chunk.length; forward(chunk); },
      });
      try {
        const noop = { uri: testMongoUri(DB, { port: passthrough.port }), freeze() {}, thaw() {}, flow: () => ({ ...flow }) };
        await assert.rejects(() => freezable.assertRelayFreezes(noop), /settled/);
      } finally { await passthrough.close(); }
    });

    /*
     * One case per clause of the guard, each over a REAL freezable relay with exactly one thing wrong in the handle the
     * guard is given - so a clause that is deleted turns exactly its case green-for-the-wrong-reason into red.
     */
    it('its guard names each way a freeze can fail to be one', async () => {
      assert.equal(typeof freezable.assertRelayFreezes, 'function', 'assertRelayFreezes is not exported');
      const real = await freezable.startFreezableRelay(DB);
      try {
        // Bytes still flowing to the server while frozen (the counters say so).
        let reads = 0;
        const leaks = { ...real, flow: () => { const f = real.flow(); reads += 1; return reads > 1 ? { ...f, toServer: f.toServer + 1 } : f; } };
        await assert.rejects(() => freezable.assertRelayFreezes(leaks), /forwarded while frozen/);
        real.thaw();
        // The operation stalled, but its bytes never reached the relay: it stalled for another reason.
        const unseen = { ...real, flow: () => ({ ...real.flow(), droppedToServer: 0 }) };
        await assert.rejects(() => freezable.assertRelayFreezes(unseen), /never reached the relay/);
        real.thaw();
        // A thaw that does not thaw: the store does not answer again.
        const stuck = { ...real, thaw() {} };
        await assert.rejects(() => freezable.assertRelayFreezes(stuck, { recoveryMs: 1500 }), /did not answer again/);
      } finally {
        real.thaw();
        await real.close();
      }
    });
  });

  describe('driverWriteFailures asserts the code it claims', () => {
    it('hands back unsatisfiable-write-concern errors (code 100) in both shapes, as a replica set gives them', async () => {
      const F = await faults.driverWriteFailures(DB);
      assert.equal(F.writeConcern.single.code, 100, `single: ${F.writeConcern.single.name} code ${F.writeConcern.single.code}`);
      assert.equal(F.writeConcern.bulk.result?.getWriteConcernError?.()?.code, 100, 'bulk: the write concern error is not code 100');
    });

    it('its check THROWS, naming the replica-set precondition, for the refusal a standalone mongod gives instead', async () => {
      assert.equal(typeof faults.assertUnsatisfiableWriteConcern, 'function', 'assertUnsatisfiableWriteConcern is not exported');
      const standalone = new MongoServerError({ ok: 0, code: 2, codeName: 'BadValue', errmsg: "cannot use 'w' > 1 when a host is not replicated" });
      for (const shape of ['single', 'bulk']) {
        assert.throws(() => faults.assertUnsatisfiableWriteConcern(standalone, shape), /replica set/i, `${shape}: a code-2 refusal was accepted`);
      }
      assert.throws(() => faults.assertUnsatisfiableWriteConcern(new Error('nothing to do with Mongo'), 'single'), /code/);
    });

    it('its check passes the real errors the driver produced against this store, so it cannot be vacuous', async () => {
      const F = await faults.driverWriteFailures(DB);
      assert.doesNotThrow(() => faults.assertUnsatisfiableWriteConcern(F.writeConcern.single, 'single'));
      assert.doesNotThrow(() => faults.assertUnsatisfiableWriteConcern(F.writeConcern.bulk, 'bulk'));
    });
  });
});
