/**
 * A bulk write the write bound covers is ONE wire command (`Q-372`, pre-ship finding F2, and round R's R1) — held at the
 * writers whose page is a peer's, and every other bulk call site in the server is accounted for, one row each.
 *
 * ## The limit the bound's guarantee has
 *
 * `maxTimeMS` is per WIRE COMMAND. The driver splits a bulk write into several commands when its batch passes the server's
 * `maxBsonObjectSize` (16 MiB — `lib/bulk/common.js`: `maxBatchSizeBytes = maxBsonObjectSize`; the finding's 48 MB was the
 * message size, which is not what the driver batches by) or `maxWriteBatchSize` operations. Each command gets the SAME
 * `maxTimeMS`, armed when THAT command reaches the server, while the client backstop is armed once, at the call. A second
 * command can therefore arrive after the backstop has answered the caller `503` and released the hold, with a fresh
 * deadline, and land. "A write the bound ended never lands" holds for one command, not for a call that becomes several.
 *
 * ## What is held, and where it stops being true
 *
 * - `inOneCommandChunks` (`db/one-command.ts`) slices a batch of operations so each slice is under `ONE_COMMAND_BYTES`
 *   (derived from the driver's limit, with room for the command's own framing) and under a stated count, and a single
 *   operation over the limit goes alone (the driver sends it alone as well);
 * - the two writers whose page is a PEER's go through it: `writeArrivals` (`sync/arrivals.ts`; a pulled page has no body
 *   cap, and 500 documents of 32 KiB are already 16 MiB) and `applyPeerTombstones` (`sync/tombstone-apply.ts`; a page is
 *   counted, not measured, and a tombstone's id is a peer's text);
 * - **every other `bulkWrite(` / `insertMany(` in `server/src` is a row of `SITES`**, found by scanning the source rather
 *   than by naming the three caps a first version of this gate pinned: a gate that named three caps concluded about all of
 *   them (its title claimed every other bounded bulk, its body read three constants). A site is one of five kinds, each
 *   with the reason it stays under one command, and the kinds that can be checked against the code are (a slicer is called
 *   once per site, the cap is named in the file, the call carries a session, the file opens its own client). There is no kind
 *   for "not known to": a new unsliced bulk fails this gate until it is sliced or states a cap.
 *
 * `request-capped` is a stated limit, not a proof: a request body is at most 10 MiB, BSON is not JSON, and a body of scalar
 * properties inflates to about twice its size, so a request-fed bulk is under 16 MiB for any real record and NOT for an
 * adversarial one. A site whose count is the store's own (a directory move, a hub's merge) is `sliced`: slicing by bytes is
 * harmless where the driver would split anyway, and it makes the one-command property hold whether or not the site runs inside
 * a hold, so nothing here needed proving about which ones do.
 *
 * Run: node --test testing/standalone/a-bounded-bulk-write-is-one-command.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BSON, MongoBulkWriteError, MongoNetworkError, MongoServerError } from 'mongodb';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { lineOf, parseSource, ts } from '../_shared/syntax-tree.mjs';
import { MONGO_MAX_WRITE_BATCH_SIZE, ONE_COMMAND_BYTES, ONE_COMMAND_MAX_OPERATIONS, SlicedBulkWriteError, bulkCommandOf, inOneCommandChunks, writeInOneCommands } from '../../server/dist/db/one-command.js';
import { classifyReadFailure } from '../../server/dist/brain/store-failure.js';
import { isWriteTimeout } from '../../server/dist/db/write-timeout.js';
import { ROWS_PER_BULK_COMMAND } from '../../server/dist/util/chunks.js';
import { READ_CHUNK } from '../../server/dist/db/read-by-id.js';
import { BULK_MAX_PER_TYPE } from '../../server/dist/brain/bulk.js';

const MIB = 1024 * 1024;
const bytes = (doc) => BSON.calculateObjectSize(doc);
const docOf = (id, size) => ({ _id: String(id), text: 'x'.repeat(size) });
const MAX_BSON_OBJECT_SIZE = 16 * MIB; // MongoDB's, and the driver's fallback when a server reports none

describe('inOneCommandChunks', () => {
  const chunk = (items, maxItems = 500) => inOneCommandChunks(items, { maxItems, bytesOf: bytes });

  it('the limit is under the driver\'s batch limit, with room for the command\'s own framing', () => {
    assert.ok(ONE_COMMAND_BYTES < MAX_BSON_OBJECT_SIZE, 'a batch at the driver\'s own limit splits once the command\'s framing is added');
    assert.ok(MAX_BSON_OBJECT_SIZE - ONE_COMMAND_BYTES >= 64 * 1024, 'less than 64 KiB of room for the command document around the operations');
    assert.ok(ONE_COMMAND_BYTES > MAX_BSON_OBJECT_SIZE / 2, 'a limit under half the driver\'s sends more commands than it has to');
  });

  it('a page under the limit is one chunk, in order', () => {
    const items = Array.from({ length: 50 }, (_, i) => docOf(i, 1000));
    assert.deepEqual(chunk(items), [items]);
  });

  it('a page over the limit is split, every chunk is under it, and nothing is lost or reordered', () => {
    const items = Array.from({ length: 20 }, (_, i) => docOf(i, MIB)); // 20 MiB
    const chunks = chunk(items);
    assert.ok(chunks.length >= 2, `${chunks.length} chunk(s) for 20 MiB`);
    for (const c of chunks) assert.ok(c.reduce((n, d) => n + bytes(d), 0) <= ONE_COMMAND_BYTES, 'a chunk is over the one-command limit');
    assert.deepEqual(chunks.flat(), items);
  });

  it('the count limit splits too', () => {
    const items = Array.from({ length: 1201 }, (_, i) => docOf(i, 10));
    assert.deepEqual(chunk(items, 500).map(c => c.length), [500, 500, 201]);
  });

  it('one operation over the limit goes alone, and its neighbours are not swallowed with it', () => {
    const big = docOf('big', ONE_COMMAND_BYTES + 1000);
    const chunks = chunk([docOf(1, 100), big, docOf(2, 100)]);
    assert.deepEqual(chunks.map(c => c.map(d => d._id)), [['1'], ['big'], ['2']]);
  });

  it('nothing is no chunk; a count that is not a positive integer is refused, not read as "no slicing"', () => {
    assert.deepEqual(chunk([]), []);
    for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => chunk([docOf(1, 1)], bad), /maxItems/);
  });
});

describe('writeInOneCommands', () => {
  const docs = (n, size = 10) => Array.from({ length: n }, (_, i) => docOf(i, size));

  it('hands each slice to the write, one after another and in order, and returns what each answered', async () => {
    const items = docs(25);
    const seen = [];
    let running = 0;
    const answers = await writeInOneCommands(items, async (slice) => {
      assert.equal(++running, 1, 'two slices were in flight at once');
      await new Promise(r => setImmediate(r));
      seen.push(slice.map(d => d._id));
      running--;
      return slice.length;
    }, { ordered: true, maxItems: 10 });
    assert.deepEqual(seen.flat(), items.map(d => d._id));
    assert.deepEqual(answers, [10, 10, 5]);
  });

  it('slices by bytes by default: twenty 1 MiB operations are never one slice', async () => {
    const sizes = await writeInOneCommands(docs(20, MIB), async (slice) => slice.reduce((n, d) => n + bytes(d), 0), { ordered: true });
    assert.ok(sizes.length >= 2);
    for (const n of sizes) assert.ok(n <= ONE_COMMAND_BYTES, `a slice of ${n} bytes is more than one command`);
  });

  it('by default a slice is at most what the DRIVER sends as one command (maxWriteBatchSize - 1), NOT ROWS_PER_BULK_COMMAND', async () => {
    // One command holds 16 MiB and up to `maxWriteBatchSize - 1` operations: the driver opens a new batch when
    // `size + 1 >= maxWriteBatchSize` (`lib/bulk/ordered.js`, `unordered.js`), so a slice of exactly `maxWriteBatchSize` is TWO
    // commands (round W, V1). The 1000 the hubs' chunked writes use answers another question (how much one `$in` delete
    // carries), and read here it turned a single insert into many commands with a delete already done (round V, S2).
    assert.equal(MONGO_MAX_WRITE_BATCH_SIZE, 100_000, 'the server\'s maxWriteBatchSize (MongoDB 4.2 to 8.x) is 100000');
    assert.equal(ONE_COMMAND_MAX_OPERATIONS, MONGO_MAX_WRITE_BATCH_SIZE - 1, 'a command the driver sends holds one operation fewer than maxWriteBatchSize');
    assert.ok(ONE_COMMAND_MAX_OPERATIONS > ROWS_PER_BULK_COMMAND);
    const counts = await writeInOneCommands(docs(ONE_COMMAND_MAX_OPERATIONS * 2 + 1), async (slice) => slice.length, { ordered: true, bytesOf: () => 1 });
    assert.deepEqual(counts, [99_999, 99_999, 1]);
  });

  it('the driver\'s own batching agrees: ONE_COMMAND_MAX_OPERATIONS operations are one batch, one more is two (no server needed)', () => {
    // The real bulk classes of the installed driver over a topology that reports the server's limits, as `hello` does. This is
    // the premise the constant is derived from; `a-bounded-bulk-write-is-one-command-db` repeats it against a real server.
    const mongodbDir = dirname(createRequire(import.meta.url).resolve('mongodb/package.json'));
    const topology = { lastHello: () => ({ maxBsonObjectSize: MAX_BSON_OBJECT_SIZE, maxWriteBatchSize: MONGO_MAX_WRITE_BATCH_SIZE }), s: { options: {} } };
    const collection = () => ({ db: { options: {}, s: { client: { topology } } }, s: { namespace: { db: 'x', collection: 'y' } }, client: { topology }, fullNamespace: {} });
    // The row reads the driver's INTERNALS (`@internal`: the bulk classes by file path, their `s` state). A driver release that moves
    // them must fail with the premise NAMED, not with a TypeError from the middle of a batching loop (round X, W4).
    const MOVED = 'the driver\'s bulk batching internals moved: re-derive the one-command cap against bulk/ordered.js and unordered.js';
    const driver = (file) => {
      try { return createRequire(import.meta.url)(join(mongodbDir, 'lib', 'bulk', file)); } catch (error) { return assert.fail(`${MOVED} (lib/bulk/${file} does not load: ${error.message})`); }
    };
    const { BatchType } = driver('common.js');
    assert.ok(BatchType && BatchType.INSERT !== undefined, `${MOVED} (common.js has no BatchType.INSERT)`);
    const batchesOf = (Class, finalBatches, n) => {
      const bulk = new Class(collection(), {});
      for (let i = 0; i < n; i++) bulk.addToOperationsList(BatchType.INSERT, { _id: i });
      return finalBatches(bulk).filter(Boolean).map(b => b.operations.length);
    };
    for (const [file, name, current] of [['ordered.js', 'OrderedBulkOperation', 'currentBatch'], ['unordered.js', 'UnorderedBulkOperation', 'currentInsertBatch']]) {
      const Class = driver(file)[name];
      assert.equal(typeof Class, 'function', `${MOVED} (${file} exports no ${name})`);
      assert.equal(typeof Class.prototype.addToOperationsList, 'function', `${MOVED} (${name}.addToOperationsList is gone)`);
      const probe = new Class(collection(), {});
      assert.ok(Array.isArray(probe.s?.batches), `${MOVED} (${name} keeps no s.batches array)`);
      assert.ok(current in probe.s, `${MOVED} (${name} keeps no s.${current})`);
      const finalBatches = (bulk) => [...bulk.s.batches, bulk.s[current]];
      assert.deepEqual(batchesOf(Class, finalBatches, ONE_COMMAND_MAX_OPERATIONS), [ONE_COMMAND_MAX_OPERATIONS], `${name}: a slice of the cap is not one batch`);
      assert.equal(batchesOf(Class, finalBatches, ONE_COMMAND_MAX_OPERATIONS + 1).length, 2, `${name}: one operation more is not a second batch, so the cap could be higher`);
    }
  });

  it('nothing is no write, ordered or not', async () => {
    let calls = 0;
    for (const ordered of [true, false]) assert.deepEqual(await writeInOneCommands([], async () => { calls++; }, { ordered }), []);
    assert.equal(calls, 0, 'the write was called for nothing');
  });

  it('`maxItems` is refused the same way with and without `commandKindOf`, an empty list included (round X, W5)', async () => {
    const kind = () => 'insert';
    for (const maxItems of [0, -1, 1.5, NaN, '10']) {
      for (const [label, extra] of [['without commandKindOf', {}], ['with commandKindOf', { commandKindOf: kind }]]) {
        for (const items of [[], docs(3)]) {
          let calls = 0;
          await assert.rejects(writeInOneCommands(items, async () => { calls++; }, { ordered: false, maxItems, ...extra }), /maxItems/,
            `${label}, ${items.length} items, maxItems ${String(maxItems)}: accepted`);
          assert.equal(calls, 0, `${label}: a slice was written before maxItems was refused`);
        }
      }
    }
  });

  it('`ordered` is required: a caller cannot get a default it did not choose', async () => {
    for (const opts of [undefined, {}, { maxItems: 10 }, { ordered: undefined }, { ordered: 'false' }, { ordered: 0 }]) {
      await assert.rejects(writeInOneCommands(docs(3), async () => 1, opts), /ordered/, `accepted ${JSON.stringify(opts)}`);
    }
  });

  it('the write is handed the `ordered` it was asked for, so the driver call and the slicing cannot disagree', async () => {
    for (const ordered of [true, false]) {
      const seen = [];
      await writeInOneCommands(docs(5), async (slice, o) => { seen.push(o.ordered); }, { ordered, maxItems: 2 });
      assert.deepEqual(seen, [ordered, ordered, ordered]);
    }
  });

  describe('a slice that fails', () => {
    /** The driver's per-operation failure: a `MongoBulkWriteError` carrying `writeErrors` (a duplicate key, a refusal). */
    const operationFailure = (n) => new MongoBulkWriteError({ message: `E11000 duplicate key ${n}`, code: 11000, writeErrors: [{ index: 0, code: 11000, errmsg: `dup ${n}` }] }, {});
    const networkFailure = () => new MongoNetworkError('connection reset'); // the driver's own class: a door classifies by it, not by a name

    it('ORDERED: stops the rest and rejects with its own error — the slices before it landed', async () => {
      let calls = 0;
      const boom = operationFailure(2);
      await assert.rejects(writeInOneCommands(docs(30), async () => { if (++calls === 2) throw boom; }, { ordered: true, maxItems: 10 }), (e) => e === boom);
      assert.equal(calls, 2, 'a slice was written after one had failed');
    });

    it('UNORDERED: every slice is attempted, and ONE error names every failure and what landed', async () => {
      const items = docs(50);
      const attempted = [];
      let calls = 0;
      const e1 = operationFailure(1);
      const e3 = operationFailure(3);
      const err = await writeInOneCommands(items, async (slice) => {
        const k = ++calls;
        attempted.push(slice[0]._id);
        if (k === 1) throw e1;
        if (k === 3) throw e3;
        return `landed ${k}`;
      }, { ordered: false, maxItems: 10 }).then(() => null, (e) => e);
      assert.deepEqual(attempted, ['0', '10', '20', '30', '40'], 'a slice was never attempted after another failed');
      assert.ok(err instanceof SlicedBulkWriteError, `rejected with ${err?.constructor?.name}`);
      assert.deepEqual(err.failures.map(f => [f.slice, f.error]), [[0, e1], [2, e3]], 'the error does not carry every failure, in slice order');
      assert.deepEqual(err.landed.map(l => [l.slice, l.answer]), [[1, 'landed 2'], [3, 'landed 4'], [4, 'landed 5']], 'the error does not say what landed');
      assert.equal(err.cause, e1, 'with nothing stopping the write, the first failure is the cause, so a classifier looking through the wrapper reads the driver\'s error');
      assert.match(err.message, /2 of 5 slices/);
    });

    it('UNORDERED: a slice that fails and nothing else failing is still that one error, wrapped the same way', async () => {
      const e = operationFailure(1);
      const err = await writeInOneCommands(docs(20), async (slice) => { if (slice[0]._id === '0') throw e; }, { ordered: false, maxItems: 10 }).then(() => null, (x) => x);
      assert.ok(err instanceof SlicedBulkWriteError);
      assert.deepEqual(err.failures.map(f => f.error), [e]);
    });

    it('UNORDERED: a failure that is not a per-operation write error (the store down, a bound ended) stops at once, as it did', async () => {
      let calls = 0;
      const down = networkFailure();
      await assert.rejects(writeInOneCommands(docs(30), async () => { if (++calls === 2) throw down; }, { ordered: false, maxItems: 10 }), (e) => e === down);
      assert.equal(calls, 2, 'a slice was written after the store failed');
    });

    it('UNORDERED: a store failure after an operation failure still stops, and the one error carries both with the STOPPING failure as its cause', async () => {
      let calls = 0;
      const e1 = operationFailure(1);
      const down = networkFailure();
      const err = await writeInOneCommands(docs(40), async () => {
        const k = ++calls;
        if (k === 1) throw e1;
        if (k === 2) throw down;
      }, { ordered: false, maxItems: 10 }).then(() => null, (x) => x);
      assert.equal(calls, 2);
      assert.ok(err instanceof SlicedBulkWriteError);
      assert.deepEqual(err.failures.map(f => f.error), [e1, down]);
      assert.equal(err.cause, down, 'the failure that ENDED the write is the cause when it is the store\'s; the dup key before it is in `failures`');
    });

    describe('what a door answers for the wrapper is what ended the write (round X, W1)', () => {
      // `errorChain` follows `cause` only, so the cause decides the answer a door gives. The failure that STOPPED the write (a bound,
      // a store failure) is retryable (503) and the caller must be told so; a per-operation failure is the caller's (400). A
      // dup key first and a timeout second used to be answered 400 — a sender told not to retry what a retry would have landed.
      const bulkTimeout = () => new MongoBulkWriteError({ message: 'Timed out during socket read', code: 50, writeErrors: [{ index: 0, code: 50, errmsg: 'x' }] }, {});
      const serverDeadline = () => new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
      const runWith = async (failures) => {
        let calls = 0;
        return writeInOneCommands(docs(30), async () => { const f = failures[calls++]; if (f) throw f; }, { ordered: false, maxItems: 10 })
          .then(() => null, (x) => x);
      };

      it('a dup key, then a bound ending the write: answered as the bound (retryable 503), through errorChain', async () => {
        const dup = operationFailure(1);
        assert.equal(classifyReadFailure(dup).status, 400, 'the premise: a raw dup key is a 400');
        for (const stop of [bulkTimeout(), serverDeadline()]) {
          const err = await runWith([dup, stop]);
          assert.ok(err instanceof SlicedBulkWriteError);
          assert.ok(isWriteTimeout(err), `${stop.message}: the wrapper does not read as a bound ending the write`);
          const answer = classifyReadFailure(err);
          assert.equal(answer.status, 503, `answered ${JSON.stringify(answer)}`);
          assert.equal(answer.retryable, true);
        }
      });

      it('a dup key, then the store going away: answered as the store (retryable 503)', async () => {
        const err = await runWith([operationFailure(1), networkFailure()]);
        assert.ok(err instanceof SlicedBulkWriteError);
        const answer = classifyReadFailure(err);
        assert.equal(answer.status, 503, `answered ${JSON.stringify(answer)}`);
        assert.equal(answer.retryable, true);
      });

      it('a dup key, then another dup key: still the first (400 duplicate key)', async () => {
        const dup = operationFailure(1);
        const err = await runWith([dup, operationFailure(2)]);
        assert.ok(err instanceof SlicedBulkWriteError);
        assert.equal(err.cause, dup);
        const answer = classifyReadFailure(err);
        assert.equal(answer.status, classifyReadFailure(dup).status, `the wrapper answered ${JSON.stringify(answer)}`);
        assert.equal(answer.status, 400);
        assert.equal(answer.retryable ?? false, false);
      });

      it('a dup key and a later slice that lands: the dup key, as before', async () => {
        const dup = operationFailure(1);
        const err = await runWith([dup]);
        assert.equal(err.cause, dup);
        assert.equal(classifyReadFailure(err).status, 400);
      });
    });

    it('UNORDERED: a bulk error that is a write concern failure or a timeout is the store\'s, not an operation\'s', async () => {
      const timeout = Object.assign(new MongoBulkWriteError({ message: 'Timed out during socket read', code: 50, writeErrors: [{ index: 0, code: 50, errmsg: 'x' }] }, {}), {});
      const concern = new MongoBulkWriteError({ message: 'waiting for replication timed out', code: 64 }, {});
      for (const e of [timeout, concern]) {
        let calls = 0;
        await assert.rejects(writeInOneCommands(docs(30), async () => { if (++calls === 1) throw e; }, { ordered: false, maxItems: 10 }), (x) => x === e);
        assert.equal(calls, 1, `${e.message}: a slice was written after the store failed`);
      }
    });
  });

  describe('bulkCommandOf: the wire command a bulkWrite operation is sent in', () => {
    it('is the driver\'s batching: updateOne, updateMany and replaceOne are one command type, deleteOne and deleteMany another', () => {
      assert.equal(bulkCommandOf({ insertOne: {} }), 'insert');
      for (const k of ['updateOne', 'updateMany', 'replaceOne']) assert.equal(bulkCommandOf({ [k]: {} }), 'update', k);
      for (const k of ['deleteOne', 'deleteMany']) assert.equal(bulkCommandOf({ [k]: {} }), 'delete', k);
    });
    it('refuses an operation it does not know rather than reading it as a kind of its own', () => {
      assert.throws(() => bulkCommandOf({ somethingNew: {} }), /not a bulkWrite operation/);
      assert.throws(() => bulkCommandOf({}), /not a bulkWrite operation/);
    });
  });

  describe('a bulk of mixed operation types', () => {
    // The driver sends an unordered bulk as one command PER OPERATION TYPE (inserts, updates, deletes), so a slice of mixed
    // operations is several commands, each with a deadline of its own. `commandKindOf` makes a slice one kind.
    const op = (kind, i) => ({ kind, i });
    const mixed = [op('update', 1), op('delete', 1), op('update', 2), op('delete', 2), op('update', 3), op('delete', 3), op('delete', 4)];
    const named = (o) => `${o.kind[0]}${o.i}`;

    it('every slice is one kind and every operation is written once', async () => {
      const slices = await writeInOneCommands(mixed, async (slice) => slice.map(named), { ordered: false, maxItems: 3, commandKindOf: (o) => o.kind });
      assert.deepEqual(slices, [['u1', 'u2', 'u3'], ['d1', 'd2', 'd3'], ['d4']]);
    });

    it('the kinds run in the DRIVER\'s order (inserts, updates, deletes), not the order they first appear', async () => {
      // `lib/bulk/common.js` of an unordered bulk sends every insert batch, then every update batch, then every delete batch.
      // A caller whose first operation is a delete does not get deletes first: it would not from the driver either.
      const ops = [op('delete', 1), op('update', 1), op('insert', 1), op('delete', 2), op('insert', 2)];
      const slices = await writeInOneCommands(ops, async (slice) => slice.map(named), { ordered: false, maxItems: 10, commandKindOf: (o) => o.kind });
      assert.deepEqual(slices, [['i1', 'i2'], ['u1'], ['d1', 'd2']]);
    });

    it('an ORDERED write cannot also ask for its operations to be regrouped by kind: refused at the call, nothing written', async () => {
      // `ordered` says the sequence matters; `commandKindOf` reorders it. The contradiction is the caller's to resolve.
      let calls = 0;
      await assert.rejects(writeInOneCommands(mixed, async () => { calls++; }, { ordered: true, commandKindOf: (o) => o.kind }), /ordered.*commandKindOf|commandKindOf.*ordered/);
      assert.equal(calls, 0, 'a slice was written before the contradiction was refused');
    });

    it('a kind that is not insert, update or delete is refused rather than given a place of its own', async () => {
      let calls = 0;
      await assert.rejects(writeInOneCommands([op('upsert', 1)], async () => { calls++; }, { ordered: false, commandKindOf: (o) => o.kind }), /insert, update or delete|commandKindOf/);
      assert.equal(calls, 0);
    });

    it('without `commandKindOf` the slices are mixed (the default stays one question: count and bytes)', async () => {
      const slices = await writeInOneCommands(mixed, async (slice) => slice.length, { ordered: false, maxItems: 3 });
      assert.deepEqual(slices, [3, 3, 1]);
    });

    it('a failure in one kind\'s slice does not stop the other kind (unordered)', async () => {
      const err = await writeInOneCommands(mixed, async (slice) => { if (slice[0].kind === 'update') throw new MongoBulkWriteError({ message: 'dup', code: 11000, writeErrors: [{ index: 0, code: 11000, errmsg: 'x' }] }, {}); },
        { ordered: false, maxItems: 3, commandKindOf: (o) => o.kind }).then(() => null, (x) => x);
      assert.ok(err instanceof SlicedBulkWriteError);
      assert.deepEqual(err.landed.map(l => l.slice), [1, 2], 'the deletes did not land after the updates failed');
    });
  });
});

