/**
 * A TRANSACTION under a position floor — the one way a multi-document write that stamps positions is run (bundle-30 plan §A4, bundle-81).
 *
 * ## Why a module
 *
 * Two writers spelled it by hand — the edge re-key in `brain/edges.ts` and the merge in `brain/merge.ts`:
 * `startSession`, the hold around `session.withTransaction(…)`, `endSession` in a `finally`. Each copy was
 * correct about the hold and both dropped the same thing: **a bound**. `withTransaction` retries a write conflict
 * for its default 120 s, so a document lock held elsewhere kept the hold for two minutes, and every
 * position-paged reader of the space with it (`Q-213`).
 *
 * ## What it is, now
 *
 * The floor hold around `inBoundedTransaction` (`db/bounded-transaction.ts`), and nothing more. The bound, the
 * read-back of a commit whose reply was lost and the `endSession` are that module's — one copy, so the question a
 * session is started for has one answer wherever it is asked. What this file adds is the one thing the bound does not
 * know:
 *
 *  - **The floor**, for the whole transaction (`withPositionFloorHeld`, `util/position-clock.ts`): a write inside a session has not
 *    committed when it returns, so its position must not reach a reader until the session has. Every position stamped inside
 *    (`withLandingStamp`) is at or above the floor, and `settledPositionCap` stays below it until the transaction ends.
 *  - **The read-back sits INSIDE the hold**, because the transaction does: a commit that fails may have landed, and
 *    `landed` is asked before the hold is released, so a late commit can never land below a reader's cursor.
 *  - **So does the seal** of a transaction the store stopped answering (`SEAL_MS`): it comes before the read-back, and at
 *    worst adds two seals and a kill to that exit while every reader waits.
 *
 * Nothing that is not the driver is awaited inside: every await holds every reader of the space.
 *
 * A session is started in `db/bounded-transaction.ts` and nowhere else (`every-transaction-is-bounded.test.js`): a
 * transaction that stamps no position has no business in this file, and one that stamps positions has no business outside it.
 */
import type { ClientSession } from 'mongodb';
import { withPositionFloorHeld } from '../util/position-clock.js';
import { recordPositions } from '../sync/record-position-stream.js';
import { inBoundedTransaction, type BoundedTransactionOptions } from '../db/bounded-transaction.js';

/**
 * Run `fn` as one transaction under a position floor on `spaceId` — see the module docblock. `holder` names it, as every
 * hold does (`util/position-clock.ts`). The callback's value is the transaction's value.
 */
export async function inHeldTransaction<T>(
  spaceId: string, holder: string, fn: (session: ClientSession) => Promise<T>, opts: BoundedTransactionOptions<T> = {},
): Promise<T> {
  return withPositionFloorHeld(recordPositions, spaceId, () => inBoundedTransaction(fn, opts), holder);
}
