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
 * Tombstones travel under the SAME `lastSeqReceived` / `lastSeqPushed` as the record collections. A deletion that
 * did not transfer, followed by a watermark that moved past it, is a deletion that never propagates — the record
 * stays alive on the peer for ever and every later cycle reports success. So each direction reports how far it
 * is COMPLETE (`deliveredThrough`: a stop inside a run of equal seqs reports that seq minus one), and
 * `sync/watermark.ts` limits the shared watermark to it. A stop for ANY reason — a refused request, a throw, a run
 * that cannot be paged past, the page bound — is a `truncated` outcome.
 *
 * ## Both page by the SAME rule as the records (`Q-237`, bundle-46; `Q-277` and `Q-295`, bundle-52)
 *
 * Equal seqs are legitimate, because a peer relays tombstones issued by several instances, each with its own clock.
 *
 *   - The PULL goes through `pageSeqRuns` (`sync/seq-run-pager.ts`), the pager the record pull uses. Every request carries
 *     `cursor` beside `sinceSeq`: a server that has the cursor mode answers one keyset read of `limit` rows with a
 *     `nextCursor`, which is followed, and a run of any length pages. A 5.6 server ignores the cursor, answers per type with
 *     no `nextCursor`, and is paged by the pager's legacy rule — which cannot pass more than `limit` tombstones at one seq.
 *   - The PUSH goes through `pushSeqRuns` (`sync/push-seq-runs.ts`) over `listTombstones`, by `(seq, _id)`.
 *
 * Both doors APPLY through `applyPeerTombstones` (`sync/tombstone-apply.ts`), which owns the shape, seq,
 * admitted-space and authorisation rules and the counter bump.
 */
import { peerSafeFetch } from './peer-fetch.js';
import { boundedJson } from '../util/bounded-read.js';
import { listTombstones } from '../brain/tombstones.js';
import { applyPeerTombstones, admitTombstone, MAX_TOMBSTONES_PER_REQUEST } from './tombstone-apply.js';
import { CounterBehindError } from './counter-after-page.js';
import { pageSeqRuns, serverCursorOf } from './seq-run-pager.js';
import { pushSeqRuns } from './push-seq-runs.js';
import { encodeSeqCursor } from '../util/seq-keyset.js';
import { log, logSafe, peerText } from '../util/log.js';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../config/types.js';
import type { NetworkMember } from '../config/types.js';
import { MAX_TRANSFER_PAGES, type TransferOutcome } from './watermark.js';

/** What a push asks for per request. */
const PUSH_PAGE = 500;

/**
 * Fetch the peer's tombstones since `sinceSeq` and apply them to the LOCAL space `spaceId`.
 *
 * Called BEFORE the record pull so deletions land before anything that would re-upsert a deleted doc. A counter
 * that could not be advanced past what was delivered is thrown (`CounterBehindError`), so the cycle counts an
 * error; any other failure holds the watermark and is logged.
 */
