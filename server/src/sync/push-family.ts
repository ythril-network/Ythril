/**
 * One replicated record family, pushed to one peer: read what it holds after the watermark, send it in batches, say how
 * far the peer is complete.
 *
 * Moved out of `sync/engine.ts`, where it was `pushCollection`. What it does not own: WHICH families replicate
 * (`REPLICATED_FAMILIES`, which also holds the family's `pushFilter`) and HOW a page ends and continues inside a run of
 * equal seqs (`pushSeqRuns`, `sync/push-seq-runs.ts` — the tombstone push's pager too).
 *
 * ## What is read, and what is sent
 *
 * Braintree and pubsub nodes relay documents from all peers; other topologies push only their own, so a foreign document
 * (one received from a third instance) does not pollute a peer's watermark. `owned` is that narrowing, and it is
 * composed with the family's own filter — a file's parents only: a chunk is derived from the blob and the receiver makes its
 * own, so sending one would ship passage text and a vector from a model the receiver may not run.
 *
 * The read PROJECTS `LOCAL_ONLY_EXCLUSION`: a vector, its model name, `matchedText` and the retention stamps never travel
 * (the receiver strips them and the docs promise it), and they were the bulk of every batch. A file's metadata goes through
 * `fileMetaForWire` besides, which keeps only the keys the receiver's schema declares (`Q-69`), and then onto the wire the
 * PEER takes (`FILE_META_REMOVAL_SINCE`): the authored keys this version knows, so a key removed here is removed there, or
 * for a peer not known to take them, the older shape. A peer reporting the newer version that still refuses the page is
 * offered it once more on the older wire and treated as older until its reported version changes (`push-refusals.ts`).
 *
 * ## `deliveredThrough` and `maxSeq` answer different questions
 *
 * `deliveredThrough` is how far the peer is COMPLETE — the last seq it accepted, less one while the run at that seq may
 * continue into a batch not yet sent — and not `maxSeq`, which is author-guarded: how far our OWN records reached. Capping
 * the watermark with the author-guarded number would let it advance past a foreign document that was never accepted, which
 * on a pubsub or braintree network (where `owned` is empty and we relay everything) is a record only we were going to send.
 *
 * ## A 200 is not "every record landed"
 *
 * The peer can discard a record whose fork chain is at its cap and still answer 200. `sync/push-refusals.ts` says what that
 * costs and why the watermark advances anyway; a record is offered once (the continuation is by position, never `seq >=`),
 * so a refusal is counted once.
 */
import type { Document } from 'mongodb';
import { peerSafeFetch } from './peer-fetch.js';
import {
  reportPushRefusals, countPushRefusals, peerTakesWireSince, rememberRefusedTheNewerWire, warnOlderWire,
} from './push-refusals.js';
import { pushSeqRuns } from './push-seq-runs.js';
import { LOCAL_ONLY_EXCLUSION } from './local-only-fields.js';
import { truncationWarn, type TransferOutcome } from './watermark.js';
import { readAfterSeq } from '../util/seq-keyset.js';
import { andPredicates } from '../db/and-predicates.js';
import { fileMetaForWire, fileMetaForOlderPeer, withAuthoredKeys } from '../api/sync/_shared.js';
import { log, peerText } from '../util/log.js';
import type { ReplicatedFamily } from './replicated-families.js';
import type { NetworkMember, FileMetaDoc } from '../config/types.js';

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

type Row = Document & { _id: string; seq: number; author?: { instanceId?: string } };

export async function pushFamily(o: {
  family: ReplicatedFamily;
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  lastSeqPushed: number;
  /** `{}` on a relaying topology, else the narrowing to this instance's own authored records. */
  owned: Record<string, unknown>;
  /** This instance's id: the author guard of `maxSeq`. */
  instanceId: string;
  /** The request init for a batch-sized body (`BATCH_FETCH_TIMEOUT_MS`). */
  requestInit: () => RequestInit;
}): Promise<{ pushed: number; maxSeq: number; refused: number } & TransferOutcome> {
  const { family, member, spaceId, remoteSpaceId, networkId } = o;
  const key = family.payloadKey;
  const peerLabel = member.label ?? member.instanceId;
  const endpoint = `${member.url}/api/sync/batch-upsert?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(networkId)}`;
  const extra = andPredicates(o.owned, family.pushFilter);
  const outcome: TransferOutcome = { deliveredThrough: o.lastSeqPushed, truncated: false };
  let pushed = 0, refused = 0;
  let localMaxSeq = o.lastSeqPushed;

  await pushSeqRuns<Row>({
    outcome,
    pageSize: PUSH_BATCH_SIZE,
    read: (after, limit) => readAfterSeq<Row>(spaceId, family.collection, after, { limit, extra, projection: LOCAL_ONLY_EXCLUSION }),
    send: async (batch) => {
      // The cursor and the count on every pass (X-20): "found nothing because there is nothing" and "found nothing because
      // the cursor is already past it" are a healthy cycle and a permanent data loss, and nothing else tells them apart.
      log.debug(`Push ${key} to ${peerText(peerLabel)} space '${peerText(spaceId)}': ${batch.length} doc(s) after seq `
        + `${outcome.deliveredThrough} (through ${batch[batch.length - 1]?.seq})`);
      // A file's metadata goes on the wire this peer takes (`Q-256`); every other family is sent as stored.
      const newer = key === 'filemeta' && peerTakesWireSince(member, FILE_META_REMOVAL_SINCE);
      if (key === 'filemeta' && !newer) warnOlderWire(member, FILE_META_REMOVAL_SINCE, 'file metadata');
      const offer = (onNewerWire: boolean) => peerSafeFetch(endpoint, {
        ...o.requestInit(), method: 'POST',
        body: JSON.stringify({ [key]: key === 'filemeta' ? batch.map(d => {
          const wire = fileMetaForWire(d as unknown as FileMetaDoc);
          return onNewerWire ? withAuthoredKeys(wire) : fileMetaForOlderPeer(wire);
        }) : batch }),
      });
      const resp = await offer(newer);
      if (!resp.ok) { await resp.body?.cancel().catch(() => {}); return `the peer answered ${resp.status}`; }
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
          if (!again.ok) { await again.body?.cancel().catch(() => {}); return `the peer answered ${again.status}`; }
          const stood = await reportPushRefusals(again, key, peerLabel, spaceId, batch.length);
          if (stood < r) { rememberRefusedTheNewerWire(member); warnOlderWire(member, FILE_META_REMOVAL_SINCE, 'file metadata'); }
          r = stood;
        }
      }
      pushed += batch.length - r; refused += r; // Q-59: what the peer refused was not pushed
      for (const doc of batch) if (doc.author?.instanceId === o.instanceId && doc.seq > localMaxSeq) localMaxSeq = doc.seq;
      return null;
    },
    stopped: (why, heldAt) => log.warn(peerText(truncationWarn(`Batch push ${key} to`, member.label ?? '', spaceId, why, heldAt))),
  });
  return { pushed, maxSeq: localMaxSeq, refused, ...outcome };
}
