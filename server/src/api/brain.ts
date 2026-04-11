import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireSpaceAuth, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit, bulkWipeRateLimit } from '../rate-limit/middleware.js';
import { listMemories, deleteMemory, countMemories, bulkDeleteMemories, updateMemory, queryBrain } from '../brain/memory.js';
import { listEntities, deleteEntity, upsertEntity, getEntityById, updateEntityById, bulkDeleteEntities } from '../brain/entities.js';
import { listEdges, deleteEdge, upsertEdge, getEdgeById, updateEdgeById, bulkDeleteEdges, traverseGraph } from '../brain/edges.js';
import { createChrono, updateChrono, getChronoById, listChrono, deleteChrono, bulkDeleteChrono, ChronoFilter } from '../brain/chrono.js';
import { embed } from '../brain/embedding.js';
import { getConfig } from '../config/loader.js';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { needsReindex, clearReindexFlag } from '../spaces/spaces.js';
import { log } from '../util/log.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { resolveMemberSpaces, resolveWriteTarget, findSpace, isProxySpace } from '../spaces/proxy.js';
import type { MemoryDoc, EntityDoc, EdgeDoc, ChronoEntry, FileMetaDoc, ChronoKind, ChronoStatus } from '../config/types.js';
import { reindexInProgress } from '../metrics/registry.js';

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
  const { fact, tags = [], entityIds = [], description, properties } = req.body ?? {};
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
  const safeDesc: string | undefined = typeof description === 'string' ? description : undefined;
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;
  const safeEntityIds: string[] = Array.isArray(entityIds) ? entityIds : [];
  const safeTags: string[] = Array.isArray(tags) ? tags : [];

  // Resolve entity names for richer embedding
  let entityNames: string[] = [];
  if (safeEntityIds.length > 0) {
    try {
      const entityDocs = await col<EntityDoc>(`${targetSpace}_entities`)
        .find({ _id: { $in: safeEntityIds } } as never, { projection: { name: 1 } })
        .toArray() as Array<{ name: string }>;
      entityNames = entityDocs.map(e => e.name);
    } catch { /* ignore — entity names are best-effort */ }
  }

  // Assemble embedding text from all content fields
  const embedParts: string[] = [];
  if (safeTags.length > 0) embedParts.push(safeTags.join(' '));
  if (entityNames.length > 0) embedParts.push(entityNames.join(' '));
  embedParts.push(fact);
  if (safeDesc?.trim()) embedParts.push(safeDesc.trim());
  if (safeProps) {
    const propEntries = Object.entries(safeProps);
    if (propEntries.length > 0) embedParts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
  }

  // Attempt embedding; fall back to empty vector if server not configured/reachable
  let embedding: number[] = [];
  let embeddingModel = 'none';
  try {
    const result = await embed(embedParts.join(' '));
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
    tags: safeTags,
    entityIds: safeEntityIds,
    author: { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel },
    createdAt: now,
    updatedAt: now,
    seq,
    embeddingModel,
  };
  if (safeDesc !== undefined) doc.description = safeDesc;
  if (safeProps !== undefined) doc.properties = safeProps;
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

// PATCH /api/brain/:spaceId/memories/:id — partial update a memory
brainRouter.patch('/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const { fact, tags, entityIds, description, properties } = req.body ?? {};
  const updates: { fact?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean> } = {};
  if (fact !== undefined) {
    if (typeof fact !== 'string' || !fact.trim()) { res.status(400).json({ error: '`fact` must be a non-empty string' }); return; }
    updates.fact = fact;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`tags` must be an array of strings' }); return; }
    updates.tags = tags;
  }
  if (entityIds !== undefined) {
    if (!Array.isArray(entityIds) || entityIds.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`entityIds` must be an array of strings' }); return; }
    updates.entityIds = entityIds;
  }
  if (description !== undefined) {
    if (typeof description !== 'string') { res.status(400).json({ error: '`description` must be a string' }); return; }
    updates.description = description;
  }
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) { res.status(400).json({ error: '`properties` must be a plain object' }); return; }
    updates.properties = properties as Record<string, string | number | boolean>;
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    const updated = await updateMemory(mid, id, updates);
    if (updated) { res.json(updated); return; }
  }
  res.status(404).json({ error: 'Memory not found' });
});

