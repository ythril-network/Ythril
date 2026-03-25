import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireSpaceAuth, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { listMemories, deleteMemory, countMemories } from '../brain/memory.js';
import { listEntities, deleteEntity } from '../brain/entities.js';
import { listEdges, deleteEdge } from '../brain/edges.js';
import { embed } from '../brain/embedding.js';
import { getConfig } from '../config/loader.js';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { needsReindex, clearReindexFlag } from '../spaces/spaces.js';
import { log } from '../util/log.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { resolveMemberSpaces, resolveWriteTarget, findSpace } from '../spaces/proxy.js';
import type { MemoryDoc } from '../config/types.js';

export const brainRouter = Router();

// ── Short-form memory CRUD  (/:spaceId/memories) ──────────────────────────
// These are the primary REST endpoints used by API clients and integration tests.

// POST /api/brain/:spaceId/memories — create a memory
brainRouter.post('/:spaceId/memories', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  // Proxy space: resolve target space for write
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const targetSpace = wt.target;
  const { fact, tags = [], entityIds = [] } = req.body ?? {};
  if (!fact || typeof fact !== 'string') {
    res.status(400).json({ error: '`fact` string required' });
    return;
  }
  if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) {
    res.status(400).json({ error: '`tags` must be an array of strings' });
    return;
  }
  if ((fact as string).length > 50_000) {
    res.status(400).json({ error: '`fact` must not exceed 50 000 characters' });
    return;
  }
  // Quota check — reject with 507 if brain hard limit exceeded
  let quotaResult;
  try {
    quotaResult = await checkQuota('brain');
  } catch (err) {
    if (err instanceof QuotaError) {
      res.status(507).json({ error: err.message, storageExceeded: true });
      return;
    }
    throw err;
  }
  // Attempt embedding; fall back to empty vector if server not configured/reachable
  let embedding: number[] = [];
  let embeddingModel = 'none';
  try {
    const result = await embed(fact);
    embedding = result.vector;
    embeddingModel = result.model;
  } catch (err) {
    log.warn(`Embedding unavailable, storing without vector: ${err}`);
  }
  const seq = await nextSeq(targetSpace);
  const now = new Date().toISOString();
  const doc: MemoryDoc = {
    _id: uuidv4(),
    spaceId: targetSpace,
    fact,
    embedding,
    tags: Array.isArray(tags) ? tags : [],
    entityIds: Array.isArray(entityIds) ? entityIds : [],
    author: { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel },
    createdAt: now,
    updatedAt: now,
    seq,
    embeddingModel,
  };
  await col<MemoryDoc>(`${targetSpace}_memories`).insertOne(doc as never);
  const body: Record<string, unknown> = { ...doc };
  if (quotaResult?.softBreached) body['storageWarning'] = true;
  res.status(201).json(body);
});