export async function pullTombstones(opts: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  sinceSeq: number;
  requestInit: () => RequestInit;
}): Promise<TransferOutcome> {
  const { member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit } = opts;
  const outcome: TransferOutcome = { deliveredThrough: sinceSeq, truncated: false };
  const peer = logSafe(member.label ?? member.instanceId);
  const where = `sync pull tombstones from ${member.label ?? member.instanceId}`;
  try {
    await pageSeqRuns({
      outcome,
      limit: MAX_TOMBSTONES_PER_REQUEST,
      maxPages: MAX_TRANSFER_PAGES,
      fetch: async (ask, limit) => {
        // `cursor` on EVERY request: a server with the cursor mode reads it (a first request's is the bare seq of the
        // position), one without ignores it and reads `sinceSeq` — the two ways of asking are one request.
        const url = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}`
          + `&networkId=${encodeURIComponent(networkId)}&sinceSeq=${ask.sinceSeq}&limit=${limit}`
          + `&cursor=${ask.cursor ?? encodeSeqCursor({ seq: ask.sinceSeq })}`;
        const resp = await peerSafeFetch(url, requestInit());
        if (!resp.ok) { await resp.body?.cancel().catch(() => {}); return { status: resp.status }; }
        // Keyed by COLLECTION name, as `GET /api/sync/tombstones` derives them from `TOMBSTONE_TYPES`. A key missing
        // here is a delete a peer told us about and we dropped on the floor.
        const data = await boundedJson<Record<string, unknown>>(resp, 'sync peer');
        return {
          groups: TOMBSTONE_TYPES.map(t => data?.[TOMBSTONE_COLLECTION[t]]).map(g => (Array.isArray(g) ? g : [])),
          nextCursor: serverCursorOf(data?.['nextCursor']),
        };
      },
      admit: (raw) => {
        const a = admitTombstone(raw);
        return 'tombstone' in a ? { seq: a.tombstone.seq, key: JSON.stringify([a.tombstone.type, a.tombstone._id]) } : null;
      },
      deliver: async (fresh) => {
        // The peer pulled from is the authenticated source: its own tombstones are authorised, one it relays for a
        // third author is refused here and applied when this instance syncs with that author directly.
        const out = await applyPeerTombstones(spaceId, fresh, { peerInstanceId: member.instanceId }, where);
        return out.unknownTypes.length > 0 ? 'a tombstone type this instance does not know' : null;
      },
      stopped: (why, heldAt) => log.warn(`Pull tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' stopped: ${logSafe(why)} — `
        + `delivered through seq ${heldAt}, so the receive watermark is held there and the rest is asked for next cycle.`),
    });
  } catch (err) {
    if (err instanceof CounterBehindError) throw err;
    outcome.truncated = true;
    log.warn(`Pull tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' failed: `
      + `${logSafe(err instanceof Error ? err.message : String(err))} — delivered through seq `
      + `${outcome.deliveredThrough}, so the receive watermark is held there.`);
  }
  return outcome;
}

/** Send our tombstones newer than `lastSeqPushed`, paging until the peer has them all. */
export async function pushTombstones(opts: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  lastSeqPushed: number;
  requestInit: () => RequestInit;
}): Promise<TransferOutcome> {
  const { member, spaceId, remoteSpaceId, networkId, lastSeqPushed, requestInit } = opts;
  const outcome: TransferOutcome = { deliveredThrough: lastSeqPushed, truncated: false };
  const peer = logSafe(member.label ?? member.instanceId);
  const endpoint = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}`
    + `&networkId=${encodeURIComponent(networkId)}`;
  let refused = 0;
  // A throw (an unreachable peer, this instance's own store) fails the member's sync, as it always has.
  await pushSeqRuns({
    outcome,
    pageSize: PUSH_PAGE,
    maxPages: MAX_TRANSFER_PAGES,
    read: (after, limit) => listTombstones(spaceId, after, limit),
    send: async (rows) => {
      const resp = await peerSafeFetch(endpoint, {
        ...requestInit(), method: 'POST', body: JSON.stringify({ tombstones: rows }),
      });
      if (!resp.ok) { await resp.body?.cancel().catch(() => {}); return `the peer answered ${resp.status}`; }
      // `refused` is additive (bundle-46): an older peer does not send it. A refusal is by shape or seq, which a
      // re-send cannot change, so the push still advances past it — as a record push does past `rejected`.
      const body = await boundedJson<{ refused?: unknown }>(resp, 'sync peer').catch(() => ({}) as { refused?: unknown });
      if (typeof body.refused === 'number' && body.refused > 0) refused += body.refused;
      return null;
    },
    stopped: (why, heldAt) => log.warn(`Push tombstones to ${peerText(peer)} for space '${peerText(spaceId)}' `
      + `stopped: ${logSafe(why)} — delivered through seq ${heldAt}, so the push watermark is held there.`),
  });
  if (refused > 0) {
    log.warn(`Push tombstones to ${peerText(peer)} for space '${peerText(spaceId)}': the peer refused ${refused} tombstone(s) by shape or `
      + 'seq; its own log names them.');
  }
  return outcome;
}