/**
 * Every bulk call site in the server: the file, how many `bulkWrite(` / `insertMany(` calls it holds, and the kind.
 *
 * - `sliced`: the file slices what it writes with `inOneCommandChunks` or `writeInOneCommands` (checked over the syntax tree:
 *   EVERY bulk call of the file sits inside the callback handed to `writeInOneCommands` or the loop over the chunks of
 *   `inOneCommandChunks`, so a bare bulk beside a sliced one is refused; the callback takes its `ordered` from the slicer; and a
 *   bulk of more than one operation type — the driver sends one command per type — passes `commandKindOf`);
 * - `chunked`: by COUNT, a cap named in `cap` (checked: `inChunks(` or the cap's own loop names it in the file) over rows
 *   far smaller than 16 MiB / the cap;
 * - `session`: the operation carries a session, which is bounded by the session (`brain/held-transaction.ts`), not by
 *   `maxTimeMS` (checked: the call passes `session`);
 * - `own-client`: the file writes through a client of its own, not `getDb()`, so no bound applies to it (checked);
 * - `request-capped`: the quantity is what a request caps (see the docblock: a stated limit, not a proof);
 *
 * **`sites` is a number, or `EVERY`** (bundle-71, Q-352). A number is the file's count of bulk calls, so a call added or
 * removed there is looked at. `EVERY` is for a `sliced` file whose RULE is the whole accounting: every bulk call in it sits in
 * what the slicer hands it (checked below, per call, over the syntax tree), so the number of calls says nothing the rule does
 * not — and a number kept beside a rule is a second copy of a fact the tree holds, which `files/tombstones.ts` outgrew the
 * day its publish and its prune began to slice by path and by page. `EVERY` is refused for any other kind: there the count
 * is the only thing standing for "somebody looked".
 */
