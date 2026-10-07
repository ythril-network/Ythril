/**
 * How a deletion the authority DECLINED is worded, counted and said — one spelling for a record's tombstone and a file's, on
 * the receiving apply and on the sender that is told about it.
 *
 * ## What it prevents
 *
 * `sync/deletion-authority.ts` answers `not_issuer`, `not_author` or `not_upstream`, and each apply
 * (`sync/tombstone-apply.ts` for records, `files/peer-tombstone-apply.ts` for files) then has to tell an operator which half
 * failed. Written in each, the two sets of words drift (the file door had no words at all until bundle-51), and so does the
 * rate they are said at: a publisher whose deletions are declined here sends the same ones every cycle, so a line per cycle
 * is the same fact for ever, and a count alone says nothing of who. So the words and the once-per-window rule are here.
 *
 * The same drift was waiting on the other side of the wire. A sender reads `refused` and `declined` out of the peer's answer
 * and says them, and the file push had read neither while the record push read both. {@link declinedCountOf},
 * {@link refusedCountOf}, {@link sayPeerDeclined} and {@link sayPeerRefused} are that reading and saying, so a push that
 * carries tombstones of a new kind starts with both. And the three things an apply does with one decline — the answer's list,
 * the per-reason list its warning is built from, and the counter (`ythril_sync_tombstones_declined_total`, which carries the
 * kind) — are {@link recordDecline}, because a copy that forgot the counter is a decline an operator's dashboard never sees.
 *
 * Every peer value in a line goes through `peerText` (`Q-270`): the issuer, the deliverer and the stamp are text a peer chose.
 */
import { log, logSafe, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { syncTombstonesDeclinedTotal } from '../metrics/registry.js';
import { warnArrivalsNotStored, type ArrivalRefusal } from './arrivals.js';
import type { Delivery, DeletionGround, DeletionTarget } from './deletion-authority.js';

export type DeclineReason = 'not_issuer' | 'not_author' | 'not_upstream';

/**
 * How long a standing condition that keeps happening is said once: the counter carries the rate, so the line is for the first
 * sight and a reminder per window. The one window of a declined deletion and of a stop in the one-time re-read of an
 * upstream's tombstones (`sync/tombstone-transfer.ts`), which are the same kind of fact — owed, tried every cycle, and
 * unchanged by being said again.
 */
export const SAID_AGAIN_MS = 60 * 60_000;
const declineSaid = warnOnce<string>({ every: SAID_AGAIN_MS });

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

/** What an apply keeps of the declines of one page: the answer's list, and the per-reason list its warning is built from. */
export interface DeclineLedger {
  declined: ArrivalRefusal[];
  declinedBy: Map<string, ArrivalRefusal[]>;
}

/**
 * Record one decline: the answer's `declined` list, the per-reason list {@link sayDeclines} reads, and the counter — all
 * three, so none can be left out by a caller. `kind` is the counter's label (a record's collection kind, or `file`), and
 * `what` the noun the words use.
 */
export function recordDecline(
  ledger: DeclineLedger,
  d: {
    id: string; reason: DeclineReason; kind: string; what: 'record' | 'file';
    issuer: string | undefined; delivery: Delivery; target: DeletionTarget | undefined;
  },
): void {
  const reason = declineText(d.reason, d.what, { issuer: d.issuer, delivery: d.delivery, target: d.target });
  ledger.declined.push({ _id: d.id, reason });
  if (!ledger.declinedBy.has(d.reason)) ledger.declinedBy.set(d.reason, []);
  ledger.declinedBy.get(d.reason)!.push({ _id: d.id, reason });
  syncTombstonesDeclinedTotal.labels({ kind: d.kind, reason: d.reason }).inc();
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

/**
 * Say what an apply deleted on the strength of the upstream: one line per page, and only when the upstream's own say-so
 * deleted something — the issuer ground alone is the rule as it always was and needs no line. `what` is `record` or `file`.
 * The one-time re-read of an upstream's tombstones does not call it: it states its deletions once, in its own completion line.
 */
export function saidDeletions(
  where: string, what: 'record' | 'file', spaceId: string, tally: Readonly<Record<DeletionGround, number>>,
): void {
  if (tally.upstream === 0) return;
  log.info(`${logSafe(where)}: deleted ${tally.upstream} ${what}(s) in space '${peerText(spaceId)}' on the upstream's say-so `
    + `(its own deletions of what it relayed here); ${tally.issuer} more on the issuer's own authority`);
}

/** A count a peer's answer carries, additive (an older peer sends none): a positive number, else 0. */
const countOf = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0);

/** How many of a pushed page the peer's answer says it did not honour on authority (`declined`, bundle-51); 0 when it says none. */
export const declinedCountOf = (body: { declined?: unknown }): number => countOf(body.declined);

/** How many of a pushed page the peer's answer says it refused by shape or seq (`refused`, bundle-46); 0 when it says none. */
export const refusedCountOf = (body: { refused?: unknown }): number => countOf(body.refused);

/** What a push carries, as the line that reports its answer names it: a record's tombstones, or a file's. */
export type PushedFamily = 'tombstones' | 'file tombstones';

/**
 * What a peer that declined a pushed tombstone holds instead — the reason in words, per family. Here rather than in each
 * push, so the two pushes cannot tell an operator different things about the same refusal.
 */
const DECLINED_BECAUSE = {
  tombstones: 'it holds those records as another peer\'s, or no stamp of this instance',
  'file tombstones': 'a file it holds as another peer\'s, or that it did not get from this instance',
} as const satisfies Record<PushedFamily, string>;

/** The opening of a line about a push: what it carried, to whom and for which space — every peer value bounded here. */
const pushLine = (family: PushedFamily, peer: unknown, spaceId: string): string =>
  `Push ${family} to ${peerText(peer)} for space '${peerText(spaceId)}'`;

/**
 * Tell an operator the peer declined `n` of what a push sent. A re-send is declined again, so the push advances past them and
 * this line is the only thing that says so. Says nothing for `0`.
 */
export function sayPeerDeclined(family: PushedFamily, peer: unknown, spaceId: string, n: number): void {
  if (n > 0) log.warn(`${pushLine(family, peer, spaceId)}: the peer declined ${n} tombstone(s) on authority (${DECLINED_BECAUSE[family]}); its own log names them.`);
}

/** Tell an operator the peer refused `n` of what a push sent by shape or seq, which a re-send cannot change. Says nothing for `0`. */
export function sayPeerRefused(family: PushedFamily, peer: unknown, spaceId: string, n: number): void {
  if (n > 0) log.warn(`${pushLine(family, peer, spaceId)}: the peer refused ${n} tombstone(s) by shape or seq; its own log names them.`);
}
