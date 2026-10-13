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
 * ## What it is, now
 *
 * The horizon hold around `inBoundedTransaction` (`db/bounded-transaction.ts`), and nothing more. The bound, the
 * read-back of a commit whose reply was lost and the `endSession` are that module's — one copy, so the question a
 * session is started for has one answer wherever it is asked. What this file adds is the one thing the bound does not
 * know:
 *
 *  - **The horizon**, for the whole transaction (`withSeqHorizonHeld`): a write inside a session has not committed when
 *    it returns, so its seq must not reach a reader until the session has.
 *  - **The read-back sits INSIDE the hold**, because the transaction does: a commit that fails may have landed, and
 *    `landed` is asked before the hold is released, so a late commit can never land below a reader's cursor.
 *
 * Nothing that is not the driver is awaited inside: every await holds every reader of the space.
 *
 * A session is started in `db/bounded-transaction.ts` and nowhere else (`every-transaction-is-bounded.test.js`): a
 * transaction that takes no seq has no business in this file, and one that takes seqs has no business outside it.
 */
import type { ClientSession } from 'mongodb';
import { withSeqHorizonHeld } from '../util/seq.js';
import { inBoundedTransaction, type BoundedTransactionOptions } from '../db/bounded-transaction.js';

/**
 * Run `fn` as one transaction under a seq hold on `spaceId` — see the module docblock. `holder` names it, as every
 * hold does (`util/seq.ts`). The callback's value is the transaction's value.
 */
export async function inHeldTransaction<T>(
  spaceId: string, holder: string, fn: (session: ClientSession) => Promise<T>, opts: BoundedTransactionOptions<T> = {},
): Promise<T> {
  return withSeqHorizonHeld(spaceId, () => inBoundedTransaction(fn, opts), holder);
}