const EVERY = 'every';
const SITES = [
  { file: 'server/src/sync/arrivals.ts', sites: 1, kind: 'sliced', reason: 'a peer\'s page, sliced by bytes and by count' },
  { file: 'server/src/sync/tombstone-apply.ts', sites: 1, kind: 'sliced', reason: 'a peer\'s tombstone page: 5000 counted, each op carries an unbounded id twice' },
  { file: 'server/src/brain/edge-rekey.ts', sites: 1, kind: 'chunked', cap: 'ROWS_PER_BULK_COMMAND', reason: 'edge rows, 1000 at a time; an edge document is nowhere near 16 KiB' },
  { file: 'server/src/brain/tombstones.ts', sites: 1, kind: 'chunked', cap: 'ROWS_PER_BULK_COMMAND', reason: 'tombstones, 1000 at a time; a tombstone is an id and four fields' },
  { file: 'server/src/brain/embed-queue.ts', sites: 1, kind: 'chunked', cap: 'SWEEP_BATCH', reason: 'job rows, 500 records at a time; a job is an id and a few fields' },
  // The conversion's commit moved into the one writer of a file's derived rows (bundle-89, Q-418), which reads the
  // parent before it writes; the bound did not change — it is still the caller's session, in chunks of the caller's cap.
  { file: 'server/src/files/derived-fields.ts', sites: 1, kind: 'session', reason: 'inside the caller\'s transaction: the session is the bound, in chunks of the caller\'s cap' },
  { file: 'server/src/db/restore.ts', sites: 2, kind: 'own-client', reason: 'an operator restore on its own MongoClient, in 500-row batches, outside every hold' },
  { file: 'server/src/brain/write-plan/commit.ts', sites: 2, kind: 'request-capped', reason: 'one write plan: the items of one request (BULK_MAX_PER_TYPE per array, a 10 MiB body)' },
  { file: 'server/src/brain/read-spill-store.ts', sites: 1, kind: 'request-capped', reason: 'the pages of one spilled answer, which is cut at a stated size before it is stored' },
  { file: 'server/src/sync/linkage-check.ts', sites: 1, kind: 'request-capped', reason: 'one row of about 300 bytes per dangling end of ONE accepted page, a page being counted' },
  { file: 'server/src/brain/merge.ts', sites: 3, kind: 'sliced', reason: 'every edge, file and link of the absorbed entity: a hub\'s count is the store\'s, not a request\'s' },
  { file: 'server/src/files/file-meta.ts', sites: 1, kind: 'sliced', reason: 'every file under a moved directory: the count is the store\'s' },
  { file: 'server/src/files/move-cascade.ts', sites: 1, kind: 'sliced', reason: 'every derived row of a moved file: the count is the store\'s' },
  { file: 'server/src/files/media/job-queue.ts', sites: 1, kind: 'sliced', reason: 'every media job under a moved path: the count is the store\'s' },
  { file: 'server/src/files/tombstones.ts', sites: EVERY, kind: 'sliced', reason: 'one tombstone per path of a deleted or moved directory, one per tombstone a peer delivered that is kept to pass on, one delete per path a newer arriving version supersedes (a peer\'s page: the count is the store\'s)' },
  { file: 'server/src/files/manifest.ts', sites: 1, kind: 'sliced', reason: 'one cache row per file hashed in a round: the count is the store\'s; small rows' },
  { file: 'server/src/metrics/space-activity-store.ts', sites: 2, kind: 'sliced', reason: 'one row per bucket of a space\'s activity: the count is the store\'s; small rows' },
];

