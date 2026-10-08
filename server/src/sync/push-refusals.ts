/**
 * A `200` from a peer does not mean every record landed. This is the part that notices.
 *
 * ## What was silent
 *
 * `POST /api/sync/batch-upsert` refuses a fact whose content diverges at an identical `seq` once that
 * record's fork chain is at `MAX_FORK_DEPTH`: the incoming version is discarded and the request still answers
 * `200`. Until now that was counted in the same `skipped` integer as *"I already hold this record, at the same
 * seq or newer"* — which is the common case, is correct, and loses nothing.
 *
 * One number, two opposite meanings. So the lossy one had never been seen.
 *
 * And the pusher checked only `resp.ok`, never the body. It then advanced `lastSeqPushed` past the discarded
 * record and **never offered it again** — a permanent loss, unreported at both ends.
 *
 * ## Why the watermark still advances
 *
 * The receiver would refuse the identical record on every future cycle, so holding the watermark back would
 * stall that space's sync entirely and deliver nothing. **The defect was the silence, not the advance** — the
 * same conclusion the swallowed media-worker writes reached earlier in this release cycle: the fix is
 * visibility, not severity.
 *
 * ## Why this is its own file
 *
 * `no-new-god-files.test.js` freezes `sync/engine.ts` at its current size and says why: *"the failure mode of
 * a god-file is not its size on any given day — it is that every change lands in the same place because that
 * is where the code already is. Put the new behaviour beside it rather than inside it."* It refused this
 * change inside the engine, correctly, so the behaviour lives here and the engine calls it.
 */
import { log, peerText } from '../util/log.js';
import { boundedJson } from '../util/bounded-read.js';
import { LruMap } from '../util/lru-map.js';
import { warnOnce } from '../util/warn-once.js';
import { SKIP_WARNING_WINDOW_MS } from '../util/single-flight.js';
import { peerRunsAtLeast } from './peer-floor.js';

/**
 * The per-type counters `batch-upsert` returns. `rejected` is every record of the family the peer neither stored nor
 * already held (Q-59); `forkDepthRefused` is what a peer before 5.5 sends instead, and the only refusal it counted.
 */
type BatchUpsertReply = Record<string, { rejected?: number; forkDepthRefused?: number } | undefined> | null;

/**
 * Report records the peer accepted the request for and then discarded. Never throws.
 *
 * **`boundedJson` and not `resp.json()`**: this body comes from a peer, and `resp.json()` would read whatever
 * it sends into fact with no ceiling. The batch timeout does not help — it bounds duration, not size, and
 * `upstream-reads-are-bounded.test.js` refuses the unbounded form.
 *
 * **Every failure here is swallowed on purpose, and this is the one place that is right.** The push already
 * succeeded; a peer on an older build sends no such field, and a body that will not parse must not turn a
 * delivery the peer accepted into a failed one. The cost of being wrong is a missing log line, and the
 * alternative is failing sync over a diagnostic.
 */
export async function reportPushRefusals(
  resp: Response,
  payloadKey: string,
  peerLabel: string,
  spaceId: string,
  batchSize: number,
): Promise<number> {
  const refused = await countPushRefusals(resp, payloadKey, peerLabel, batchSize);
  warnPushRefusals(payloadKey, peerLabel, spaceId, refused, batchSize);
  return refused;
}

/**
 * How many records of the family a peer's answer says it discarded — the read half of `reportPushRefusals`, for the
 * caller that must decide before it says anything: a push that will OFFER the refused records again on another wire has
 * not dropped them, and a warning that they "will not be offered again" would be false. Same swallowing, same bounds.
 */
export async function countPushRefusals(resp: Response, payloadKey: string, peerLabel: string, batchSize: number): Promise<number> {
  try {
    const body = await boundedJson<BatchUpsertReply>(
      resp, `batch-upsert ${payloadKey} response from ${peerLabel}`);
    const stats = body?.[payloadKey];
    // Clamped: a peer's number is a claim, and one larger than the batch must not make `pushed` negative.
    return Math.min(Math.max(0, Number(stats?.rejected ?? stats?.forkDepthRefused ?? 0) || 0), batchSize);
  } catch { return 0; /* a diagnostic must never fail a push the peer accepted */ }
}

