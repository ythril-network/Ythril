/**
 * The tombstone half of a sync cycle — both directions, side by side.
 *
 * ## Why it lives here rather than in `engine.ts`
 *
 * Pull and push each had their own inline block, twenty lines apart in a thousand-line file, and the two halves of
 * one protocol phase never got read together. That cost something specific: the pull's `!resp.ok` branch **did not
 * exist**. A peer answering `503` to a tombstone fetch applied nothing, logged nothing, and the cycle advanced its
 * watermark past the deletions anyway. The push side had a warn for the same case. One phase, two implementations,
 * and the weaker one silently won — which `CLAUDE.md` names as the defect this codebase produces most.
 *
 * ## Both return a `TransferOutcome`, and that is the point
 *
 * Brain tombstones travel in the SAME position stream as the record families (bundle-81, design rev 8 §6, Q-394): they are an ordinary transfer under
 * `lastPosReceived` / `lastPosPushed`, not a ceiling beside them. A deletion that did not transfer, followed by a mark that moved past it, is a deletion
 * that never propagates — and a tombstone-only cycle that moved no mark re-sent the same deletions for ever. So each direction reports how far it is
 * COMPLETE (`deliveredThrough`), and `sync/watermark.ts` takes the minimum over every transfer. A stop for ANY reason — a refused request, a throw,
 * the cycle's page bound — is a `truncated` outcome, and says whether it was a cap or a fault.
 *
 * ## Both page by position, the way the records do
 *
 *   - The PULL goes through `pagePositionRuns` (`sync/position-run-pager.ts`), the pager the record pull uses: the peer answers `{ items, nextCursor, through,
 *     head, positions: 1 }` with each tombstone carrying its `type`, and a run of equal positions pages through the cursor.
 *   - The PUSH goes through `pushPositionRuns` (`sync/push-position-runs.ts`) over `listTombstonesAfterPosition`, by `(pos, _id)`, and sends what the
 *     network's push selection offers (`sync/push-selection.ts`: every tombstone on a relaying network, the ones issued here on a mesh).
 *
 * Both doors APPLY through `applyPeerTombstones` (`sync/tombstone-apply.ts`), which owns the shape, seq, admitted-space and authorisation rules and the
 * guarded write. The pull hands it the `Delivery` of the page (`deliveryOf`, `sync/deletion-authority.ts`): who delivered it, and whether that peer is
 * this space's upstream — the ground on which it may delete what it relayed (bundle-51, D-14).
 *
 * The same pull, with `repair`, is the one-time RE-READ of an upstream's tombstones (`sync/tombstone-reread.ts`): its own start and outcome (never part of
 * the receive mark), its own wording, and its stops said once per window.
 */
import { peerSafeFetch } from './peer-fetch.js';
import { transferRefusal, turnSignal, type ExchangeTurn } from './held-answer.js';
import { boundedJson } from '../util/bounded-read.js';
import { listTombstonesAfterPosition } from '../brain/tombstones.js';
import { applyPeerTombstones, MAX_TOMBSTONES_PER_REQUEST } from './tombstone-apply.js';
import { pagePositionRuns } from './position-run-pager.js';
import { pushPositionRuns } from './push-position-runs.js';
import { readPushReply } from './push-refusals.js';
import { log, logSafe, peerText } from '../util/log.js';
import { PeerPagesBySeq, PositionsBuilding } from '../util/errors.js';
import { warnOnce } from '../util/warn-once.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { pushSelection } from './push-selection.js';
import { MAX_TRANSFER_PAGES, type TransferOutcome } from './watermark.js';
import { deliveryOfMember } from './deletion-authority.js';
import { SAID_AGAIN_MS, declinedCountOf, refusedCountOf, sayPeerDeclined, sayPeerRefused } from './decline-report.js';

/** What a push asks for per request. */
const PUSH_PAGE = 500;

/**
 * A stop of the one-time re-read that goes on being the same stop (an unknown type, a peer that answers 5xx) is said once
 * per window: the repair stays owed and is tried every cycle, so a line per try would be the same line for ever. The
 * ordinary pull says each stop each cycle, as it always has.
 */
