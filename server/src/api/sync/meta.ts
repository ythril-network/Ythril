/**
 * Peer-facing space meta — the schema, purpose and notes a downstream instance merges into its copy (`F-39.1`).
 *
 * Served under the same admission as a space's records (`spaceAllowed`): a peer that may sync the space's data may
 * read what describes it, and nothing else. What is served is `replicatedMetaOf` — everything a network governs,
 * nothing the server owns — so the receiver keeps its own version counter and history.
 */
import { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth } from '../../auth/middleware.js';
import { getConfig } from '../../config/loader.js';
import { reportServerFailure } from '../../util/report-failure.js';
import { replicatedMetaOf } from '../../sync/replicated-meta.js';
import { spaceAllowed } from './_shared.js';

export const syncMetaRouter = Router();

/** GET /api/sync/meta?spaceId=&networkId= */
syncMetaRouter.get('/meta', syncRateLimit, requireAuth, (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken as Record<string, unknown>)) { res.status(403).json({ error: 'Forbidden' }); return; }
    const space = getConfig().spaces.find(s => s.id === spaceId);
    if (!space) { res.status(404).json({ error: 'Space not found' }); return; }
    res.json({ meta: replicatedMetaOf(space.meta) });
  } catch (err) {
    reportServerFailure('sync GET /meta', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
