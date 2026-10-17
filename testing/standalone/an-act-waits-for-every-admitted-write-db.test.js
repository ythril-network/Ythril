/**
 * A deletion or wipe waits for EVERY write that was admitted before it registered, and nothing such a write lands survives the wipe
 * (bundle-106 PR A; design v5 §2.6b: each write unit is admitted by the writer's check AND counted by the fence, and the unit in flight is what
 * the drain waits for).
 *
 * ## The rule, and the shape it was broken in
 *
 * The record writers (`updateFact`, `deleteFact`, the entity, edge and chrono updates), the file-meta writers, the tombstone writers and a peer's
 * tombstone apply asked the gate and entered no fence. A wipe registered while one of them was between its check and its store write
 * therefore saw no unit in flight, drained at once and deleted — and the write landed after the first delete. For a writer that CREATES (a
 * file-meta upsert, a tombstone) that is data the act removed coming back; for one that updates it is an act that did not wait for what it
 * had admitted. `every-transfer-enters-the-fence` holds every asker to `admitSpaceWrite` by derivation; this holds the behaviour, once per
 * writer family, against a REAL wipe run through the runner.
 *
 * ## How a row is driven
 *
 * The writer's own store write is parked at the driver (`parkWrites`), after its check and its reads. A real wipe is then registered and run
 * through the runner, and a bounded run of store round trips later the act must NOT have completed (its drain is waiting on the parked unit).
 * Released, the act completes and the space holds nothing of what the write carried. Ordering is a latch and round trips, never a timer.
 *
 * ## Seen red
 *
 * With the family's writer reverted to ask-only (the gate's check and no count) the act completes while the write is still parked, and the
 * file-meta row and the tombstone are still there after it.
 *
 * Run: `node --test testing/standalone/an-act-waits-for-every-admitted-write-db.test.js` (a Mongo the harness accepts; a prior `npm run build:server`).
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { parkWrites } from './_write-faults.mjs';
import { clearActEntries, resetRunnerForTest } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const S = 'admitwait';

describe('a wipe waits for every write admitted before it, and no such write survives it', { skip }, () => {
  let door, loader, runner, fence, writers, proto;
  before(async () => {
    door = await openToolDoor({ suite: 'admitwait', spaces: [{ id: S, label: S, folders: [] }] });
    loader = await import('../../server/dist/config/loader.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    fence = await import('../../server/dist/sync/space-transfer-fence.js');
    writers = {
      fact: await import('../../server/dist/brain/fact.js'),
      fileMeta: await import('../../server/dist/files/file-meta.js'),
      tombstones: await import('../../server/dist/brain/tombstones.js'),
    };
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  after(async () => { await door?.close(); });
  afterEach(() => { clearActEntries(loader); resetRunnerForTest(runner); });

  const register = () => { let out; loader.mutateConfig(cfg => { out = runner.registerSpaceAct(cfg, { kind: 'wipe', localId: S }, Date.now()); }); return out; };
  /** Store round trips, bounded: how a row lets a wipe that is NOT waiting finish, without a timer. */
  const roundTrips = async (n) => { for (let i = 0; i < n; i++) await door.mongo.getDb().command({ ping: 1 }); };

  /**
   * One row. `seed` stages the space, `run` is the writer (a promise), `collection`/`method` name the store write to park, and `gone` reads what
   * of the write's data is still in the space after the wipe (must be 0).
   */
  async function row({ name, seed, run, collection, method, gone }) {
    await seed?.();
    const park = parkWrites(proto);
    try {
      const parked = park.arm(`${S}_${collection}`, { when: (m) => method === undefined || m === method });
      const writing = run().then(() => null, (err) => err);
      // Past the writer's check, at its store write — in a bounded run of round trips, so a write that never reaches the store fails the row.
      let reached = false;
      void parked.reached.then(() => { reached = true; });
      for (let i = 0; i < 400 && !reached; i++) await door.mongo.getDb().command({ ping: 1 });
      assert.ok(reached, `${name} never reached its store write on ${S}_${collection}${method ? ` (${method})` : ''}: ${(await Promise.race([writing, null]))?.message ?? 'still running'}`);
      const { entry } = register();
      let actDone = false;
      const act = runner.runSpaceAct(entry.id).then((r) => { actDone = true; return r; });
      await roundTrips(150);
      const waited = actDone === false;   // judged with the survival check below, so a tree that breaks both says both
      parked.release();
      const result = await act;
      assert.equal(result.ok, true, `the wipe did not complete once the write was released: ${JSON.stringify(result).slice(0, 300)}`);
      const err = await writing;
      assert.ok(err === null || err?.name !== 'TypeError', `${name} failed: ${err?.message}`);
      const left = await gone();
      assert.deepEqual({ waited, left }, { waited: true, left: 0 },
        `${name}: the wipe ${waited ? 'waited' : 'completed while the write was still in flight, so it did not wait for a write it had admitted'}, and ${left} of what the write carried ${left === 0 ? 'is gone' : 'survived the wipe: the wipe deleted first and the write landed after it'}`);
      assert.equal(fence.spaceTransfersRunning(S), 0, `${name} left its count behind`);
    } finally { park.restore(); }
  }

  it('a record update (updateFact): the wipe waits for the update in flight', async () => {
    await row({
      name: 'updateFact', collection: 'facts', method: 'findOneAndUpdate',
      seed: async () => { await door.coll(S, 'facts').deleteMany({}); await door.coll(S, 'facts').insertOne({ _id: 'f-wait', spaceId: S, fact: 'a fact', type: 'note', tags: [], seq: 1 }); },
      run: () => writers.fact.updateFact(S, 'f-wait', { tags: ['edited'] }),
      gone: () => door.coll(S, 'facts').countDocuments({}),
    });
  });

  it('a file-meta write (upsertFileMeta): the wipe waits, and the row it creates does not survive the wipe', async () => {
    await row({
      name: 'upsertFileMeta', collection: 'files',
      seed: async () => { await door.coll(S, 'files').deleteMany({}); },
      run: () => writers.fileMeta.upsertFileMeta(S, 'admitted/wipe-me.txt', 3),
      gone: () => door.coll(S, 'files').countDocuments({ _id: 'admitted/wipe-me.txt' }),
    });
  });

  it('a tombstone write (writeTombstones): the wipe waits, and the tombstone it stores does not survive the wipe', async () => {
    await row({
      name: 'writeTombstones', collection: 'tombstones', method: 'bulkWrite',
      seed: async () => { await door.coll(S, 'tombstones').deleteMany({}); },
      run: () => writers.tombstones.writeTombstones(S, [{ _id: 'tomb-wait', type: 'fact' }]),
      gone: () => door.coll(S, 'tombstones').countDocuments({ _id: 'tomb-wait' }),
    });
  });
});
