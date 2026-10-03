/**
 * Peer deletion propagation — record tombstones and file tombstones.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../../config/types.js';
import { toSafeRelPath } from '../../util/paths.js';
import { z } from 'zod';
import { col, asFilter, asUpdate } from '../../db/mongo.js';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getDataRoot } from '../../config/loader.js';
import { listTombstones } from '../../brain/tombstones.js';
import { requireAuth, denyReadOnly, isInstanceAdmin } from '../../auth/middleware.js';
import { log } from '../../util/log.js';
import { reportServerFailure } from '../../util/report-failure.js';
import { applyPeerTombstones, MAX_TOMBSTONES_PER_REQUEST } from '../../sync/tombstone-apply.js';
import { deleteStored } from '../../files/stored-bytes.js';
import path from 'node:path';
import type { FileTombstoneDoc } from '../../config/types.js';

import { spaceAllowed, pushAllowed, callerPeerId } from './_shared.js';
import { recordServedSeq } from '../../sync/served-watermark.js';
import { spaceCollection } from '../../db/space-collection.js';

export const syncTombstonesRouter = Router();


// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/tombstones?spaceId=&networkId=&sinceSeq=
 * Bulk tombstone export for efficient deletion sync.
 *
 * Also records how far this peer has been served (`lastSeqServed`), which is what makes the tombstones
 * prunable at all — see `sync/served-watermark.ts`. This is the right hook for it: `pullFromPeer` calls this
 * endpoint first, once per space per cycle, with the peer's raw confirmed watermark, whereas the
 * record-family GETs page with opaque cursors.
 */
syncTombstonesRouter.get('/tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, sinceSeq = '0', limit = '1000' } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const since = parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 1000, 5000);
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
      [TOMBSTONE_COLLECTION[t], await listTombstones(spaceId, since, pageSize, t)] as const,
    )));

    // After the read, so a bookkeeping failure can never cost the peer its tombstones.
    recordServedSeq(callerPeerId(req.authToken as Record<string, unknown>), spaceId, since);
    res.json(grouped);
  } catch (err) {
    log.error(`sync GET tombstones: ${err}`);
    res.status(500).json({ error: 'Internal error' });
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
    const out = await applyPeerTombstones(spaceId, tombstones, { peerInstanceId: callerPeerId, trustedRelay },
      `sync POST tombstones from ${callerPeerId ?? 'a local token'}`);
    if (out.unknownTypes.length > 0) { res.status(400).json({ error: 'Invalid tombstone format' }); return; }

    // `applied` keeps its meaning — every element admitted by shape and seq — and `refused` is additive.
    res.status(200).json({ applied: out.admitted, refused: out.refused.length });
  } catch (err) {
    reportServerFailure('sync POST tombstones', err);
    res.status(500).json({ error: 'Internal error' });
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

    const filter = since
      ? { spaceId, deletedAt: { $gt: since } }
      : { spaceId };
    const tombstones = await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones'))
      .find(asFilter<FileTombstoneDoc>(filter))
      .sort({ deletedAt: 1 })
      .limit(5000)
      .toArray();
    res.json({ tombstones });
  } catch (err) {
    log.error(`sync GET file-tombstones: ${err}`);
    res.status(500).json({ error: 'Internal error' });
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
      await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones')).updateOne(
        asFilter<FileTombstoneDoc>({ _id: doc._id }),
        asUpdate<FileTombstoneDoc>({ $setOnInsert: doc }),
        { upsert: true },
      );
      applied++;
    }

    res.json({ applied });
  } catch (err) {
    log.error(`sync POST file-tombstones: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
