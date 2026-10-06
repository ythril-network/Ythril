/**
 * The premise of `db/one-command.ts`, measured on the real driver and server: a bulk write past the driver's batch limit is
 * SEVERAL wire commands, and one that `inOneCommandChunks` slices is exactly ONE each (`Q-372`, pre-ship finding F2).
 * The pure half (the slicer's rows, the writer that uses it, the caps) is `a-bounded-bulk-write-is-one-command.test.js`.
 *
 * ## What is measured
 *
 * - the server's `maxBsonObjectSize` is the 16 MiB the limit is derived from (a server that reports less would make
 *   `ONE_COMMAND_BYTES` too big);
 * - a bulk write of more than that is more than one `update` command, so the premise "the driver splits" still holds for
 *   the installed driver — if a driver upgrade batches differently, THIS is the test that says the guarantee's limit moved;
 * - every slice `inOneCommandChunks` makes, including one filled to the limit, is exactly one `update` command.
 *
 * The commands counted are the ones the server's own Mongo layer sends: the client is reconnected with command monitoring
 * through the URI, so production code needs no branch for it.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-bounded-bulk-write-is-one-command-db.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { MONGO_MAX_WRITE_BATCH_SIZE, ONE_COMMAND_BYTES, ONE_COMMAND_MAX_OPERATIONS, bulkCommandOf, inOneCommandChunks, operationBytes, writeInOneCommands } from '../../server/dist/db/one-command.js';

const skip = await mongoSkipReason();
const SUITE = 'bulkonecommand';
const DB = `ythril_harness_${SUITE}`;
const MIB = 1024 * 1024;

/** One upsert operation carrying a document of about `size` bytes, as `arrivals` writes one. */
const opOf = (id, size) => ({ updateOne: { filter: { _id: id }, update: { $set: { text: 'x'.repeat(size) } }, upsert: true } });
const bytesOfOp = (op) => operationBytes({ filter: op.updateOne.filter, update: op.updateOne.update });

