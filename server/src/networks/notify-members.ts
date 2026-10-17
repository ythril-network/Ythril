/**
 * Tell a network's members something through their `POST /api/notify` — the ONE sender of every notice this instance sends a member
 * (bundle-106, design v5 §1.6, R5, VR19, W20; ruling R-P2).
 *
 * ## What it prevents
 *
 * "Tell the members to pull now" was written three times (the deletion door, the wipe planner, the schema-change opener), and two more
 * notices — a departure and a removal — were two more hand-written POSTs. Each copy read the peer's token on the caller's stack, two used
 * a bare `fetch`, the timeouts were three literals, and one event was sent for months that the receiver's enum refused with a 400 nobody
 * read (`Q-108`). And the openers that could now decide a round at open would have told nobody, because the telling lived in the doors.
 * So: one module, called by `proposeRound` (so no opener can leave it out) and by the two member notices; the event and its payload come
 * from ONE table; the recipients come from a snapshot taken before the round acted (a deletion takes the space out of the network); the
 * peer's token is read at SEND time; every send goes through `peerSafeFetch` with a named timeout; and each failure is logged naming the
 * network, the member, the event and the round.
 *
 * ## What it does not promise
 *
 * Delivery. A notice is a wake-up, best-effort: a member that misses it sees the round at its next scheduled cycle, within the round's
 * deadline (D-37 → Q-516 for one back after it). A failure never fails the caller's request.
 */
import { getConfig, getSecrets } from '../config/loader.js';
import type { VoteRoundType } from '../config/types.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { log, peerText } from '../util/log.js';

/** How long one notice may take: a wake-up is not worth waiting longer for, and `peerSafeFetch`'s own default is a transfer's. */
export const NOTIFY_SEND_TIMEOUT_MS = 5_000;

/**
 * Every notice this instance sends a member, and whether the receiver runs a sync cycle on it. The receiver's trigger set
 * (`SYNC_TRIGGER_EVENTS`, `api/notify.ts`) must say the same: `every-round-is-opened-and-settled-by-one-function` holds the two together.
 *
 * `meta_change_pending` does NOT wake (W19 cut): a receiver running a full cycle on it costs about members² × spaces requests per
 * schema edit, and a schema change reaching members at their next scheduled cycle is what it always did. The receiver records it.
 */
export const NOTICE_EVENTS = [
  { event: 'space_deletion_pending', round: 'space_deletion', wakes: true },
  { event: 'space_wipe_pending', round: 'space_wipe', wakes: true },
  { event: 'meta_change_pending', round: 'meta_change', wakes: false },
  { event: 'sync_available', round: 'space_addition', wakes: true },
  { event: 'member_departed', round: null, wakes: false },
  { event: 'member_removed', round: null, wakes: false },
] as const;

export type NoticeEvent = typeof NOTICE_EVENTS[number]['event'];

/** Who to tell about a round, captured BEFORE the round acted: a deletion takes the space out of the network and drops its label. */
export interface RoundNoticeSnapshot {
  networkId: string;
  label?: string;
  roundId: string;
  type: VoteRoundType;
  /** The NETWORK's id for the space the round is about. */
  spaceId?: string;
  spaceLabel?: string;
  /** A wipe's covered types, present only when the round names a subset. */
  types?: readonly string[];
  members: { instanceId: string; url: string; label?: string }[];
}

let pending = 0;

/** Notices queued or being sent now — the quiescence a test waits for before it asserts that something was NOT sent. */
export function notifySendsPending(): number {
  return pending;
}

/**
 * Send one notice to one member, reading its token NOW. Resolves to the response status, `null` when the member has no token any more
 * (it was removed meanwhile, and is skipped), and rejects on a transport error. `what` names the notice in the log.
 */
export async function sendNotice(
  networkId: string, member: { instanceId: string; url: string }, event: NoticeEvent, data?: Record<string, unknown>,
  timeoutMs: number = NOTIFY_SEND_TIMEOUT_MS,
): Promise<number | null> {
  const peerToken = getSecrets().peerTokens[member.instanceId];
  if (!peerToken) return null;
  pending++;
  try {
    const res = await peerSafeFetch(`${member.url}/api/notify`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ networkId, instanceId: getConfig().instanceId, event, ...(data ? { data } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } finally {
    pending--;
  }
}

/** The event and payload a round of this type is told with, or `null` for a round nobody is woken for (a join, a removal). */
function noticeOf(s: RoundNoticeSnapshot): { event: NoticeEvent; data: Record<string, unknown> } | null {
  const row = NOTICE_EVENTS.find(r => r.round === s.type);
  if (!row) return null;
  const data: Record<string, unknown> = { spaceId: s.spaceId, spaceLabel: s.spaceLabel };
  if (s.type === 'space_wipe' && s.types && s.types.length > 0) data['types'] = [...s.types];
  return { event: row.event, data };
}

/**
 * Tell every member in `snapshot` to pull the round now — deferred past the caller's synchronous save, each member's token read when it
 * is sent. Resolves when every send has ended; never rejects, and nothing the caller does waits for it.
 */
export function notifyMembersToPull(snapshot: RoundNoticeSnapshot): Promise<void> {
  const notice = noticeOf(snapshot);
  if (!notice || snapshot.members.length === 0) return Promise.resolve();
  pending++;
  return new Promise<void>(resolve => setImmediate(() => {
    pending--;
    const what = (m: { instanceId: string }) =>
      `${notice.event} to member ${peerText(m.instanceId)} of network ${peerText(snapshot.networkId)} (round ${peerText(snapshot.roundId)})`;
    void Promise.allSettled(snapshot.members.map(async (m) => {
      try {
        const status = await sendNotice(snapshot.networkId, m, notice.event, notice.data);
        if (status === null) log.info(`${what(m)} not sent: the member has no token here any more`);
        else if (status < 200 || status >= 300) log.warn(`${what(m)} answered HTTP ${status}`);
        else log.debug(`${what(m)} sent`);
      } catch (err) {
        log.warn(`${what(m)} failed: ${peerText(err)}`);
      }
    })).then(() => resolve(), (err: unknown) => { log.error(`notify of round ${peerText(snapshot.roundId)}: ${peerText(err)}`); resolve(); });
  }));
}
