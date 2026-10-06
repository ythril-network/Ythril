/**
 * How a manual scan of several spaces answers a space that fails — the one loop both scan routes run (`Q-381`, bundle-53 G31).
 *
 * ## The question it answers
 *
 * `POST /api/duplicates/scan` and `POST /api/contradictions/scan` scan every space the token may (or the one named). Each looped the
 * scanner's `scanSpace` with no `catch`, so ONE space whose scan threw ended the request in `sendCaughtFailure`: a `500`, no word of
 * which space, and the spaces behind it never scanned — while the ones before it had been, so the operator could not tell what the failed
 * request had done. The background walks stopped doing that in G16 (`eachSpace`); a request has no walk above it, so this is its loop.
 *
 * What a request answers for a space is two different things, and they must not be told alike:
 *
 *  - **a space that failed** is NAMED: it is in `failedSpaces` with a reason in words of ours, said once in the server log by the shared
 *    reporter (`reportSpaceFailure`, `when: 'next scan'`), and the scan goes on to the next space;
 *  - **a store that is not answering** (`storeIsNotAnswering`, `db/store-condition.ts`) ENDS the request: the next space would wait the
 *    same timeout, once per space, while the operator waits. It is rethrown, so the route's `catch` answers it as every door answers a
 *    store failure (`sendCaughtFailure`: the retryable `503`). It is not reported here: that `catch` logs it, once.
 *
 * ## The reason is ours, never the driver's
 *
 * The driver's text names the stage, the collection and the value, and is the log's (the reporter says it there). What a caller reads is
 * `classifyReadFailure`'s sentence for a failure on the store's side or a driver fault, and `refusalText`'s for anything else: our own
 * error's message as it is, one generic sentence for a refusal the DATABASE raised. `refusalText` is asked only of what
 * `classifyReadFailure` did not already answer on the store's side, because it rethrows that — and a space whose scan failed with a
 * store-side error that is not "not answering" (a search index rebuilding) is still one space's failure, not the request's.
 *
 * One response field for both routes: `failedSpaces: [{ spaceId, reason }]`, present and empty when nothing failed, so a client reads
 * its length without a guard.
 */
import { classifyReadFailure, refusalText } from './store-failure.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { reportSpaceFailure } from '../util/space-failure.js';

/** One space a manual scan could not scan, and why — in words of ours (see the module docblock). */
export interface FailedSpace {
  spaceId: string;
  reason: string;
}

/** What a manual scan of several spaces did: what each scanned space returned, and the spaces that failed. */
export interface RequestScan<R> {
  /** The scanner's result for each space that was scanned, in the order they were asked. */
  results: R[];
  /** Always present — empty when every space was scanned. */
  failedSpaces: FailedSpace[];
}

/** The sentence a caller reads for why a space's scan failed: never the driver's text. */
function reasonInOurWords(err: unknown): string {
  const answered = classifyReadFailure(err);
  // A failure on the store's side or a driver fault: the sentence classifyReadFailure answers every door with.
  if (answered.status >= 500) return answered.error;
  return refusalText(err);
}

/**
 * Scan each of `spaceIds` with `scanOne`, one after the other (the scan is write-heavy and a request is no place to fan out), and answer
 * what was scanned and what failed. `step` is the reporter's name for the scan (`Dupe scan`, `Contradiction scan`).
 *
 * Throws only a failure that says the store is not answering, which ends the request (see the module docblock).
 */
export async function scanSpacesInRequest<R>(
  step: string,
  spaceIds: readonly string[],
  scanOne: (spaceId: string) => Promise<R>,
): Promise<RequestScan<R>> {
  const results: R[] = [];
  const failedSpaces: FailedSpace[] = [];
  for (const spaceId of spaceIds) {
    try {
      results.push(await scanOne(spaceId));
    } catch (err) {
      if (storeIsNotAnswering(err)) throw err;
      reportSpaceFailure(step, spaceId, err, { when: 'next scan' });
      failedSpaces.push({ spaceId, reason: reasonInOurWords(err) });
    }
  }
  return { results, failedSpaces };
}
