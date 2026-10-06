/**
 * How a manual scan of several spaces answers a space that fails — the one loop both scan routes run (`Q-381`, the 5.6.6 patch).
 *
 * ## The question it answers
 *
 * `POST /api/duplicates/scan` and `POST /api/contradictions/scan` scan every space the token may (or the one named). Each looped the
 * scanner's `scanSpace` with no `catch`, so ONE space whose scan threw ended the request in the route's catch: a `500 Internal error`, no
 * word of which space, and the spaces behind it never scanned — while the ones before it had been, so the operator could not tell what
 * the failed request had done. The background walks already isolated each space; a request has no walk above it, so this is its loop.
 *
 * What a request answers for a space that failed is NAMED: it is in `failedSpaces` with a reason in words of ours, said in the server log
 * (`runSpaceStep`, every time: a manual scan is a deliberate act), and the scan goes on to the next space.
 *
 * ## The reason is ours, never the driver's
 *
 * The driver's text names hosts, collections and values, and is the log's. What a caller reads is `caughtFailureText`'s: our own error's
 * message as it is, and a failure the DATABASE DRIVER raised as one sentence of ours (which also logs the driver's text, under the
 * operation it names).
 *
 * One response field for both routes: `failedSpaces: [{ spaceId, reason }]`, present and empty when nothing failed, so a client reads
 * its length without a guard. Two routes that each built it would answer it differently within a release.
 */
import { caughtFailureText } from './store-failure.js';
import { runSpaceStep } from '../spaces/space-step.js';
import { peerText } from '../util/log.js';

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

/**
 * Scan each of `spaceIds` with `scanOne`, one after the other (the scan is write-heavy and a request is no place to fan out), and answer
 * what was scanned and what failed. `step` is the log's name for the scan (`Dupe scan`, `Contradiction scan`). Never throws for a
 * space's failure.
 */
export async function scanSpacesInRequest<R>(
  step: string,
  spaceIds: readonly string[],
  scanOne: (spaceId: string) => Promise<R>,
): Promise<RequestScan<R>> {
  const results: R[] = [];
  const failedSpaces: FailedSpace[] = [];
  for (const spaceId of spaceIds) {
    const scanned = await runSpaceStep(step, spaceId, () => scanOne(spaceId), { everyTime: true });
    if (scanned.ok) results.push(scanned.value);
    else failedSpaces.push({ spaceId, reason: caughtFailureText(scanned.error, `${step} of space '${peerText(spaceId)}'`) });
  }
  return { results, failedSpaces };
}
