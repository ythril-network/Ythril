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
 * `fileMetaForWire` besides, which keeps only the keys the receiver's schema declares (`Q-69`).
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
import { reportPushRefusals } from './push-refusals.js';
import { pushSeqRuns } from './push-seq-runs.js';
import { LOCAL_ONLY_EXCLUSION } from './local-only-fields.js';
import { truncationWarn, type TransferOutcome } from './watermark.js';
import { readAfterSeq } from '../util/seq-keyset.js';
import { fileMetaForWire } from '../api/sync/_shared.js';
import { log, peerText } from '../util/log.js';
import type { ReplicatedFamily } from './replicated-families.js';
import type { NetworkMember, FileMetaDoc } from '../config/types.js';

/** Docs pushed per batch-upsert request (caps per-request payload size). */
const PUSH_BATCH_SIZE = 200;

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
  const filters = [o.owned, family.pushFilter ?? {}].filter(f => Object.keys(f).length > 0);
  const extra = filters.length > 0 ? { $and: filters } : undefined;
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
      const resp = await peerSafeFetch(endpoint, {
        ...o.requestInit(), method: 'POST',
        body: JSON.stringify({ [key]: key === 'filemeta' ? batch.map(d => fileMetaForWire(d as unknown as FileMetaDoc)) : batch }),
      });
      if (!resp.ok) { await resp.body?.cancel().catch(() => {}); return `the peer answered ${resp.status}`; }
      const r = await reportPushRefusals(resp, key, peerLabel, spaceId, batch.length);
      pushed += batch.length - r; refused += r; // Q-59: what the peer refused was not pushed
      for (const doc of batch) if (doc.author?.instanceId === o.instanceId && doc.seq > localMaxSeq) localMaxSeq = doc.seq;
      return null;
    },
    stopped: (why, heldAt) => log.warn(peerText(truncationWarn(`Batch push ${key} to`, member.label ?? '', spaceId, why, heldAt))),
  });
  return { pushed, maxSeq: localMaxSeq, refused, ...outcome };
}
