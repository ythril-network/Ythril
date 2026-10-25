/**
 * Peer deletion propagation — record tombstones and file tombstones.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { z } from 'zod';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { peerBoundTo } from '../../auth/peer-bound.js';
import { listTombstonesAfterPosition } from '../../brain/tombstones.js';
import { pageAnswer, pushAnswer } from '../../sync/wire-answer.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { sendCaughtFailure } from '../send-failure.js';
import { withinWriteBound } from '../../db/write-bound.js';
import { applyPeerTombstones, MAX_TOMBSTONES_PER_REQUEST } from '../../sync/tombstone-apply.js';
import {
  publishedFileTombstones, publishedFileTombstonePage, fileTombstoneOnTheWire, FILE_TOMBSTONE_PAGE, LEGACY_FILE_TOMBSTONE_LIMIT,
} from '../../files/tombstones.js';
import { applyPeerFileTombstones } from '../../files/peer-tombstone-apply.js';

import { refusePeerSpace, refusePeerWrite, pushAllowed, deliveryOfRequest, syncPositionStart, BAD_SINCE_INSTANT } from './_shared.js';
import { parseLimit } from '../../util/pagination.js';
import { recordServedPosition } from '../../sync/served-watermark.js';
import { isoReadStart, BAD_ISO_CURSOR } from '../../util/seq-keyset.js';
import { refusalOfParse } from '../../util/log.js';

export const syncTombstonesRouter = Router();


// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/tombstones?spaceId=&networkId=&afterPos=&cursor=
 * Brain tombstones in the same position stream as the records (bundle-81, design rev 8 §6): one read of every type, `limit` rows in `(pos, _id)` order after
 * the start, below the settled cap, each carrying its `type`, answered as the wire module builds a page: `{ items, nextCursor, through, head, positions: 1 }`.
 * The start is `afterPos` (a whole number) or the opaque `p1.` cursor a previous page handed back, which also pages through a run of equal positions (a
 * relayed tombstone of the legacy band shares its position with the rows beside it). A `sinceSeq` and every old cursor form are refused, and the grouped
 * per-type answer of 5.6 is gone with them.
 *
 * Also records how far this peer has been served (`lastPosServed`), which is what makes the tombstones prunable at all — see `sync/served-watermark.ts`.
 * The mark is the position the peer asked from, cut at this instance's own settled cap (`ownPositionMark`), so a puller that sends `afterPos` near 2^53 cannot
 * drive this instance's clock toward the ceiling through it; a cursor inside a run records the position BEFORE it (everything below was delivered, and part
 * of the run at it may not have been, so a prune must keep that run). Written on every network that carries the space: it belongs to the peer's token.
 */
syncTombstonesRouter.get('/tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, limit } = req.query as Record<string, unknown>;
    if (typeof spaceId !== 'string' || !spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (refusePeerSpace(res, spaceId, networkId as string | undefined, req.authToken)) return;

    const start = syncPositionStart(req.query as Record<string, unknown>);
    if ('refusal' in start) { res.status(400).json({ error: start.refusal }); return; }
    const pageSize = parseLimit(limit, 1000, 5000);
    // One more row than asked for decides `nextCursor` without a second query, as the record pages do.
    const read = await listTombstonesAfterPosition(spaceId, start, pageSize + 1);
    // After the read, so a bookkeeping failure can never cost the peer its tombstones; mid-run only the position before the cursor's counts as served.
    await recordServedPosition(peerBoundTo(req.authToken), spaceId, start.id === undefined ? start.pos : Math.max(0, start.pos - 1));
    res.json(pageAnswer(read, pageSize));
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
      const tooMany = refusalOfParse(parsed.error).issues.some(i => i.code === 'too_big');
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
    const delivery = deliveryOfRequest(spaceId, req);
    // Bounded like every push door (bundle-30 `B2`): a stalled lock answers a retryable 503, never a hung request.
    const out = await withinWriteBound(async () => await applyPeerTombstones(spaceId, tombstones,
      delivery, `sync POST tombstones from ${delivery.peerInstanceId ?? 'a local token'}`));
    if (out.unknownTypes.length > 0) { res.status(400).json({ error: 'Invalid tombstone format' }); return; }

    // `applied` keeps its meaning — every element admitted by shape and seq — and `refused` is additive, as is
    // `declined` (elements the deletion authority did not honour; absent when none, so an exact old body still holds).
    res.status(200).json(pushAnswer({
      applied: out.admitted, refused: out.refused.length,
      ...(out.declined.length > 0 ? { declined: out.declined.length } : {}),
    }));
  } catch (err) {
    if (refusePeerWrite(res, err, req.authToken)) return;
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
    if (refusePeerSpace(res, spaceId, networkId as string | undefined, req.authToken)) return;

    if (cursor !== undefined && cursor !== '') {
      const after = isoReadStart(cursor);
      if (after === undefined) { res.status(400).json({ error: BAD_ISO_CURSOR }); return; }
      const page = await publishedFileTombstonePage(spaceId, after, FILE_TOMBSTONE_PAGE);
      res.json({ tombstones: page.rows.map(fileTombstoneOnTheWire), nextCursor: page.next });
      return;
    }
    if (since !== undefined && since !== '' && typeof since !== 'string') { res.status(400).json({ error: BAD_SINCE_INSTANT }); return; }
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
 * none). A `200` acknowledges the page — a declined element would be declined again, so the sender may prune it. That holds
 * because the authority reads a row by what it holds: a row that ARRIVING BYTES created (seq 0, authored only by whoever
 * delivered them — `recordArrivedFile`'s placeholder) is authorless to it (`fileTargetOf`), so the file's origin deleting
 * what a peer delivered first is applied, never declined; what is declined is a row somebody authored.
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
    const delivery = deliveryOfRequest(spaceId, req);
    // Bounded like every push door (bundle-30 `B2`): a stalled lock answers a retryable 503, never a hung request.
    const out = await withinWriteBound(async () => await applyPeerFileTombstones(spaceId, tombstones, delivery,
      `sync POST file-tombstones from ${delivery.peerInstanceId ?? 'a local token'}`));
    res.status(200).json({
      applied: out.applied, refused: out.refused.length,
      ...(out.declined.length > 0 ? { declined: out.declined.length } : {}),
    });
  } catch (err) {
    if (refusePeerWrite(res, err, req.authToken)) return;
    sendCaughtFailure(res, 'sync POST file-tombstones', err);
  }
});
