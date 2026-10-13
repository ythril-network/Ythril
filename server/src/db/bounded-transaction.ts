/**
 * A TRANSACTION that the write bound ends — the one way a multi-document write is run inside a MongoDB session.
 *
 * ## The question it answers
 *
 * *"Run these writes as one transaction, and be sure it ends when the write bound says so."* Nothing else: it holds
 * NO seq horizon. The bound and the horizon are two questions. A transaction that writes seq-carrying documents asks
 * the second one too, and puts the hold around this (`brain/held-transaction.ts`); a transaction that writes none (the
 * lease fence, `files/media/lease.ts`) must not stall every seq-paged reader of a space for as long as it runs.
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
 */
import type { ClientSession } from 'mongodb';
import { getMongo } from './mongo.js';
import { boundOperationMs, boundTimeLeft, writeTimeoutMs, withinWriteBound, withinWriteBoundOf, outsideWriteBound } from './write-bound.js';
import { StoreTimeout } from './write-timeout.js';

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