// DELETE /api/brain/:spaceId/memories — bulk wipe all memories
brainRouter.delete('/:spaceId/memories', bulkWipeRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  if (isProxySpace(spaceId)) {
    res.status(400).json({ error: 'Bulk wipe not supported on proxy spaces — target member spaces individually' });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: '`confirm: true` required in request body' });
    return;
  }
  const deleted = await bulkDeleteMemories(spaceId);
  res.json({ deleted });
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
    chrono: await col(`${mid}_chrono`).countDocuments(),
    files: await col(`${mid}_files`).countDocuments(),
  })));
  const memories = counts.reduce((s, c) => s + c.memories, 0);
  const entities = counts.reduce((s, c) => s + c.entities, 0);
  const edges = counts.reduce((s, c) => s + c.edges, 0);
  const chrono = counts.reduce((s, c) => s + c.chrono, 0);
  const files = counts.reduce((s, c) => s + c.files, 0);
  res.json({ spaceId, memories, entities, edges, chrono, files });
});

// GET /api/brain/spaces/:spaceId/memories
brainRouter.get('/spaces/:spaceId/memories', globalRateLimit, requireSpaceAuth, async (req, res) => {
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

// PATCH /api/brain/spaces/:spaceId/memories/:id — partial update a memory (long-form)
brainRouter.patch('/spaces/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const { fact, tags, entityIds, description, properties } = req.body ?? {};
  const updates: { fact?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean> } = {};
  if (fact !== undefined) {
    if (typeof fact !== 'string' || !fact.trim()) { res.status(400).json({ error: '`fact` must be a non-empty string' }); return; }
    updates.fact = fact;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`tags` must be an array of strings' }); return; }
    updates.tags = tags;
  }
  if (entityIds !== undefined) {
    if (!Array.isArray(entityIds) || entityIds.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`entityIds` must be an array of strings' }); return; }
    updates.entityIds = entityIds;
  }
  if (description !== undefined) {
    if (typeof description !== 'string') { res.status(400).json({ error: '`description` must be a string' }); return; }
    updates.description = description;
  }
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) { res.status(400).json({ error: '`properties` must be a plain object' }); return; }
    updates.properties = properties as Record<string, string | number | boolean>;
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    const updated = await updateMemory(mid, id, updates);
    if (updated) { res.json(updated); return; }
  }
  res.status(404).json({ error: 'Memory not found' });
});

// DELETE /api/brain/spaces/:spaceId/memories — bulk wipe (long-form)
brainRouter.delete('/spaces/:spaceId/memories', bulkWipeRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  if (isProxySpace(spaceId)) {
    res.status(400).json({ error: 'Bulk wipe not supported on proxy spaces — target member spaces individually' });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: '`confirm: true` required in request body' });
    return;
  }
  const deleted = await bulkDeleteMemories(spaceId);
  res.json({ deleted });
});

// POST /api/brain/spaces/:spaceId/entities — create/upsert an entity
brainRouter.post('/spaces/:spaceId/entities', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const { name, type = '', tags = [], properties = {}, description } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: '`name` string required' });
    return;
  }
  if (typeof type !== 'string') {
    res.status(400).json({ error: '`type` must be a string' });
    return;
  }
  if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) {
    res.status(400).json({ error: '`tags` must be an array of strings' });
    return;
  }
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    res.status(400).json({ error: '`properties` must be a plain object' });
    return;
  }
  for (const [k, v] of Object.entries(properties)) {
    if (typeof k !== 'string' || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) {
      res.status(400).json({ error: '`properties` values must be string, number, or boolean' });
      return;
    }
  }
  const safeDesc: string | undefined = typeof description === 'string' ? description : undefined;
  const entity = await upsertEntity(wt.target, name.trim(), type.trim(), tags, properties, safeDesc);
  res.status(201).json(entity);
});

