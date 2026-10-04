/**
 * Presync warm-up — eagerly warms auth cache, embedding pipeline, and Mongo handles.
 *
 * Split out of the api/sync.ts monolith (A17.6); handlers are unchanged.
 */
import { Router } from 'express';
import { col, asFilter } from '../../db/mongo.js';
import { warmEmbeddingModel } from '../../brain/embedding.js';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { getConfig } from '../../config/loader.js';
import { requireAuth } from '../../auth/middleware.js';
import { log, peerText } from '../../util/log.js';
import { spaceCollection } from '../../db/space-collection.js';
import { carriedLocalId } from '../../sync/space-map.js';
import { sendCaughtFailure } from '../send-failure.js';

export const syncWarmRouter = Router();


// ── Vote conclusion logic ──────────────────────────────────────────────────


// ── Presync warm-up ─────────────────────────────────────────────────────────
/**
 * POST /api/sync/warm
 * Called by a peer before the real sync cycle begins.  Eagerly warms:
 *  1. Auth middleware bcrypt cache (happens automatically via requireAuth)
 *  2. Local ONNX embedding pipeline (model load / cache hit)
 *  3. MongoDB collection handles + first-query per space collection
 *
 * Body: { networkId, spaces: string[] }
 * Returns 200 { status: 'ready' } once all warm-up work completes.
 */
syncWarmRouter.post('/warm', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const body = req.body as { networkId?: string; spaces?: string[] };
    if (!body?.networkId || !Array.isArray(body.spaces) || body.spaces.length === 0) {
      res.status(400).json({ error: 'networkId and spaces[] required' });
      return;
    }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === body.networkId);
    // A peer token warms only a network it is a member of — the same "not found" as a network that does not exist,
    // so a caller learns nothing about networks it is not in (Q-133).
    const peerId = (req.authToken as { peerInstanceId?: string } | undefined)?.peerInstanceId;
    if (!net || (peerId && !net.members.some(m => m.instanceId === peerId))) {
      res.status(404).json({ error: 'Network not found' });
      return;
    }

    // The caller names spaces by the NETWORK's ids (Q-133). Each is resolved to this instance's space, and one the
    // network does not carry here is dropped — so the list is bounded by what this network carries, deduped, and
    // never reaches a collection outside it.
    const targets = [...new Set(body.spaces.slice(0, net.spaces.length).map(sid => carriedLocalId(net, sid)))]
      .filter((sid): sid is string => sid !== null);

    // Warm embedding model and MongoDB collections in parallel
    await Promise.all([
      warmEmbeddingModel().catch(err =>
        log.warn(`Warm: embedding model failed: ${peerText(err)}`),
      ),
      ...targets.flatMap(sid => [
        col(spaceCollection(sid, 'facts')).findOne(asFilter({}), { projection: { _id: 1 } }).catch(() => {}),
        col(spaceCollection(sid, 'entities')).findOne(asFilter({}), { projection: { _id: 1 } }).catch(() => {}),
        col(spaceCollection(sid, 'edges')).findOne(asFilter({}), { projection: { _id: 1 } }).catch(() => {}),
        col(spaceCollection(sid, 'chrono')).findOne(asFilter({}), { projection: { _id: 1 } }).catch(() => {}),
      ]),
    ]);

    res.json({ status: 'ready' });
  } catch (err) {
    sendCaughtFailure(res, `sync POST warm`, err);
  }
});
