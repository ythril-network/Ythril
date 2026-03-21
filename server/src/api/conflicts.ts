import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { ConflictDoc } from '../config/types.js';

export const conflictsRouter = Router();

/** Return the space IDs the authenticated token is allowed to access. */
function accessibleSpaces(tokenSpaces?: string[]): string[] {
  const cfg = getConfig();
  const all = cfg.spaces.map(s => s.id);
  if (!tokenSpaces || tokenSpaces.length === 0) return all;
  return all.filter(id => tokenSpaces.includes(id));
}

// GET /api/conflicts — list unresolved conflicts for all accessible spaces
conflictsRouter.get('/', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    const results: ConflictDoc[] = [];
    for (const spaceId of spaces) {
      const docs = await col<ConflictDoc>(`${spaceId}_conflicts`)
        .find({})
        .sort({ detectedAt: -1 })
        .limit(500)
        .toArray() as ConflictDoc[];
      results.push(...docs);
    }
    results.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    res.json({
      conflicts: results.map(c => ({
        id: c._id,
        spaceId: c.spaceId,
        originalPath: c.originalPath,
        conflictPath: c.conflictPath,
        peerInstanceId: c.peerInstanceId,
        peerInstanceLabel: c.peerInstanceLabel,
        detectedAt: c.detectedAt,
      })),
    });
  } catch (err) {
    log.error(`GET /api/conflicts: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/conflicts/:id — get a single conflict record
conflictsRouter.get('/:id', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    for (const spaceId of spaces) {
      const doc = await col<ConflictDoc>(`${spaceId}_conflicts`)
        .findOne({ _id: req.params['id'] } as never) as ConflictDoc | null;
      if (doc) {
        res.json({
          id: doc._id,
          spaceId: doc.spaceId,
          originalPath: doc.originalPath,
          conflictPath: doc.conflictPath,
          peerInstanceId: doc.peerInstanceId,
          peerInstanceLabel: doc.peerInstanceLabel,
          detectedAt: doc.detectedAt,
        });
        return;
      }
    }
    res.status(404).json({ error: 'Conflict not found' });
  } catch (err) {
    log.error(`GET /api/conflicts/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/conflicts/:id — dismiss (resolve) a conflict record
conflictsRouter.delete('/:id', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    for (const spaceId of spaces) {
      const result = await col<ConflictDoc>(`${spaceId}_conflicts`)
        .deleteOne({ _id: req.params['id'] } as never);
      if (result.deletedCount > 0) {
        res.status(204).end();
        return;
      }
    }
    res.status(404).json({ error: 'Conflict not found' });
  } catch (err) {
    log.error(`DELETE /api/conflicts/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/conflicts/:id/resolve — forward-compatible alias for dismissing a conflict
conflictsRouter.post('/:id/resolve', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    for (const spaceId of spaces) {
      const result = await col<ConflictDoc>(`${spaceId}_conflicts`)
        .deleteOne({ _id: req.params['id'] } as never);
      if (result.deletedCount > 0) {
        res.status(200).json({ status: 'resolved' });
        return;
      }
    }
    res.status(404).json({ error: 'Conflict not found' });
  } catch (err) {
    log.error(`POST /api/conflicts/:id/resolve: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

