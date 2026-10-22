/**
 * A transaction is ended by the write bound, holds no seq horizon of its own, and ends its session — whoever starts it
 * (bundle-44 plan rev 3, D2: `db/bounded-transaction.ts`, `inBoundedTransaction`).
 *
 * ## The defect
 *
 * Two places started a MongoDB session by hand, and a third was about to. `brain/held-transaction.ts` did it correctly,
 * under a seq hold, with a bound (bundle-30, `Q-213`). `files/media/lease.ts` `writeUnderClaim` did it with NO bound
 * (`getMongo().startSession()`, then `withTransaction`): a document lock held elsewhere (the job row being fenced, a
 * record the writes touch) makes `withTransaction` retry the write conflict for the driver's default 120 s, and the
 * media worker, the move and every other caller of the fence waits that long. The bound, the read-back of a commit
 * whose reply was lost, the `endSession` in a `finally` and the one-batch read are the forgettable half of a
 * transaction, and each hand-written start dropped a different one of them.
 *
 * ## The rule this file holds
 *
 * **A transaction started through `inBoundedTransaction` (`db/bounded-transaction.ts`) —**
 *
 *  - **holds NO seq horizon.** The bound and the horizon are two questions. `inHeldTransaction` is the horizon hold put
 *    around it (`withSeqHorizonHeld(() => inBoundedTransaction(…))`); a transaction that writes no seq-carrying
 *    document (the lease fence) must not stall every seq-paged reader of a space for as long as it runs;
 *  - **is ended by the write bound** when a document lock is held elsewhere — within the bound, never after the
 *    driver's 120 s — and nothing it wrote lands;
 *  - **answers a lost commit reply as landed** when `landed` says so, and as the error it came as when it does not;
 *  - **ends its session even when the callback throws**;
 *  - **reads past one batch** inside the transaction (`db/write-bound.ts` asks a timed transaction's cursor for all of
 *    its rows in the first batch, the driver refusing `maxTimeMS` on a `getMore` otherwise).
 *
 * **and `writeUnderClaim` (`files/media/lease.ts`) is such a transaction**: the same bound rows, asked of it. A lock
 * held on its job row ends it within the write bound, and what it would have written does not land.
 *
 * ## Which rows are red today, and why
 *
 * The `inBoundedTransaction` rows fail on the module that does not exist yet (`server/dist/db/bounded-transaction.js`):
 * each reports that, so the design's D2 is the reason, not a typo in a fixture. The `writeUnderClaim` rows that ask for
 * the bound fail on UNCHANGED code for the reason the plan gives (F12): the call waits for the lock for as long as the
 * lock lives. The rows marked "control" pass today and must keep passing — they are what shows the red ones are red
 * for the bound and not for the fixture.
 *
 * ## Q-530: a bound-ended transaction leaves nothing to land and nothing held (design rev 4.3, step 7)
 *
 * The server's client goes through `_delayed-write-relay.mjs` (delivering what a closed client already sent), which holds the
 * one command a row names: the first statement of a fenced write, its commit, a seal, a kill. A driver that gives up does not
 * unsend a command already on the wire; it reaches the server late and opens (or commits) a transaction no caller owns, which
 * holds the job row (CI's failure). The design's answer is the SEAL — a retryable no-op write on the same session at a higher
 * txnNumber, which aborts transaction N and refuses anything of N after it — then a kill and a second seal when the first fails,
 * the session marked dirty, and one report line when no seal sent after the last kill answered. Every row waits on a latch
 * (a held message, the server's reply to it, the call's own answer), never on a sleep. At the base no seal, kill or dirty
 * mark exists, so rows (i), (ii)/(vii), (iv), (v), (vi) and (viii) are red for that; (iii) is green at the base and guards the
 * seal from running on an ordinary refusal. `SEAL_MS` is read from the module.
 *
 * ## The stall is REAL (`_write-faults.mjs`)
 *
 * `holdDocumentLock` leaves another session's transaction open on a document; a write inside a transaction then fails
 * with `WriteConflict` and is retried by `withTransaction` for as long as ITS budget lasts — the only stall a driver
 * bound can end (a parked promise never reaches the driver).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-bounded-transaction-ends-and-holds-no-horizon-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, openFixtureMongo, mongoSkipReason, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { holdDocumentLock, settleWithin, setWriteBoundForTest, loseNextCommitReply } from './_write-faults.mjs';
import { startDelayedWriteRelay, lsidHex } from './_delayed-write-relay.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bounded-txn-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const S = 'boundedtxn';
const FACTS = `${S}_facts`;
const JOBS = `${S}_media_jobs`;
/** The write bound a stalled case waits out, and how long past it a bounded call may take to be reported ended (generous: the rule is 2 s against the driver's 120 s). */
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };
const SLACK_MS = 3000;
/** A fenced write's bound: `lease.ts` `LEASED_WRITE_BOUND_FACTOR` (2, not exported) times the write bound. */
const LEASED_BOUND_MS = 2 * BOUND.writeTimeoutMs;
/** The landed read-back's own fresh bound (`withinWriteBound` in `bounded-transaction.ts`): the write bound. */
const READ_BACK_MS = BOUND.writeTimeoutMs;
/**
 * How long a bound-ended call may take to answer: its leased bound, then on the store-not-answering exit at most seal + kill +
 * seal (rev 4.3: 2 x SEAL_MS + KILL_WAIT_MS), then the read-back, then slack. Set in `before`, where the two figures the
 * server owns can be read from it.
 */
