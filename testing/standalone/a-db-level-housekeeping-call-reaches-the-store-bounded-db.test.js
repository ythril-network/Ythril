/**
 * A real `listCollections` and a real `dropCollection`, inside a housekeeping bound, reach the store carrying the figure — and a
 * drop the bound ended never lands afterwards (`Q-358`, bundle-53 G5; probe P8).
 *
 * ## What it holds, against the real driver and a real server
 *
 * - inside `withinHousekeepingBound` both calls SUCCEED and the command that reaches the wire carries `maxTimeMS` = the figure
 *   (read off the driver's command monitoring on a client of this test's own, wrapped by the real `observeRecordWrites`);
 * - a client whose own `timeoutMS` is set (an operator's `MONGO_URI`) still sends the figure, and the calls still succeed;
 * - outside a scope nothing is added to either command;
 * - a drop that is STALLED (another session's open transaction holds the collection) is ended by the SERVER at the figure,
 *   answered `StoreTimeout`, and once the blocker is gone the collection is STILL THERE: a bound-ended drop cannot land later.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-db-level-housekeeping-call-reaches-the-store-bounded-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { holdDocumentLock } from './_write-faults.mjs';
import { sleep } from '../_shared/sleep.mjs';
import * as wb from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';
import { observeRecordWrites } from '../../server/dist/db/record-write-observer.js';

const skip = await mongoSkipReason();
const DB = 'ythril_harness_hkdb';
const FIGURE_MS = 7000;

let mongo;
/** A client of this test's own, command-monitored, and the commands it sent. */
const open = [];
async function monitored(options = {}) {
  const client = new MongoClient(testMongoUri(DB), { monitorCommands: true, serverSelectionTimeoutMS: 10_000, ...options });
  const sent = [];
  client.on('commandStarted', (e) => { if (['listCollections', 'drop'].includes(e.commandName)) sent.push({ name: e.commandName, command: e.command }); });
  await client.connect();
  open.push(client);
  return { client, sent, db: observeRecordWrites(client.db(DB), () => false, () => {}) };
}

describe('a Db-level housekeeping call reaches the store bounded', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('hkdb');
    wb.setWriteBoundForTest({ writeTimeoutMs: 6000, holdDeadlineMs: 20_000, housekeepingOpMs: FIGURE_MS });
  });
  after(async () => {
    wb.setWriteBoundForTest(null);
    for (const c of open) await c.close();
    await closeTestMongo();
  });

  it('listCollections and dropCollection succeed inside the scope and carry the figure on the wire', async () => {
    const { sent, db } = await monitored();
    await db.createCollection('hk_a');
    await wb.withinHousekeepingBound(async () => {
      const names = (await db.listCollections({ name: 'hk_a' }, { nameOnly: true }).toArray()).map(c => c.name);
      assert.deepEqual(names, ['hk_a']);
      assert.equal(await db.dropCollection('hk_a'), true);
    });
    const list = sent.filter(s => s.name === 'listCollections').at(-1);
    const drop = sent.find(s => s.name === 'drop');
    assert.equal(list.command.maxTimeMS, FIGURE_MS, 'the listing carries no figure');
    assert.equal(drop.command.maxTimeMS, FIGURE_MS, 'the drop carries no figure');
    assert.equal((await db.listCollections({ name: 'hk_a' }).toArray()).length, 0, 'the drop did not drop');
  });

  it('the figure is the scope\'s own when it states one', async () => {
    const { sent, db } = await monitored();
    await db.createCollection('hk_b');
    await wb.withinHousekeepingBound(async () => { await db.listCollections().toArray(); await db.dropCollection('hk_b'); }, { opMs: wb.CLAIM_OP_MS });
    assert.deepEqual(sent.filter(s => s.name === 'drop').map(s => s.command.maxTimeMS), [wb.CLAIM_OP_MS]);
  });

  it('a client that carries its own timeoutMS still sends the figure, and both calls succeed', async () => {
    const { sent, db } = await monitored({ timeoutMS: 60_000 });
    await db.createCollection('hk_c');
    await wb.withinHousekeepingBound(async () => {
      assert.ok((await db.listCollections({ name: 'hk_c' }).toArray()).length === 1);
      await db.dropCollection('hk_c');
    });
    for (const s of sent.filter(s => s.name === 'drop' || s.command.filter?.name === 'hk_c')) {
      assert.equal(s.command.maxTimeMS, FIGURE_MS, `${s.name}: the client's own clock replaced the figure on the wire`);
    }
    assert.ok(sent.length >= 2);
  });

  it('outside a scope nothing is added to either command', async () => {
    const { sent, db } = await monitored();
    await db.createCollection('hk_d');
    await db.listCollections({ name: 'hk_d' }).toArray();
    await db.dropCollection('hk_d');
    assert.ok(sent.length >= 2, 'the commands were not seen (floor)');
    for (const s of sent) assert.equal('maxTimeMS' in s.command, false, `${s.name}: a bound outside any scope`);
  });

  it('a stalled drop is ended by the server at the figure, answered StoreTimeout, and does not land afterwards', { timeout: 60_000 }, async () => {
    const { db } = await monitored();
    await db.createCollection('hk_stalled');
    await db.collection('hk_stalled').insertOne({ _id: 'locked' });
    // Another session's open transaction holds the collection, so a drop (which needs it exclusively) waits behind it.
    const lock = await holdDocumentLock(mongo, 'hk_stalled', { filter: { _id: 'locked' } });
    const t0 = Date.now();
    let error;
    try {
      error = await wb.withinHousekeepingBound(() => db.dropCollection('hk_stalled').then(() => null, (e) => e), { opMs: 1000 });
    } finally {
      await lock.release();
    }
    const ms = Date.now() - t0;
    assert.ok(error instanceof StoreTimeout, `the stalled drop was answered ${error}, not StoreTimeout`);
    assert.ok(ms >= 900 && ms < 6000, `answered after ${ms} ms, not at the figure`);
    // A drop the bound ended must not run when its blocker goes: give the server the time it would need to apply it.
    await sleep(2500);
    const still = await db.listCollections({ name: 'hk_stalled' }).toArray();
    assert.equal(still.length, 1, 'the drop landed after the caller was answered a timeout');
    await db.dropCollection('hk_stalled');
  });
});
