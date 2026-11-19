/**
 * A bounded transaction's `StoreTimeout`, thrown after at least one transient retry, always carries the failure that made it retry
 * as its `cause` (Q-839: `db/bounded-transaction.ts`, `inBoundedTransaction`).
 *
 * ## The defect
 *
 * `inBoundedTransaction` retries a `TransientTransactionError` (a write conflict) until the write bound ends it, and then answers
 * `StoreTimeout` with the driver's error as the cause. It kept that cause only when the deadline fell before the backoff pause.
 * When the deadline had already passed at the start of the next attempt (`attempt()`'s early-deadline throw), or the bound ended
 * the attempt itself (a cause-less `StoreTimeout` from inside it), the timeout was thrown with no cause. Which one happened
 * depended on where the deadline landed, so `a-write-conflict-in-a-held-transaction-answers-the-store-503-on-both-doors-db.test.js`
 * ("the driver's error is not kept as the cause") passed or failed by timing on main after PR #1619.
 *
 * ## The rule this file holds
 *
 * **Every `StoreTimeout` `inBoundedTransaction` throws after a transient retry carries the last transient failure as `cause`** — and
 * nothing else changes: a timeout with no retry before it has no cause to invent, and a timeout that already has its own cause keeps it.
 *
 * ## No timing race
 *
 * The first rows drive the loop with a callback that fails transiently on its first call and ends on its second with the cause-less
 * `StoreTimeout` the bound ending mid-attempt throws (`commitWithin`'s race, the write-bound scope). The bound is generous, so the
 * second attempt is always reached; nothing waits on a deadline.
 *
 * The server's end at the deadline (bundle-310): an attempt begun with a few ms left sends them as `maxTimeMS`, and the server answers
 * MaxTimeMSExpired, which escaped as the raw driver error. Those rows wait past the short bound inside the callback before throwing the
 * server's error, so the deadline has passed whatever the machine's speed; their control throws it well inside a generous bound.
 *
 * The server's end BEFORE our clock reads the deadline (bundle-354, Q-935): the server counts a statement's `maxTimeMS` on its own
 * clock, so its end of a statement sent with the deadline's remainder can be back while ours still reads a few ms short. Those rows
 * send the read that opens an attempt to the real store and answer it with the server's error a fixed time before the deadline,
 * so our clock reads before it on every machine; their control ends a read that carried its own, shorter, per-operation limit.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-transaction-timeout-after-a-retry-keeps-the-failure-as-its-cause-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoServerError } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { setWriteBoundForTest } from './_write-faults.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-txn-timeout-cause-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

/** Generous: the rows that must reach a second attempt never come near it. */
const GENEROUS_BOUND = { writeTimeoutMs: 20_000, holdDeadlineMs: 20_000 };
/** Short, at the floor `a-test-bounds-only-the-operation-it-holds` sets: the row that retries until the bound ends it. */
const SHORT_BOUND = { writeTimeoutMs: 1000, holdDeadlineMs: 1000 };

/** A write conflict as the driver delivers it: a server error carrying the transient label that makes the loop retry. */
function transientFailure(tag) {
  const err = new MongoServerError({ message: `write conflict (${tag})`, code: 112, codeName: 'WriteConflict' });
  err.addErrorLabel('TransientTransactionError');
  return err;
}

let inBoundedTransaction, StoreTimeout, restoreBound = () => {};

/** Run `fn` through the bounded transaction; the error it threw, or a failure saying it threw none. */
async function thrownBy(fn) {
  try {
    await inBoundedTransaction(fn);
  } catch (err) {
    return err;
  }
  assert.fail('the transaction ended without an error');
}

