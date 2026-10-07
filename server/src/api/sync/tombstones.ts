/**
 * Peer deletion propagation — record tombstones and file tombstones.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../../config/types.js';
import { z } from 'zod';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getConfig } from '../../config/loader.js';
import { listTombstones } from '../../brain/tombstones.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { sendCaughtFailure } from '../send-failure.js';
import { withinWriteBound } from '../../db/write-bound.js';
import { applyPeerTombstones, MAX_TOMBSTONES_PER_REQUEST } from '../../sync/tombstone-apply.js';
import { deliveryOf } from '../../sync/deletion-authority.js';
import {
  publishedFileTombstones, publishedFileTombstonePage, fileTombstoneOnTheWire, FILE_TOMBSTONE_PAGE, LEGACY_FILE_TOMBSTONE_LIMIT,
} from '../../files/tombstones.js';
import { applyPeerFileTombstones } from '../../files/peer-tombstone-apply.js';

import { spaceAllowed, pushAllowed, callerPeerId, deliveryFromToken, syncReadStart, BAD_SYNC_START } from './_shared.js';
import { parseLimit } from '../../util/pagination.js';
import { recordServedSeq } from '../../sync/served-watermark.js';
import { completeThrough } from '../../sync/watermark.js';
import { encodeSeqCursor, isoReadStart, BAD_ISO_CURSOR } from '../../util/seq-keyset.js';

export const syncTombstonesRouter = Router();


// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/tombstones?spaceId=&networkId=&sinceSeq=&cursor=
 * Bulk tombstone export for efficient deletion sync, in one of two modes.
 *
 * **`sinceSeq` alone (legacy mode)** serves `seq > sinceSeq` per type, at most `limit` of each, and is UNCHANGED: a 5.6
 * puller reads a full group as "more may follow" and moves on from the group's last seq, so a different shape would be
 * misread. It cannot page past more than `limit` tombstones at one seq, and a peer token can plant that many (it names the
 * seq of what it issues): such a puller stays held below that seq until it upgrades.
 *
 * **`cursor` (cursor mode)** is one read of every type, `limit` rows in `(seq, _id)` order after the cursor's position
 * (`util/seq-keyset.ts`), grouped by type in the answer, with `nextCursor` beside the type keys — `null` on the last page.
 * It pages through a run at one seq, which is what closes that wedge. A first request carries the bare-seq cursor of
 * its watermark. The cursor wins over `sinceSeq`, and it is opaque: a client echoes it and never builds one.
 *
 * Also records how far this peer has been served (`lastSeqServed`), which is what makes the tombstones
 * prunable at all — see `sync/served-watermark.ts`. This is the right hook for it: `pullFromPeer` calls this
 * endpoint first, once per space per cycle, with the peer's raw confirmed watermark. Legacy mode records `sinceSeq`;
 * cursor mode records the cursor's seq MINUS ONE — everything below it was delivered, and part of the run at it may not
 * have been, so a prune must keep that run.
 */
syncTombstonesRouter.get('/tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, sinceSeq, cursor, limit } = req.query as Record<string, unknown>;
    if (typeof spaceId !== 'string' || !spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId as string | undefined, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

    // One reading of the start and the size for every sync read (`Q-388`): see `syncReadStart`.
    const since = syncReadStart(sinceSeq, cursor);
    if (since === undefined) { res.status(400).json({ error: BAD_SYNC_START }); return; }
    const pageSize = parseLimit(limit, 1000, 5000);

    if (cursor !== undefined && cursor !== '') {
      // One more row than asked for decides `nextCursor` without a second query, as the record pages do.
      const rows = await listTombstones(spaceId, since, pageSize + 1);
      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      const byType = Object.fromEntries(TOMBSTONE_TYPES.map(t => [TOMBSTONE_COLLECTION[t], page.filter(r => r.type === t)] as const));
      // Mid-run, the rest of the cursor's seq is not delivered yet, so only the seq before it counts as served.
      recordServedSeq(callerPeerId(req.authToken as Record<string, unknown>), spaceId, completeThrough(since.seq, true));
      res.json({ ...byType, nextCursor: rows.length > pageSize && last ? encodeSeqCursor({ seq: last.seq, id: last._id }) : null });
      return;
    }
    /*
     * DERIVED from `TOMBSTONE_TYPES`, and it was four hand-written calls with a four-key response.
     *
     * A tombstone type absent from here is never SERVED: the deleting instance stores its tombstone, the
     * peer asks for tombstones and is handed a response with no key for that kind, and the deleted record
     * lives on there for ever. Nothing reports it — the peer got a 200 with a well-formed body, and the
     * record it still holds looks exactly like a record nobody deleted.
     *
     * `M-2` is the fifth type, and the key each one takes is its COLLECTION name (`fact` is served under
     * `facts`) — which is a mapping that already exists rather than a naming convention to re-derive
     * here. The response keys are the same as before plus `links`; JSON has no key order, so nothing a peer
     * parses changes.
     */
    const grouped = Object.fromEntries(await Promise.all(TOMBSTONE_TYPES.map(async (t) =>
      [TOMBSTONE_COLLECTION[t], await listTombstones(spaceId, since.seq, pageSize, t)] as const,
    )));

    // After the read, so a bookkeeping failure can never cost the peer its tombstones.
    recordServedSeq(callerPeerId(req.authToken as Record<string, unknown>), spaceId, since.seq);
    res.json(grouped);
  } catch (err) {
    sendCaughtFailure(res, `sync GET tombstones`, err);
  }
});


