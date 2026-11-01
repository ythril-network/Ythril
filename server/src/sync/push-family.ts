/**
 * One replicated record family, pushed to one peer: read what it holds after the mark, send it in batches, say how far the peer is complete.
 *
 * Moved out of `sync/engine.ts`, where it was `pushCollection`. What it does not own: WHICH families replicate
 * (`REPLICATED_FAMILIES`, which also holds the family's `pushFilter`), WHICH rows a network's push offers (`sync/push-selection.ts`) and HOW a
 * page ends and continues inside a run of equal positions (`pushPositionRuns`, `sync/push-position-runs.ts` — the tombstone push's pager too).
 *
 * ## What is read, and what is sent
 *
 * What the push offers is the network's selection (`sync/push-selection.ts`): everything on a relaying network (braintree, pubsub), the rows written
 * here on a mesh (closed, democratic, club). It is composed with the family's own filter — a file's parents only: a chunk is derived from the blob
 * and the receiver makes its own, so sending one would ship passage text and a vector from a model the receiver may not run.
 *
 * The read PROJECTS `LOCAL_ONLY_EXCLUSION`: a vector, its model name, `matchedText`, the retention stamps and the position fields never travel
 * (the receiver strips them and the docs promise it), and they were the bulk of every batch. A file's metadata goes through
 * `fileMetaForWire` besides, which keeps only the keys the receiver's schema declares (`Q-69`), and then onto the wire the
 * PEER takes (`FILE_META_REMOVAL_SINCE`): the authored keys this version knows, so a key removed here is removed there, or
 * for a peer not known to take them, the older shape. A peer reporting the newer version that still refuses the page is
 * offered it once more on the older wire and treated as older until its reported version changes (`push-refusals.ts`).
 *
 * ## `deliveredThrough` is the peer's completeness in OUR stream
 *
 * It is the last position the peer is COMPLETE through — less one while the run at the last position sent may continue into a batch not yet sent,
 * and the settled cap less one when the read ran to the end (so a cycle that found nothing, or only tombstones, still moves the mark). There is no
 * author guard: the selection decides what is offered, and the mark is a position of this instance's own stream.
 *
 * ## A 200 is not "every record landed", and not "a 6.0 peer"
 *
 * The peer can discard a record whose fork chain is at its cap and still answer 200. `sync/push-refusals.ts` says what that
 * costs and why the mark advances anyway; a record is offered once (the continuation is by position, never `pos >=`),
 * so a refusal is counted once. And the answer must carry `positions: 1` (`parsePushAnswer`): a 200 without it is a 5.x receiver, which
 * throws `PeerPagesBySeq` and ends the member's turn instead of moving a mark on an answer that says nothing about positions.
 */
import { peerSafeFetch } from './peer-fetch.js';
import {
  reportPushRefusals, countPushRefusals, readPushReply, peerTakesWireSince, rememberRefusedTheNewerWire, warnOlderWire,
} from './push-refusals.js';
import { pushPositionRuns } from './push-position-runs.js';
import { pushSelection } from './push-selection.js';
import { LOCAL_ONLY_EXCLUSION } from './local-only-fields.js';
import { stopTransfer, truncationWarn, type TransferOutcome } from './watermark.js';
import { readAfterPosition } from '../util/position-keyset.js';
import { andPredicates } from '../db/and-predicates.js';
import { fileMetaForWire, fileMetaForOlderPeer, withAuthoredKeys } from '../api/sync/_shared.js';
import { log, peerText } from '../util/log.js';
import { transferRefusal, turnSignal, type ExchangeTurn } from './held-answer.js';
import { syncItemsPushedTotal } from '../metrics/registry.js';
import type { ReplicatedFamily, TargetKey } from './replicated-families.js';
import type { NetworkConfig, NetworkMember, FileMetaDoc } from '../config/types.js';
import type { Document } from 'mongodb';

/** Docs pushed per batch-upsert request (caps per-request payload size). */
const PUSH_BATCH_SIZE = 200;

/**
 * The first release that declares `authoredKeys` and an optional `tags` on a file's metadata (`Q-256`; 5.7.0 is the
 * next minor above every published 5.6.x). A peer known to run it or later is sent the removal list and the row as it
 * is; any other — a lower version, none reported, one that does not parse, or one that refused the newer wire — is sent
 * what every version accepts: no new key, and `tags: []` for a row with none. A released v5.6.9 receiver refuses a
 * document with a key it does not declare, or without `tags`, and discards it while answering 200.
 */
export const FILE_META_REMOVAL_SINCE = '5.7.0';

type Row = Document & { _id: string; seq: number };

