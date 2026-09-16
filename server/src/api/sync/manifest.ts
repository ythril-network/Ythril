/**
 * Peer file manifest and the merkle summary used to skip unchanged subtrees.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth } from '../../auth/middleware.js';
import { log } from '../../util/log.js';
import { buildFileManifest } from '../../files/manifest.js';
import { computeMerkleRoot } from '../../brain/merkle.js';
import { spaceAllowed } from './_shared.js';

export const syncManifestRouter = Router();


// ═══════════════════════════════════════════════════════════════════════════
// FILE MANIFEST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/manifest?spaceId=&networkId=&since=<isoTimestamp>
 * Returns list of { path, sha256, size, modifiedAt } for files changed since timestamp.
 * Omit `since` for a full manifest.
 */
syncManifestRouter.get('/manifest', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, since } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceDate = since ? new Date(since) : undefined;
    const manifest = await buildFileManifest(spaceId, sinceDate);
    res.json({ manifest });
  } catch (err) {
    log.error(`sync GET manifest: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// MERKLE ROOT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/merkle?spaceId=&networkId=
 *
 * Returns the SHA-256 Merkle root for the given space.  The root covers all
 * fact / entity / edge documents (identified by their _id + seq) and all
 * files in the space (identified by their relative path + sha256 hash).
 *
 * This endpoint is consumed by the sync engine when a network has
 * `merkle: true` — after data sync the engine compares roots across peers and
 * emits a MERKLE_DIVERGENCE warning if they disagree.
 *
 * Response: { spaceId, networkId, root, leafCount, computedAt }
 */
syncManifestRouter.get('/merkle', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const result = await computeMerkleRoot(spaceId);
    res.json({ ...result, networkId: networkId ?? null });
  } catch (err) {
    log.error(`sync GET merkle: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
