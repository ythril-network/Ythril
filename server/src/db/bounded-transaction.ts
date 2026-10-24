/**
 * A TRANSACTION that the write bound ends — the one way a multi-document write is run inside a MongoDB session.
 *
 * ## The question it answers
 *
 * *"Run these writes as one transaction, and be sure it ends when the write bound says so."* Nothing else: it holds
 * NO position horizon. The bound and the horizon are two questions. A transaction that writes seq-carrying documents asks
 * the second one too, and puts the floor around this (`brain/held-transaction.ts`); a transaction that writes none (the
 * lease fence, `files/media/lease.ts`) must not stall every position-paged reader of a space for as long as it runs.
 *
 * ## What it prevents
 *
 * `withTransaction` retries a write conflict for the driver's default 120 s, so a document lock held elsewhere kept a
 * transaction waiting two minutes — under a seq hold, every seq-paged reader of the space with it (`Q-213`); under the
 * media worker's fence, the worker and every move waiting on it. A hand-written session start drops the bound, or the
 * read-back below, or the `endSession`, or the one-batch read, and each copy dropped a different one of them. They are
 * inside here so that no caller can leave them out.
 *
 * ## What it does, in order
 *
 *  1. **Opens a bound scope when none is active** (`withinWriteBound`). Without a scope `db/write-bound.ts` bounds
 *     nothing and a timed transaction's cursor reads are not asked for all of their rows in one batch — so a caller
 *     outside a hold gets the same bound as one inside it, and an enclosing scope's deadline is never raised. A transaction
 *     whose purpose has a bound of its own (`boundMs`) opens its scope at that figure instead, and its commit is capped there.
 *  2. **Bounds the session**: `defaultTimeoutMS` = what is left of the scope's deadline, so `withTransaction`'s retry
 *     loop ends at the deadline, and the commit carries `maxCommitTimeMS`. Operations issued without the session are
 *     bounded by the scope.
 *  3. **Reads back a failed commit** when `landed` is given: a commit that fails may have landed (its reply lost, or
 *     `maxTimeMS` firing after the commit applied). `landed` is asked once, with a fresh bound of its own, and a
 *     transaction that did land is answered as landed. Without it, or when it says no, the commit's error is thrown as
 *     it came.
 *  4. **Ends the session** in a `finally`, which is also when the record-write observer reports the session's writes.
 *
 * `fn` runs again from the top when `withTransaction` retries a transient error, so it must be safe to run twice.
 *
 * ## A transaction the bound ended is sealed before anything is answered (`Q-530`)
 *
 * When the store is not answering (`storeIsNotAnswering`: the bound ended it, or the store cannot be reached), a statement of
 * the transaction, or its commit, may still be on the wire. The client's abort and `endSession` have already run when it
 * arrives, so it opens a transaction nobody owns, holds every document it wrote, and outlives the server's own transaction
 * lifetime: the next write on those documents fails with a write conflict. So, BEFORE the commit is read back:
 *
 *  1. **The seal**: one retryable write on the same session that matches nothing, outside any transaction. It carries the
 *     session's next transaction number, which aborts a transaction still open under the old one and refuses every statement
 *     or commit of it that arrives later (`TransactionTooOld`). Bounded by `SEAL_MS`.
 *  2. **When the seal fails**: `killSessions` on the session, which frees what is open NOW, then a second seal. The kill alone
 *     closes nothing for later: it drops the transaction number, so a statement arriving after it reopens the old transaction.
 *     Only a seal sent after the last kill counts.
 *  3. **The session is never pooled again**, so its id is not handed to the next transaction.
 *
 * Only an answered seal makes the outcome `gone`, and only then is a "not landed" read-back the truth. Otherwise the outcome
 * is `unconfirmed`, said in one ERROR line, and the caller receives the store's own error, which already means "may have
 * landed". The residual, stated: with no seal answered, a late statement may hold what it wrote, with NO time bound, until a
 * later command on that session id or a kill after it lands. A client whose connection string sets `retryWrites=false`
 * cannot send a seal (the driver attaches no transaction number), so it is always in that residual; `mongo.ts` says so at boot.
 * An ordinary refusal (a callback that throws, a lost claim) sends nothing: no statement of it can still be in flight.
 */
import type { ClientSession } from 'mongodb';
import { getDb, getMongo } from './mongo.js';
import { KILL_WAIT_MS, boundOperationMs, boundTimeLeft, writeTimeoutMs, withinWriteBound, withinWriteBoundOf, outsideWriteBound } from './write-bound.js';
import type { EndedOperation } from './write-bound.js';
import { StoreTimeout } from './write-timeout.js';
import { storeIsNotAnswering } from './store-condition.js';
import { log, peerText } from '../util/log.js';

/**
 * The seal's own bound, ms: one write of nothing, which must outlast a store that is slow but still answering, since a seal
 * that fails costs a kill and a second seal. Paid only when the store was not answering, inside the caller's seq hold when
 * there is one: at worst `2 x SEAL_MS + KILL_WAIT_MS` added to that exit.
 */
export const SEAL_MS = 2_000;