// POST /api/brain/spaces/:spaceId/edges — create/upsert an edge
brainRouter.post('/spaces/:spaceId/edges', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const { from, to, label, weight, type, description, properties, tags } = req.body ?? {};
  if (!from || typeof from !== 'string') {
    res.status(400).json({ error: '`from` string required' });
    return;
  }
  if (!to || typeof to !== 'string') {
    res.status(400).json({ error: '`to` string required' });
    return;
  }
  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: '`label` string required' });
    return;
  }
  if (weight !== undefined && typeof weight !== 'number') {
    res.status(400).json({ error: '`weight` must be a number' });
    return;
  }
  if (type !== undefined && typeof type !== 'string') {
    res.status(400).json({ error: '`type` must be a string' });
    return;
  }
  if (description !== undefined && typeof description !== 'string') {
    res.status(400).json({ error: '`description` must be a string' });
    return;
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`tags` must be an array of strings' });
    return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;
  const safeTags: string[] | undefined = Array.isArray(tags) ? tags : undefined;
  const edge = await upsertEdge(
    wt.target, from.trim(), to.trim(), label.trim(), weight, type?.trim(),
    typeof description === 'string' ? description : undefined, safeProps, safeTags,
  );
  res.status(201).json(edge);
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
  const filter: Record<string, unknown> = {};
  if (typeof req.query['name'] === 'string') filter['name'] = req.query['name'];
  if (typeof req.query['type'] === 'string') filter['type'] = req.query['type'];
  if (typeof req.query['tag'] === 'string') filter['tags'] = req.query['tag'];
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listEntities(mid, filter, limit, skip)))).flat();
  res.json({ entities: all, limit, skip });
});

// GET /api/brain/spaces/:spaceId/entities/:id
brainRouter.get('/spaces/:spaceId/entities/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    const doc = await getEntityById(mid, id);
    if (doc) { res.json(doc); return; }
  }
  res.status(404).json({ error: 'Entity not found' });
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

// PATCH /api/brain/spaces/:spaceId/entities/:id — partial update an entity by ID
brainRouter.patch('/spaces/:spaceId/entities/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const { name, type, description, tags, properties } = req.body ?? {};
  const updates: { name?: string; type?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean> } = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) { res.status(400).json({ error: '`name` must be a non-empty string' }); return; }
    updates.name = name.trim();
  }
  if (type !== undefined) {
    if (typeof type !== 'string') { res.status(400).json({ error: '`type` must be a string' }); return; }
    updates.type = type.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string') { res.status(400).json({ error: '`description` must be a string' }); return; }
    updates.description = description;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`tags` must be an array of strings' }); return; }
    updates.tags = tags;
  }
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) { res.status(400).json({ error: '`properties` must be a plain object' }); return; }
    updates.properties = properties as Record<string, string | number | boolean>;
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    const updated = await updateEntityById(mid, id, updates);
    if (updated) { res.json(updated); return; }
  }
  res.status(404).json({ error: 'Entity not found' });
});

// DELETE /api/brain/spaces/:spaceId/entities — bulk wipe all entities
brainRouter.delete('/spaces/:spaceId/entities', bulkWipeRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  if (isProxySpace(spaceId)) {
    res.status(400).json({ error: 'Bulk wipe not supported on proxy spaces — target member spaces individually' });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: '`confirm: true` required in request body' });
    return;
  }
  const deleted = await bulkDeleteEntities(spaceId);
  res.json({ deleted });
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
  const filter: { from?: string; to?: string; label?: string } = {};
  if (typeof req.query['from'] === 'string') filter.from = req.query['from'];
  if (typeof req.query['to'] === 'string') filter.to = req.query['to'];
  if (typeof req.query['label'] === 'string') filter.label = req.query['label'];
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listEdges(mid, filter, limit, skip)))).flat();
  res.json({ edges: all, limit, skip });
});

// GET /api/brain/spaces/:spaceId/edges/:id
brainRouter.get('/spaces/:spaceId/edges/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    const doc = await getEdgeById(mid, id);
    if (doc) { res.json(doc); return; }
  }
  res.status(404).json({ error: 'Edge not found' });
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

// PATCH /api/brain/spaces/:spaceId/edges/:id — partial update an edge by ID
brainRouter.patch('/spaces/:spaceId/edges/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const { label, description, tags, properties, weight, type } = req.body ?? {};
  const updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string } = {};
  if (label !== undefined) {
    if (typeof label !== 'string' || !label.trim()) { res.status(400).json({ error: '`label` must be a non-empty string' }); return; }
    updates.label = label.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string') { res.status(400).json({ error: '`description` must be a string' }); return; }
    updates.description = description;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`tags` must be an array of strings' }); return; }
    updates.tags = tags;
  }
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) { res.status(400).json({ error: '`properties` must be a plain object' }); return; }
    updates.properties = properties as Record<string, string | number | boolean>;
  }
  if (weight !== undefined) {
    if (typeof weight !== 'number') { res.status(400).json({ error: '`weight` must be a number' }); return; }
    updates.weight = weight;
  }
  if (type !== undefined) {
    if (typeof type !== 'string') { res.status(400).json({ error: '`type` must be a string' }); return; }
    updates.type = type.trim();
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    const updated = await updateEdgeById(mid, id, updates);
    if (updated) { res.json(updated); return; }
  }
  res.status(404).json({ error: 'Edge not found' });
});

