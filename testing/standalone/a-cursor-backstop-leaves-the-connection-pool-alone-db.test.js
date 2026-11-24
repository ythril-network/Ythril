/**
 * The client backstop that ends a stalled housekeeping read ends that one read, never the driver's pool (`Q-754`, Full run 45431865235).
 *
 * ## The question it closes
 *
 * A cursor-returning call (`find`, `aggregate`, `listCollections`) is bounded by an `AbortSignal` the driver honours, aborted at the
 * backstop (`withCursorBackstop`, `db/write-bound.ts`); the docblock there says the driver closes the connection the aborted read was
 * on. The TTL sweep's hung-space file saw a healthy space's line 4.81 s after the hung space's, against 75 ms in a passing run, and
 * one explanation was that the abort cleared the pool: every later read then waits for server selection. The driver clears a pool when
 * a connection fails with a NETWORK error, and the abort is not one, but that is a reading of the driver, not a measurement.
 *
 * ## What is held (events counted, never time measured)
 *
 * While a read the SERVER cannot end (a view whose stage is `$addFields` + `$function`, which `maxTimeMS` does not interrupt) runs in a
 * housekeeping scope, so that only the client backstop ends it:
 *
 *  - the read is ended by the backstop (`StoreTimeout`), not by the server's own deadline and not by finishing;
 *  - no `connectionPoolCleared`, no `connectionCheckOutFailed` and no server description turning `Unknown` is seen on the sweep's client
 *    from the start of the stalled read to the end of the next read;
 *  - a read of ANOTHER collection started the moment the backstop fired is served: its checkout is satisfied by a `connectionCheckedOut`
 *    event and it returns its document, with the same three counts still zero.
 *
 * A control shows the event is live: a store that stops answering (the freezable relay) makes the monitor clear a client's pool, and a
 * listener on `connectionPoolCleared` counts it. An event this driver names differently fails there, so a zero above means the pool
 * was left alone.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-cursor-backstop-leaves-the-connection-pool-alone-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { startFreezableRelay } from './_freezable-relay.mjs';
import { withCollectionAsView } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

/** The housekeeping bound of the stalled read; its backstop fires `SERVER_FIRST_MARGIN_MS` after it. */
const BOUND_MS = 600;
/** How long the view's stage sleeps: far past bound + margin, so only the backstop can end the read. */
const STALL_MS = 6000;

const stalledPipeline = [{ $addFields: { _s: { $function: { body: `function(){sleep(${STALL_MS});return 1}`, args: [], lang: 'js' } } } }];

describe('the client backstop of a stalled housekeeping read leaves the pool alone (real MongoDB)', { skip }, () => {
  let mongo; let wb; let StoreTimeout;
  const seen = { cleared: 0, checkOutFailed: 0, checkedOut: 0, unknown: 0, closed: [] };
  const listeners = {
    connectionPoolCleared: () => { seen.cleared += 1; },
    connectionCheckOutFailed: () => { seen.checkOutFailed += 1; },
    connectionCheckedOut: () => { seen.checkedOut += 1; },
    connectionClosed: (e) => { seen.closed.push(e.reason); },
    serverDescriptionChanged: (e) => { if (e.newDescription.type === 'Unknown') seen.unknown += 1; },
  };
  const reset = () => { seen.cleared = 0; seen.checkOutFailed = 0; seen.checkedOut = 0; seen.unknown = 0; seen.closed = []; };

  before(async () => {
    mongo = await openTestMongo('bsppool');
    wb = await import('../../server/dist/db/write-bound.js');
    ({ StoreTimeout } = await import('../../server/dist/db/write-timeout.js'));
    for (const [name, fn] of Object.entries(listeners)) mongo.getMongo().on(name, fn);
  });
  after(async () => {
    for (const [name, fn] of Object.entries(listeners)) mongo?.getMongo().off(name, fn);
    await closeTestMongo();
  });

  it('control: a store that stops answering clears the pool of a client, and a listener counts it', async () => {
    // A client of its own through the freezable relay: the monitor notices the frozen store and clears the pool, as the other
    // pool-event files here do (`a-store-answers-ping-ends-in-its-bound-db`).
    const relay = await startFreezableRelay('ythril_harness_bsppool', { query: '&connectTimeoutMS=1000&heartbeatFrequencyMS=500&serverSelectionTimeoutMS=20000' });
    const client = new MongoClient(relay.uri);
    let cleared = 0;
    client.on('connectionPoolCleared', () => { cleared += 1; });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      relay.freeze();
      await waitFor(() => cleared > 0, 25_000, 50, undefined, { what: 'the monitor to notice the frozen store and clear the pool' });
    } finally {
      relay.thaw();
      await client.close(true).catch(() => {});
      await relay.close();
    }
    assert.ok(cleared >= 1, 'no connectionPoolCleared was counted for a store that stopped answering: the listener counts nothing');
  });

  it('a stalled read the backstop ends clears nothing, and the next read on another collection is served at once', async () => {
    const db = mongo.getDb();
    await mongo.col('bsp_src').insertOne({ _id: 's' });
    await mongo.col('bsp_other').insertOne({ _id: 'o' });
    await withCollectionAsView(db, 'bsp_view', 'bsp_src', async () => {
      reset();
      const outcome = await wb.withinHousekeepingBound(async () => {
        let ended;
        try { await mongo.col('bsp_view').find({}).toArray(); } catch (err) { ended = err; }
        const checkedOutBefore = seen.checkedOut;
        // Started the moment the backstop fired: the pool has had no time to mend anything the abort broke.
        const docs = await mongo.col('bsp_other').find({ _id: 'o' }).toArray();
        return { ended, docs, servedByACheckout: seen.checkedOut - checkedOutBefore };
      }, { opMs: BOUND_MS });
      assert.ok(outcome.ended instanceof StoreTimeout, `the stalled read was not ended by the backstop: ${outcome.ended?.stack ?? 'it completed'}`);
      assert.deepEqual(outcome.docs.map((d) => d._id), ['o'], 'the read behind the backstop did not return its document');
      assert.ok(outcome.servedByACheckout >= 1, `the read behind the backstop was served by no connection checkout (${JSON.stringify(seen)})`);
      assert.equal(seen.cleared, 0, `the backstop cleared the driver's pool (${JSON.stringify(seen)})`);
      assert.equal(seen.checkOutFailed, 0, `a checkout failed after the backstop fired (${JSON.stringify(seen)})`);
      assert.equal(seen.unknown, 0, `the server turned Unknown after the backstop fired (${JSON.stringify(seen)})`);
      console.log(`# backstop of a stalled cursor read: connections closed with reasons [${seen.closed.join(', ')}], pool cleared ${seen.cleared}, checkouts failed ${seen.checkOutFailed}`);
    }, { pipeline: stalledPipeline });
  });
});
