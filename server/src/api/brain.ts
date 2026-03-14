import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireSpaceAuth } from '../auth/middleware.js';
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
import type { MemoryDoc } from '../config/types.js';

export const brainRouter = Router();

// ── Short-form memory CRUD  (/:spaceId/memories) ──────────────────────────
// These are the primary REST endpoints used by API clients and integration tests.

// POST /api/brain/:spaceId/memories — create a memory
brainRouter.post('/:spaceId/memories', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
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
  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const doc: MemoryDoc = {
    _id: uuidv4(),
    spaceId,
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
  await col<MemoryDoc>(`${spaceId}_memories`).insertOne(doc as never);
  res.status(201).json(doc);
});

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
  const docs = await listMemories(spaceId, {}, limit, skip);
  res.json({ memories: docs, limit, skip });
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
  const doc = await col<MemoryDoc>(`${spaceId}_memories`).findOne({ _id: id } as never) as MemoryDoc | null;
  if (!doc) { res.status(404).json({ error: 'Memory not found' }); return; }
  res.json(doc);
});

// DELETE /api/brain/:spaceId/memories/:id — delete memory
brainRouter.delete('/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const ok = await deleteMemory(spaceId, id);
  if (!ok) { res.status(404).json({ error: 'Memory not found' }); return; }
  res.status(204).end();
});

// GET /api/brain/spaces/:spaceId/stats
brainRouter.get('/spaces/:spaceId/stats', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const [memories, entities, edges] = await Promise.all([
    countMemories(spaceId),
    col(`${spaceId}_entities`).countDocuments(),
    col(`${spaceId}_edges`).countDocuments(),
  ]);
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
  const docs = await listMemories(spaceId, {}, limit, skip);
  res.json({ memories: docs, limit, skip });
});

// DELETE /api/brain/spaces/:spaceId/memories/:id
brainRouter.delete('/spaces/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const ok = await deleteMemory(spaceId, id);
  if (!ok) { res.status(404).json({ error: 'Memory not found' }); return; }
  res.status(204).end();
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
  const docs = await listEntities(spaceId, {}, limit);
  res.json({ entities: docs });
});

// DELETE /api/brain/spaces/:spaceId/entities/:id
brainRouter.delete('/spaces/:spaceId/entities/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const ok = await deleteEntity(spaceId, id);
  if (!ok) { res.status(404).json({ error: 'Entity not found' }); return; }
  res.status(204).end();
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
  const docs = await listEdges(spaceId, {}, limit);
  res.json({ edges: docs });
});

// DELETE /api/brain/spaces/:spaceId/edges/:id
brainRouter.delete('/spaces/:spaceId/edges/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const ok = await deleteEdge(spaceId, id);
  if (!ok) { res.status(404).json({ error: 'Edge not found' }); return; }
  res.status(204).end();
});

// GET /api/brain/spaces/:spaceId/reindex-status
brainRouter.get('/spaces/:spaceId/reindex-status', globalRateLimit, requireSpaceAuth, (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  res.json({ spaceId, needsReindex: needsReindex(spaceId) });
});

// POST /api/brain/spaces/:spaceId/reindex
// Re-embeds all memories in a space using the currently configured model.
// Long-running: may take minutes for large spaces. Progress is logged server-side.
brainRouter.post('/spaces/:spaceId/reindex', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const BATCH = 50;
  let skip = 0;
  let reindexed = 0;
  let errors = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await col<MemoryDoc>(`${spaceId}_memories`)
      .find({}, { projection: { _id: 1, fact: 1 } })
      .skip(skip)
      .limit(BATCH)
      .toArray();

    if (batch.length === 0) break;

    for (const doc of batch) {
      try {
        const result = await embed(doc.fact);
        await col<MemoryDoc>(`${spaceId}_memories`).updateOne(
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

  clearReindexFlag(spaceId);
  res.json({ spaceId, reindexed, errors });
});