export async function pushFamily(o: {
  family: ReplicatedFamily;
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  /** This instance's position the peer has been sent complete through for the space on this network (the mark), 0 when none. */
  since: number;
  /** The network this push is on: its type decides what is offered (`sync/push-selection.ts`). */
  net: Pick<NetworkConfig, 'type'>;
  /** The request init for a batch-sized body (`BATCH_FETCH_TIMEOUT_MS`). */
  requestInit: () => RequestInit;
  /** The space's turn with this member: its signal cuts the batch in flight, and a refusal the peer answers is handed to it. */
  turn?: ExchangeTurn;
  /**
   * The target families whose push stopped early earlier in this cycle (`familiesNotComplete`), sent as `incomplete` on every request, so the receiver
   * does not judge a reference whose target is still on its way as missing (bundle-39 D4, Q-334). Empty: the field is not sent. An older receiver
   * ignores it and checks as before.
   */
  incomplete?: readonly TargetKey[];
}): Promise<{ pushed: number; refused: number } & TransferOutcome> {
  const { family, member, spaceId, remoteSpaceId, networkId } = o;
  const key = family.payloadKey;
  const peerLabel = member.label ?? member.instanceId;
  const endpoint = `${member.url}/api/sync/batch-upsert?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`;
  const extra = andPredicates(pushSelection(o.net).records, family.pushFilter);
  const outcome: TransferOutcome = { deliveredThrough: o.since, truncated: false };
  let pushed = 0, refused = 0;

  await pushPositionRuns<Row>({
    outcome,
    pageSize: PUSH_BATCH_SIZE,
    read: (after, limit) => readAfterPosition<Row>(spaceId, family.collection, after, { limit, extra, projection: LOCAL_ONLY_EXCLUSION }),
    send: async (batch) => {
      // The cursor and the count on every pass (X-20): "found nothing because there is nothing" and "found nothing because
      // the cursor is already past it" are a healthy cycle and a permanent data loss, and nothing else tells them apart.
      log.debug(`Push ${key} to ${peerText(peerLabel)} space '${peerText(spaceId)}': ${batch.length} doc(s) after position `
        + `${outcome.deliveredThrough} (last id ${peerText(batch[batch.length - 1]?._id ?? '')})`);
      // A file's metadata goes on the wire this peer takes (`Q-256`); every other family is sent as stored.
      const newer = key === 'filemeta' && peerTakesWireSince(member, FILE_META_REMOVAL_SINCE);
      if (key === 'filemeta' && !newer) warnOlderWire(member, FILE_META_REMOVAL_SINCE, 'file metadata');
      const init = o.requestInit();
      const offer = (onNewerWire: boolean) => peerSafeFetch(endpoint, {
        ...init, signal: turnSignal(init.signal, o.turn), method: 'POST',
        body: JSON.stringify({ [key]: key === 'filemeta' ? batch.map(d => {
          const wire = fileMetaForWire(d as unknown as FileMetaDoc);
          return onNewerWire ? withAuthoredKeys(wire) : fileMetaForOlderPeer(wire);
        }) : batch, ...(o.incomplete && o.incomplete.length > 0 ? { incomplete: o.incomplete } : {}) }),
      });
      const resp = await offer(newer);
      if (!resp.ok) {
        const verdict = await transferRefusal(resp);
        await resp.body?.cancel().catch(() => {});
        if (verdict === 'family-held') {
          // The peer is rebuilding its edge identity index and holds THIS family only. It is not handed to the turn (`refusedBy` would end the whole space's
          // exchange): the family stops as held, the mark stops with it, and every other family of the space goes on.
          syncItemsPushedTotal.inc({ type: family.countKey, outcome: 'held' }, batch.length);
          const reason = `the peer holds the ${key} family (${resp.status}): it is rebuilding its edge identity index`;
          stopTransfer(outcome, () => {}, reason, 'held');   // said once, by the loop's own stop for the reason handed back
          return reason;
        }
        o.turn?.refusedBy(verdict);
        if (verdict === 'held') syncItemsPushedTotal.inc({ type: family.countKey, outcome: 'held' }, batch.length);
        return `the peer answered ${resp.status}`;
      }
      // A 6.0 receiver stamps its answer; one without the stamp is a 5.x receiver, and this THROWS (the member's turn ends, no mark is written).
      await readPushReply(resp, peerLabel);
      let r: number;
      if (!newer) r = await reportPushRefusals(resp, key, peerLabel, spaceId, batch.length);
      else {
        r = await countPushRefusals(resp, key, peerLabel, batch.length);
        if (r > 0) {
          // A peer that reports the newer version and refused documents may have been rolled back to one that refuses
          // the keys it was sent. The peer says how many it dropped and not which, so the page is offered ONCE more on
          // the wire every version takes (receivers keep the newer copy they hold, so a document that landed is a no-op).
          // Refusals that stand on the older wire are the documents' own, and are reported as any push's.
          const again = await offer(false);
          if (!again.ok) { o.turn?.refusedBy(await transferRefusal(again)); await again.body?.cancel().catch(() => {}); return `the peer answered ${again.status}`; }
          await readPushReply(again, peerLabel);
          const stood = await reportPushRefusals(again, key, peerLabel, spaceId, batch.length);
          if (stood < r) { rememberRefusedTheNewerWire(member); warnOlderWire(member, FILE_META_REMOVAL_SINCE, 'file metadata'); }
          r = stood;
        }
      }
      pushed += batch.length - r; refused += r; // Q-59: what the peer refused was not pushed
      if (r > 0) syncItemsPushedTotal.inc({ type: family.countKey, outcome: 'refused' }, r);
      return null;
    },
    stopped: (why, heldAt) => log.warn(peerText(truncationWarn(`Batch push ${key} to`, member.label ?? '', spaceId, why, heldAt))),
  });
  return { pushed, refused, ...outcome };
}