let SEAL_MS, KILL_WAIT_MS, CAP_MS;
/** A write from another session to a job row: a free row answers in milliseconds; a row an open transaction holds is refused at this. */
const JOB_ROW_PROBE_MS = 500;
/** Sessions taken from the pool to see whether the orphan's lsid is among them (probe 6 c: the LIFO pool hands it to the first). */
const POOL_PROBE_SESSIONS = 20;
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify', 'findandmodify']);
/** Comfortably past the default first batch (101), far below 16 MB. */
const ROWS = 1_200;
const JOB = 'job-1';
const CLAIM = { jobId: JOB, claimToken: 'token-1' };

let mongo, seq, writeBound, lease, held, storeCondition, logLines;
/** The relay the server's client goes through (passing everything until a row holds something), and a client that does not. */
let relay, fixture;
/** The module the design creates — loaded in `before`, so a missing one fails EACH row with its own message. */
let bounded = null;
let boundedError = null;

/** The entry point, or a failure that says why every `inBoundedTransaction` row is red. */
function inBounded() {
  if (bounded) return bounded.inBoundedTransaction;
  throw new Error('server/dist/db/bounded-transaction.js exports no inBoundedTransaction — the bounded transaction (plan rev 3, D2) '
    + `does not exist yet (${boundedError?.message ?? 'no export'}), so nothing can be asked of it`);
}

const facts = () => mongo.col(FACTS);

// ── Q-530 fixtures: a transaction the bound ended with a statement still on the wire ─────────────────────────────

const commandName = (c) => Object.keys(c)[0];
/**
 * A SEAL of transaction `n` on session `orphan`, by what it is rather than where it writes: a write on that session, outside a
 * transaction (no `autocommit`), carrying a txnNumber above `n` (the driver bumps it for a retryable write). The design leaves
 * the seal's collection to the implementation; this matches whichever it picks.
 */
const isSealOf = (orphan, n) => (c) => lsidHex(c.lsid) === orphan && WRITE_COMMANDS.has(commandName(c))
  && c.autocommit === undefined && c.txnNumber !== undefined && Number(c.txnNumber) > n;
/** Any write on session `orphan` outside a transaction — a seal, with or without a txnNumber. */
const isWriteOutsideTransactionOf = (orphan) => (c) => lsidHex(c.lsid) === orphan && WRITE_COMMANDS.has(commandName(c)) && c.autocommit === undefined;
/** A `killSessions` naming session `orphan`. */
const isKillOf = (orphan) => (c) => Array.isArray(c.killSessions) && c.killSessions.some((s) => lsidHex(s) === orphan);
const replyText = (r) => (r === undefined ? 'no reply' : r.ok === 1 ? 'ok' : `${r.code} ${r.codeName}`);
const settled = (p) => p.then((value) => ({ value }), (error) => ({ error }));
/** WARN / ERROR lines of the server's log that say `pattern`. */
const reportLines = (lines, pattern) => lines.filter((l) => /\b(WARN|ERROR)\b/.test(l) && pattern.test(l));

async function seedJob(jobId) {
  await fixture.col(JOBS).insertOne({ _id: jobId, spaceId: S, status: 'processing', claimToken: CLAIM.claimToken, fencedWrites: 0 });
}

/**
 * A fenced write (`writeUnderClaim`) whose FIRST statement — the fence's update of the job row, which starts transaction `n`
 * — the relay holds, so the leased bound ends the call with that statement still undelivered: Q-530's CI failure, on demand.
 * `arm(orphan, n)` runs as soon as the statement is held (long before the bound ends), for what a row holds or records next.
 * Returns while the call is still running: `call` settles to `{ value }` / `{ error }`; `stopLog()` ends `lines`.
 */
async function boundEndedFencedWrite(jobId, arm = () => {}) {
  await seedJob(jobId);
  const fence = relay.hold((c) => c.update === JOBS && c.startTransaction === true && c.updates?.[0]?.q?._id === jobId);
  const lines = [];
  const stopLog = logLines.subscribeLogLines((l) => lines.push(l));
  const call = settled(lease.writeUnderClaim(S, { jobId, claimToken: CLAIM.claimToken }, async () => 'wrote'));
  const statement = await Promise.race([fence.first, call.then(() => null)]);
  fence.disarm();
  if (statement === null) {
    stopLog();
    throw new Error(`fixture: the fenced write on ${jobId} answered before its first statement reached the relay (${(await call).error?.message ?? 'ok'})`);
  }
  const orphan = lsidHex(statement.command.lsid);
  const n = Number(statement.command.txnNumber);
  arm(orphan, n);
  return { call, statement, orphan, n, lines, stopLog };
}

