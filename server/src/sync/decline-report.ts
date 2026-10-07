/**
 * How a deletion the authority DECLINED is worded and said — one spelling for a record's tombstone and a file's.
 *
 * ## What it prevents
 *
 * `sync/deletion-authority.ts` answers `not_issuer`, `not_author` or `not_upstream`, and each apply
 * (`sync/tombstone-apply.ts` for records, `files/peer-tombstone-apply.ts` for files) then has to tell an operator which half
 * failed. Written in each, the two sets of words drift (the file door had no words at all until bundle-51), and so does the
 * rate they are said at: a publisher whose deletions are declined here sends the same ones every cycle, so a line per cycle
 * is the same fact for ever, and a count alone says nothing of who. So the words and the once-per-window rule are here, and
 * the counter (`ythril_sync_tombstones_declined_total`) stays the apply's, because it carries the kind.
 *
 * Every peer value in a line goes through `peerText` (`Q-270`): the issuer, the deliverer and the stamp are text a peer chose.
 */
import { peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { warnArrivalsNotStored, type ArrivalRefusal } from './arrivals.js';
import type { Delivery, DeletionTarget } from './deletion-authority.js';

export type DeclineReason = 'not_issuer' | 'not_author' | 'not_upstream';

/**
 * How long a decline that keeps happening is said once: the counter carries the rate, so the line is for the first sight
 * and a reminder per window.
 */
const DECLINE_SAID_AGAIN_MS = 60 * 60_000;
const declineSaid = warnOnce<string>({ every: DECLINE_SAID_AGAIN_MS });

/** The words a decline carries, per reason, for a `what` (`record` or `file`). */
export function declineText(
  reason: DeclineReason, what: 'record' | 'file',
  { issuer, delivery, target }: { issuer: string | undefined; delivery: Delivery; target: DeletionTarget | undefined },
): string {
  const peer = peerText(delivery.peerInstanceId ?? '-');
  const issuerText = peerText(issuer ?? '-');
  if (reason === 'not_issuer') {
    return `issuer '${issuerText}' is not the delivering peer '${peer}' — possible cross-instance delete forgery`;
  }
  if (reason === 'not_author') {
    return `the ${what} here was written by '${peerText(target?.author?.instanceId)}', not by the issuer '${issuerText}'`;
  }
  return `the ${what} here was not delivered by the upstream '${peer}' (delivered by '${peerText(target?.deliveredBy ?? '-')}'), and it did not write it`;
}

/**
 * Say a page's declines: ONE warning per (peer, space, family, reason) window, however many pages repeat it. A family is
 * what the apply names its elements (`tombstone`, `file tombstone`).
 */
export function sayDeclines(
  where: string, spaceId: string, family: string, delivery: Delivery, declinedBy: ReadonlyMap<string, ArrivalRefusal[]>,
): void {
  for (const [reason, items] of declinedBy) {
    declineSaid(JSON.stringify([delivery.peerInstanceId ?? '', spaceId, family, reason]),
      () => warnArrivalsNotStored(where, spaceId, family, `declined (${reason})`, items));
  }
}