// DELETE /api/brain/spaces/:spaceId/edges — bulk wipe all edges
brainRouter.delete('/spaces/:spaceId/edges', bulkWipeRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  if (isProxySpace(spaceId)) {
    res.status(400).json({ error: 'Bulk wipe not supported on proxy spaces — target member spaces individually' });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: '`confirm: true` required in request body' });
    return;
  }
  const deleted = await bulkDeleteEdges(spaceId);
  res.json({ deleted });
});

// POST /api/brain/spaces/:spaceId/traverse — graph traversal (BFS)
brainRouter.post('/spaces/:spaceId/traverse', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const { startId, direction, edgeLabels, maxDepth, limit } = req.body ?? {};
  if (!startId || typeof startId !== 'string') {
    res.status(400).json({ error: '`startId` string required' });
    return;
  }
  const validDirections = new Set(['outbound', 'inbound', 'both']);
  const effectiveDirection: 'outbound' | 'inbound' | 'both' =
    typeof direction === 'string' && validDirections.has(direction)
      ? (direction as 'outbound' | 'inbound' | 'both')
      : 'outbound';
  const effectiveEdgeLabels: string[] | undefined =
    Array.isArray(edgeLabels) && edgeLabels.every((l: unknown) => typeof l === 'string')
      ? edgeLabels
      : undefined;
  if (edgeLabels !== undefined && !Array.isArray(edgeLabels)) {
    res.status(400).json({ error: '`edgeLabels` must be an array of strings' });
    return;
  }
  const rawDepth = typeof maxDepth === 'number' ? maxDepth : 3;
  const effectiveDepth = Math.min(Math.max(1, rawDepth), 10);
  const rawLimit = typeof limit === 'number' ? limit : 100;
  const effectiveLimit = Math.min(Math.max(1, rawLimit), 1000);

  const memberIds = resolveMemberSpaces(spaceId);
  const result = await traverseGraph(memberIds, startId.trim(), effectiveDirection, effectiveEdgeLabels, effectiveDepth, effectiveLimit);
  res.json(result);
});

// ── Chrono CRUD ───────────────────────────────────────────────────────────────

const CHRONO_KINDS = new Set<ChronoKind>(['event', 'deadline', 'plan', 'prediction', 'milestone']);
const CHRONO_STATUSES = new Set<ChronoStatus>(['upcoming', 'active', 'completed', 'overdue', 'cancelled']);

// POST /api/brain/spaces/:spaceId/chrono — create a chrono entry
brainRouter.post('/spaces/:spaceId/chrono', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }

  const { title, kind, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: '`title` string required' }); return;
  }
  if (!kind || !CHRONO_KINDS.has(kind)) {
    res.status(400).json({ error: '`kind` must be one of: event, deadline, plan, prediction, milestone' }); return;
  }
  if (!startsAt || typeof startsAt !== 'string') {
    res.status(400).json({ error: '`startsAt` ISO8601 string required' }); return;
  }
  if (endsAt !== undefined && typeof endsAt !== 'string') {
    res.status(400).json({ error: '`endsAt` must be an ISO8601 string' }); return;
  }
  if (status !== undefined && !CHRONO_STATUSES.has(status)) {
    res.status(400).json({ error: '`status` must be one of: upcoming, active, completed, overdue, cancelled' }); return;
  }
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    res.status(400).json({ error: '`confidence` must be a number between 0 and 1' }); return;
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`tags` must be an array of strings' }); return;
  }
  if (entityIds !== undefined && (!Array.isArray(entityIds) || entityIds.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`entityIds` must be an array of strings' }); return;
  }
  if (memoryIds !== undefined && (!Array.isArray(memoryIds) || memoryIds.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`memoryIds` must be an array of strings' }); return;
  }
  if (description !== undefined && typeof description !== 'string') {
    res.status(400).json({ error: '`description` must be a string' }); return;
  }
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    res.status(400).json({ error: '`properties` must be a plain object' }); return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;

  const entry = await createChrono(wt.target, {
    title: title.trim(), kind, startsAt, endsAt, status, confidence,
    tags, entityIds, memoryIds, description, properties: safeProps, recurrence,
  });
  res.status(201).json(entry);
});

