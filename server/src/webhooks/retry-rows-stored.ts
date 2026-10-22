/**
 * Which of these webhook retry rows does the queue hold, after a write of them failed? (bundle-169, Q-580)
 *
 * ## What it prevents
 *
 * Three paths write a retry row: the overflow flush, the requeue after a failed first delivery, and the poll's requeue of a failed retry.
 * Each counted by the write's ANSWER, and the answer is not the store's state: a write whose rows landed and whose reply was lost (a store
 * that went away after applying it, a bound that fired after the server wrote) was counted lost while the poll went on to deliver every
 * row of it. The driver cannot settle it either: on a timeout `insertedIds` names every attempted row whether 0 or all of them were stored
 * (probe P2). Only reading the ids back is exact, so the counters are taken from that read and never from the error.
 *
 * ## The verdict per row
 *
 *  - `stored`: the read found it.
 *  - `not_stored`: not found, not due, and the write is KNOWN to have ended (the store refused it, or the server's own deadline ended it).
 *  - `not_known_stored`: anything else. A row not found that was already due when the read ended may have been delivered and removed by
 *    the poll; a write ended by the client side, or a store that is not answering, may still land; and a read-back that fails or has no
 *    time left knows nothing.
 *
 * The bound is inside: the read runs as a detached write's (`detachedWrite`, each operation at the write bound, no request's deadline),
 * and at shutdown the caller's `timeLeft` ends it with the drain budget.
 */
import { readStoredById } from '../db/read-by-id.js';
import { detachedWrite } from '../db/write-bound.js';
import { errorChain } from '../db/error-chain.js';
import { isMaxTimeExpired } from '../db/max-time.js';
import { storeIsNotAnswering } from '../db/store-condition.js';

export type RetryRowVerdict = 'stored' | 'not_stored' | 'not_known_stored';

/** What a verdict needs of a row: its id, and when it falls due (a due row may already have been delivered and removed). */
export interface RetryRowRef {
  readonly _id: string;
  readonly scheduledAt: Date;
}

/**
 * Did the write that failed with `writeError` END, so that a row the read does not find was never stored? A refusal (a duplicate key, a
 * validation failure) and a server-side deadline (`MaxTimeMSExpired`) end it; a client-side timeout or a store that is not answering do not.
 */
function writeKnownEnded(writeError: unknown): boolean {
  if (errorChain(writeError).some(e => isMaxTimeExpired(e))) return true;
  return !storeIsNotAnswering(writeError);
}

/**
 * The verdict for each row of `rows` (keyed by `_id`) after a write of them failed with `writeError`. Never throws: a read-back that fails
 * answers `not_known_stored` for every row. `timeLeft` (ms, at shutdown) ends the read when the caller's budget is spent.
 */
export async function retryRowsStored(
  collName: string, rows: readonly RetryRowRef[], writeError: unknown, { timeLeft }: { timeLeft?: () => number } = {},
): Promise<Map<string, RetryRowVerdict>> {
  const verdicts = new Map<string, RetryRowVerdict>();
  let found: Map<string, unknown>;
  try {
    found = await detachedWrite(() => readStoredById(collName, rows.map(r => r._id), { _id: 1 }, {
      ...(timeLeft ? {
        timeLeft: () => {
          const ms = timeLeft();
          if (ms <= 0) throw new Error('the retry rows could not be read back: no time is left');
          return ms;
        },
      } : {}),
    }));
  } catch {
    for (const r of rows) verdicts.set(r._id, 'not_known_stored');
    return verdicts;
  }
  const readEnded = Date.now();
  const ended = writeKnownEnded(writeError);
  for (const r of rows) {
    if (found.has(r._id)) verdicts.set(r._id, 'stored');
    else if (r.scheduledAt.getTime() <= readEnded || !ended) verdicts.set(r._id, 'not_known_stored');
    else verdicts.set(r._id, 'not_stored');
  }
  return verdicts;
}
