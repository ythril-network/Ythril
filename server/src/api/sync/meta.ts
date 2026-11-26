/**
 * Peer-facing space meta — the schema, purpose and notes a downstream instance merges into its copy (`F-39.1`).
 *
 * Served to a caller that may REACH the space (`refusePeerReach`) and may read its schema (`refuseSchemaRung`, the one check this door and
 * `GET /schema-snapshot` share): a peer that may sync the space's data may read what describes it, and nothing else. It is NOT held while a wipe is applied on one side (design v5 X17): a wipe changes no schema,
 * and a subscriber takes its type schemas through this door, so holding it would delay schema propagation for the hold's length. What is served is `replicatedMetaOf` — everything a network governs,
 * nothing the server owns — so the receiver keeps its own version counter and history.
 */
import { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth } from '../../auth/middleware.js';
import { getConfig } from '../../config/loader.js';
import { replicatedMetaOf, servedMetaFor } from '../../sync/replicated-meta.js';
import { isDirectionalNetwork } from '../../networks/network-spaces.js';
import { servedNetworkPart } from '../../networks/schema-standing.js';
import { refusePeerReach, refuseSchemaRung } from './_shared.js';
import { registerSchemaSnapshotRoute } from './schema-snapshot.js';
import { inlineResolvableRefs } from '../../spaces/schema-validation.js';
import { sendCaughtFailure } from '../send-failure.js';
import { sendLostSpace } from '../write-target-answer.js';

export const syncMetaRouter = Router();

/** GET /api/sync/meta?spaceId=&networkId= */
syncMetaRouter.get('/meta', syncRateLimit, requireAuth, (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (refusePeerReach(res, spaceId, networkId, req.authToken)) return;
    if (refuseSchemaRung(res, spaceId, req.authToken)) return;
    const space = getConfig().spaces.find(s => s.id === spaceId);
    if (!space) { sendLostSpace(req, res, spaceId); return; }
    // Own definitions plus THIS network's layer only — never another network's, never the effective mix (F-39.2).
    const net = getConfig().networks.find(n => n.id === networkId);
    const layer = net?.schemaLayers?.[spaceId];
    // Q-60: library references written inline where this instance can resolve them — a peer's library is its own.
    const meta = inlineResolvableRefs(replicatedMetaOf(servedMetaFor(space, layer ? { networkId, meta: layer } : undefined)));
    // Q-966: on a voted network, the network's own part, which is what a joiner or a healing member stores as the network's layer, and whether
    // it is the whole schema (`servedNetworkPart` decides both).
    if (net && !isDirectionalNetwork(net) && net.spaces.includes(spaceId)) {
      res.json({ meta, ...servedNetworkPart(net, spaceId, meta, () => inlineResolvableRefs(replicatedMetaOf(layer ?? {}))) });
      return;
    }
    res.json({ meta });
  } catch (err) {
    sendCaughtFailure(res, 'sync GET /meta', err);
  }
});

// GET /api/sync/schema-snapshot: the other schema door, registered here so it rides this router inside the peer-authenticated syncRouter.
registerSchemaSnapshotRoute(syncMetaRouter);
