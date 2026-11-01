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
 *  - {@link stopKindOfThrow}: the catches around a fetch. A throw while shutdown is under way is the shutdown's abort (`shutdownSignal`), `'closing'`;
 *    anything else stays `'error'`.
 *
 * The guard each caller would forget is inside: the transfer is stopped with its kind here, so a catch cannot log a local fault and leave the
 * transfer to the pager's generic `'error'` (`stopTransfer` lets `'error'` yield to the kind set first).
 */
import { isStoreSide } from '../brain/store-failure.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { isShuttingDown, shutdownSignal } from '../lifecycle.js';
import { logSafe, peerText } from '../util/log.js';
import { stopTransfer, type TransferOutcome, type TransferStop } from './watermark.js';

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

/** `'closing'` for a throw while shutdown is under way (the shutdown signal aborted the fetch), `'error'` for anything else. */
export function stopKindOfThrow(_err: unknown): Extract<TransferStop, 'closing' | 'error'> {
  return isShuttingDown() && shutdownSignal().aborted ? 'closing' : 'error';
}
