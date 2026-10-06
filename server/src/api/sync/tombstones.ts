/**
 * Peer deletion propagation — record tombstones and file tombstones.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../../config/types.js';
import { toSafeRelPath } from '../../util/paths.js';
import { z } from 'zod';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getDataRoot } from '../../config/loader.js';
import { listTombstones } from '../../brain/tombstones.js';
import { requireAuth, denyReadOnly, isInstanceAdmin } from '../../auth/middleware.js';
import { sendCaughtFailure } from '../send-failure.js';
import { withinWriteBound } from '../../db/write-bound.js';
import { applyPeerTombstones, MAX_TOMBSTONES_PER_REQUEST } from '../../sync/tombstone-apply.js';
import { deleteStored } from '../../files/stored-bytes.js';
import { publishedFileTombstones, storePeerFileTombstone } from '../../files/tombstones.js';
import path from 'node:path';
import type { FileTombstoneDoc } from '../../config/types.js';

import { spaceAllowed, pushAllowed, callerPeerId, syncReadStart, BAD_SYNC_START } from './_shared.js';
import { parseLimit } from '../../util/pagination.js';
import { recordServedSeq } from '../../sync/served-watermark.js';
import { encodeSeqCursor } from '../../util/seq-keyset.js';

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
      recordServedSeq(callerPeerId(req.authToken as Record<string, unknown>), spaceId, Math.max(0, since.seq - 1));
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
     * A peer token may only delete content its own instance issued and authored; a trusted local/admin token (no
     * peerInstanceId) may relay any tombstone.
     */
    const callerPeerId = (req.authToken as Record<string, unknown>)?.['peerInstanceId'] as string | undefined;
    const trustedRelay = !callerPeerId && !!req.authToken && isInstanceAdmin(req.authToken);
    // Bounded like every push door (bundle-30 `B2`): a stalled lock answers a retryable 503, never a hung request.
    const out = await withinWriteBound(async () => await applyPeerTombstones(spaceId, tombstones,
      { peerInstanceId: callerPeerId, trustedRelay }, `sync POST tombstones from ${callerPeerId ?? 'a local token'}`));
    if (out.unknownTypes.length > 0) { res.status(400).json({ error: 'Invalid tombstone format' }); return; }

    // `applied` keeps its meaning — every element admitted by shape and seq — and `refused` is additive.
    res.status(200).json({ applied: out.admitted, refused: out.refused.length });
  } catch (err) {
    sendCaughtFailure(res, 'sync POST tombstones', err);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// FILE TOMBSTONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/file-tombstones?spaceId=&networkId=&since=<isoTimestamp>
 * Returns file deletion tombstones so peers can replicate file removals.
 * Omit `since` for all tombstones; provide an ISO timestamp for incremental sync.
 */
syncTombstonesRouter.get('/file-tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, since } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

    // Published ones only, in their wire shape: a tombstone whose act has not happened is never served (bundle-30 I15).
    const tombstones = await publishedFileTombstones(spaceId, { ...(since ? { since } : {}), limit: 5000 });
    res.json({ tombstones });
  } catch (err) {
    sendCaughtFailure(res, `sync GET file-tombstones`, err);
  }
});


/**
 * POST /api/sync/file-tombstones
 * Accepts file-deletion tombstones from a peer and applies them locally:
 * each tombstone causes the corresponding file to be removed from the local
 * filesystem and the tombstone to be recorded in our MongoDB so we can
 * re-propagate it to further peers.
 */
syncTombstonesRouter.post('/file-tombstones', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    // `spaceId` is typed as present: pushAllowed refuses the request (400) before anything reads it, if it is not.
    const { spaceId, tombstones } = req.body as { spaceId: string; tombstones?: unknown[] };
    const { networkId } = req.query as Record<string, string>;
    // The space is named in the BODY on this route; the preamble is the same one every sync write runs.
    if (pushAllowed(res, spaceId, networkId, req.authToken) === null) return;
    if (!Array.isArray(tombstones)) { res.status(400).json({ error: 'tombstones must be array' }); return; }

    const spaceFiles = path.resolve(getDataRoot(), 'files', spaceId);
    let applied = 0;

    for (const raw of tombstones) {
      const ts = raw as Partial<FileTombstoneDoc>;
      if (!ts._id || !ts.path || typeof ts.path !== 'string') continue;

      // Path-traversal guard — must stay within the space's files directory.
      const rel = toSafeRelPath(ts.path);
      const abs = path.join(spaceFiles, rel);
      if (!abs.startsWith(spaceFiles + path.sep) && abs !== spaceFiles) continue;

      // Delete the file (ignore if already gone).
      await deleteStored(abs).catch(() => {});   // under the path lock (F-43)

      // Record tombstone locally so we can propagate it to further peers.
      const doc: FileTombstoneDoc = {
        _id: ts._id,
        spaceId,
        path: rel,
        deletedAt: typeof ts.deletedAt === 'string' ? ts.deletedAt : new Date().toISOString(),
      };
      await storePeerFileTombstone(spaceId, doc);
      applied++;
    }

    res.json({ applied });
  } catch (err) {
    sendCaughtFailure(res, 'sync POST file-tombstones', err);
  }
});