/** Every transaction the server holds open for session `orphan` (`$currentOp`, idle sessions included), as text. */
async function transactionsOf(orphan) {
  const ops = await fixture.getMongo().db('admin').aggregate([{ $currentOp: { allUsers: true, idleSessions: true } }]).toArray();
  return ops.filter((o) => o.transaction && lsidHex(o.lsid) === orphan)
    .map((o) => `${o.type}${o.active ? '/active' : ''} txn=${o.transaction.parameters?.txnNumber}`);
}

/** Whether another session can write the job row now: `'free'`, or what refused it within JOB_ROW_PROBE_MS. */
async function jobRowAnswer(jobId) {
  try {
    await fixture.col(JOBS).updateOne({ _id: jobId }, { $set: { probedAt: Date.now() } }, { maxTimeMS: JOB_ROW_PROBE_MS });
    return 'free';
  } catch (err) {
    return `held (${err.codeName ?? err.message})`;
  }
}

/** A `commitTransaction` of transaction `n` on the session whose lsid is `lsid`, as a late commit would arrive (probe 6's shape). */
async function commitAs(lsid, n) {
  const s = fixture.getMongo().startSession();
  s.serverSession.id = { id: lsid.id };
  s.serverSession.txnNumber = n;
  try {
    await fixture.getMongo().db('admin').command({ commitTransaction: 1, autocommit: false }, { session: s });
    return { ok: 1 };
  } catch (err) {
    return { code: err.code, codeName: err.codeName };
  } finally {
    s.serverSession.isDirty = true;
    await s.endSession();
  }
}

/**
 * Leave nothing of a Q-530 row behind for the next: release every held message, wait for the server's answer to each (so a late
 * statement has run), then kill the orphan's session, which ends any transaction it left open (probe 6 b2).
 */
async function freeOrphan(run) {
  run?.stopLog?.();
  const released = relay.releaseAll();
  await Promise.all(released.map((m) => m.reply));
  if (run?.statement) await fixture.getMongo().db('admin').command({ killSessions: [{ id: run.statement.command.lsid.id }] }).catch(() => {});
}

