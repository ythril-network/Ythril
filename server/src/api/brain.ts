import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { listMemories, deleteMemory, countMemories } from '../brain/memory.js';
import { listEntities, deleteEntity } from '../brain/entities.js';
import { listEdges, deleteEdge } from '../brain/edges.js';
import { getConfig } from '../config/loader.js';
import { col } from '../db/mongo.js';

export const brainRouter = Router();

// GET /api/brain/spaces/:spaceId/stats
brainRouter.get('/spaces/:spaceId/stats', globalRateLimit, requireAuth, async (req, res) => {
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
brainRouter.get('/spaces/:spaceId/memories', globalRateLimit, requireAuth, async (req, res) => {
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
brainRouter.delete('/spaces/:spaceId/memories/:id', globalRateLimit, requireAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const ok = await deleteMemory(spaceId, id);
  if (!ok) { res.status(404).json({ error: 'Memory not found' }); return; }
  res.status(204).end();
});

// GET /api/brain/spaces/:spaceId/entities
brainRouter.get('/spaces/:spaceId/entities', globalRateLimit, requireAuth, async (req, res) => {
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
brainRouter.delete('/spaces/:spaceId/entities/:id', globalRateLimit, requireAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const ok = await deleteEntity(spaceId, id);
  if (!ok) { res.status(404).json({ error: 'Entity not found' }); return; }
  res.status(204).end();
});

// GET /api/brain/spaces/:spaceId/edges
brainRouter.get('/spaces/:spaceId/edges', globalRateLimit, requireAuth, async (req, res) => {
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
brainRouter.delete('/spaces/:spaceId/edges/:id', globalRateLimit, requireAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const ok = await deleteEdge(spaceId, id);
  if (!ok) { res.status(404).json({ error: 'Edge not found' }); return; }
  res.status(204).end();
});