/** The push body: an array of elements, unvalidated here, at most `MAX_TOMBSTONES_PER_REQUEST` of them. */
export const TombstonePage = z.object({ tombstones: z.array(z.unknown()).max(MAX_TOMBSTONES_PER_REQUEST).default([]) });

/** POST /api/sync/tombstones — apply tombstones received from a peer */
syncTombstonesRouter.post('/tombstones', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;

    // The envelope only — each element is the apply's. Over the cap is refused whole, before anything is read: an
    // honest sender pages well below it (`pushTombstones`).
    const parsed = TombstonePage.safeParse(req.body ?? {});
    if (!parsed.success) {
      const tooMany = parsed.error.issues.some(i => i.code === 'too_big');
      res.status(400).json({ error: tooMany ? `At most ${MAX_TOMBSTONES_PER_REQUEST} tombstones per request` : 'Invalid tombstone format' });
      return;
    }
    const { tombstones } = parsed.data;

    /*
     * EVERY RULE IS THE APPLY'S (`sync/tombstone-apply.ts`, bundle-46), shared with the pull: the shape and seq of
     * each element on its own, the space this door ADMITTED — `spaceId` here, after the alias middleware, never the
     * one a tombstone names — authorisation before anything is stored, and the counter bump. A malformed element
     * is refused alone and counted in `refused`; an element of a type this instance does not know answers 400 for
     * the page, so the sender holds it and re-sends after this receiver upgrades.
     *
     * A peer token may delete content its own instance issued and authored, and — when it is this space's direct upstream
     * on a pub/sub or tree network — what it relayed here (`sync/deletion-authority.ts`); a trusted local/admin token (no
     * peerInstanceId) may relay any tombstone. The delivery is resolved ONCE for the page, from the admitted space.
     */
    const delivery = deliveryOf(getConfig(), spaceId, deliveryFromToken(req.authToken as Record<string, unknown>));
    // Bounded like every push door (bundle-30 `B2`): a stalled lock answers a retryable 503, never a hung request.
    const out = await withinWriteBound(async () => await applyPeerTombstones(spaceId, tombstones,
      delivery, `sync POST tombstones from ${delivery.peerInstanceId ?? 'a local token'}`));
    if (out.unknownTypes.length > 0) { res.status(400).json({ error: 'Invalid tombstone format' }); return; }

    // `applied` keeps its meaning — every element admitted by shape and seq — and `refused` is additive, as is
    // `declined` (elements the deletion authority did not honour; absent when none, so an exact old body still holds).
    res.status(200).json({
      applied: out.admitted, refused: out.refused.length,
      ...(out.declined.length > 0 ? { declined: out.declined.length } : {}),
    });
  } catch (err) {
    sendCaughtFailure(res, 'sync POST tombstones', err);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// FILE TOMBSTONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/file-tombstones?spaceId=&networkId=&since=<isoTimestamp>&cursor=
 * Returns file deletion tombstones so peers can replicate file removals, in one of two modes.
 *
 * **`cursor` (cursor mode)** is one page of at most `FILE_TOMBSTONE_PAGE` in LOCAL-position order — `(positionAt, _id)`, the
 * publish time of an own tombstone and the receive time of a relayed one (`files/tombstones.ts`) — with `nextCursor`
 * beside `tombstones`: `null` on the last page. Equal positions page without skipping a row. The cursor is opaque (echo it,
 * never build one); one that does not decode is a `400`, never an empty page that reads as "the end".
 *
 * **No cursor (legacy mode)** is what it always was: one answer of at most `LEGACY_FILE_TOMBSTONE_LIMIT` rows and no
 * `nextCursor`, so an older puller reading a full answer as "that is all" is not handed a shape it would misread. `since`
 * (an ISO instant, applied to the position) is still accepted there.
 *
 * Only published tombstones, and only their wire shape: a tombstone whose act has not happened is never served (bundle-30
 * I15), and a position or a local field never leaves this instance.
 */
syncTombstonesRouter.get('/file-tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, since, cursor } = req.query as Record<string, unknown>;
    if (typeof spaceId !== 'string' || !spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId as string | undefined, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (cursor !== undefined && cursor !== '') {
      const after = isoReadStart(cursor);
      if (after === undefined) { res.status(400).json({ error: BAD_ISO_CURSOR }); return; }
      const page = await publishedFileTombstonePage(spaceId, after, FILE_TOMBSTONE_PAGE);
      res.json({ tombstones: page.rows.map(fileTombstoneOnTheWire), nextCursor: page.next });
      return;
    }
    if (since !== undefined && since !== '' && typeof since !== 'string') { res.status(400).json({ error: BAD_SYNC_START }); return; }
    const rows = await publishedFileTombstones(spaceId, { ...(since ? { since: since as string } : {}), limit: LEGACY_FILE_TOMBSTONE_LIMIT });
    res.json({ tombstones: rows.map(fileTombstoneOnTheWire) });
  } catch (err) {
    sendCaughtFailure(res, `sync GET file-tombstones`, err);
  }
});


