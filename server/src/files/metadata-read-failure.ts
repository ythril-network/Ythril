import { classifyReadFailure, storeFailureDetail } from '../brain/store-failure.js';
import { log, logSafe } from '../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../util/warn-once.js';

/**
 * The words a listing uses for a member space whose file records could not be read, `metadataIncomplete` on the answer (Q-341).
 * A CLOSED vocabulary: a short lower-case word each, never the driver's text, an address, a path or a collection name.
 *
 * - `store-unavailable`: the store's own condition, one that retrying may clear (a pool cleared, a bound that ended the call, a stopped member);
 * - `store-fault`: the driver failed on its own side in a way nothing here recognises, or the deployment's write concern cannot be met;
 * - `unknown`: a failure that is not the store's at all (our own code threw).
 */
export const METADATA_READ_FAILURES = ['store-unavailable', 'store-fault', 'unknown'] as const;
export type MetadataReadFailure = (typeof METADATA_READ_FAILURES)[number];

const said = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });

/**
 * A member's metadata read failed: the reason to put in the listing's `metadataIncomplete`, and the operator's line, said once per window
 * per space (a page that polls its listing would otherwise write one per poll). The line names the space and carries the driver's account,
 * which the answer never does. A different reason for the same space is news and is said again.
 *
 * It prevents the listing swallowing the failure and listing the files bare, which reads as "nothing has been processed yet": a listing
 * that read a member's records and failed has no way to leave the classification or the log line out, because both are here.
 */
export function metadataReadFailed(space: string, err: unknown): MetadataReadFailure {
  const f = classifyReadFailure(err);
  const reason: MetadataReadFailure = f.status < 500 ? 'unknown' : f.retryable ? 'store-unavailable' : 'store-fault';
  said(space, () => {
    log.warn(`The Files listing of space ${logSafe(space)} lists its files without status, tags and folder sizes: reading its file records failed (${reason}): ${logSafe(storeFailureDetail(err))}`);
  }, reason);
  return reason;
}