describe('a bounded transaction ends, holds no horizon, and ends its session', { skip }, () => {
  let restoreBound = () => {};

  before(async () => {
    // Every row's server client goes through the relay; it passes everything until a Q-530 row holds a command. A client's
    // close DELIVERS what it already sent: a driver that gives up destroys its socket, and the late statement is the case.
    relay = await startDelayedWriteRelay({ host: TEST_MONGO_HOST, port: TEST_MONGO_PORT, deliverAfterClientCloses: true });
    mongo = await openTestMongo('boundedtxn', { port: relay.port });
    fixture = await openFixtureMongo('boundedtxn');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'bounded-txn-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Bounded transaction', folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    seq = await import('../../server/dist/util/seq.js');
    writeBound = await import('../../server/dist/db/write-bound.js');
    lease = await import('../../server/dist/files/media/lease.js');
    held = await import('../../server/dist/brain/held-transaction.js');
    try {
      bounded = await import('../../server/dist/db/bounded-transaction.js');
      if (typeof bounded.inBoundedTransaction !== 'function') { boundedError = new Error('the module has no inBoundedTransaction export'); bounded = null; }
    } catch (err) { boundedError = err; }
    storeCondition = await import('../../server/dist/db/store-condition.js');
    logLines = await import('../../server/dist/util/log.js');
    SEAL_MS = bounded?.SEAL_MS;
    assert.equal(typeof SEAL_MS, 'number', 'fixture: bounded-transaction.js exports no SEAL_MS (the seal\'s own bound), so the cap cannot be sized');
    KILL_WAIT_MS = writeBound.KILL_WAIT_MS;
    assert.equal(typeof KILL_WAIT_MS, 'number', 'fixture: write-bound.js exports no KILL_WAIT_MS, so the cap cannot be sized');
    CAP_MS = LEASED_BOUND_MS + 2 * SEAL_MS + KILL_WAIT_MS + READ_BACK_MS + SLACK_MS;
    restoreBound = await setWriteBoundForTest(BOUND);
    await facts().insertMany(Array.from({ length: ROWS }, (_, i) => ({
      _id: `f-${String(i).padStart(5, '0')}`, spaceId: S, fact: `fact ${i}`, seq: i + 1,
    })));
    await mongo.col(JOBS).insertOne({ _id: JOB, spaceId: S, status: 'processing', claimToken: CLAIM.claimToken, fencedWrites: 0 });
  });
  after(async () => {
    restoreBound();
    relay?.releaseAll();
    await closeTestMongo();
    await fixture?.close();
    await relay?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── inBoundedTransaction: no horizon ───────────────────────────────────────────────────────────────────────

  it('control: inHeldTransaction DOES hold the space\'s seq horizon while it runs (what the test below is the opposite of)', async () => {
    const inside = await held.inHeldTransaction(S, 'test.bounded-txn.control', async () => seq.lowestUncommittedSeq(S));
    assert.notEqual(inside, undefined, 'fixture: inHeldTransaction held no horizon, so "holds none" below proves nothing');
  });

  it('holds NO seq horizon: no space\'s seq-paged reader is stalled while it runs', async () => {
    const inside = await inBounded()(async (session) => {
      await facts().findOne({ _id: 'f-00000' }, { session });
      return seq.lowestUncommittedSeq(S);
    });
    assert.equal(inside, undefined,
      `a bounded transaction registered a seq hold at ${inside} on '${S}': every seq-paged reader of the space (the pull routes, `
      + 'the push loop, the tombstone pages) would be served nothing above it for as long as the transaction lives');
  });

  it('holds no horizon while it is STALLED on a lock either, and is still ended by the bound', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00001' } });
    let entered = false;
    let horizonWhileStalled = 'not read';
    let res;
    try {
      const op = Promise.resolve().then(() => run(async (session) => {
        entered = true;
        await facts().updateOne({ _id: 'f-00001' }, { $set: { stalledEdit: true } }, { session });
      }));
      // the callback has started (it will stall on the lock); the assertion after the finally reports it if it never did
      await waitFor(() => entered, 5000, 10).catch(() => {});
      horizonWhileStalled = seq.lowestUncommittedSeq(S);
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(entered, 'fixture: the transaction never started its callback');
    assert.equal(horizonWhileStalled, undefined, `the stalled transaction held the horizon of '${S}' at ${horizonWhileStalled}`);
  });

  // ── inBoundedTransaction: the bound ────────────────────────────────────────────────────────────────────────

  it('a document lock held elsewhere ends it within the write bound, and what it wrote does not land', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00002' } });
    let res;
    try {
      const op = Promise.resolve().then(() => run(
        async (session) => facts().updateOne({ _id: 'f-00002' }, { $set: { boundedEdit: true } }, { session })));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled,
      `the transaction was still waiting ${res.elapsedMs} ms after it began against a ${BOUND.writeTimeoutMs} ms write bound: `
      + 'withTransaction kept retrying the write conflict, so a document lock held elsewhere stalls its caller for the driver\'s 120 s');
    assert.equal(res.ok, false, 'a transaction the bound ended was answered as a success');
    assert.equal((await facts().findOne({ _id: 'f-00002' }))?.boundedEdit, undefined, 'a transaction the bound ended landed its write');
  });

  it('inside an enclosing bound scope it ends at that scope\'s deadline, not at the per-operation figure', { timeout: 30_000 }, async () => {
    // The scope's deadline is the shorter of the two: the transaction takes its budget from the ACTIVE bound, as a
    // hold's transaction always did, and not from a figure of its own.
    const run = inBounded();
    const restore = await setWriteBoundForTest({ writeTimeoutMs: 10_000, holdDeadlineMs: BOUND.holdDeadlineMs });
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00003' } });
    let res;
    try {
      const op = Promise.resolve().then(() => writeBound.withinWriteBound(() => run(
        async (session) => facts().updateOne({ _id: 'f-00003' }, { $set: { boundedEdit: true } }, { session }))));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
      restore();
      restoreBound = await setWriteBoundForTest(BOUND);
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled && res.ok === false,
      `inside a ${BOUND.holdDeadlineMs} ms hold deadline the transaction ${res.settled ? 'was answered as a success' : `was still waiting ${res.elapsedMs} ms later`}`);
  });

  // ── inBoundedTransaction: the commit whose reply is lost ───────────────────────────────────────────────────

  it('a commit that landed and was reported failed is answered as landed when `landed` says so', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lost = await loseNextCommitReply(mongo);
    const asked = [];
    let outcome;
    try {
      outcome = await Promise.resolve().then(() => run(
        async (session) => { await facts().updateOne({ _id: 'f-00004' }, { $set: { landedEdit: 'yes' } }, { session }); return 'the value'; },
        { landed: async (value) => { asked.push(value); return (await facts().findOne({ _id: 'f-00004' }))?.landedEdit === 'yes'; } },
      )).then(value => ({ value }), error => ({ error }));
    } finally {
      lost.restore();
    }
    assert.ok(lost.fired(), 'fixture: no commit was made, so no reply was lost');
    assert.equal((await facts().findOne({ _id: 'f-00004' }))?.landedEdit, 'yes', 'fixture: the commit did not land');
    assert.equal(outcome.error, undefined, `a transaction that LANDED was answered as failed (${outcome.error?.message})`);
    assert.equal(outcome.value, 'the value', 'the transaction\'s own value was not returned');
    assert.deepEqual(asked, ['the value'], '`landed` is asked once, with what the callback returned');
  });

  it('a commit that failed is thrown as it came when `landed` says it did not land', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lost = await loseNextCommitReply(mongo);
    let outcome;
    try {
      outcome = await Promise.resolve().then(() => run(
        async (session) => { await facts().updateOne({ _id: 'f-00005' }, { $set: { landedEdit: 'yes' } }, { session }); return 1; },
        { landed: async () => false },
      )).then(value => ({ value }), error => ({ error }));
    } finally {
      lost.restore();
    }
    assert.ok(lost.fired(), 'fixture: no commit was made, so no reply was lost');
    assert.equal(outcome.value, undefined, 'a commit the caller\'s read-back denied was answered as landed');
    assert.equal(outcome.error?.codeName, 'MaxTimeMSExpired', `the commit error was not rethrown as it came (${outcome.error?.message})`);
  });

  it('without `landed`, a failed commit is thrown as it came', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lost = await loseNextCommitReply(mongo);
    let outcome;
    try {
      outcome = await Promise.resolve().then(() => run(
        async (session) => { await facts().updateOne({ _id: 'f-00006' }, { $set: { landedEdit: 'yes' } }, { session }); return 1; },
      )).then(value => ({ value }), error => ({ error }));
    } finally {
      lost.restore();
    }
    assert.ok(lost.fired(), 'fixture: no commit was made, so no reply was lost');
    assert.equal(outcome.error?.codeName, 'MaxTimeMSExpired', `a failed commit was swallowed or reworded (${outcome.error?.message ?? 'answered ok'})`);
  });

  // ── inBoundedTransaction: the session ends ─────────────────────────────────────────────────────────────────

  it('ends its session when the callback throws, and rethrows what it threw without asking `landed`', async () => {
    const run = inBounded();
    let session;
    let landedAsked = false;
    const boom = new Error('the callback failed');
    await assert.rejects(Promise.resolve().then(() => run(
      async (s) => { session = s; throw boom; },
      { landed: async () => { landedAsked = true; return true; } },
    )), (err) => err === boom, 'the callback\'s error was replaced or swallowed');
    assert.ok(session, 'fixture: the callback was never handed a session');
    assert.equal(session.hasEnded, true, 'the session was left open after the callback threw: a leaked session holds its server resources and its locks');
    assert.equal(landedAsked, false, '`landed` is for a failed COMMIT; it was asked about a callback that threw');
  });

  it('ends its session when the transaction succeeds', async () => {
    let session;
    await inBounded()(async (s) => { session = s; await facts().findOne({ _id: 'f-00007' }, { session: s }); });
    assert.equal(session?.hasEnded, true, 'the session was left open after the transaction committed');
  });

  it('ends its session when the bound ended the transaction', { timeout: 30_000 }, async () => {
    const run = inBounded();
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00008' } });
    let session;
    let res;
    try {
      const op = Promise.resolve().then(() => run(
        async (s) => { session = s; return facts().updateOne({ _id: 'f-00008' }, { $set: { boundedEdit: true } }, { session: s }); }));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled, `fixture: the bound did not end the transaction in ${CAP_MS} ms`);
    assert.equal(session?.hasEnded, true, 'the session was left open after the bound ended the transaction');
  });

  // ── inBoundedTransaction: reads ────────────────────────────────────────────────────────────────────────────

  it('a find of more rows than one default batch completes inside it', async () => {
    const ids = await inBounded()(async (session) =>
      (await facts().find({ spaceId: S }, { session, projection: { _id: 1 } }).toArray()).map(d => d._id));
    assert.equal(ids.length, ROWS, `the transaction read ${ids.length} of ${ROWS} rows`);
  });

  it('an aggregate of more rows than one default batch completes inside it', async () => {
    const n = await inBounded()(async (session) =>
      (await facts().aggregate([{ $match: { spaceId: S } }, { $project: { _id: 1 } }], { session }).toArray()).length);
    assert.equal(n, ROWS, `the transaction aggregated ${n} of ${ROWS} rows`);
  });

  // ── writeUnderClaim (files/media/lease.ts): the same bound ─────────────────────────────────────────────────

  it('control: writeUnderClaim fences the claim and lands its writes when nothing is locked', async () => {
    const fencedBefore = (await mongo.col(JOBS).findOne({ _id: JOB })).fencedWrites;
    const value = await lease.writeUnderClaim(S, CLAIM, async (session) => {
      await facts().insertOne({ _id: 'lease-control', spaceId: S, fact: 'written under the claim', seq: ROWS + 1 }, { session });
      return 'done';
    });
    assert.equal(value, 'done');
    assert.ok(await facts().findOne({ _id: 'lease-control' }), 'the writes under a held claim did not land');
    assert.equal((await mongo.col(JOBS).findOne({ _id: JOB })).fencedWrites, fencedBefore + 1, 'the fence was not written');
  });

  it('control: writeUnderClaim answers a claim that is gone with JobLeaseLostError and writes nothing', async () => {
    await assert.rejects(lease.writeUnderClaim(S, { jobId: JOB, claimToken: 'someone-elses' }, async (session) => {
      await facts().insertOne({ _id: 'lease-lost', spaceId: S, fact: 'must not land', seq: ROWS + 2 }, { session });
    }), (err) => lease.isLeaseLost(err));
    assert.equal(await facts().findOne({ _id: 'lease-lost' }), null, 'a run that lost its claim wrote its results');
  });

  it('writeUnderClaim: a lock held on its job row ends it within the write bound, and what it would have written does not land', { timeout: 30_000 }, async () => {
    const lock = await holdDocumentLock(mongo, JOBS, { filter: { _id: JOB } });
    let res;
    try {
      const op = Promise.resolve().then(() => lease.writeUnderClaim(S, CLAIM, async (session) => {
        await facts().insertOne({ _id: 'lease-bounded', spaceId: S, fact: 'must not land', seq: ROWS + 3 }, { session });
      }));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled,
      `writeUnderClaim was still waiting ${res.elapsedMs} ms after it began against a ${BOUND.writeTimeoutMs} ms write bound: it starts `
      + 'its session with no bound, so withTransaction retries the lock\'s write conflict for the driver\'s 120 s (plan F12)');
    assert.equal(res.ok, false, 'a fenced write the bound ended was answered as a success');
    assert.equal(await facts().findOne({ _id: 'lease-bounded' }), null, 'a fenced write the bound ended landed its results');
  });

  it('writeUnderClaim: a lock held on a record its writes touch ends it within the write bound too', { timeout: 30_000 }, async () => {
    const lock = await holdDocumentLock(mongo, FACTS, { filter: { _id: 'f-00009' } });
    let res;
    try {
      const op = Promise.resolve().then(() => lease.writeUnderClaim(S, CLAIM, async (session) => {
        await facts().updateOne({ _id: 'f-00009' }, { $set: { claimedEdit: true } }, { session });
      }));
      res = await settleWithin(op, CAP_MS);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled, `writeUnderClaim was still waiting ${res.elapsedMs} ms after it began, on a record lock, against a ${BOUND.writeTimeoutMs} ms write bound`);
    assert.equal(res.ok, false, 'a write the bound ended was answered as a success');
    assert.equal((await facts().findOne({ _id: 'f-00009' }))?.claimedEdit, undefined, 'a write the bound ended landed');
  });

  it('writeUnderClaim: ends its session whether its writes succeed or throw', async () => {
    let ok, threw;
    await lease.writeUnderClaim(S, CLAIM, async (s) => { ok = s; });
    await assert.rejects(lease.writeUnderClaim(S, CLAIM, async (s) => { threw = s; throw new Error('writes failed'); }), /writes failed/);
    assert.equal(ok?.hasEnded, true, 'the session was left open after a fenced write committed');
    assert.equal(threw?.hasEnded, true, 'the session was left open after a fenced write threw');
  });

  it('writeUnderClaim: a read of more rows than one default batch completes inside it', async () => {
    const n = await lease.writeUnderClaim(S, CLAIM, async (session) =>
      (await facts().find({ spaceId: S }, { session, projection: { _id: 1 } }).toArray()).length);
    assert.ok(n >= ROWS, `the fenced transaction read ${n} of at least ${ROWS} rows`);
  });

  // ── Q-530: a bound-ended transaction leaves nothing to land and nothing held (design rev 4.3, step 7) ──────────

  it('Q-530 (i): after the bound ended a fenced write whose first statement was still on the wire, the next fenced write AND a revokingClaims write on that job row succeed', { timeout: 60_000 }, async () => {
    const jobId = 'job-q530-i';
    const run = await boundEndedFencedWrite(jobId);
    let occupy;
    try {
      const outcome = await run.call;
      assert.ok(outcome.error, 'fixture: the fenced write whose first statement was held was answered as a success');
      // Take the pool's next session and keep it: on a pool that hands the orphan's lsid out again (LIFO), the next fenced write
      // would run ON the orphan's session, and its own transaction would end the orphan's — passing for the wrong reason.
      occupy = mongo.getMongo().startSession();
      run.statement.release();
      const late = await run.statement.reply;
      const open = await transactionsOf(run.orphan);
      const row = await jobRowAnswer(jobId);
      const next = await settled(lease.writeUnderClaim(S, { jobId, claimToken: CLAIM.claimToken }, async (s) => lsidHex(s.id)));
      const revoke = await settled(lease.revokingClaims(() => mongo.col(JOBS).updateOne({ _id: jobId }, { $set: { revokedProbe: Date.now() } })));
      if (next.value !== undefined) assert.notEqual(next.value, run.orphan, 'fixture: the next fenced write ran on the orphan\'s own session');
      assert.equal(next.error, undefined,
        `the next fenced write on ${jobId} failed (${next.error?.name}: ${next.error?.message}): the first statement of transaction ${run.n}, `
        + `delivered after the bound had ended its call (server answered: ${replyText(late)}), opened a transaction nobody owns on session `
        + `${run.orphan.slice(0, 8)}, and it holds the job row (Q-530)`);
      assert.equal(revoke.error, undefined, `a revokingClaims write on ${jobId} failed (${revoke.error?.name}: ${revoke.error?.message}): the orphan transaction holds the row`);
      assert.equal(row, 'free', `the job row was ${row} for a write from another session after the late statement`);
      assert.deepEqual(open, [], `the bounded session ${run.orphan.slice(0, 8)} still has a transaction open on the server after its call answered`);
      assert.equal(late?.code, 225, `the late statement of transaction ${run.n} was answered ${replyText(late)}; a sealed transaction answers 225 TransactionTooOld`);
    } finally {
      if (occupy) { occupy.serverSession.isDirty = true; await occupy.endSession(); }
      await freeOrphan(run);
    }
  });

  it('Q-530 (ii)/(vii): a COMMIT held past the bound is sealed — delivered late it is refused, and nothing lands after the read-back answered "not landed"', { timeout: 60_000 }, async () => {
    let target;
    const asked = [];
    const commit = relay.hold((c) => c.commitTransaction === 1 && target !== undefined && lsidHex(c.lsid) === target);
    const outcome = await settled(inBounded()(
      async (s) => { target = lsidHex(s.id); await facts().updateOne({ _id: 'f-00010' }, { $set: { lateCommit: true } }, { session: s }); return 'the value'; },
      { landed: async (value) => { asked.push(value); return (await fixture.col(FACTS).findOne({ _id: 'f-00010' }))?.lateCommit === true; } },
    ));
    commit.disarm();
    try {
      assert.equal(commit.held.length, 1, 'fixture: the transaction\'s commit never reached the relay');
      const held = commit.held[0];
      const n = Number(held.command.txnNumber);
      held.release();
      const late = await held.reply;
      const open = await transactionsOf(target);
      const landedAfter = (await fixture.col(FACTS).findOne({ _id: 'f-00010' }))?.lateCommit;
      assert.ok(outcome.error, 'a transaction whose commit never reached the server was answered as a success');
      assert.deepEqual(asked, ['the value'], 'fixture: `landed` was not asked once about the failed commit');
      assert.equal(landedAfter, undefined,
        `the commit of transaction ${n}, delivered after the caller had been answered "not landed", LANDED (server answered: ${replyText(late)}): `
        + 'the driver leaves a timed-out commit\'s transaction open (probe 6 a4), so the read-back was not definitive');
      assert.equal(late?.code, 225, `the late commit of transaction ${n} was answered ${replyText(late)}; a sealed transaction answers 225 TransactionTooOld`);
      assert.deepEqual(open, [], `session ${target?.slice(0, 8)} still has a transaction open on the server`);
    } finally {
      await freeOrphan({ statement: commit.held[0] });
    }
  });

  it('Q-530 (iii): an ordinary refusal inside the transaction sends no seal and no kill (green at base: no seal exists yet)', async () => {
    // What it guards: the seal is for an exit where a statement may still be in flight (the store did not answer). A callback
    // that refused is not one, and a seal there is a store call inside the seq hold that buys nothing (vet C3 6).
    const refusals = [
      { name: 'a claim that is gone (JobLeaseLostError)', run: () => lease.writeUnderClaim(S, { jobId: JOB, claimToken: 'someone-elses' }, async () => {}), is: (e) => lease.isLeaseLost(e) },
      { name: 'a callback that throws', run: () => inBounded()(async (s) => { await facts().findOne({ _id: 'f-00011' }, { session: s }); throw new Error('the callback refused'); }), is: (e) => e?.message === 'the callback refused' },
    ];
    for (const refusal of refusals) {
      const seen = relay.record(() => true);
      let outcome;
      try { outcome = await settled(refusal.run()); } finally { seen.stop(); }
      assert.ok(refusal.is(outcome.error), `fixture: ${refusal.name} was answered ${outcome.error?.message ?? 'ok'}`);
      // The refusal's session, derived from what it sent: the statement that started its transaction.
      const first = seen.commands.find((c) => c.startTransaction === true);
      assert.ok(first, `fixture: ${refusal.name} sent no statement that started a transaction, so there is no session to ask about`);
      const lsid = lsidHex(first.lsid);
      const n = Number(first.txnNumber);
      const seals = seen.commands.filter(isSealOf(lsid, n));
      const kills = seen.commands.filter(isKillOf(lsid));
      assert.deepEqual(seals.map(commandName), [], `${refusal.name} sent a seal: a refusal leaves nothing in flight to seal`);
      assert.deepEqual(kills.map(commandName), [], `${refusal.name} sent a kill of its session`);
    }
  });

  it('Q-530 (iv): the session of a transaction the bound ended is never handed out again — no session the pool gives carries its lsid', { timeout: 60_000 }, async () => {
    const run = await boundEndedFencedWrite('job-q530-iv');
    const sessions = [];
    try {
      const outcome = await run.call;
      assert.ok(outcome.error, 'fixture: the fenced write whose first statement was held was answered as a success');
      for (let k = 0; k < POOL_PROBE_SESSIONS; k++) sessions.push(mongo.getMongo().startSession());
      const reused = sessions.filter((s) => lsidHex(s.serverSession.id) === run.orphan).length;
      assert.equal(reused, 0,
        `${reused} of ${sessions.length} sessions taken from the pool carry the lsid ${run.orphan.slice(0, 8)} of transaction ${run.n}, which the bound `
        + 'ended with a statement still on the wire: the session went back to the pool, so the next caller\'s commands share an lsid with a '
        + 'transaction that may still open late (mark it dirty: serverSession.isDirty)');
    } finally {
      for (const s of sessions) { s.serverSession.isDirty = true; await s.endSession(); }
      await freeOrphan(run);
    }
  });

  it('Q-530 (v): a seal that fails is followed by a kill and a second seal, in that order, and the second seal aborts what a late statement reopened after the kill', { timeout: 60_000 }, async () => {
    const jobId = 'job-q530-v';
    let seals, order;
    const run = await boundEndedFencedWrite(jobId, (orphan, n) => {
      seals = relay.hold(isSealOf(orphan, n), { count: 2 });
      order = relay.record((c) => isSealOf(orphan, n)(c) || isKillOf(orphan)(c));
    });
    try {
      // Latch: the second seal reached the relay — or the call answered without one.
      const second = await Promise.race([seals.whenHeld(2), run.call.then(() => null)]);
      let late, secondReply;
      if (second) {
        run.statement.release();
        late = await run.statement.reply; // after the kill: it reopens transaction n (probe 6 b1, b167-tests530 probe)
        second.release();
        secondReply = await second.reply;
      }
      const outcome = await run.call;
      run.stopLog();
      order.stop();
      assert.equal(seals.held.length, 2,
        `${seals.held.length} seal(s) of transaction ${run.n} were sent after the bound ended it with a statement still on the wire; the design `
        + 'sends a seal, a kill when it fails, and a second seal (rev 4.3)');
      assert.deepEqual(order.commands.map((c) => (c.killSessions ? 'kill' : 'seal')), ['seal', 'kill', 'seal'], 'the order was not seal, kill, seal');
      assert.ok(outcome.error, 'fixture: the bound-ended fenced write was answered as a success');
      assert.equal(replyText(late), 'ok', 'fixture: the late statement released after the kill did not reopen its transaction, so the second seal had nothing to abort');
      assert.equal(replyText(secondReply), 'ok', 'the second seal was refused');
      assert.deepEqual(await transactionsOf(run.orphan), [], 'the second seal left the transaction the late statement reopened open');
      const commit = await commitAs(run.statement.command.lsid, run.n);
      assert.equal(commit.code, 225, `a late commit of transaction ${run.n} was answered ${replyText(commit)}, not 225 TransactionTooOld`);
      assert.equal(await jobRowAnswer(jobId), 'free', 'the job row is still held');
      const firstSeal = seals.held[0];
      firstSeal.release();
      const firstLate = await firstSeal.reply;
      assert.equal(firstLate?.code, 225, `the first seal, delivered after the second, was answered ${replyText(firstLate)}; it is too old and harmless (D5)`);
      const said = reportLines(run.lines, /seal/i);
      assert.equal(said.length, 1, `the seal's failure and the kill after it were reported in ${said.length} lines, not one:\n${said.join('\n')}`);
    } finally {
      order?.stop();
      await freeOrphan(run);
    }
  });

  it('Q-530 (vi): when every seal and the kill are held, the caller receives the original store error and the outcome is reported unconfirmed', { timeout: 60_000 }, async () => {
    let seals, kills;
    const run = await boundEndedFencedWrite('job-q530-vi', (orphan, n) => {
      seals = relay.hold(isSealOf(orphan, n), { count: Infinity });
      kills = relay.hold(isKillOf(orphan), { count: Infinity });
    });
    try {
      const outcome = await run.call;
      run.stopLog();
      assert.ok(seals.held.length >= 2, `${seals.held.length} seal(s) were sent after the bound ended transaction ${run.n}; the design sends one, and a second after the kill`);
      assert.ok(kills.held.length >= 1, 'no kill of the session was sent after the first seal failed');
      assert.ok(outcome.error && storeCondition.storeIsNotAnswering(outcome.error),
        `the caller was not answered the original store error (${outcome.error ? `${outcome.error.name}: ${outcome.error.message}` : 'it was answered a success'})`);
      const said = reportLines(run.lines, /unconfirmed|could not be confirmed/i);
      assert.equal(said.length, 1, `an unconfirmed seal was reported in ${said.length} lines, not one:\n${said.join('\n')}`);
    } finally {
      await freeOrphan(run);
    }
  });

  // Last: it reconnects the server's client with retryWrites=false, on a database of its own name (the harness drops a database on
  // open and on close, and one name per open keeps a-db-harness-name-is-unique true).
  it('Q-530 (viii): on a client with retryWrites=false no seal is sent (it would carry no txnNumber); the kill runs and the outcome is reported unconfirmed', { timeout: 60_000 }, async () => {
    await closeTestMongo();
    mongo = await openTestMongo('boundedtxnnoretry', { port: relay.port, query: '&retryWrites=false' });
    let writes, kills;
    const run = await boundEndedFencedWrite('job-q530-viii', (orphan) => {
      writes = relay.record(isWriteOutsideTransactionOf(orphan));
      kills = relay.record(isKillOf(orphan));
    });
    try {
      const outcome = await run.call;
      run.stopLog();
      assert.ok(outcome.error, 'fixture: the bound-ended fenced write was answered as a success');
      assert.ok(kills.commands.length >= 1,
        'no kill of the session was sent: with retryWrites=false the seal cannot carry a txnNumber, so the kill is what is left (rev 4.1, V4 S1)');
      assert.deepEqual(writes.commands.map(commandName), [],
        'a seal was sent on a client that does not retry writes: without a txnNumber it aborts nothing and only looks as if it succeeded');
      const said = reportLines(run.lines, /unconfirmed|could not be confirmed/i);
      assert.equal(said.length, 1, `the unsealed exit was reported in ${said.length} lines, not one:\n${said.join('\n')}`);
    } finally {
      writes?.stop();
      kills?.stop();
      await freeOrphan(run);
    }
  });
});