describe('a transaction timeout after a retry keeps the failure that made it retry as its cause', { skip }, () => {
  before(async () => {
    await openTestMongo('txntimeoutcause');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'txn-timeout-cause-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: 'txntimeoutcause', label: 'Transaction timeout cause', folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ inBoundedTransaction } = await import('../../server/dist/db/bounded-transaction.js'));
    ({ StoreTimeout } = await import('../../server/dist/db/write-timeout.js'));
    assert.equal(typeof inBoundedTransaction, 'function', 'fixture: bounded-transaction.js exports no inBoundedTransaction');
  });
  after(async () => {
    restoreBound();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a cause-less timeout ending the second attempt carries the first attempt\'s transient failure', async () => {
    restoreBound = await setWriteBoundForTest(GENEROUS_BOUND);
    const first = transientFailure('first');
    let calls = 0;
    const err = await thrownBy(async () => {
      calls += 1;
      if (calls === 1) throw first;
      throw new StoreTimeout('x');
    });
    assert.equal(calls, 2, 'fixture: the callback did not run a second time, so the retry was never reached');
    assert.ok(err instanceof StoreTimeout, `it threw ${err?.name}: ${err?.message}, not a StoreTimeout`);
    assert.equal(err.cause, first, 'the StoreTimeout thrown after a retry does not carry the transient failure that made it retry as its cause');
  });

  it('the cause is the LAST transient failure when the transaction retried more than once', async () => {
    restoreBound = await setWriteBoundForTest(GENEROUS_BOUND);
    const failures = [transientFailure('one'), transientFailure('two')];
    let calls = 0;
    const err = await thrownBy(async () => {
      calls += 1;
      if (calls <= failures.length) throw failures[calls - 1];
      throw new StoreTimeout('x');
    });
    assert.equal(calls, 3, 'fixture: the callback did not run three times');
    assert.ok(err instanceof StoreTimeout, `it threw ${err?.name}: ${err?.message}, not a StoreTimeout`);
    assert.equal(err.cause, failures[1], 'the cause is not the failure of the last retried attempt');
  });

  it('a timeout that already has its own cause keeps it', async () => {
    restoreBound = await setWriteBoundForTest(GENEROUS_BOUND);
    const own = new Error('the server\'s own deadline error');
    const timeout = new StoreTimeout('x', { cause: own });
    let calls = 0;
    const err = await thrownBy(async () => {
      calls += 1;
      if (calls === 1) throw transientFailure('first');
      throw timeout;
    });
    assert.equal(err, timeout, 'a StoreTimeout that carried a cause was replaced');
    assert.equal(err.cause, own, 'a StoreTimeout\'s own cause was overwritten by the transient failure');
  });

  it('control: a timeout with no retry before it is thrown as it came, with no cause invented', async () => {
    restoreBound = await setWriteBoundForTest(GENEROUS_BOUND);
    const timeout = new StoreTimeout('x');
    const err = await thrownBy(async () => { throw timeout; });
    assert.equal(err, timeout, 'a timeout from the first attempt was replaced');
    assert.equal(err.cause, undefined, 'a cause was invented for a timeout nothing had failed before');
  });

  it('control: a callback that fails transiently every time is ended by the bound with a StoreTimeout that carries the transient failure', async () => {
    restoreBound = await setWriteBoundForTest(SHORT_BOUND);
    const failures = [];
    const err = await thrownBy(async () => {
      const failure = transientFailure(`try ${failures.length + 1}`);
      failures.push(failure);
      throw failure;
    });
    assert.ok(failures.length >= 1, 'fixture: the callback never ran');
    assert.ok(err instanceof StoreTimeout, `it threw ${err?.name}: ${err?.message}, not a StoreTimeout`);
    assert.ok(failures.includes(err.cause), 'the StoreTimeout the bound ended the retrying with does not carry one of the transient failures as its cause');
  });

  // The server's own end of a statement at the transaction's deadline: a later attempt that starts with a few ms left sends its
  // statements with that few ms as `maxTimeMS`, and the server answers MaxTimeMSExpired. That is the bound ending the transaction,
  // so it is answered as the bound's StoreTimeout, never as the raw driver error (bundle-310's Full run, run 44104649536, shard 3).
  it('the server ending a later attempt at the deadline is answered StoreTimeout, carrying the transient failure that made it retry', async () => {
    restoreBound = await setWriteBoundForTest(SHORT_BOUND);
    const first = transientFailure('first');
    let calls = 0;
    const err = await thrownBy(async () => {
      calls += 1;
      if (calls === 1) throw first;
      await elapse(SHORT_BOUND.writeTimeoutMs + 100, 'ttl elapses: the transaction\'s deadline passes before the server answers');
      throw serverDeadlineFailure();
    });
    assert.equal(calls, 2, 'fixture: the callback did not run a second time, so the retry was never reached');
    assert.ok(err instanceof StoreTimeout, `it threw ${err?.name}: ${err?.message}, not a StoreTimeout`);
    assert.equal(err.cause, first, 'the StoreTimeout does not carry the transient failure that made the transaction retry');
  });

  it('the server ending the only attempt at the deadline is answered StoreTimeout, carrying the server\'s error', async () => {
    restoreBound = await setWriteBoundForTest(SHORT_BOUND);
    const ended = serverDeadlineFailure();
    const err = await thrownBy(async () => {
      await elapse(SHORT_BOUND.writeTimeoutMs + 100, 'ttl elapses: the transaction\'s deadline passes before the server answers');
      throw ended;
    });
    assert.ok(err instanceof StoreTimeout, `it threw ${err?.name}: ${err?.message}, not a StoreTimeout`);
    assert.equal(err.cause, ended, 'the StoreTimeout does not carry the server\'s own error as its cause');
  });

  it('control: a server time limit that ends a statement BEFORE the transaction\'s deadline is thrown as it came', async () => {
    restoreBound = await setWriteBoundForTest(GENEROUS_BOUND);
    const ended = serverDeadlineFailure();
    const err = await thrownBy(async () => { throw ended; });
    assert.equal(err, ended, 'a statement\'s own time limit, inside the transaction\'s bound, was re-dressed as the bound\'s StoreTimeout');
  });

  // Q-935 (bundle-354): the read that opens a later attempt is sent with the deadline's remainder as its `maxTimeMS`; the server
  // counts that on its own clock from when the read arrives, and its MaxTimeMSExpired was back while OUR clock still read a few ms
  // before the deadline, so the clock comparison said "not the bound's" and the raw driver error escaped (the sighting: the
  // control above at line 139, one run of a loaded day, 991 ms into a 1 000 ms bound). The read here is real; only its answer is
  // the server's end of it, given `EARLY_MS` before its limit runs out by our clock.
  it('the server ending the opening read of a later attempt by the deadline\'s remainder, before our clock reads the deadline, is answered StoreTimeout', async () => {
    restoreBound = await setWriteBoundForTest(SHORT_BOUND);
    const fault = await endTheOpeningReadEarly({ fromCall: 2 });
    const first = transientFailure('first');
    let calls = 0;
    let err;
    try {
      err = await thrownBy(async () => {
        calls += 1;
        if (calls === 1) throw first;
        assert.fail('fixture: the second attempt\'s opening read answered, so the callback ran again');
      });
    } finally {
      fault.restore();
    }
    assert.equal(calls, 1, 'fixture: the callback did not run exactly once before the second attempt');
    assert.equal(fault.ended.length, 1, 'fixture: the second attempt\'s opening read was never ended');
    assert.ok(fault.ended[0].maxTimeMS <= SHORT_BOUND.holdDeadlineMs,
      `fixture: the opening read carried ${fault.ended[0].maxTimeMS} ms, more than the deadline's remainder`);
    assert.ok(fault.ended[0].clockBeforeDeadline, 'fixture: the server\'s end was not given before our clock read the deadline');
    assert.ok(err instanceof StoreTimeout, `it threw ${err?.name}: ${err?.message}, not a StoreTimeout`);
    assert.equal(err.cause, first, 'the StoreTimeout does not carry the transient failure that made the transaction retry');
  });

  it('the server ending the opening read of the only attempt by the deadline\'s remainder, before our clock reads the deadline, is answered StoreTimeout', async () => {
    restoreBound = await setWriteBoundForTest(SHORT_BOUND);
    const fault = await endTheOpeningReadEarly({ fromCall: 1 });
    let err;
    try {
      err = await thrownBy(async () => assert.fail('fixture: the opening read answered, so the callback ran'));
    } finally {
      fault.restore();
    }
    assert.equal(fault.ended.length, 1, 'fixture: the opening read was never ended');
    assert.ok(err instanceof StoreTimeout, `it threw ${err?.name}: ${err?.message}, not a StoreTimeout`);
    assert.equal(err.cause, fault.ended[0].error, 'the StoreTimeout does not carry the server\'s own error as its cause');
  });

  it('control: the opening read ended by its OWN per-operation limit, shorter than the deadline\'s remainder, is thrown as it came', async () => {
    // Each operation 1 s, the transaction 20 s: the opening read carries its own 1 s, not the remainder.
    restoreBound = await setWriteBoundForTest({ writeTimeoutMs: SHORT_BOUND.writeTimeoutMs, holdDeadlineMs: GENEROUS_BOUND.holdDeadlineMs });
    const fault = await endTheOpeningReadEarly({ fromCall: 1 });
    let err;
    try {
      err = await thrownBy(async () => assert.fail('fixture: the opening read answered, so the callback ran'));
    } finally {
      fault.restore();
    }
    assert.equal(fault.ended.length, 1, 'fixture: the opening read was never ended');
    assert.equal(fault.ended[0].maxTimeMS, SHORT_BOUND.writeTimeoutMs, 'fixture: the opening read did not carry its own per-operation limit');
    assert.equal(err, fault.ended[0].error, 'a statement\'s own time limit, shorter than the transaction\'s bound, was re-dressed as the bound\'s StoreTimeout');
  });
});

/** How long before its limit runs out by OUR clock the server's end of the opening read is given: a server clock that runs ahead. */
const EARLY_MS = 100;

/**
 * From the `fromCall`-th call on, the read that opens a bounded transaction (`openOnTheServer`: `findOne` of
 * `__transaction_opens__` in `transaction_seal`) is sent to the real store, and then answered with the server's MaxTimeMSExpired
 * `EARLY_MS` before its limit — the `maxTimeMS` it was sent with, or the transaction's deadline when that comes first — has run
 * out by this process's clock. `ended` records each ended read: the limit it carried, the error, and whether our clock still read
 * before the transaction's deadline when the error was thrown. The built error is the one `loseNextCommitReply`
 * (`_write-faults.mjs`) builds, for the same reason: the store cannot be made to end a statement early on demand (no fail points on
 * the test store).
 */
async function endTheOpeningReadEarly({ fromCall }) {
  const mongo = await import('../../server/dist/db/mongo.js');
  // Read inside the read's own call: the transaction's bound scope is the active one there.
  const { boundTimeLeft } = await import('../../server/dist/db/write-bound.js');
  const proto = Object.getPrototypeOf(mongo.getMongo().db('probe').collection('probe'));
  const original = proto.findOne;
  const ended = [];
  let calls = 0;
  proto.findOne = async function endedEarly(filter, options, ...rest) {
    if (this.collectionName !== 'transaction_seal' || filter?._id !== '__transaction_opens__') return original.call(this, filter, options, ...rest);
    calls += 1;
    const sentAt = Date.now();
    const deadline = sentAt + boundTimeLeft();
    const answer = await original.call(this, filter, options, ...rest);
    if (calls < fromCall) return answer;
    const limitEnds = Math.min(sentAt + options.maxTimeMS, deadline);
    await elapse(Math.max(0, limitEnds - EARLY_MS - Date.now()), 'simulated latency: the server runs the read until its own clock, ahead of ours, reads its limit');
    const error = serverDeadlineFailure();
    ended.push({ maxTimeMS: options.maxTimeMS, error, clockBeforeDeadline: boundTimeLeft() > 0 });
    throw error;
  };
  return { ended, restore: () => { proto.findOne = original; } };
}

/** The server's answer to a statement whose `maxTimeMS` ran out, as the driver delivers it: no transient label, so no retry. */
function serverDeadlineFailure() {
  return new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
}