const rereadSaid = warnOnce<string>({ every: SAID_AGAIN_MS });

/**
 * Fetch the peer's tombstones after the position `since` and apply them to the LOCAL space `spaceId`.
 *
 * Called BEFORE the record pull so deletions land before anything that would re-upsert a deleted doc. A failure
 * holds the watermark and is logged.
 *
 * `repair` is the same read made for the one-time RE-READ of an upstream's tombstones (`sync/tombstone-reread.ts`): it
 * applies with the repair's extra bound, is named as what it is in every line, and its stops are said once per window —
 * and none of them says a watermark is held, because the re-read has none: it is owed or it is done.
 */
export async function pullTombstones(opts: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  /** The peer's position this pull is complete through (the mark), or where a re-read is owed from. */
  since: number;
  requestInit: () => RequestInit;
  repair?: boolean;
  /** The records deleted per ground are added here, for the re-read's own completion line. */
  tally?: { issuer: number; upstream: number };
  /** The space's turn with this member: its signal cuts the page in flight, and a refusal the peer answers is handed to it. */
  turn?: ExchangeTurn;
}): Promise<TransferOutcome & { refused: number; behind?: { peerHead: number; startedFrom: number } }> {
  const { member, spaceId, remoteSpaceId, networkId, since, requestInit, tally, turn } = opts;
  const repair = opts.repair === true;
  const outcome: TransferOutcome = { deliveredThrough: since, truncated: false };
  let refusedHere = 0;
  let behind: { peerHead: number; startedFrom: number } | undefined;
  const peer = logSafe(member.label ?? member.instanceId);
  const where = `sync ${repair ? 're-read' : 'pull'} tombstones from ${member.label ?? member.instanceId}`;
  // Resolved once for the page's door: the peer pulled from is the authenticated source, and whether it is this space's
  // upstream is this instance's own knowledge (`sync/deletion-authority.ts`), never the peer's say-so.
  const delivery = deliveryOfMember(spaceId, member);
  /** One line, said as the mode says it: every time for the ordinary pull, once per window for the re-read. */
  const say = (kind: string, report: () => void): void => {
    if (!repair) { report(); return; }
    rereadSaid(JSON.stringify([member.instanceId, spaceId, kind]), report);
  };
  try {
    await pagePositionRuns({
      outcome,
      limit: MAX_TOMBSTONES_PER_REQUEST,
      maxPages: MAX_TRANSFER_PAGES,
      fetch: async (ask, limit) => {
        const params = new URLSearchParams({
          spaceId: remoteSpaceId, networkId, limit: String(limit),
          ...(ask.cursor ? { cursor: ask.cursor } : { afterPos: String(ask.afterPos) }),
        });
        const init = requestInit();
        const resp = await peerSafeFetch(`${member.url}/api/sync/tombstones?${params}`, { ...init, signal: turnSignal(init.signal, turn) });
        if (!resp.ok) { turn?.refusedBy(await transferRefusal(resp)); await resp.body?.cancel().catch(() => {}); return { status: resp.status }; }
        return { body: await boundedJson<unknown>(resp, 'sync peer') };
      },
      deliver: async (items) => {
        // The peer pulled from is the authenticated source: its own tombstones are authorised, and — when it is this
        // space's upstream — so is one for what it relayed. One it relays for a third author of a record it did NOT
        // deliver is refused here and applied when this instance syncs with that author directly.
        const out = await applyPeerTombstones(spaceId, items, delivery, where, repair ? { repair: true } : {});
        refusedHere += out.refused.length;
        if (tally) { tally.issuer += out.deleted.issuer; tally.upstream += out.deleted.upstream; }
        return out.unknownTypes.length > 0 ? 'a tombstone type this instance does not know' : null;
      },
      // The `head` guard belongs to the receive mark; the re-read has none of its own to forget.
      ...(repair ? {} : { onBehind: (peerHead: number, startedFrom: number) => { behind = { peerHead, startedFrom }; } }),
      stopped: (why, heldAt) => say('stopped', () => log.warn(repair
        ? `Re-read of tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' stopped: ${logSafe(why)} — `
          + `read through position ${heldAt}; the one-time repair stays owed and is tried again next cycle.`
        : `Pull tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' stopped: ${logSafe(why)} — `
          + `delivered through position ${heldAt}, so the receive mark is held there and the rest is asked for next cycle.`)),
    });
  } catch (err) {
    // A peer that does not page by position, and a space that owes its positions, are the ENGINE's to read: they end the member's turn.
    if (err instanceof PeerPagesBySeq || err instanceof PositionsBuilding) throw err;
    outcome.truncated = true;
    outcome.stoppedBy = 'error';
    say('failed', () => log.warn(repair
      ? `Re-read of tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' failed: ${logSafe(err instanceof Error ? err.message : String(err))} `
        + `— read through position ${outcome.deliveredThrough}; the one-time repair stays owed and is tried again next cycle.`
      : `Pull tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' failed: ${logSafe(err instanceof Error ? err.message : String(err))} `
        + `— delivered through position ${outcome.deliveredThrough}, so the receive mark is held there.`));
  }
  return { ...outcome, refused: refusedHere, ...(behind ? { behind } : {}) };
}