describe('a bulk write past the driver\'s batch limit is several commands; a slice of inOneCommandChunks is one', { skip }, () => {
  let mongo;
  let counting = false;
  let commands = [];
  let batches = [];

  before(async () => {
    mongo = await openTestMongo(SUITE, { query: '&monitorCommands=true' });
    // Only the commands aimed at the probe collection: anything else the server's modules send to this database in the
    // window (a background delete was seen) is not the bulk write under count. Each command's operation count is kept too.
    mongo.getMongo().on('commandStarted', (ev) => {
      if (!(counting && ev.databaseName === DB && ev.command?.[ev.commandName] === 'probe')) return;
      commands.push(ev.commandName);
      const ops = ev.command.documents ?? ev.command.updates ?? ev.command.deletes;
      if (Array.isArray(ops)) batches.push(ops.length);
    });
  });

  /**
   * How many operations each command `fn` sent carried. The property under test is what ONE command carries, so this is
   * asserted on rather than on how many commands went out: a retryable write the driver sends again after a transient
   * error is a second command with the same operations (CI, under load, counted three delete commands for a batch the
   * driver splits in two).
   */
  async function batchesDuring(fn) {
    batches = [];
    await commandsDuring(fn);
    return [...batches];
  }
  after(async () => { await closeTestMongo(); });

  /** The command names sent while `fn` ran. */
  async function commandsDuring(fn) {
    commands = [];
    counting = true;
    try { await fn(); } finally { counting = false; }
    return [...commands];
  }
  const updatesDuring = async (fn) => (await commandsDuring(fn)).filter(c => c === 'update').length;
  const coll = () => mongo.getDb().collection('probe');

  it('the server\'s maxBsonObjectSize is the 16 MiB the one-command limit is derived from', async () => {
    const hello = await mongo.getMongo().db('admin').command({ hello: 1 });
    assert.equal(hello.maxBsonObjectSize, 16 * MIB, 'ONE_COMMAND_BYTES is derived from 16 MiB; this server reports another');
    assert.ok(ONE_COMMAND_BYTES < hello.maxBsonObjectSize);
  });

  it('monitoring sees the commands, so the counts below cannot pass by counting nothing', async () => {
    const seen = await commandsDuring(() => coll().bulkWrite([opOf('probe', 10)], { ordered: false }));
    assert.ok(seen.includes('update'), `monitoring saw ${JSON.stringify(seen)}`);
  });

  it('a bulk write of more than 16 MiB is more than one update command (the premise: the driver splits)', async () => {
    await coll().deleteMany({});
    const ops = Array.from({ length: 6 }, (_, i) => opOf(`big${i}`, 3 * MIB)); // ~18 MiB
    const n = await updatesDuring(() => coll().bulkWrite(ops, { ordered: false }));
    assert.ok(n >= 2, `the driver sent ${n} update command(s) for ~18 MiB of operations; the premise of the one-command limit is gone`);
  });

  it('every slice of inOneCommandChunks over that same batch is exactly one update command', async () => {
    await coll().deleteMany({});
    const ops = Array.from({ length: 6 }, (_, i) => opOf(`slice${i}`, 3 * MIB));
    const chunks = inOneCommandChunks(ops, { maxItems: 500, bytesOf: bytesOfOp });
    assert.ok(chunks.length >= 2, `${chunks.length} slice(s) for ~18 MiB`);
    for (const [k, chunk] of chunks.entries()) {
      const sent = await batchesDuring(() => coll().bulkWrite(chunk, { ordered: false }));
      assert.ok(sent.length > 0 && sent.every(n => n === chunk.length),
        `slice ${k} (${chunk.length} operations) went out as commands of ${JSON.stringify(sent)} operations: the driver split it`);
    }
    assert.equal(await coll().countDocuments({}), 6, 'a slice did not land');
  });

  it('a slice filled to the limit is still one command: the room left for the command\'s own framing is enough', async () => {
    await coll().deleteMany({});
    // Fill one slice as full as the slicer allows: operations of 1 MiB until the next would not fit, then a last one that
    // brings the slice to within a few hundred bytes of ONE_COMMAND_BYTES.
    const ops = [];
    let total = 0;
    for (let i = 0; total + bytesOfOp(opOf(`full${i}`, MIB)) <= ONE_COMMAND_BYTES; i++) { ops.push(opOf(`full${i}`, MIB)); total += bytesOfOp(ops.at(-1)); }
    const room = ONE_COMMAND_BYTES - total;
    const last = opOf('fullLast', Math.max(1, room - 300));
    ops.push(last);
    total += bytesOfOp(last);
    assert.ok(total <= ONE_COMMAND_BYTES && ONE_COMMAND_BYTES - total < 1024, `the fixture is not at the limit (${ONE_COMMAND_BYTES - total} bytes short)`);
    assert.equal(inOneCommandChunks(ops, { maxItems: 500, bytesOf: bytesOfOp }).length, 1, 'the slicer would split a slice at the limit');
    const sent = await batchesDuring(() => coll().bulkWrite(ops, { ordered: false }));
    assert.ok(sent.length > 0 && sent.every(n => n === ops.length),
      `a batch at ONE_COMMAND_BYTES went out as commands of ${JSON.stringify(sent)} operations: the limit leaves too little room for the command's framing`);
  });

  it('the slice the module makes by default IS one command at the cap, which is one fewer than the server\'s maxWriteBatchSize (the driver\'s `size + 1 >= max` batching)', async () => {
    const hello = await mongo.getMongo().db('admin').command({ hello: 1 });
    assert.equal(hello.maxWriteBatchSize, MONGO_MAX_WRITE_BATCH_SIZE, 'the constant is not the server\'s write batch size');
    assert.equal(ONE_COMMAND_MAX_OPERATIONS, hello.maxWriteBatchSize - 1, 'a command the driver sends holds maxWriteBatchSize - 1 operations; the cap is not that');
    await coll().deleteMany({});
    await coll().insertOne({ _id: 'kept' });
    // DELETES OF ABSENT IDS, not inserts: the driver batches by operation count whatever the operation is, so a batch of
    // deletes that match nothing reaches the server as the same number of commands while writing nothing. The first form of
    // this case inserted 200 000 documents, and in CI the database container was shut down under it mid-run ("interrupted at
    // shutdown"), taking the next file's cases with it.
    const ops = Array.from({ length: ONE_COMMAND_MAX_OPERATIONS + 1 }, (_, i) => ({ deleteOne: { filter: { _id: `absent${i}` } } }));
    // The premise first: handed to the driver whole, one operation over the cap does not fit one command — the largest
    // command carries exactly the cap, and the batch is split (a retried command repeats a size; it never merges two).
    const whole = await batchesDuring(() => coll().bulkWrite(ops, { ordered: false }));
    assert.equal(Math.max(...whole), ONE_COMMAND_MAX_OPERATIONS,
      `${ops.length} deletes went out as commands of ${JSON.stringify(whole)} operations: the driver no longer batches at maxWriteBatchSize - 1`);
    assert.deepEqual([...new Set(whole)].sort((a, b) => b - a), [ONE_COMMAND_MAX_OPERATIONS, 1],
      `${ops.length} deletes went out as commands of ${JSON.stringify(whole)} operations`);
    // Then the module: its slices are the cap and the rest, and every command a slice sends carries the WHOLE slice — the
    // driver did not split it. (A retried command carries the whole slice again, which is the same property.)
    const perSlice = await writeInOneCommands(ops, async (slice, { ordered }) => {
      const sent = await batchesDuring(() => coll().bulkWrite(slice, { ordered }));
      return { operations: slice.length, unsplit: sent.length > 0 && sent.every(n => n === slice.length) };
    }, { ordered: false });
    assert.deepEqual(perSlice, [{ operations: ONE_COMMAND_MAX_OPERATIONS, unsplit: true }, { operations: 1, unsplit: true }],
      `the slices the module makes were sent as ${JSON.stringify(perSlice)}`);
    assert.deepEqual(await coll().find({}).toArray(), [{ _id: 'kept' }], 'a delete of an absent id removed something');
  });

  it('an UNORDERED bulk of mixed operation types is one command per type per slice; sliced by type, every slice is one command', async () => {
    await coll().deleteMany({});
    const mixed = [
      { insertOne: { document: { _id: 'm1' } } }, { updateOne: { filter: { _id: 'm1' }, update: { $set: { x: 1 } }, upsert: true } },
      { insertOne: { document: { _id: 'm2' } } }, { deleteOne: { filter: { _id: 'm1' } } },
    ];
    const all = await commandsDuring(() => coll().bulkWrite(mixed, { ordered: false }));
    assert.ok(all.filter(c => ['insert', 'update', 'delete'].includes(c)).length >= 3, `one slice of three operation types was sent as ${JSON.stringify(all)}`);
    await coll().deleteMany({});
    const answers = await writeInOneCommands(mixed, async (slice, { ordered }) => {
      const sent = await batchesDuring(() => coll().bulkWrite(slice, { ordered }));
      return sent.length > 0 && sent.every(n => n === slice.length);
    }, { ordered: false, commandKindOf: bulkCommandOf });
    assert.deepEqual(answers, [true, true, true], `a slice of one operation type was split by the driver: ${JSON.stringify(answers)}`);
  });
});