// POST /api/brain/spaces/:spaceId/chrono/:id — update a chrono entry
brainRouter.post('/spaces/:spaceId/chrono/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }

  const { title, kind, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  if (status !== undefined && !CHRONO_STATUSES.has(status)) {
    res.status(400).json({ error: '`status` must be one of: upcoming, active, completed, overdue, cancelled' }); return;
  }
  if (kind !== undefined && !CHRONO_KINDS.has(kind)) {
    res.status(400).json({ error: '`kind` must be one of: event, deadline, plan, prediction, milestone' }); return;
  }
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    res.status(400).json({ error: '`confidence` must be a number between 0 and 1' }); return;
  }
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    res.status(400).json({ error: '`properties` must be a plain object' }); return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;

  const updated = await updateChrono(wt.target, id, {
    title, kind, startsAt, endsAt, status, confidence,
    tags, entityIds, memoryIds, description, properties: safeProps, recurrence,
  });
  if (!updated) { res.status(404).json({ error: 'Chrono entry not found' }); return; }
  res.json(updated);
});

// PATCH /api/brain/spaces/:spaceId/chrono/:id — partial update a chrono entry by ID
brainRouter.patch('/spaces/:spaceId/chrono/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }

  const { title, kind, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  if (status !== undefined && !CHRONO_STATUSES.has(status)) {
    res.status(400).json({ error: '`status` must be one of: upcoming, active, completed, overdue, cancelled' }); return;
  }
  if (kind !== undefined && !CHRONO_KINDS.has(kind)) {
    res.status(400).json({ error: '`kind` must be one of: event, deadline, plan, prediction, milestone' }); return;
  }
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    res.status(400).json({ error: '`confidence` must be a number between 0 and 1' }); return;
  }
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    res.status(400).json({ error: '`properties` must be a plain object' }); return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;

  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    const updated = await updateChrono(mid, id, {
      title, kind, startsAt, endsAt, status, confidence,
      tags, entityIds, memoryIds, description, properties: safeProps, recurrence,
    });
    if (updated) { res.json(updated); return; }
  }
  res.status(404).json({ error: 'Chrono entry not found' });
});

// GET /api/brain/spaces/:spaceId/chrono/:id
brainRouter.get('/spaces/:spaceId/chrono/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    const doc = await getChronoById(mid, id);
    if (doc) { res.json(doc); return; }
  }
  res.status(404).json({ error: 'Chrono entry not found' });
});

// GET /api/brain/spaces/:spaceId/chrono
brainRouter.get('/spaces/:spaceId/chrono', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = Math.min(Number(req.query['limit'] ?? 50), 500);
  const skip = Number(req.query['skip'] ?? 0);
  const filter: ChronoFilter = {};
  if (typeof req.query['status'] === 'string') filter.status = req.query['status'];
  if (typeof req.query['kind'] === 'string') filter.kind = req.query['kind'];

  // tags — comma-separated or repeated — AND semantics
  if (Array.isArray(req.query['tags'])) {
    filter.tags = (req.query['tags'] as string[]).flatMap(t => t.split(',').map(s => s.trim())).filter(Boolean);
  } else if (typeof req.query['tags'] === 'string') {
    filter.tags = req.query['tags'].split(',').map(s => s.trim()).filter(Boolean);
  } else if (typeof req.query['tag'] === 'string') {
    filter.tags = [req.query['tag']];
  }

  // tagsAny — comma-separated or repeated — OR semantics
  if (Array.isArray(req.query['tagsAny'])) {
    filter.tagsAny = (req.query['tagsAny'] as string[]).flatMap(t => t.split(',').map(s => s.trim())).filter(Boolean);
  } else if (typeof req.query['tagsAny'] === 'string') {
    filter.tagsAny = req.query['tagsAny'].split(',').map(s => s.trim()).filter(Boolean);
  }

  if (typeof req.query['after'] === 'string') filter.after = req.query['after'];
  if (typeof req.query['before'] === 'string') filter.before = req.query['before'];
  if (typeof req.query['search'] === 'string') filter.search = req.query['search'];

  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listChrono(mid, filter, limit, skip)))).flat();
  res.json({ chrono: all, limit, skip });
});