/**
 * Send our tombstones after the position `since`, paging until the peer has them all. WHICH tombstones is the network's selection
 * (`sync/push-selection.ts`), asked here and handed in by no caller: every tombstone on a relaying network, the ones issued here on a mesh.
 */
export async function pushTombstones(opts: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  /** This instance's position the peer has been sent complete through (the mark), 0 when none. */
  since: number;
  /** The network this push is on: its type decides what is offered. */
  net: Pick<NetworkConfig, 'type'>;
  requestInit: () => RequestInit;
  /** The space's turn with this member: its signal cuts the page in flight, and a refusal the peer answers is handed to it. */
  turn?: ExchangeTurn;
}): Promise<TransferOutcome> {
  const { member, spaceId, remoteSpaceId, networkId, since, requestInit, turn } = opts;
  const selection = pushSelection(opts.net).tombstones;
  const outcome: TransferOutcome = { deliveredThrough: since, truncated: false };
  const peer = logSafe(member.label ?? member.instanceId);
  const endpoint = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}`
    + `&networkId=${encodeURIComponent(networkId)}`;
  let refused = 0;
  let declined = 0;
  // A throw (an unreachable peer, this instance's own store) fails the member's sync, as it always has.
  await pushPositionRuns({
    outcome,
    pageSize: PUSH_PAGE,
    maxPages: MAX_TRANSFER_PAGES,
    read: (after, limit) => listTombstonesAfterPosition(spaceId, after, limit, selection),
    send: async (rows) => {
      const init = requestInit();
      const resp = await peerSafeFetch(endpoint, {
        ...init, signal: turnSignal(init.signal, turn), method: 'POST', body: JSON.stringify({ tombstones: rows }),
      });
      if (!resp.ok) { turn?.refusedBy(await transferRefusal(resp)); await resp.body?.cancel().catch(() => {}); return `the peer answered ${resp.status}`; }
      // A 6.0 receiver stamps its answer; one without the stamp is a 5.x receiver, and this THROWS (the turn ends, no mark is written).
      // `refused` is additive (bundle-46): an older peer does not send it. A refusal is by shape or seq, which a
      // re-send cannot change, so the push still advances past it — as a record push does past `rejected`.
      // `declined` is additive too (bundle-51): the peer's deletion authority did not honour that many. A re-send is
      // declined again, so the push advances past them as well, and the line below is what tells an operator.
      const body = await readPushReply(resp, peer);
      refused += refusedCountOf(body as { refused?: unknown });
      declined += declinedCountOf(body as { declined?: unknown });
      return null;
    },
    stopped: (why, heldAt) => log.warn(`Push tombstones to ${peerText(peer)} for space '${peerText(spaceId)}' `
      + `stopped: ${logSafe(why)} — delivered through position ${heldAt}, so the push mark is held there.`),
  });
  sayPeerRefused('tombstones', peer, spaceId, refused);
  sayPeerDeclined('tombstones', peer, spaceId, declined);
  return outcome;
}