const CALL = /\.(?:bulkWrite|insertMany)\s*\(/g;
const sourceOf = (file) => stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const KINDS = new Set(['sliced', 'chunked', 'session', 'own-client', 'request-capped']);

// ── what a `sliced` file is read for, over its syntax tree (not a count of calls, not text) ──────────────────────────
const parsed = (file) => parseSource(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
const walk = (node, visit) => { visit(node); ts.forEachChild(node, (c) => walk(c, visit)); };
const nodes = (root, is) => { const out = []; walk(root, (n) => { if (is(n)) out.push(n); }); return out; };
const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '');
const callsTo = (root, name) => nodes(root, (n) => ts.isCallExpression(n) && calleeName(n) === name);
const bulkCallsIn = (root) => nodes(root, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['bulkWrite', 'insertMany'].includes(n.expression.name.text));
const holds = (outer, inner) => inner.getStart() >= outer.getStart() && inner.end <= outer.end;

/**
 * The code a bulk call may sit in and be sliced: the callback handed to `writeInOneCommands`, or the body of a `for (… of X)`
 * where X is a call of `inOneCommandChunks` or a name it was initialised with. A bulk call anywhere else in the file is
 * unsliced, whatever else the file does.
 */
function slicedScopes(sf) {
  const scopes = callsTo(sf, 'writeInOneCommands').flatMap(c => (c.arguments[1] && ts.isFunctionLike(c.arguments[1]) ? [c.arguments[1]] : []));
  const chunkNames = new Set(nodes(sf, (n) => ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && calleeName(n.initializer) === 'inOneCommandChunks')
    .map(d => d.name.getText(sf)));
  for (const loop of nodes(sf, ts.isForOfStatement)) {
    const e = loop.expression;
    if ((ts.isCallExpression(e) && calleeName(e) === 'inOneCommandChunks') || (ts.isIdentifier(e) && chunkNames.has(e.text))) scopes.push(loop.statement);
  }
  return scopes;
}

/** The bulk operation types (`insertOne`, `updateOne`, …) that appear as keys in `root`. */
const OPERATION_KEYS = ['insertOne', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'];
const operationKeysIn = (root) => new Set(nodes(root, (n) => (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && OPERATION_KEYS.includes(n.name.getText()))
  .map(n => n.name.getText()));

/**
 * The wire commands the operations handed to a `writeInOneCommands` call are sent in, read from the code that builds them:
 * the keys inside the first argument, and — when it is a name — inside what the name is initialised with and what is
 * `push`ed onto it, in the function the call is in; and `insert` when the write callback is an `insertMany`.
 *
 * **`readable` is false when no kind could be read at all** — the operations were built by a helper elsewhere, so this
 * syntax tree does not show what they are. That is not "one kind": a gate that took it for none would pass a mixed bulk
 * the day its builder moved out of the file (round W, V7). Such a call FAILS CLOSED unless it passes `commandKindOf`
 * (which makes the writer read each kind itself).
 */
function commandsOf(call, sf) {
  const first = call.arguments[0];
  const keys = operationKeysIn(first);
  if (ts.isIdentifier(first)) {
    let scope = first.parent;
    while (scope && !ts.isFunctionLike(scope) && scope !== sf) scope = scope.parent;
    for (const d of nodes(scope, (n) => ts.isVariableDeclaration(n) && n.name.getText() === first.text && n.initializer)) operationKeysIn(d.initializer).forEach(k => keys.add(k));
    for (const p of nodes(scope, (n) => ts.isCallExpression(n) && n.expression.getText() === `${first.text}.push`)) p.arguments.forEach(a => operationKeysIn(a).forEach(k => keys.add(k)));
  }
  const commands = new Set([...keys].map(k => bulkCommandOf({ [k]: {} })));
  const write = call.arguments[1];
  if (write && ts.isFunctionLike(write) && callsTo(write, 'insertMany').length > 0) commands.add('insert');
  return { commands, readable: commands.size > 0 };
}

/** The names of the options object (third argument) of a `writeInOneCommands` call. */
const optionNamesOf = (call) => {
  const options = call.arguments[2];
  return options && ts.isObjectLiteralExpression(options) ? options.properties.map(p => p.name?.getText()) : [];
};

/** The options object's `ordered` as written: `true`, `false`, or `undefined` for anything else (a variable, absent). */
const orderedLiteralOf = (call) => {
  const options = call.arguments[2];
  const prop = options && ts.isObjectLiteralExpression(options) ? options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'ordered') : undefined;
  if (!prop) return undefined;
  return prop.initializer.kind === ts.SyntaxKind.TrueKeyword ? true : prop.initializer.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
};

/** Does the write callback hand a `session` to the driver (`{ ordered, session }` or `session: s`)? Then it is inside a transaction. */
const passesASession = (call) => {
  const write = call.arguments[1];
  return !!write && ts.isFunctionLike(write)
    && nodes(write, (n) => (ts.isShorthandPropertyAssignment(n) || ts.isPropertyAssignment(n)) && n.name.getText() === 'session').length > 0;
};

/** The calls of `sf` that break the ledger's two reading rules: unreadable kinds without `commandKindOf`; a session without `ordered: true`. */
function ledgerViolations(sf, where = '') {
  const out = [];
  for (const call of callsTo(sf, 'writeInOneCommands')) {
    const at = `${where}:${lineOf(sf, call)}`;
    const { commands, readable } = commandsOf(call, sf);
    const sliced = optionNamesOf(call).includes('commandKindOf');
    if (!readable && !sliced) out.push(`${at}: the operation kinds cannot be read from this file (built elsewhere?): pass commandKindOf, or build them where they can be read`);
    if (commands.size >= 2 && !sliced) out.push(`${at}: ${[...commands].join(' + ')} in one bulk: pass commandKindOf: bulkCommandOf`);
    if (passesASession(call) && orderedLiteralOf(call) !== true) {
      out.push(`${at}: the bulk is written inside a transaction (it passes a session) and is not ordered: true. A transaction aborts at the first error, so an unordered write keeps sending slices into a dead transaction`);
    }
  }
  return out;
}

describe('every bulk call site in the server is accounted for', () => {
  const found = () => {
    const files = trackedSources(['server/src'], { ext: ['.ts'], floor: 200, specs: false });
    const byFile = new Map();
    for (const f of files) {
      const n = [...sourceOf(f).matchAll(new RegExp(CALL.source, 'g'))].length;
      if (n > 0) byFile.set(f, n);
    }
    return byFile;
  };

  it('the scan finds the sites (a floor: an empty scan accounts for nothing)', () => {
    const byFile = found();
    assert.ok(byFile.size >= 15, `the scan found calls in only ${byFile.size} file(s)`);
    assert.ok([...byFile.values()].reduce((a, b) => a + b, 0) >= 20, 'the scan found fewer than 20 calls');
  });

  it('each file with a bulk call has a row, with the number of calls it holds, and no row is about a file without one', () => {
    const byFile = found();
    const rows = new Map(SITES.map(r => [r.file, r]));
    assert.equal(rows.size, SITES.length, 'a file has two rows');
    const unaccounted = [...byFile].filter(([f]) => !rows.has(f)).map(([f, n]) => `${f} (${n})`);
    assert.deepEqual(unaccounted, [], 'a bulkWrite/insertMany call is in a file with no row: slice it with inOneCommandChunks, or add a row saying why not');
    const wrongCount = SITES.filter(r => byFile.has(r.file) && r.sites !== EVERY && byFile.get(r.file) !== r.sites).map(r => `${r.file}: ${byFile.get(r.file)} call(s), row says ${r.sites}`);
    assert.deepEqual(wrongCount, [], 'a file gained or lost a bulk call its row does not describe');
    const stale = SITES.filter(r => !byFile.has(r.file)).map(r => r.file);
    assert.deepEqual(stale, [], 'a row is about a file with no bulk call');
  });

  it('every row has a kind and a reason', () => {
    for (const r of SITES) {
      assert.ok(KINDS.has(r.kind), `${r.file}: unknown kind ${r.kind}`);
      assert.ok(typeof r.reason === 'string' && r.reason.length >= 20, `${r.file}: no reason`);
      assert.ok(Number.isInteger(r.sites) || (r.sites === EVERY && r.kind === 'sliced'), `${r.file}: \`sites\` is a count, or EVERY on a sliced row (got ${r.sites} on a ${r.kind} row)`);
    }
  });

  for (const r of SITES) {
    if (r.kind === 'sliced') {
      it(`${r.file}: EVERY bulk call sits inside what the slicer hands it (its callback, or the loop over its chunks)`, () => {
        const sf = parsed(r.file);
        const bulks = bulkCallsIn(sf);
        if (r.sites === EVERY) assert.ok(bulks.length >= 1, `${r.file}: the row says every bulk call is sliced, and the tree has none`);
        else assert.equal(bulks.length, r.sites, `${r.file}: ${bulks.length} bulk call(s) in the tree, the row says ${r.sites}`);
        const scopes = slicedScopes(sf);
        assert.ok(scopes.length >= 1, `${r.file} calls neither writeInOneCommands (with a callback) nor loops over inOneCommandChunks`);
        const bare = bulks.filter(b => !scopes.some(sc => holds(sc, b))).map(b => `line ${lineOf(sf, b)}`);
        assert.deepEqual(bare, [], `${r.file}: a bulk call outside the slicer, whatever else the file slices: ${bare.join(', ')}`);
        assert.doesNotMatch(sourceOf(r.file), /\binChunks\([^)]*\b(?:toWrite|store|ops)\b/, `${r.file} slices by count alone again`);
      });
      it(`${r.file}: the bulk call is given the ordered the slicer was given, not a value of its own`, () => {
        const sf = parsed(r.file);
        for (const call of callsTo(sf, 'writeInOneCommands')) {
          const write = call.arguments[1];
          assert.ok(write && ts.isFunctionLike(write) && write.parameters.length >= 2, `line ${lineOf(sf, call)}: the write does not take the slicer's { ordered }`);
          const literal = nodes(write, (n) => ts.isPropertyAssignment(n) && n.name.getText() === 'ordered' && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(n.initializer.kind));
          assert.deepEqual(literal.map(n => lineOf(sf, n)), [], `${r.file}: the write gives the driver its own ordered literal: the slicing and the bulk call can disagree`);
          const forwarded = nodes(write, (n) => ts.isShorthandPropertyAssignment(n) && n.name.text === 'ordered');
          assert.ok(forwarded.length >= 1, `${r.file} line ${lineOf(sf, call)}: the write never passes ordered to the driver`);
        }
      });
    } else if (r.kind === 'chunked') {
      it(`${r.file}: its chunk is the ${r.cap} cap`, () => {
        assert.match(sourceOf(r.file), new RegExp(`\\binChunks\\([^)]*\\b${r.cap}\\b`), `${r.file} no longer chunks by ${r.cap}`);
      });
    } else if (r.kind === 'session') {
      it(`${r.file}: the call carries a session`, () => {
        assert.match(sourceOf(r.file), /(?:insertMany|bulkWrite)\([^;]*\{\s*session\b/, `${r.file}: the bulk call no longer passes a session`);
      });
    } else if (r.kind === 'own-client') {
      it(`${r.file}: writes through a client of its own`, () => {
        const code = sourceOf(r.file);
        assert.match(code, /new MongoClient\(/, `${r.file} no longer opens its own client`);
        assert.doesNotMatch(code, /\bgetDb\(/, `${r.file} reaches the bounded door`);
      });
    }
  }

  it('a writeInOneCommands whose operations are of more than one wire command type says how to slice them apart (commandKindOf); one whose kinds cannot be read says so too', () => {
    const analysed = [];
    const mixed = [];
    const violations = [];
    for (const r of SITES.filter(x => x.kind === 'sliced')) {
      const sf = parsed(r.file);
      for (const call of callsTo(sf, 'writeInOneCommands')) {
        const { commands } = commandsOf(call, sf);
        analysed.push(`${r.file}:${lineOf(sf, call)}`);
        if (commands.size >= 2) mixed.push(`${r.file}:${lineOf(sf, call)}`);
      }
      violations.push(...ledgerViolations(sf, r.file));
    }
    assert.ok(analysed.length >= 10, `only ${analysed.length} writeInOneCommands call(s) analysed`);
    assert.ok(mixed.length >= 1, 'no mixed-type bulk found: the derivation is broken, or the premise it guards is gone');
    assert.deepEqual(violations, [], 'a bulk of several operation types is several commands per slice (the driver batches an unordered bulk by type): pass commandKindOf: bulkCommandOf');
  });

  describe('the ledger\'s reading rules, exercised on source of their own (a rule that cannot be seen refusing is a claim)', () => {
    const violationsOf = (code) => ledgerViolations(parseSource('snippet.ts', code), 'snippet.ts');
    const WRITE = '(slice, { ordered }) => coll.bulkWrite(slice, { ordered })';

    it('operations built in the file are read: a mixed literal without commandKindOf is refused, with it accepted', () => {
      const ops = '[{ insertOne: { document: d } }, { deleteOne: { filter: f } }]';
      assert.match(violationsOf(`await writeInOneCommands(${ops}, ${WRITE}, { ordered: false });`).join('\n'), /insert \+ delete in one bulk/);
      assert.deepEqual(violationsOf(`await writeInOneCommands(${ops}, ${WRITE}, { ordered: false, commandKindOf: bulkCommandOf });`), []);
    });

    it('operations pushed onto a name in the function are read too', () => {
      const code = `function f() { const ops = []; ops.push({ insertOne: {} }); ops.push({ updateOne: {} }); return writeInOneCommands(ops, ${WRITE}, { ordered: false }); }`;
      assert.match(violationsOf(code).join('\n'), /insert \+ update in one bulk/);
    });

    it('operations built by a helper elsewhere FAIL CLOSED: not read as "one kind"', () => {
      const code = `import { buildOps } from './ops.js'; async function f() { await writeInOneCommands(buildOps(rows), ${WRITE}, { ordered: false }); }`;
      assert.match(violationsOf(code).join('\n'), /cannot be read from this file/);
      const named = `import { buildOps } from './ops.js'; async function f() { const ops = buildOps(rows); await writeInOneCommands(ops, ${WRITE}, { ordered: false }); }`;
      assert.match(violationsOf(named).join('\n'), /cannot be read from this file/, 'a name initialised by a call to a helper is not readable either');
    });

    it('an unreadable call that passes commandKindOf is accepted, and so is an insertMany callback (its kind is the call\'s)', () => {
      assert.deepEqual(violationsOf(`await writeInOneCommands(buildOps(rows), ${WRITE}, { ordered: false, commandKindOf: bulkCommandOf });`), []);
      assert.deepEqual(violationsOf('await writeInOneCommands(rows.map(toDoc), (slice, { ordered }) => coll.insertMany(slice, { ordered }), { ordered: true });'), []);
    });

    it('a bulk that passes a session must be ordered: true — unordered, absent or a variable is refused', () => {
      const withSession = (opts) => `await writeInOneCommands([{ insertOne: {} }], (slice, { ordered }) => coll.bulkWrite(slice, { ordered, session }), ${opts});`;
      assert.deepEqual(violationsOf(withSession('{ ordered: true }')), []);
      for (const opts of ['{ ordered: false }', '{ ordered: unordered }']) assert.match(violationsOf(withSession(opts)).join('\n'), /inside a transaction/, opts);
      // `session: s` spelled as a property, not shorthand, is the same thing.
      assert.match(violationsOf('await writeInOneCommands([{ insertOne: {} }], (slice, { ordered }) => coll.bulkWrite(slice, { ordered, session: s }), { ordered: false });').join('\n'), /inside a transaction/);
    });

    it('a bulk with no session may be unordered', () => {
      assert.deepEqual(violationsOf(`await writeInOneCommands([{ insertOne: {} }], ${WRITE}, { ordered: false });`), []);
    });
  });

  it('the premise `request-capped` rests on: a request body is at most 10 MiB, a bulk save at most BULK_MAX_PER_TYPE per array', () => {
    const app = sourceOf('server/src/app.ts');
    const limits = [...app.matchAll(/express\.json\(\s*\{\s*limit:\s*'(\d+)mb'/g)].map(m => Number(m[1]));
    assert.ok(limits.length >= 1, 'app.ts no longer sets a JSON body limit the analysis rests on');
    for (const l of limits) assert.ok(l <= 10, `the JSON body limit is ${l} MiB; the analysis in db/write-bound.ts rests on 10 MiB at most`);
    assert.ok(BULK_MAX_PER_TYPE <= 500, `a bulk save takes ${BULK_MAX_PER_TYPE} items per array`);
    assert.ok(ROWS_PER_BULK_COMMAND <= 1000 && READ_CHUNK <= 500, 'a chunk of rows grew past what the analysis assumes');
  });
});