/** The warning for records a peer discarded and that will not be offered again — said by `reportPushRefusals`. */
export function warnPushRefusals(payloadKey: string, peerLabel: string, spaceId: string, refused: number, batchSize: number): void {
  if (refused <= 0) return;
  log.warn(`Batch push ${peerText(payloadKey)} to ${peerText(peerLabel)}: ${refused} of ${batchSize} record(s) DROPPED, refused by the peer `
    + `in space '${peerText(spaceId)}' (invalid for its schema, an undeclared type, an implausible seq, or a fork chain at `
    + 'its cap). They are not counted as pushed and will not be offered again — the log on the peer names the records.');
}

// ── Which wire a peer takes (`Q-256`) ──────────────────────────────────────────────────────────────────────────────

/**
 * Peers that refused the NEWER wire although the version they report takes it, by instance id, with the version they
 * reported when they did. Kept in memory, bounded: it is a saving and a safeguard, never a rule — a restart forgets it
 * and costs one refused page, re-offered on the older wire as the first time.
 */
const MAX_PEERS_REMEMBERED = 1_000;
const refusedTheNewerWire = new LruMap<string, string>(MAX_PEERS_REMEMBERED);

/** The version a member reports, as this module compares it: a change of the report (an upgrade, a rollback) is news. */
const reportedVersion = (member: { version?: string | null }): string => member.version?.trim() ?? '';

/**
 * Does this peer take a wire introduced in `since`? It does when its reported version says so
 * (`peerRunsAtLeast`: an unknown or unparseable version does NOT) and it has not REFUSED that wire at this version.
 *
 * **The second half is a rollback.** A version is self-reported and gossiped late: a peer rolled back to a release that
 * refuses the newer keys still reports the newer version until the next exchange says otherwise, and a push in between
 * would be refused whole per document and counted delivered. So a refusal marks the peer OLD until its reported version
 * changes (`rememberRefusedTheNewerWire`), and the refused page is offered again on the older wire by the caller.
 */
export function peerTakesWireSince(member: { instanceId: string; version?: string | null }, since: string): boolean {
  if (!peerRunsAtLeast(member, since)) return false;
  return refusedTheNewerWire.peek(member.instanceId) !== reportedVersion(member);
}

/** The peer refused a page sent on the newer wire that the older wire then delivered: it does not take it, at this version. */
export function rememberRefusedTheNewerWire(member: { instanceId: string; version?: string | null }): void {
  refusedTheNewerWire.set(member.instanceId, reportedVersion(member));
}

/** Forget every peer that refused a wire. For tests. */
export function forgetRefusedWires(): void { refusedTheNewerWire.clear(); }

const olderWireSaid = warnOnce<string>({ every: SKIP_WARNING_WINDOW_MS });

/**
 * Say, once per peer per window, that this peer is sent the older wire — so an operator who removed a key and sees it
 * survive on one peer reads why in this instance's log, and which version ends it. Through `peerText`: the label and the
 * version are the peer's.
 */
export function warnOlderWire(member: { instanceId: string; label?: string | null; version?: string | null }, since: string, what: string): void {
  olderWireSaid(member.instanceId, () => log.warn(
    `Push to ${peerText(member.label ?? member.instanceId)}: ${peerText(what)} goes on the older wire, because this peer is not known to run `
    + `${peerText(since)} or later (it reports ${member.version ? `'${peerText(member.version)}'` : 'no version'}, or refused the newer wire). `
    + 'Keys removed here reach it on the file\'s next edit; nothing it does not understand is sent to it.'), reportedVersion(member));
}

/**
 * The refusals of one push, one entry per family, for the member's `incomplete` list — so a cycle whose records the
 * peer refused is recorded as not complete, with the count, instead of `success` (Q-59). The watermark still
 * advances (see the top of this file); what changes is that the history says what did not land.
 */
export function refusedTransfers(pushed: Record<string, { refused?: number }>): string[] {
  return Object.entries(pushed).filter(([, r]) => (r.refused ?? 0) > 0).map(([k, r]) => `${k}: ${r.refused} refused by the peer`);
}