// DELETE /api/brain/spaces/:spaceId/chrono/:id
brainRouter.delete('/spaces/:spaceId/chrono/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const memberIds = resolveMemberSpaces(spaceId);
  for (const mid of memberIds) {
    if (await deleteChrono(mid, id)) { res.status(204).end(); return; }
  }
  res.status(404).json({ error: 'Chrono entry not found' });
});

// DELETE /api/brain/spaces/:spaceId/chrono — bulk wipe all chrono entries
brainRouter.delete('/spaces/:spaceId/chrono', bulkWipeRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  if (isProxySpace(spaceId)) {
    res.status(400).json({ error: 'Bulk wipe not supported on proxy spaces — target member spaces individually' });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: '`confirm: true` required in request body' });
    return;
  }
  const deleted = await bulkDeleteChrono(spaceId);
  res.json({ deleted });
});

// GET /api/brain/spaces/:spaceId/files — list file metadata records
brainRouter.get('/spaces/:spaceId/files', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
  const skip = Number(req.query['skip'] ?? 0);
  const filter: Record<string, unknown> = {};
  if (typeof req.query['tag'] === 'string') filter['tags'] = req.query['tag'];
  if (typeof req.query['path'] === 'string') filter['path'] = req.query['path'];
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid =>
    col(`${mid}_files`)
      .find(filter as never)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
  ))).flat();
  res.json({ files: all, limit, skip });
});

