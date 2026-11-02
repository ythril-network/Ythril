/**
 * What a throw means to the transfer it ended: a page THIS instance could not land, a stop for shutdown, or the peer's fault (bundle-39 D1, D5; Q-220, Q-228).
 *
 * ## The defect it closes
 *
 * A pulled page that parsed and then failed to land here (a store fault, a view where a collection should be, a stepping-down primary) stopped its
 * transfer as `'error'`, the same kind as a peer that answered 500. The scheduled door counted it toward PEER UNREACHABLE, so an operator was sent to
 * look at a healthy peer for a fault in their own store, and the manual door did not look at it at all. A turn's fetch that shutdown aborted was an
 * `'error'` too, so every shutdown during a cycle counted a failure for every member in flight.
 *
 * ## The two questions, each asked at the one place it can be answered
 *
 *  - {@link landingStop}: the page step's catch (`pull-family.ts`, the tombstone apply inside `pullTombstones`). Whatever is thrown while LANDING a page
 *    the peer delivered is this instance's: the peer's part is done once the page parsed. Not limited to `isStoreSide`: a bug that throws while landing
 *    is not the peer's either, and counting it toward PEER UNREACHABLE is the defect. The reason says which (store failure or not), in our words.
 *  - {@link stopKindIfShutdownBegan}: the catches around a fetch. A throw while shutdown is under way is the shutdown's abort (`shutdownSignal`), `'closing'`;
 *    anything else stays `'error'`. {@link stopAtClosing} and {@link stopIfClosingThrew} are the two pagers' shutdown stops, written once.
 *
 * The guard each caller would forget is inside: the transfer is stopped with its kind here, so a catch cannot log a local fault and leave the
 * transfer to the pager's generic `'error'` (`stopTransfer` lets `'error'` yield to the kind set first).
 */
import { isStoreSide } from '../brain/store-failure.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { isShuttingDown } from '../lifecycle.js';
import { logSafe, peerText } from '../util/log.js';
import { stopTransfer, type TransferOutcome, type TransferStop, type TransferStopped } from './watermark.js';

/**
 * The sentence a page that could not land here is logged and recorded under. Names this instance, never the peer, and carries the error's message
 * through `logSafe` (bounded, control characters out): it goes to the log and the cycle's history, never into an answer body.
 */
export function arrivalStopReason(err: unknown, spaceId: string): string {
  const message = logSafe(err instanceof Error ? err.message : String(err));
  return isStoreSide(err)
    ? `this instance's database failed while landing a page in space '${peerText(spaceId)}' (${message}); the page is fetched again next cycle`
    : `this instance could not land a page in space '${peerText(spaceId)}' (${message}); the page is fetched again next cycle`;
}

/** Stop `outcome` as `'local'` for `err`, thrown while landing a delivered page, and return the reason for the pager's own stop. */
export function landingStop(outcome: TransferOutcome, err: unknown, spaceId: string): string {
  const reason = arrivalStopReason(err, spaceId);
  stopTransfer(outcome, () => {}, reason, 'local');   // said once, by the pager's own stop for the reason handed back
  if (storeIsNotAnswering(err)) outcome.storeDown = true;   // a total outage: the cycle stops at this member (v6 S6)
  return reason;
}

/**
 * `'closing'` for a throw while shutdown is under way, `'error'` for anything else. It reads no error: it asks only whether shutdown has begun, which is
 * the shutdown signal's abort for the fetch that threw (`beginShutdown`, `lifecycle.ts`, sets `shuttingDown` and aborts `shutdownSignal` in the one call,
 * so `isShuttingDown()` already says the signal is aborted and a second check would only restate it).
 */
export function stopKindIfShutdownBegan(): Extract<TransferStop, 'closing' | 'error'> {
  return isShuttingDown() ? 'closing' : 'error';
}

/** The reason a transfer that stopped for shutdown carries. */
const CLOSING_REASON = 'shutdown began';

/**
 * The page-boundary stop for shutdown, in both pagers (`position-run-pager.ts`, `push-position-runs.ts`): stop the transfer as `'closing'` where the last
 * page landed, `true` when it did. `shouldStop` defaults to shutdown having begun, so no caller can leave a transfer paging through the drain; a test
 * passes its own.
 */
export function stopAtClosing(outcome: TransferOutcome, stopped: TransferStopped, shouldStop: () => boolean = isShuttingDown): boolean {
  if (!shouldStop()) return false;
  stopTransfer(outcome, stopped, CLOSING_REASON, 'closing');
  return true;
}

/**
 * The catch around a page's fetch or send, in both pagers: a throw the shutdown signal caused stops the transfer for shutdown (`true`) and is never the
 * member's failure; any other throw is `false`, and the caller rethrows it for the engine to read.
 */
export function stopIfClosingThrew(outcome: TransferOutcome, stopped: TransferStopped): boolean {
  if (stopKindIfShutdownBegan() !== 'closing') return false;
  stopTransfer(outcome, stopped, CLOSING_REASON, 'closing');
  return true;
}
