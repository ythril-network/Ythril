/**
 * Did a BOUND end this database operation — in any of the shapes the driver reports it in?
 *
 * ## Why it is its own question, and why it is not one error class
 *
 * A write issued while a seq hold is active is bounded (`db/write-bound.ts`), because a write that never ends holds
 * every seq-paged reader of its space below it (`Q-213`). The bundle-30 design probe ended blocked writes with a
 * bound on the real store and recorded what came back, and it is not one error:
 *
 * | how the write was bounded | what the caller receives |
 * |---|---|
 * | a single-document write + `timeoutMS` | `MongoOperationTimeoutError`, no code |
 * | any write + `maxTimeMS` | code 50 `MaxTimeMSExpired`, as `MongoServerError` OR `MongoBulkWriteError` |
 * | `bulkWrite` / `insertMany` + `timeoutMS` | `MongoBulkWriteError`, NO code, message `Timed out during socket read (…)` or `Server reported a timeout error` |
 * | `withTransaction` under a session timeout | the LAST attempt's error: 112 `WriteConflict`, labelled `TransientTransactionError` |
 * | a hold whose deadline passed before the operation was sent | `StoreTimeout`, ours |
 *
 * A classifier keyed on `instanceof MongoOperationTimeoutError` alone answers "not a timeout" for a timed-out
 * batched write, and the arrival writer then reads it as one document's refusal (dropped from its sync page for
 * good) or a generic fault (a 500 that reads as our bug). Every shape is recognised here, once.
 *
 * ## What it never takes for a timeout
 *
 * `MongoInvalidArgumentError` — including the two the driver's own timeout machinery raises ("cannot be given a
 * timeoutMS setting…", "Cannot create a Timeout with a negative duration"). A misused bound is a defect to
 * surface; read as a timeout it would be retried for ever. (`db/write-errors.ts` no longer reads it as a
 * document's refusal either.)
 *
 * ## Wrappers are looked through
 *
 * Our own wrappers carry the driver's error as `underlying` (`ArrivalWriteError`, the counter error) and the driver
 * nests one as `cause`. A timeout wrapped by a writer is still a timeout to the door that must answer it. The walk is
 * `errorChain`'s, shared with the store-failure classifier.
 */
import { errorChain } from './error-chain.js';
import { isMaxTimeExpired } from './max-time.js';
import { writeErrorCode } from './write-errors.js';

/**
 * A hold's time was spent before an operation could be sent: the bound refused to send it rather than send it
 * unbounded (a `timeoutMS` of 0 means NO bound to the driver). The message is ours and says nothing about the
 * store's internals, because it is what a door answers.
 */
/**
 * The one sentence every store failure ends with, on every door and in this error alike: what the caller may rely on
 * and what to do (retry). Three spellings of it had grown (bundle-30 I6, C1).
 *
 * **True of a read as of a write (bundle-30 I12).** It said *"Nothing was confirmed written by it"*, which is the
 * guarantee a save needs and describes nothing the reader of a failed list load or search did — and the same sentence
 * answers both, since the REST error handler cannot tell them apart. So it states the one thing true of each: the
 * operation is not known to have completed (a read returned nothing; a write may or may not have landed, and was not
 * confirmed), and retrying is the remedy.
 */
export const STORE_RETRY_SENTENCE = 'It did not complete as far as this server can confirm; retry the request (store-side failure; retryable).';

export class StoreTimeout extends Error {
  constructor(what = 'the database operation') {
    super(`${what} could not be completed in time. ${STORE_RETRY_SENTENCE}`);
    this.name = 'StoreTimeout';
  }
}

/** The `MongoBulkWriteError` messages a `timeoutMS` produces, by which side of the socket fired first (probe P1). */
const BULK_TIMEOUT_MESSAGE = /^(Timed out during socket read|Server reported a timeout error)/;
const WRITE_CONFLICT = 112;

/** True when this error, or one it wraps (`errorChain`), is a bound ending the operation. */
export function isWriteTimeout(err: unknown): boolean {
  return errorChain(err).some(isTimeoutItself);
}

function isTimeoutItself(e: object): boolean {
  const name = (e as { name?: unknown }).name;
  if (name === 'MongoInvalidArgumentError') return false;
  if (e instanceof StoreTimeout || name === 'StoreTimeout' || name === 'MongoOperationTimeoutError') return true;
  const isDriverError = typeof name === 'string' && name.startsWith('Mongo');
  if (!isDriverError) return false;
  if (isMaxTimeExpired(e)) return true;
  if (name === 'MongoBulkWriteError' && BULK_TIMEOUT_MESSAGE.test((e as Error).message ?? '')) return true;
  const labelled = (e as { hasErrorLabel?: (l: string) => boolean }).hasErrorLabel;
  return writeErrorCode(e) === WRITE_CONFLICT && typeof labelled === 'function'
    && labelled.call(e, 'TransientTransactionError');
}