// POST /api/brain/spaces/:spaceId/query — structured query with filter/projection
brainRouter.post('/spaces/:spaceId/query', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const { collection, filter, projection, limit, maxTimeMS } = req.body ?? {};
  const validCollections = ['memories', 'entities', 'edges', 'chrono', 'files'] as const;
  if (!validCollections.includes(collection)) {
    res.status(400).json({ error: `collection must be one of: ${validCollections.join(', ')}` });
    return;
  }
  const safeFilter: Record<string, unknown> =
    filter != null && typeof filter === 'object' && !Array.isArray(filter)
      ? (filter as Record<string, unknown>)
      : {};
  const safeProjection: Record<string, unknown> | undefined =
    projection != null && typeof projection === 'object' && !Array.isArray(projection)
      ? (projection as Record<string, unknown>)
      : undefined;
  const safeLimit = typeof limit === 'number' ? limit : 20;
  const safeMaxTimeMS = typeof maxTimeMS === 'number' ? maxTimeMS : 5000;

  try {
    const memberIds = resolveMemberSpaces(spaceId);
    const docs = (await Promise.all(
      memberIds.map(mid =>
        queryBrain(
          mid,
          collection as typeof validCollections[number],
          safeFilter,
          safeProjection,
          safeLimit,
          safeMaxTimeMS,
        ),
      ),
    )).flat();
    res.json({ results: docs, collection, count: docs.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

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

  reindexInProgress.set(1);
  try {
  for (const mid of memberIds) {
    const BATCH = 50;

    // Re-embed memories
    {
      let skip = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await col<MemoryDoc>(`${mid}_memories`)
          .find({}, { projection: { _id: 1, fact: 1, tags: 1, entityIds: 1, description: 1, properties: 1 } })
          .skip(skip)
          .limit(BATCH)
          .toArray();
        if (batch.length === 0) break;
        for (const doc of batch) {
          try {
            // Resolve entity IDs to names for richer embedding
            const entityIds: string[] = Array.isArray(doc.entityIds) ? doc.entityIds : [];
            const entityDocs = entityIds.length > 0
              ? await col<EntityDoc>(`${mid}_entities`)
                  .find({ _id: { $in: entityIds } } as never, { projection: { name: 1 } })
                  .toArray() as Array<{ name: string }>
              : [];
            const entityNames = entityDocs.map(e => e.name);
            const tags: string[] = Array.isArray(doc.tags) ? doc.tags : [];
            const parts: string[] = [];
            if (tags.length > 0) parts.push(tags.join(' '));
            if (entityNames.length > 0) parts.push(entityNames.join(' '));
            parts.push(doc.fact);
            if (doc.description?.trim()) parts.push(doc.description.trim());
            if (doc.properties) {
              const propEntries = Object.entries(doc.properties);
              if (propEntries.length > 0) parts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
            }
            const text = parts.join(' ');
            const result = await embed(text);
            await col<MemoryDoc>(`${mid}_memories`).updateOne(
              { _id: doc._id },
              { $set: { embedding: result.vector, embeddingModel: result.model } },
            );
            reindexed++;
          } catch { errors++; }
        }
        skip += batch.length;
      }
    }

    // Re-embed entities (name + type + tags + description + properties)
    {
      let skip = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await col<EntityDoc>(`${mid}_entities`)
          .find({}, { projection: { _id: 1, name: 1, type: 1, tags: 1, description: 1, properties: 1 } })
          .skip(skip)
          .limit(BATCH)
          .toArray();
        if (batch.length === 0) break;
        for (const doc of batch) {
          try {
            const tags: string[] = Array.isArray(doc.tags) ? doc.tags : [];
            const parts: string[] = [doc.name, doc.type];
            if (tags.length > 0) parts.push(tags.join(' '));
            if (doc.description?.trim()) parts.push(doc.description.trim());
            if (doc.properties) {
              const propEntries = Object.entries(doc.properties);
              if (propEntries.length > 0) parts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
            }
            const result = await embed(parts.join(' '));
            await col<EntityDoc>(`${mid}_entities`).updateOne(
              { _id: doc._id },
              { $set: { embedding: result.vector, embeddingModel: result.model } },
            );
            reindexed++;
          } catch { errors++; }
        }
        skip += batch.length;
      }
    }

    // Re-embed edges (tags + from + label + to + type + description)
    {
      let skip = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await col<EdgeDoc>(`${mid}_edges`)
          .find({}, { projection: { _id: 1, from: 1, label: 1, to: 1, type: 1, tags: 1, description: 1 } })
          .skip(skip)
          .limit(BATCH)
          .toArray();
        if (batch.length === 0) break;
        for (const doc of batch) {
          try {
            const tags: string[] = Array.isArray(doc.tags) ? doc.tags : [];
            const parts: string[] = [];
            if (tags.length > 0) parts.push(tags.join(' '));
            parts.push(doc.from, doc.label, doc.to);
            if (doc.type?.trim()) parts.push(doc.type.trim());
            if (doc.description?.trim()) parts.push(doc.description.trim());
            const result = await embed(parts.join(' '));
            await col<EdgeDoc>(`${mid}_edges`).updateOne(
              { _id: doc._id },
              { $set: { embedding: result.vector, embeddingModel: result.model } },
            );
            reindexed++;
          } catch { errors++; }
        }
        skip += batch.length;
      }
    }

    // Re-embed chrono (kind + status + title + description + tags)
    {
      let skip = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await col<ChronoEntry>(`${mid}_chrono`)
          .find({}, { projection: { _id: 1, title: 1, kind: 1, status: 1, description: 1, tags: 1 } })
          .skip(skip)
          .limit(BATCH)
          .toArray();
        if (batch.length === 0) break;
        for (const doc of batch) {
          try {
            const tags: string[] = Array.isArray(doc.tags) ? doc.tags : [];
            const parts: string[] = [doc.kind, doc.status, doc.title];
            if (tags.length > 0) parts.push(tags.join(' '));
            if (doc.description?.trim()) parts.push(doc.description.trim());
            const result = await embed(parts.join(' '));
            await col<ChronoEntry>(`${mid}_chrono`).updateOne(
              { _id: doc._id },
              { $set: { embedding: result.vector, embeddingModel: result.model } },
            );
            reindexed++;
          } catch { errors++; }
        }
        skip += batch.length;
      }
    }

    // Re-embed files (path + tags + description)
    {
      let skip = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await col<FileMetaDoc>(`${mid}_files`)
          .find({}, { projection: { _id: 1, path: 1, tags: 1, description: 1 } })
          .skip(skip)
          .limit(BATCH)
          .toArray();
        if (batch.length === 0) break;
        for (const doc of batch) {
          try {
            const tags: string[] = Array.isArray(doc.tags) ? doc.tags : [];
            const parts: string[] = [doc.path];
            if (tags.length > 0) parts.push(tags.join(' '));
            if (doc.description?.trim()) parts.push(doc.description.trim());
            const result = await embed(parts.join(' '));
            await col<FileMetaDoc>(`${mid}_files`).updateOne(
              { _id: doc._id },
              { $set: { embedding: result.vector, embeddingModel: result.model } },
            );
            reindexed++;
          } catch { errors++; }
        }
        skip += batch.length;
      }
    }

    clearReindexFlag(mid);
  }
  } finally {
    reindexInProgress.set(0);
  }

  res.json({ spaceId, reindexed, errors });
});