/** Build a MongoDB filter from `tag` and `entity` query params */
function buildMemoryFilter(query: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const tag = typeof query['tag'] === 'string' ? query['tag'] : undefined;
  const entity = typeof query['entity'] === 'string' ? query['entity'] : undefined;
  if (tag) filter['tags'] = { $regex: `^${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
  if (entity) filter['entityIds'] = entity;
  return filter;
}

// GET /api/brain/:spaceId/memories — list memories
brainRouter.get('/:spaceId/memories', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = Math.min(Number(req.query['limit'] ?? 100), 500);
  const skip = Number(req.query['skip'] ?? 0);
  const filter = buildMemoryFilter(req.query as Record<string, unknown>);
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listMemories(mid, filter, limit, skip)))).flat();
  res.json({ memories: all, limit, skip });
});

// GET /api/brain/:spaceId/memories/:id — get single memory
brainRouter.get('/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    const doc = await col<MemoryDoc>(`${mid}_memories`).findOne({ _id: id } as never) as MemoryDoc | null;
    if (doc) { res.json(doc); return; }
  }
  res.status(404).json({ error: 'Memory not found' });
});

// DELETE /api/brain/:spaceId/memories/:id — delete memory
brainRouter.delete('/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    if (await deleteMemory(mid, id)) { res.status(204).end(); return; }
  }
  res.status(404).json({ error: 'Memory not found' });
});

// GET /api/brain/spaces/:spaceId/stats
brainRouter.get('/spaces/:spaceId/stats', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const memberIds = resolveMemberSpaces(spaceId);
  const counts = await Promise.all(memberIds.map(async mid => ({
    memories: await countMemories(mid),
    entities: await col(`${mid}_entities`).countDocuments(),
    edges: await col(`${mid}_edges`).countDocuments(),
  })));
  const memories = counts.reduce((s, c) => s + c.memories, 0);
  const entities = counts.reduce((s, c) => s + c.entities, 0);
  const edges = counts.reduce((s, c) => s + c.edges, 0);
  res.json({ spaceId, memories, entities, edges });
});

// GET /api/brain/spaces/:spaceId/memories
brainRouter.get('/spaces/:spaceId/memories', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = Math.min(Number(req.query['limit'] ?? 20), 100);
  const skip = Number(req.query['skip'] ?? 0);
  const filter = buildMemoryFilter(req.query as Record<string, unknown>);
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listMemories(mid, filter, limit, skip)))).flat();
  res.json({ memories: all, limit, skip });
});

// DELETE /api/brain/spaces/:spaceId/memories/:id
brainRouter.delete('/spaces/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    if (await deleteMemory(mid, id)) { res.status(204).end(); return; }
  }
  res.status(404).json({ error: 'Memory not found' });
});

// GET /api/brain/spaces/:spaceId/entities
brainRouter.get('/spaces/:spaceId/entities', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
  const skip = Number(req.query['skip'] ?? 0);
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listEntities(mid, {}, limit, skip)))).flat();
  res.json({ entities: all, limit, skip });
});

// DELETE /api/brain/spaces/:spaceId/entities/:id
brainRouter.delete('/spaces/:spaceId/entities/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    if (await deleteEntity(mid, id)) { res.status(204).end(); return; }
  }
  res.status(404).json({ error: 'Entity not found' });
});

// GET /api/brain/spaces/:spaceId/edges
brainRouter.get('/spaces/:spaceId/edges', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
  const skip = Number(req.query['skip'] ?? 0);
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listEdges(mid, {}, limit, skip)))).flat();
  res.json({ edges: all, limit, skip });
});

// DELETE /api/brain/spaces/:spaceId/edges/:id
brainRouter.delete('/spaces/:spaceId/edges/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    if (await deleteEdge(mid, id)) { res.status(204).end(); return; }
  }
  res.status(404).json({ error: 'Edge not found' });
});

// GET /api/brain/spaces/:spaceId/reindex-status
brainRouter.get('/spaces/:spaceId/reindex-status', globalRateLimit, requireSpaceAuth, (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const memberIds = resolveMemberSpaces(spaceId);
  const needs = memberIds.some(mid => needsReindex(mid));
  res.json({ spaceId, needsReindex: needs });
});

// POST /api/brain/spaces/:spaceId/reindex
// Re-embeds all memories in a space using the currently configured model.
// Long-running: may take minutes for large spaces. Progress is logged server-side.
brainRouter.post('/spaces/:spaceId/reindex', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const memberIds = resolveMemberSpaces(spaceId);
  let reindexed = 0;
  let errors = 0;

  for (const mid of memberIds) {
    const BATCH = 50;
    let skip = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await col<MemoryDoc>(`${mid}_memories`)
        .find({}, { projection: { _id: 1, fact: 1 } })
        .skip(skip)
        .limit(BATCH)
        .toArray();

      if (batch.length === 0) break;

      for (const doc of batch) {
        try {
          const result = await embed(doc.fact);
          await col<MemoryDoc>(`${mid}_memories`).updateOne(
            { _id: doc._id },
            { $set: { embedding: result.vector, embeddingModel: result.model } },
          );
          reindexed++;
        } catch {
          errors++;
        }
      }

      skip += batch.length;
    }

    clearReindexFlag(mid);
  }

  res.json({ spaceId, reindexed, errors });
});
