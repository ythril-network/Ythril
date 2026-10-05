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
import { ONE_COMMAND_BYTES, inOneCommandChunks, operationBytes } from '../../server/dist/db/one-command.js';

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

  before(async () => {
    mongo = await openTestMongo(SUITE, { query: '&monitorCommands=true' });
    mongo.getMongo().on('commandStarted', (ev) => {
      if (counting && ev.databaseName === DB) commands.push(ev.commandName);
    });
  });
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
      const n = await updatesDuring(() => coll().bulkWrite(chunk, { ordered: false }));
      assert.equal(n, 1, `slice ${k} (${chunk.length} operations) was sent as ${n} update commands`);
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
    const n = await updatesDuring(() => coll().bulkWrite(ops, { ordered: false }));
    assert.equal(n, 1, `a batch at ONE_COMMAND_BYTES was sent as ${n} update commands: the limit leaves too little room for the command's framing`);
  });
});