/** Where the seal writes. It matches nothing and creates nothing; it is a collection no reader or observer watches. */
const SEAL_COLLECTION = 'transaction_seal';

/** One seal: true when the server answered it, so the session's old transaction number is closed for good. */
async function sealOnce(session: ClientSession): Promise<boolean> {
  try {
    await getMongo().db(getDb().databaseName).collection(SEAL_COLLECTION)
      .updateOne({ _id: '__seal_matches_nothing__' as unknown as never }, { $set: { sealed: true } }, { session, timeoutMS: SEAL_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Seal a session whose transaction the bound ended (see the module docblock): seal, else kill and seal again. NEVER throws;
 * says one line when the outcome is not a first seal answered.
 */
async function sealTransaction(session: ClientSession): Promise<EndedOperation> {
  return outsideWriteBound(async () => {
    let canSeal: boolean;
    try {
      canSeal = getMongo().options.retryWrites !== false;
    } catch (err) {
      // No client (shutdown closed it): nothing can be sent. Said, and the caller still gets its own error.
      const why = `no client: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`Bounded transaction: the store stopped answering with a statement possibly in flight, and its end could not be confirmed (${peerText(why)}).`);
      return { outcome: 'unconfirmed', killed: 0, why };
    }
    if (canSeal && await sealOnce(session)) return { outcome: 'gone', killed: 0 };
    let killed = 0;
    let why: string;
    try {
      await getMongo().db('admin').command({ killSessions: [session.id] }, { timeoutMS: KILL_WAIT_MS });
      killed = 1;
      why = canSeal ? 'the first seal was not answered' : 'retryWrites=false, so no seal can be sent';
    } catch (err) {
      why = `${canSeal ? 'the first seal was not answered' : 'retryWrites=false, so no seal can be sent'}, and the kill failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (canSeal && await sealOnce(session)) {
      log.warn(`Bounded transaction: the store stopped answering with a statement possibly in flight; ${peerText(why)}; ${killed ? 'the session was killed and ' : ''}a second seal was answered. `
        + 'Nothing it sent can land or hold a document now.');
      return { outcome: 'gone', killed };
    }
    log.error(`Bounded transaction: the store stopped answering with a statement possibly in flight, and its end could not be confirmed (${peerText(why)}${canSeal ? '; the second seal was not answered either' : ''}). `
      + 'The caller was answered the store\'s own error; a late statement may still hold the documents it wrote until a kill after it lands.');
    return { outcome: 'unconfirmed', killed, why };
  });
}

export interface BoundedTransactionOptions<T> {
  /**
   * Did the transaction land after all? Asked only when its COMMIT failed, with what the callback returned. True: the
   * transaction's value is returned as if the commit had answered. Without it, a failed commit is thrown as it came.
   */
  landed?: (result: T) => Promise<boolean>;
  /**
   * The bound of this transaction's PURPOSE, ms, when it is not the write bound's: the deadline across the transaction and the cap on
   * its commit. For a transaction whose size is the data's (a conversion's whole set of derived rows) and which the server itself
   * ends at its own transaction lifetime — a figure tighter than that would refuse what the data's size makes legitimate. An
   * enclosing scope's lower deadline still wins. Absent: the write bound.
   */
  boundMs?: number;
}

/** Run `fn` as one transaction under the write bound — see the module docblock. The callback's value is the value. */
export async function inBoundedTransaction<T>(
  fn: (session: ClientSession) => Promise<T>, opts: BoundedTransactionOptions<T> = {},
): Promise<T> {
  // No active scope with a deadline: open one. An enclosing one is kept as it is (a scope never raises what an outer bounded).
  const left = boundTimeLeft();
  if (left === undefined) {
    return opts.boundMs === undefined
      ? withinWriteBound(() => inBoundedTransaction(fn, opts))
      : withinWriteBoundOf(opts.boundMs, () => inBoundedTransaction(fn, opts));
  }
  if (left <= 0) throw new StoreTimeout('the transaction');
  const session = getMongo().startSession({ defaultTimeoutMS: left });
  let ran = false;
  let result: T | undefined;
  try {
    return await session.withTransaction(async () => {
      ran = false;
      result = await fn(session);
      ran = true;
      return result;
    }, { maxCommitTimeMS: Math.min(left, opts.boundMs ?? writeTimeoutMs(), boundOperationMs() ?? Infinity) });
  } catch (err) {
    // The store stopped answering: a statement or the commit may still be on the wire. Seal BEFORE the read-back, so a late
    // commit cannot land after the read-back said no. The session is never pooled again.
    if (storeIsNotAnswering(err)) {
      await sealTransaction(session);
      if (session.serverSession) session.serverSession.isDirty = true;
    }
    // `ran`: the callback finished, so what failed is the commit — the one failure that may have landed.
    if (!ran || !opts.landed) throw err;
    const landed = opts.landed;
    const value = result as T;
    // A fresh bound for the one read, outside the spent one.
    const confirmed = await outsideWriteBound(() => withinWriteBound(() => landed(value))).catch(() => false);
    if (confirmed) return value;
    throw err;
  } finally {
    await session.endSession();
  }
}
