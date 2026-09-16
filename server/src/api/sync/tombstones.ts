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
import { listTombstones, applyRemoteTombstone } from '../../brain/tombstones.js';
import { requireAuth, denyReadOnly, isInstanceAdmin } from '../../auth/middleware.js';
import { log } from '../../util/log.js';
import { bumpSeq } from '../../util/seq.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TombstoneDoc, FileTombstoneDoc } from '../../config/types.js';

import { spaceAllowed, isNonPeerSyncWrite, NON_PEER_WRITE_MESSAGE, isDirectionalWriteBlocked, callerPeerId } from './_shared.js';
import { recordServedSeq } from '../../sync/served-watermark.js';

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


/** POST /api/sync/tombstones — apply tombstones received from a peer */
syncTombstonesRouter.post('/tombstones', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

    const body = req.body as { tombstones?: TombstoneDoc[] };
    const tombstones = body?.tombstones ?? [];

    /*
     * `TOMBSTONE_TYPES`, not `KNOWLEDGE_TYPES` — and this door said the wrong one while the GET door 28
     * lines above already served the right one. One rule, two doors, the weaker one winning silently.
     *
     * The cost was not a rejected record. `pushTombstones` calls `listTombstones` with NO type filter, so a
     * push page can carry a link tombstone; `z.array(...).safeParse` fails on one bad element and rejects the
     * WHOLE page; the route answers 400; `sync/tombstone-transfer.ts` reads a non-ok push as truncated and
     * holds the watermark at that cursor. So one undelivered link tombstone would stop EVERY deletion of
     * every kind propagating from that instance by push, permanently, and the next cycle would fail
     * identically.
     *
     * Latent only because no link delete path exists yet — it goes live the hour slice 2 ships one. Found by
     * an audit of the link-as-collection decision rather than by a test, which is the part worth keeping:
     * nothing gates 'use the tombstone tuple on the tombstone door', and the two agreed by luck.
     */
    const schema = z.array(z.object({
      _id: z.string(),
      type: z.enum(TOMBSTONE_TYPES),
      spaceId: z.string(),
      deletedAt: z.string(),
      instanceId: z.string(),
      seq: z.number(),
      originalSeq: z.number().optional(),
    }));
    const parsed = schema.safeParse(tombstones);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid tombstone format' }); return; }

    // A peer token may only delete content it authored (peerInstanceId === tombstone issuer);
    // a trusted local/admin token (no peerInstanceId) may relay any tombstone.
    const callerPeerId = (req.authToken as Record<string, unknown>)?.['peerInstanceId'] as string | undefined;
    const trustedRelay = !callerPeerId && !!req.authToken && isInstanceAdmin(req.authToken);
    await Promise.all(parsed.data.map(t =>
      applyRemoteTombstone(t as TombstoneDoc, { peerInstanceId: callerPeerId, trustedRelay }),
    ));

    /*
     * A TOMBSTONE MUST ADVANCE THE COUNTER, exactly as a document does.
     *
     * The bump exists so "future local writes always get a seq higher than any document received from this
     * peer" — its own words. A tombstone was received from this peer and carries the deleting instance's seq,
     * and skipping it breaks that invariant in the one place it costs a record:
     *
     *   a busy peer (counter 5001) deletes a record         -> tombstone, seq 5001
     *   a quiet peer (counter 300) receives it              -> counter stays 300
     *   the quiet peer re-creates that record with the same id -> local seq 301
     *   it pushes back                                      -> `tombstone.seq >= incoming.seq`, refused as
     *                                                          `tombstoned` with a 200
     *
     * The sender reads only `resp.ok`, so it advances past the record and never offers it again. Silent,
     * permanent, and one-directional. It is reachable today wherever a caller supplies the id — facts,
     * entities and chrono all take one — and it is what would make a derived edge id unsafe (P-23).
     *
     * Bumped on everything RECEIVED rather than on what `applyRemoteTombstone` accepted. A tombstone it
     * refuses on authorship grounds still tells us where that peer's clock is, and the two errors are not
     * symmetric: advancing too far only skips some seq numbers, while not advancing far enough loses a
     * record.
     */
    const maxTombstoneSeq = parsed.data.reduce((m, t) => Math.max(m, t.seq ?? 0), 0);
    if (maxTombstoneSeq > 0) bumpSeq(spaceId, maxTombstoneSeq).catch(() => {});

    res.status(200).json({ applied: parsed.data.length });
  } catch (err) {
    log.error(`sync POST tombstones: ${err}`);
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
    const tombstones = await col<FileTombstoneDoc>(`${spaceId}_file_tombstones`)
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
    const { spaceId, tombstones } = req.body as { spaceId?: string; tombstones?: unknown[] };
    const { networkId } = req.query as Record<string, string>;
    if (!spaceId || typeof spaceId !== 'string') { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!Array.isArray(tombstones)) { res.status(400).json({ error: 'tombstones must be array' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (isNonPeerSyncWrite(req.authToken as Record<string, unknown>)) { res.status(403).json({ error: NON_PEER_WRITE_MESSAGE }); return; }
    if (isDirectionalWriteBlocked(spaceId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Directional network: write not permitted from this peer' }); return; }

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
      await fs.unlink(abs).catch(() => {});

      // Record tombstone locally so we can propagate it to further peers.
      const doc: FileTombstoneDoc = {
        _id: ts._id,
        spaceId,
        path: rel,
        deletedAt: typeof ts.deletedAt === 'string' ? ts.deletedAt : new Date().toISOString(),
      };
      await col<FileTombstoneDoc>(`${spaceId}_file_tombstones`).updateOne(
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
