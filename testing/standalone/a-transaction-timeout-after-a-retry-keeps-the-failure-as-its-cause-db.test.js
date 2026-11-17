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
});

/** The server's answer to a statement whose `maxTimeMS` ran out, as the driver delivers it: no transient label, so no retry. */
function serverDeadlineFailure() {
  return new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
}
