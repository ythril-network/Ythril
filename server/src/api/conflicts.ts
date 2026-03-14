import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';

export const conflictsRouter = Router();

/**
 * Conflict resolution API — stub implementation.
 *
 * Conflicts arise when two brains in a network independently modify the same
 * memory or entity and the sync engine cannot auto-merge them.
 *
 * Phase 3 will implement full detection and persistence. For now the endpoints
 * are structurally present so MCP clients and the UI can be wired up without
 * breaking changes later.
 */

// GET /api/conflicts — list unresolved conflicts for the authenticated token's spaces
conflictsRouter.get('/', globalRateLimit, requireAuth, (_req, res) => {
  // TODO(phase-3): query conflicts collection filtered to req.authToken.spaces
  res.json({ conflicts: [] });
});

// GET /api/conflicts/:id
conflictsRouter.get('/:id', globalRateLimit, requireAuth, (_req, res) => {
  res.status(404).json({ error: 'Conflict not found' });
});

// POST /api/conflicts/:id/resolve
// Body: { strategy: 'keep-local' | 'keep-remote' | 'merge', mergedValue?: string }
conflictsRouter.post('/:id/resolve', globalRateLimit, requireAuth, (_req, res) => {
  // TODO(phase-3): apply resolution strategy and remove conflict record
  res.status(404).json({ error: 'Conflict not found' });
});
