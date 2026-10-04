/**
 * A TRANSACTION under a seq hold — the one way a multi-document write that takes seqs is run (bundle-30 plan §A4).
 *
 * ## Why a module
 *
 * Two writers spelled it by hand — the edge re-key in `brain/edges.ts` and the merge in `brain/merge.ts`:
 * `startSession`, `withSeqHorizonHeld(() => session.withTransaction(…))`, `endSession` in a `finally`. Each copy was
 * correct about the hold and both dropped the same thing: **a bound**. `withTransaction` retries a write conflict
 * for its default 120 s, so a document lock held elsewhere kept the horizon held for two minutes, and every
 * seq-paged reader of the space with it (`Q-213`).
 *
 * ## What it holds, in order
 *
 *  1. **The horizon**, for the whole transaction (`withSeqHorizonHeld`): a write inside a session has not
 *     committed when it returns, so its seq must not reach a reader until the session has.
 *  2. **The bound**: the session is started with `defaultTimeoutMS` = what is left of the hold's deadline, so
 *     `withTransaction`'s retry loop ends at the deadline (probe P1: it ended under the bound, 17 attempts in), and
 *     the commit carries `maxCommitTimeMS` too. Operations without the session (the counter `$inc` of an allocation
 *     inside) are bounded by the hold's scope (`db/write-bound.ts`).
 *  3. **The read-back, INSIDE the hold**: a commit that fails may have landed (its reply lost, or `maxTimeMS`
 *     firing after the commit applied). When `landed` is given and the commit failed, it is asked — with a fresh
 *     bound of its own, still holding the horizon — before the hold is released. A late commit can therefore never
 *     land below a reader's cursor, and a write that landed is answered as landed.
 *  4. **The session ends** in a `finally`, which is also when the record-write observer reports its writes.
 *
 * Nothing that is not the driver is awaited inside: every await holds every reader of the space.
 *
 * The third `startSession` in the codebase, `files/media/lease.ts`, is a LEASE transaction with no seq hold — a
 * different question, and deliberately not this module's.
 */
import type { ClientSession } from 'mongodb';
import { getMongo } from '../db/mongo.js';
import { withSeqHorizonHeld } from '../util/seq.js';
import { boundTimeLeft, writeTimeoutMs, withinWriteBound, outsideWriteBound } from '../db/write-bound.js';
import { StoreTimeout } from '../db/write-timeout.js';

export interface HeldTransactionOptions<T> {
  /**
   * Did the transaction land after all? Asked only when its COMMIT failed, with what the callback returned, inside
   * the hold. True: the transaction's value is returned as if the commit had answered. Without it, a failed commit
   * is thrown as it came.
   */
  landed?: (result: T) => Promise<boolean>;
}

/**
 * Run `fn` as one transaction under a seq hold on `spaceId` — see the module docblock. `holder` names it, as every
 * hold does (`util/seq.ts`). The callback's value is the transaction's value.
 */
export async function inHeldTransaction<T>(
  spaceId: string, holder: string, fn: (session: ClientSession) => Promise<T>, opts: HeldTransactionOptions<T> = {},
): Promise<T> {
  return withSeqHorizonHeld(spaceId, async () => {
    const left = boundTimeLeft() ?? writeTimeoutMs();
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
      }, { maxCommitTimeMS: Math.min(left, writeTimeoutMs()) });
    } catch (err) {
      // `ran`: the callback finished, so what failed is the commit — the one failure that may have landed.
      if (!ran || !opts.landed) throw err;
      const landed = opts.landed;
      const value = result as T;
      // A fresh bound for the one read, outside the spent one — and still inside the hold.
      const confirmed = await outsideWriteBound(() => withinWriteBound(() => landed(value))).catch(() => false);
      if (confirmed) return value;
      throw err;
    } finally {
      await session.endSession();
    }
  }, holder);
}