/**
 * POST /api/sync/file-tombstones
 * Accepts file-deletion tombstones from a peer and applies them locally — through the ONE apply
 * (`files/peer-tombstone-apply.ts`, shared with the pull): each element is judged by the deletion authority and, when it may
 * delete, removes everything the file left (bytes, row, artefacts, job, cached hash) and is recorded so this instance can
 * pass it on to its own peers.
 *
 * At most `MAX_TOMBSTONES_PER_REQUEST` per request (the record route's cap, one constant), refused whole before anything is
 * read; an honest sender pages at `FILE_TOMBSTONE_PAGE`. The answer is counts: `applied` (admitted by shape and path),
 * `refused` (a malformed element, each on its own) and `declined` (the deletion authority did not honour it; absent when
 * none). A `200` acknowledges the page — a declined element would be declined again, so the sender may prune it.
 */
syncTombstonesRouter.post('/file-tombstones', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    // `spaceId` is typed as present: pushAllowed refuses the request (400) before anything reads it, if it is not.
    const { spaceId, tombstones } = (req.body ?? {}) as { spaceId: string; tombstones?: unknown[] };
    const { networkId } = req.query as Record<string, string>;
    // The space is named in the BODY on this route; the preamble is the same one every sync write runs.
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    if (!Array.isArray(tombstones)) { res.status(400).json({ error: 'tombstones must be array' }); return; }
    if (tombstones.length > MAX_TOMBSTONES_PER_REQUEST) {
      res.status(400).json({ error: `At most ${MAX_TOMBSTONES_PER_REQUEST} tombstones per request` });
      return;
    }

    // Resolved ONCE for the page, from the admitted space and the authenticated token (`sync/deletion-authority.ts`).
    const delivery = deliveryOf(getConfig(), spaceId, deliveryFromToken(req.authToken as Record<string, unknown>));
    // Bounded like every push door (bundle-30 `B2`): a stalled lock answers a retryable 503, never a hung request.
    const out = await withinWriteBound(async () => await applyPeerFileTombstones(spaceId, tombstones, delivery,
      `sync POST file-tombstones from ${delivery.peerInstanceId ?? 'a local token'}`));
    res.status(200).json({
      applied: out.applied, refused: out.refused.length,
      ...(out.declined.length > 0 ? { declined: out.declined.length } : {}),
    });
  } catch (err) {
    sendCaughtFailure(res, 'sync POST file-tombstones', err);
  }
});
