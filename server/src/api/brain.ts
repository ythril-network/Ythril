import { Router } from 'express';
import type express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireSpaceAuth, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit, bulkWipeRateLimit } from '../rate-limit/middleware.js';
import { NotFoundError } from '../util/errors.js';
import { listMemories, deleteMemory, countMemories, bulkDeleteMemories, remember, updateMemory, queryBrain, findSimilar, recall, type RecallKnowledgeType } from '../brain/memory.js';
import { listEntities, deleteEntity, upsertEntity, getEntityById, updateEntityById, bulkDeleteEntities, findEntitiesByName, findEntityBacklinks } from '../brain/entities.js';
import { listEdges, deleteEdge, upsertEdge, getEdgeById, updateEdgeById, bulkDeleteEdges, traverseGraph } from '../brain/edges.js';
import { computeMergePlan, applyResolutions, executeMerge, validateResolution, type PropertyResolution } from '../brain/merge.js';
import { validateDeleteFields, applyDeleteFields as applyDeleteFieldsPaths } from '../brain/delete-fields.js';
/** Regex that matches a UUID v4 (case-insensitive). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import { createChrono, updateChrono, getChronoById, listChrono, deleteChrono, bulkDeleteChrono, ChronoFilter } from '../brain/chrono.js';
import { embed } from '../brain/embedding.js';
import { updateFileMeta, deleteFileMeta } from '../files/file-meta.js';
import { getConfig } from '../config/loader.js';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { needsReindex, clearReindexFlag } from '../spaces/spaces.js';
import { log } from '../util/log.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { resolveMemberSpaces, resolveWriteTarget, findSpace, isProxySpace } from '../spaces/proxy.js';
import { validateEntity, validateEdge, validateMemory, validateChrono, resolveMetaRefs, type SchemaViolation } from '../spaces/schema-validation.js';
import type { MemoryDoc, EntityDoc, EdgeDoc, ChronoEntry, FileMetaDoc, ChronoType, ChronoStatus, SpaceMeta } from '../config/types.js';
import { reindexInProgress } from '../metrics/registry.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';

export const brainRouter = Router();
let reindexJobRunning = false;

// ── Webhook helper ────────────────────────────────────────────────────────

/** Extract token identification from the request for webhook payloads. */
function webhookToken(req: express.Request): { tokenId?: string; tokenLabel?: string } {
  const t = req.authToken;
  if (!t) return {};
  return {
    tokenId: 'id' in t ? (t as { id: string }).id : undefined,
    tokenLabel: t.name,
  };
}

// ── Schema validation helpers ─────────────────────────────────────────────

/** Look up the meta block for a space from config, with library refs resolved. Returns undefined if none. */
function getSpaceMeta(spaceId: string): SpaceMeta | undefined {
  const cfg = getConfig();
  const meta = cfg.spaces.find(s => s.id === spaceId)?.meta;
  if (!meta) return undefined;
  return resolveMetaRefs(meta);
}

/** Check whether strict linkage enforcement is enabled for a space. */
function isStrictLinkage(spaceId: string): boolean {
  return getSpaceMeta(spaceId)?.strictLinkage === true;
}

/**
 * Apply schema validation to a write operation.
 * Returns { blocked: true, violations } when strict mode rejects the write.
 * Returns { blocked: false, warnings } when warn mode lets the write through.
 * Returns { blocked: false, warnings: [] } when validation is off or no meta.
 */
function applyValidation(
  meta: SpaceMeta | undefined,
  violations: SchemaViolation[],
): { blocked: boolean; warnings: SchemaViolation[] } {
  if (!meta || !meta.validationMode || meta.validationMode === 'off' || violations.length === 0) {
    return { blocked: false, warnings: [] };
  }
  if (meta.validationMode === 'strict') {
    return { blocked: true, warnings: violations };
  }
  // warn mode
  return { blocked: false, warnings: violations };
}

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
  const { fact, tags = [], entityIds = [], description, properties, type: memoryType } = req.body ?? {};
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
  // Validate that all entityIds are valid UUID v4 (not names) — only when strictLinkage is on
  if (isStrictLinkage(wt.target)) {
    const invalidEntityIds = safeEntityIds.filter((id: string) => !UUID_V4_RE.test(id));
    if (invalidEntityIds.length > 0) {
      res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidEntityIds });
      return;
    }
  }
  const safeTags: string[] = Array.isArray(tags) ? tags : [];

  // Schema validation
  const safeMemoryType: string | undefined = typeof memoryType === 'string' ? memoryType : undefined;
  const meta = getSpaceMeta(wt.target);
  const violations = validateMemory(meta ?? {}, { type: safeMemoryType, properties: safeProps });
  const validation = applyValidation(meta, violations);
  if (validation.blocked) {
    res.status(400).json({ error: 'schema_violation', violations: validation.warnings });
    return;
  }

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
  if (safeMemoryType !== undefined) doc.type = safeMemoryType;
  await col<MemoryDoc>(`${targetSpace}_memories`).insertOne(doc as never);
  emitWebhookEvent({ event: 'memory.created', spaceId: targetSpace, entry: { ...doc, embedding: undefined }, ...webhookToken(req) });
  const body: Record<string, unknown> = { ...doc };
  if (quotaResult?.softBreached) body['storageWarning'] = true;
  if (validation.warnings.length > 0) body['warnings'] = validation.warnings;
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
    if (await deleteMemory(mid, id)) {
      emitWebhookEvent({ event: 'memory.deleted', spaceId: mid, entry: { _id: id }, ...webhookToken(req) });
      res.status(204).end();
      return;
    }
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
  const { fact, tags, entityIds, description, properties, deleteFields } = req.body ?? {};
  // Validate deleteFields
  const dfResult = validateDeleteFields(deleteFields);
  if (!dfResult.ok) { res.status(400).json({ error: dfResult.error }); return; }
  const dfPaths: string[] | undefined = Array.isArray(deleteFields) && deleteFields.length > 0 ? deleteFields : undefined;
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
    if (isStrictLinkage(wt.target)) {
      const invalidIds = entityIds.filter((id: string) => !UUID_V4_RE.test(id));
      if (invalidIds.length > 0) { res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidIds }); return; }
    }
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
  if (Object.keys(updates).length === 0 && !dfPaths) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    // Schema validation after deleteFields + merge for memories
    if (dfPaths) {
      const existing = await listMemories(mid, { _id: id }, 1, 0);
      if (existing.length === 0) continue;
      const mem = existing[0]!;
      const resultProps = updates.properties ?? (mem.properties != null ? { ...mem.properties } : {});
      const sim: Record<string, unknown> = { properties: resultProps };
      applyDeleteFieldsPaths(sim, dfPaths);
      const simProps = (sim['properties'] ?? {}) as Record<string, unknown>;
      const meta = getSpaceMeta(mid);
      const violations = validateMemory(meta ?? {}, { properties: simProps });
      const validation = applyValidation(meta, violations);
      if (validation.blocked) {
        res.status(422).json({ error: 'schema_violation', message: 'deleteFields + merge result violates required properties', violations: validation.warnings });
        return;
      }
    }
    const updated = await updateMemory(mid, id, updates, dfPaths);
    if (updated) {
      emitWebhookEvent({ event: 'memory.updated', spaceId: mid, entry: { ...updated, embedding: undefined }, ...webhookToken(req) });
      res.json(updated);
      return;
    }
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
    if (await deleteMemory(mid, id)) {
      emitWebhookEvent({ event: 'memory.deleted', spaceId: mid, entry: { _id: id }, ...webhookToken(req) });
      res.status(204).end();
      return;
    }
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
  const { fact, tags, entityIds, description, properties, deleteFields } = req.body ?? {};
  // Validate deleteFields
  const dfResult = validateDeleteFields(deleteFields);
  if (!dfResult.ok) { res.status(400).json({ error: dfResult.error }); return; }
  const dfPaths: string[] | undefined = Array.isArray(deleteFields) && deleteFields.length > 0 ? deleteFields : undefined;
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
    if (isStrictLinkage(wt.target)) {
      const invalidIds = entityIds.filter((id: string) => !UUID_V4_RE.test(id));
      if (invalidIds.length > 0) { res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidIds }); return; }
    }
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
  if (Object.keys(updates).length === 0 && !dfPaths) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    // Schema validation after deleteFields + merge for memories
    if (dfPaths) {
      const existing = await listMemories(mid, { _id: id }, 1, 0);
      if (existing.length === 0) continue;
      const mem = existing[0]!;
      const resultProps = updates.properties ?? (mem.properties != null ? { ...mem.properties } : {});
      const sim: Record<string, unknown> = { properties: resultProps };
      applyDeleteFieldsPaths(sim, dfPaths);
      const simProps = (sim['properties'] ?? {}) as Record<string, unknown>;
      const meta = getSpaceMeta(mid);
      const violations = validateMemory(meta ?? {}, { properties: simProps });
      const validation = applyValidation(meta, violations);
      if (validation.blocked) {
        res.status(422).json({ error: 'schema_violation', message: 'deleteFields + merge result violates required properties', violations: validation.warnings });
        return;
      }
    }
    const updated = await updateMemory(mid, id, updates, dfPaths);
    if (updated) {
      emitWebhookEvent({ event: 'memory.updated', spaceId: mid, entry: { ...updated, embedding: undefined }, ...webhookToken(req) });
      res.json(updated);
      return;
    }
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
  const { id, name, type = '', tags = [], properties = {}, description } = req.body ?? {};
  if (id !== undefined) {
    if (typeof id !== 'string' || !UUID_V4_RE.test(id)) {
      res.status(400).json({ error: '`id` must be a valid UUID v4' });
      return;
    }
  }
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
  const safeId: string | undefined = typeof id === 'string' ? id : undefined;

  // Schema validation
  const meta = getSpaceMeta(wt.target);
  const violations = validateEntity(meta ?? {}, { name: name.trim(), type: type.trim(), properties });
  const validation = applyValidation(meta, violations);
  if (validation.blocked) {
    res.status(400).json({ error: 'schema_violation', violations: validation.warnings });
    return;
  }

  try {
    const { entity, warning } = await upsertEntity(wt.target, name.trim(), type.trim(), tags, properties, safeDesc, safeId);
    emitWebhookEvent({ event: warning ? 'entity.updated' : 'entity.created', spaceId: wt.target, entry: { ...entity, embedding: undefined }, ...webhookToken(req) });
    const result: Record<string, unknown> = { ...entity };
    if (warning) result['warning'] = warning;
    if (validation.warnings.length > 0) result['warnings'] = validation.warnings;
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
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
  if (isStrictLinkage(wt.target) && !UUID_V4_RE.test(from)) {
    res.status(400).json({ error: '`from` must be a valid UUID v4 (entity ID), not a name' });
    return;
  }
  if (!to || typeof to !== 'string') {
    res.status(400).json({ error: '`to` string required' });
    return;
  }
  if (isStrictLinkage(wt.target) && !UUID_V4_RE.test(to)) {
    res.status(400).json({ error: '`to` must be a valid UUID v4 (entity ID), not a name' });
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

  // Schema validation
  const meta = getSpaceMeta(wt.target);
  const violations = validateEdge(meta ?? {}, { label: label.trim(), properties: safeProps });
  const validation = applyValidation(meta, violations);
  if (validation.blocked) {
    res.status(400).json({ error: 'schema_violation', violations: validation.warnings });
    return;
  }

  const edge = await upsertEdge(
    wt.target, from.trim(), to.trim(), label.trim(), weight, type?.trim(),
    typeof description === 'string' ? description : undefined, safeProps, safeTags,
  );
  emitWebhookEvent({ event: 'edge.created', spaceId: wt.target, entry: { ...edge, embedding: undefined }, ...webhookToken(req) });
  const result: Record<string, unknown> = { ...edge };
  if (validation.warnings.length > 0) result['warnings'] = validation.warnings;
  res.status(201).json(result);
});

// GET /api/brain/spaces/:spaceId/entities
brainRouter.get('/spaces/:spaceId/entities', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = Math.min(Number(req.query['limit'] ?? 50), 500);
  const skip = Number(req.query['skip'] ?? 0);
  const filter: Record<string, unknown> = {};
  if (typeof req.query['name'] === 'string') filter['name'] = req.query['name'];
  if (typeof req.query['type'] === 'string') filter['type'] = req.query['type'];
  if (typeof req.query['tag'] === 'string') filter['tags'] = req.query['tag'];
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listEntities(mid, filter, limit, skip)))).flat();
  res.json({ entities: all, limit, skip });
});

// GET /api/brain/spaces/:spaceId/entities/by-ids?ids=id1,id2,... — batch fetch up to 100 entities by ID
brainRouter.get('/spaces/:spaceId/entities/by-ids', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const raw = req.query['ids'];
  if (typeof raw !== 'string' || !raw.trim()) {
    res.status(400).json({ error: '`ids` query parameter required (comma-separated)' });
    return;
  }
  const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 100);
  if (!ids.length) { res.json({ entities: [] }); return; }
  const memberIds = resolveMemberSpaces(spaceId);
  const all = (await Promise.all(memberIds.map(mid => listEntities(mid, { _id: { $in: ids } } as never, 100)))).flat();
  res.json({ entities: all });
});

// GET /api/brain/spaces/:spaceId/entities/by-name?name=... — find entities by name (no type constraint)
brainRouter.get('/spaces/:spaceId/entities/by-name', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const name = req.query['name'];
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: '`name` query parameter required' });
    return;
  }
  const memberIds = resolveMemberSpaces(spaceId);
  // Case-insensitive substring search — escape user input to prevent ReDoS
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = (await Promise.all(memberIds.map(mid => listEntities(mid, { name: { $regex: escaped, $options: 'i' } }, 20)))).flat();
  res.json({ entities: all });
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
    const entity = await getEntityById(mid, id);
    if (!entity) continue;
    // Check for inbound references before allowing deletion (only when strictLinkage is on)
    if (isStrictLinkage(mid)) {
      const backlinks = await findEntityBacklinks(mid, id);
      if (backlinks.length > 0) {
        res.status(409).json({ error: 'Cannot delete: entity has inbound references', backlinks });
        return;
      }
    }
    if (await deleteEntity(mid, id)) {
      emitWebhookEvent({ event: 'entity.deleted', spaceId: mid, entry: { _id: id }, ...webhookToken(req) });
      res.status(204).end();
      return;
    }
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
  const { name, type, description, tags, properties, deleteFields } = req.body ?? {};
  // Validate deleteFields
  const dfResult = validateDeleteFields(deleteFields);
  if (!dfResult.ok) { res.status(400).json({ error: dfResult.error }); return; }
  const dfPaths: string[] | undefined = Array.isArray(deleteFields) && deleteFields.length > 0 ? deleteFields : undefined;
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
  if (Object.keys(updates).length === 0 && !dfPaths) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    // Fetch existing entity to validate schema after deleteFields + merge
    if (dfPaths) {
      const existing = await getEntityById(mid, id);
      if (!existing) continue;
      // Build the resulting entity state to validate against schema
      const resultName = updates.name ?? existing.name;
      const resultType = updates.type ?? existing.type;
      const resultTags = updates.tags !== undefined
        ? Array.from(new Set([...(existing.tags ?? []), ...updates.tags]))
        : existing.tags ?? [];
      const resultProps = updates.properties !== undefined
        ? { ...(existing.properties ?? {}), ...updates.properties }
        : { ...(existing.properties ?? {}) };
      // Build a simulation and apply deleteFields for schema check
      const sim: Record<string, unknown> = { properties: resultProps, tags: resultTags, description: updates.description !== undefined ? updates.description : existing.description };
      applyDeleteFieldsPaths(sim, dfPaths);
      const simProps = (sim['properties'] ?? {}) as Record<string, unknown>;
      // Schema validation after deleteFields + merge
      const meta = getSpaceMeta(mid);
      const violations = validateEntity(meta ?? {}, { name: resultName, type: resultType, properties: simProps, tags: sim['tags'] as string[] });
      const validation = applyValidation(meta, violations);
      if (validation.blocked) {
        res.status(422).json({ error: 'schema_violation', message: 'deleteFields + merge result violates required properties', violations: validation.warnings });
        return;
      }
    }
    const updated = await updateEntityById(mid, id, updates, dfPaths);
    if (updated) {
      emitWebhookEvent({ event: 'entity.updated', spaceId: mid, entry: { ...updated, embedding: undefined }, ...webhookToken(req) });
      res.json(updated);
      return;
    }
  }
  res.status(404).json({ error: 'Entity not found' });
});

// POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId — merge two entities
brainRouter.post('/spaces/:spaceId/entities/:survivorId/merge/:absorbedId', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const survivorId = req.params['survivorId'] as string;
  const absorbedId = req.params['absorbedId'] as string;

  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  if (!UUID_V4_RE.test(survivorId)) {
    res.status(400).json({ error: '`survivorId` must be a valid UUID v4' });
    return;
  }
  if (!UUID_V4_RE.test(absorbedId)) {
    res.status(400).json({ error: '`absorbedId` must be a valid UUID v4' });
    return;
  }
  if (survivorId === absorbedId) {
    res.status(400).json({ error: 'Cannot merge an entity with itself' });
    return;
  }

  if (isProxySpace(spaceId)) {
    res.status(400).json({ error: 'Entity merge not supported on proxy spaces — target member spaces directly' });
    return;
  }

  // Parse resolution map from body (optional)
  const resolutions: PropertyResolution[] = [];
  const bodyResolutions = req.body?.resolutions;
  if (bodyResolutions && Array.isArray(bodyResolutions)) {
    for (const r of bodyResolutions) {
      if (typeof r !== 'object' || !r || typeof r.key !== 'string' || typeof r.resolution !== 'string') {
        res.status(400).json({ error: 'Each resolution must be an object with `key` (string) and `resolution` (string)' });
        return;
      }
      resolutions.push({
        key: r.key,
        resolution: r.resolution,
        ...(r.customValue !== undefined ? { customValue: r.customValue } : {}),
      });
    }
  }

  // Compute merge plan
  const result = await computeMergePlan(spaceId, survivorId, absorbedId, resolutions);
  if ('error' in result) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  const { plan, fullyResolved, survivor, absorbed } = result;

  // Validate all provided resolutions
  for (const conflict of plan.propertyConflicts) {
    if (!conflict.resolved) continue;
    const err = validateResolution(conflict.resolution!, conflict.type, conflict.customValue !== undefined);
    if (err) {
      res.status(400).json({ error: `Invalid resolution for property '${conflict.key}': ${err}` });
      return;
    }
  }

  // If not fully resolved, return 409 with the plan
  if (!fullyResolved) {
    res.status(409).json(plan);
    return;
  }

  // All conflicts resolved — execute merge atomically
  const mergedProperties = applyResolutions(
    survivor.properties ?? {},
    absorbed.properties ?? {},
    plan.propertyConflicts,
    plan.absorbedOnlyProperties,
  );

  const mergeResult = await executeMerge(spaceId, survivor, absorbed, mergedProperties);
  const mergedEntity = mergeResult.entity;

  // Emit webhook events
  emitWebhookEvent({ event: 'entity.merged', spaceId, entry: { survivor: { ...mergedEntity, embedding: undefined }, absorbedId: absorbed._id }, ...webhookToken(req) });
  emitWebhookEvent({ event: 'entity.updated', spaceId, entry: { ...mergedEntity, embedding: undefined }, ...webhookToken(req) });
  emitWebhookEvent({ event: 'entity.deleted', spaceId, entry: { _id: absorbed._id }, ...webhookToken(req) });
  for (const dupId of mergeResult.deletedDuplicateEdgeIds) {
    emitWebhookEvent({ event: 'edge.deleted', spaceId, entry: { _id: dupId }, ...webhookToken(req) });
  }

  res.json({
    merged: { ...mergedEntity, embedding: undefined },
    absorbedId: absorbed._id,
    relinked: true,
    duplicateEdgeWarnings: plan.duplicateEdgeWarnings,
    deletedDuplicateEdgeIds: mergeResult.deletedDuplicateEdgeIds,
  });
});
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
  // Batch-resolve entity names for from/to so the client can display names instead of raw UUIDs
  const allEntityIds = [...new Set(all.flatMap(e => [e.from, e.to]))];
  const nameMap = new Map<string, string>();
  if (allEntityIds.length) {
    await Promise.all(memberIds.map(async (mid) => {
      const docs = await col<{ _id: string; name: string }>(`${mid}_entities`)
        .find({ _id: { $in: allEntityIds } } as never, { projection: { _id: 1, name: 1 } })
        .toArray();
      for (const d of docs) nameMap.set(String(d._id), d.name);
    }));
  }
  const enriched = all.map(e => ({ ...e, fromName: nameMap.get(e.from), toName: nameMap.get(e.to) }));
  res.json({ edges: enriched, limit, skip });
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
    if (await deleteEdge(mid, id)) {
      emitWebhookEvent({ event: 'edge.deleted', spaceId: mid, entry: { _id: id }, ...webhookToken(req) });
      res.status(204).end();
      return;
    }
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
  const { label, description, tags, properties, weight, type, deleteFields } = req.body ?? {};
  // Validate deleteFields
  const dfResult = validateDeleteFields(deleteFields);
  if (!dfResult.ok) { res.status(400).json({ error: dfResult.error }); return; }
  const dfPaths: string[] | undefined = Array.isArray(deleteFields) && deleteFields.length > 0 ? deleteFields : undefined;
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
  if (Object.keys(updates).length === 0 && !dfPaths) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    // Schema validation after deleteFields + merge
    if (dfPaths) {
      const existing = await getEdgeById(mid, id);
      if (!existing) continue;
      const resultProps = updates.properties !== undefined
        ? { ...(existing.properties ?? {}), ...updates.properties }
        : { ...(existing.properties ?? {}) };
      const sim: Record<string, unknown> = { properties: resultProps };
      applyDeleteFieldsPaths(sim, dfPaths);
      const simProps = (sim['properties'] ?? {}) as Record<string, unknown>;
      const meta = getSpaceMeta(mid);
      const violations = validateEdge(meta ?? {}, { label: updates.label ?? existing.label, properties: simProps });
      const validation = applyValidation(meta, violations);
      if (validation.blocked) {
        res.status(422).json({ error: 'schema_violation', message: 'deleteFields + merge result violates required properties', violations: validation.warnings });
        return;
      }
    }
    const updated = await updateEdgeById(mid, id, updates, dfPaths);
    if (updated) {
      emitWebhookEvent({ event: 'edge.updated', spaceId: mid, entry: { ...updated, embedding: undefined }, ...webhookToken(req) });
      res.json(updated);
      return;
    }
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

const CHRONO_TYPES = new Set<ChronoType>(['event', 'deadline', 'plan', 'prediction', 'milestone']);
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

  const { title, type, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: '`title` string required' }); return;
  }
  if (!type || !CHRONO_TYPES.has(type)) {
    res.status(400).json({ error: '`type` must be one of: event, deadline, plan, prediction, milestone' }); return;
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
  if (entityIds !== undefined) {
    if (isStrictLinkage(wt.target)) {
      const invalidEIds = (entityIds as string[]).filter((id: string) => !UUID_V4_RE.test(id));
      if (invalidEIds.length > 0) { res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidEIds }); return; }
    }
  }
  if (memoryIds !== undefined && (!Array.isArray(memoryIds) || memoryIds.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`memoryIds` must be an array of strings' }); return;
  }
  if (memoryIds !== undefined) {
    if (isStrictLinkage(wt.target)) {
      const invalidMIds = (memoryIds as string[]).filter((id: string) => !UUID_V4_RE.test(id));
      if (invalidMIds.length > 0) { res.status(400).json({ error: '`memoryIds` must contain valid UUID v4 values (memory IDs), not names', invalid: invalidMIds }); return; }
    }
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

  // Schema validation
  const meta = getSpaceMeta(wt.target);
  const violations = validateChrono(meta ?? {}, { type, properties: safeProps });
  const validation = applyValidation(meta, violations);
  if (validation.blocked) {
    res.status(400).json({ error: 'schema_violation', violations: validation.warnings });
    return;
  }

  const entry = await createChrono(wt.target, {
    title: title.trim(), type, startsAt, endsAt, status, confidence,
    tags, entityIds, memoryIds, description, properties: safeProps, recurrence,
  });
  emitWebhookEvent({ event: 'chrono.created', spaceId: wt.target, entry: { ...entry, embedding: undefined }, ...webhookToken(req) });
  const result: Record<string, unknown> = { ...entry };
  if (validation.warnings.length > 0) result['warnings'] = validation.warnings;
  res.status(201).json(result);
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

  const { title, type, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  if (status !== undefined && !CHRONO_STATUSES.has(status)) {
    res.status(400).json({ error: '`status` must be one of: upcoming, active, completed, overdue, cancelled' }); return;
  }
  if (type !== undefined && !CHRONO_TYPES.has(type)) {
    res.status(400).json({ error: '`type` must be one of: event, deadline, plan, prediction, milestone' }); return;
  }
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    res.status(400).json({ error: '`confidence` must be a number between 0 and 1' }); return;
  }
  if (entityIds !== undefined && Array.isArray(entityIds) && isStrictLinkage(wt.target)) {
    const invalidEIds = entityIds.filter((id: string) => !UUID_V4_RE.test(id));
    if (invalidEIds.length > 0) { res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidEIds }); return; }
  }
  if (memoryIds !== undefined && Array.isArray(memoryIds) && isStrictLinkage(wt.target)) {
    const invalidMIds = memoryIds.filter((id: string) => !UUID_V4_RE.test(id));
    if (invalidMIds.length > 0) { res.status(400).json({ error: '`memoryIds` must contain valid UUID v4 values (memory IDs), not names', invalid: invalidMIds }); return; }
  }
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    res.status(400).json({ error: '`properties` must be a plain object' }); return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;

  const updated = await updateChrono(wt.target, id, {
    title, type, startsAt, endsAt, status, confidence,
    tags, entityIds, memoryIds, description, properties: safeProps, recurrence,
  });
  if (!updated) { res.status(404).json({ error: 'Chrono entry not found' }); return; }
  emitWebhookEvent({ event: 'chrono.updated', spaceId: wt.target, entry: { ...updated, embedding: undefined }, ...webhookToken(req) });
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

  const { title, type, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  if (status !== undefined && !CHRONO_STATUSES.has(status)) {
    res.status(400).json({ error: '`status` must be one of: upcoming, active, completed, overdue, cancelled' }); return;
  }
  if (type !== undefined && !CHRONO_TYPES.has(type)) {
    res.status(400).json({ error: '`type` must be one of: event, deadline, plan, prediction, milestone' }); return;
  }
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    res.status(400).json({ error: '`confidence` must be a number between 0 and 1' }); return;
  }
  if (entityIds !== undefined && Array.isArray(entityIds) && isStrictLinkage(wt.target)) {
    const invalidEIds = entityIds.filter((id: string) => !UUID_V4_RE.test(id));
    if (invalidEIds.length > 0) { res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidEIds }); return; }
  }
  if (memoryIds !== undefined && Array.isArray(memoryIds) && isStrictLinkage(wt.target)) {
    const invalidMIds = memoryIds.filter((id: string) => !UUID_V4_RE.test(id));
    if (invalidMIds.length > 0) { res.status(400).json({ error: '`memoryIds` must contain valid UUID v4 values (memory IDs), not names', invalid: invalidMIds }); return; }
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
      title, type, startsAt, endsAt, status, confidence,
      tags, entityIds, memoryIds, description, properties: safeProps, recurrence,
    });
    if (updated) {
      emitWebhookEvent({ event: 'chrono.updated', spaceId: mid, entry: { ...updated, embedding: undefined }, ...webhookToken(req) });
      res.json(updated);
      return;
    }
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
  if (typeof req.query['type'] === 'string') filter.type = req.query['type'];

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
    if (await deleteChrono(mid, id)) {
      emitWebhookEvent({ event: 'chrono.deleted', spaceId: mid, entry: { _id: id }, ...webhookToken(req) });
      res.status(204).end();
      return;
    }
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
  if (typeof req.query['path'] === 'string') filter['path'] = req.query['path'].replace(/\\/g, '/').replace(/^\/+/, '');
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

// DELETE /api/brain/spaces/:spaceId/files — delete file metadata record by path (does NOT delete the file on disk)
brainRouter.delete('/spaces/:spaceId/files', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` }); return;
  }
  const path = req.query['path'];
  if (typeof path !== 'string' || !path.trim()) {
    res.status(400).json({ error: '`path` query parameter required' }); return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    await deleteFileMeta(mid, path);
  }
  res.status(204).end();
});

// PATCH /api/brain/spaces/:spaceId/files — update file metadata by path (query param ?path=)
brainRouter.patch('/spaces/:spaceId/files', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` }); return;
  }
  const path = req.query['path'];
  if (typeof path !== 'string' || !path.trim()) {
    res.status(400).json({ error: '`path` query parameter required' }); return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }

  const { description, tags, entityIds, chronoIds, memoryIds, properties } = req.body ?? {};
  if (tags !== undefined && !Array.isArray(tags)) { res.status(400).json({ error: '`tags` must be an array' }); return; }
  if (entityIds !== undefined && !Array.isArray(entityIds)) { res.status(400).json({ error: '`entityIds` must be an array' }); return; }
  if (chronoIds !== undefined && !Array.isArray(chronoIds)) { res.status(400).json({ error: '`chronoIds` must be an array' }); return; }
  if (memoryIds !== undefined && !Array.isArray(memoryIds)) { res.status(400).json({ error: '`memoryIds` must be an array' }); return; }
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    res.status(400).json({ error: '`properties` must be a plain object' }); return;
  }

  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    const updated = await updateFileMeta(mid, path, { description, tags, entityIds, chronoIds, memoryIds, properties });
    if (updated) { res.json(updated); return; }
  }
  res.status(404).json({ error: 'File metadata record not found' });
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

// POST /api/brain/spaces/:spaceId/recall — semantic vector search by natural language query
brainRouter.post('/spaces/:spaceId/recall', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const { query, topK, types, minScore } = req.body ?? {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    res.status(400).json({ error: 'query must be a non-empty string' });
    return;
  }
  const safeTopK = typeof topK === 'number' ? Math.min(Math.max(topK, 1), 100) : 10;
  const safeTypes = Array.isArray(types) ? types.filter((t: unknown): t is RecallKnowledgeType => typeof t === 'string') : undefined;
  const safeMinScore = typeof minScore === 'number' ? minScore : undefined;

  try {
    const memberIds = resolveMemberSpaces(spaceId);
    const all = (await Promise.all(
      memberIds.map(mid => recall(mid, query.trim(), safeTopK, undefined, safeTypes, undefined, safeMinScore)),
    )).flat();
    all.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    const results = all.slice(0, safeTopK);
    res.json({ results, count: results.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// POST /api/brain/spaces/:spaceId/find-similar — vector similarity search by existing entry ID
const VALID_ENTRY_TYPES = new Set(['memory', 'entity', 'edge', 'chrono', 'file']);

brainRouter.post('/spaces/:spaceId/find-similar', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const entryId = typeof body['entryId'] === 'string' ? body['entryId'].trim() : '';
  const entryType = typeof body['entryType'] === 'string' ? body['entryType'].trim() : '';
  const topK = typeof body['topK'] === 'number' ? Math.min(Math.max(body['topK'], 1), 100) : 10;
  const minScore = typeof body['minScore'] === 'number' ? body['minScore'] : undefined;
  const crossSpace = body['crossSpace'] === true;
  const targetTypes = Array.isArray(body['targetTypes'])
    ? (body['targetTypes'] as unknown[]).filter((t): t is RecallKnowledgeType => typeof t === 'string' && VALID_ENTRY_TYPES.has(t))
    : undefined;

  if (!entryId || !UUID_V4_RE.test(entryId)) {
    res.status(400).json({ error: 'entryId must be a valid UUID v4' });
    return;
  }
  if (!VALID_ENTRY_TYPES.has(entryType)) {
    res.status(400).json({ error: `entryType must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}` });
    return;
  }

  // Determine cross-space search scope
  let crossSpaceIds: string[] | undefined;
  if (crossSpace) {
    const tokenSpaces = req.authToken?.spaces;
    crossSpaceIds = cfg.spaces
      .filter(s => !tokenSpaces || tokenSpaces.includes(s.id))
      .map(s => s.id);
  }

  try {
    const result = await findSimilar(
      spaceId,
      entryId,
      entryType as RecallKnowledgeType,
      topK,
      targetTypes,
      minScore,
      crossSpaceIds,
    );
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
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

  if (reindexJobRunning) {
    res.status(409).json({ error: 'Reindex already in progress' });
    return;
  }

  const memberIds = resolveMemberSpaces(spaceId);
  reindexJobRunning = true;
  reindexInProgress.set(1);
  res.json({ spaceId, reindexed: 0, errors: 0, status: 'started' });

  // Start heavy work on the next turn so HTTP headers flush immediately.
  setImmediate(() => {
    void (async () => {
      let reindexed = 0;
      let errors = 0;
      try {
        for (const mid of memberIds) {
        const BATCH = 50;

        // Re-embed memories
        {
          let cursor: string | null = null;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
            const batch: MemoryDoc[] = await col<MemoryDoc>(`${mid}_memories`)
              .find(q as never, { projection: { _id: 1, fact: 1, tags: 1, entityIds: 1, description: 1, properties: 1 } })
              .sort({ _id: 1 })
              .limit(BATCH)
              .toArray() as MemoryDoc[];
            if (batch.length === 0) break;
            for (const doc of batch) {
              try {
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
            cursor = batch[batch.length - 1]?._id ?? null;
          }
        }

        // Re-embed entities (name + type + tags + description + properties)
        {
          let cursor: string | null = null;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
            const batch: EntityDoc[] = await col<EntityDoc>(`${mid}_entities`)
              .find(q as never, { projection: { _id: 1, name: 1, type: 1, tags: 1, description: 1, properties: 1 } })
              .sort({ _id: 1 })
              .limit(BATCH)
              .toArray() as EntityDoc[];
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
            cursor = batch[batch.length - 1]?._id ?? null;
          }
        }

        // Re-embed edges (tags + from + label + to + type + description)
        {
          let cursor: string | null = null;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
            const batch: EdgeDoc[] = await col<EdgeDoc>(`${mid}_edges`)
              .find(q as never, { projection: { _id: 1, from: 1, label: 1, to: 1, type: 1, tags: 1, description: 1 } })
              .sort({ _id: 1 })
              .limit(BATCH)
              .toArray() as EdgeDoc[];
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
            cursor = batch[batch.length - 1]?._id ?? null;
          }
        }

        // Re-embed chrono (kind + status + title + description + tags)
        {
          let cursor: string | null = null;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
            const batch: ChronoEntry[] = await col<ChronoEntry>(`${mid}_chrono`)
              .find(q as never, { projection: { _id: 1, title: 1, type: 1, status: 1, description: 1, tags: 1 } })
              .sort({ _id: 1 })
              .limit(BATCH)
              .toArray() as ChronoEntry[];
            if (batch.length === 0) break;
            for (const doc of batch) {
              try {
                const tags: string[] = Array.isArray(doc.tags) ? doc.tags : [];
                const parts: string[] = [doc.type, doc.status, doc.title];
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
            cursor = batch[batch.length - 1]?._id ?? null;
          }
        }

        // Re-embed files (path + tags + description)
        {
          let cursor: string | null = null;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
            const batch: FileMetaDoc[] = await col<FileMetaDoc>(`${mid}_files`)
              .find(q as never, { projection: { _id: 1, path: 1, tags: 1, description: 1 } })
              .sort({ _id: 1 })
              .limit(BATCH)
              .toArray() as FileMetaDoc[];
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
            cursor = batch[batch.length - 1]?._id ?? null;
          }
        }

          clearReindexFlag(mid);
        }
        log.info(`Reindex completed for space '${spaceId}': reindexed=${reindexed}, errors=${errors}`);
      } catch (err) {
        log.error(`Reindex job failed for space '${spaceId}': ${String(err)}`);
      } finally {
        reindexJobRunning = false;
        reindexInProgress.set(0);
      }
    })();
  });
});

// ── Bulk write ────────────────────────────────────────────────────────────────

const BULK_MAX_PER_TYPE = 500;

interface BulkError {
  type: 'memory' | 'entity' | 'edge' | 'chrono';
  index: number;
  reason: string;
}

interface BulkCounts {
  memories: number;
  entities: number;
  edges: number;
  chrono: number;
}

/**
 * POST /api/brain/spaces/:spaceId/bulk
 *
 * Batch upsert memories, entities, edges, and chrono entries in a single
 * request.  Processing order: memories → entities → edges → chrono, so edges
 * referencing newly created entities within the same batch resolve correctly.
 *
 * All four arrays are optional.  Entries that fail per-item validation are
 * recorded in `errors` and do not abort the remaining batch items.
 */
brainRouter.post('/spaces/:spaceId/bulk', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const targetSpace = wt.target;

  // Schema validation context
  const bulkMeta = getSpaceMeta(targetSpace);
  const bulkValidation = bulkMeta?.validationMode ?? 'off';

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawMemories = Array.isArray(body['memories']) ? (body['memories'] as unknown[]).slice(0, BULK_MAX_PER_TYPE) : [];
  const rawEntities = Array.isArray(body['entities']) ? (body['entities'] as unknown[]).slice(0, BULK_MAX_PER_TYPE) : [];
  const rawEdges    = Array.isArray(body['edges'])    ? (body['edges']    as unknown[]).slice(0, BULK_MAX_PER_TYPE) : [];
  const rawChrono   = Array.isArray(body['chrono'])   ? (body['chrono']   as unknown[]).slice(0, BULK_MAX_PER_TYPE) : [];

  const inserted: BulkCounts = { memories: 0, entities: 0, edges: 0, chrono: 0 };
  const updated:  BulkCounts = { memories: 0, entities: 0, edges: 0, chrono: 0 };
  const errors: BulkError[] = [];

  // ── memories ───────────────────────────────────────────────────────────────
  for (let i = 0; i < rawMemories.length; i++) {
    const item = rawMemories[i] as Record<string, unknown>;
    const fact = typeof item['fact'] === 'string' ? item['fact'].trim() : '';
    if (!fact) { errors.push({ type: 'memory', index: i, reason: 'missing required field: fact' }); continue; }
    if (fact.length > 50_000) { errors.push({ type: 'memory', index: i, reason: '`fact` must not exceed 50 000 characters' }); continue; }
    const tags: string[] = Array.isArray(item['tags']) ? (item['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
    const entityIds: string[] = Array.isArray(item['entityIds']) ? (item['entityIds'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
    const description: string | undefined = typeof item['description'] === 'string' ? item['description'] : undefined;
    const itemMemoryType: string | undefined = typeof item['type'] === 'string' ? item['type'] : undefined;
    const properties: Record<string, string | number | boolean> | undefined =
      item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties'])
        ? (item['properties'] as Record<string, string | number | boolean>)
        : undefined;
    try {
      // Schema validation per memory
      if (bulkValidation !== 'off' && bulkMeta) {
        const sv = validateMemory(bulkMeta, { type: itemMemoryType, properties });
        if (sv.length > 0) {
          if (bulkValidation === 'strict') { errors.push({ type: 'memory', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
          for (const v of sv) errors.push({ type: 'memory', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
        }
      }
      await remember(targetSpace, fact, entityIds, tags, description, properties, undefined, itemMemoryType);
      inserted.memories++;
    } catch (err) {
      errors.push({ type: 'memory', index: i, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── entities ───────────────────────────────────────────────────────────────
  for (let i = 0; i < rawEntities.length; i++) {
    const item = rawEntities[i] as Record<string, unknown>;
    const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
    if (!name) { errors.push({ type: 'entity', index: i, reason: 'missing required field: name' }); continue; }
    const type = typeof item['type'] === 'string' ? item['type'].trim() : '';
    if (!type) { errors.push({ type: 'entity', index: i, reason: 'missing required field: type' }); continue; }
    const rawId = typeof item['id'] === 'string' ? item['id'].trim() : undefined;
    if (rawId !== undefined && !UUID_V4_RE.test(rawId)) {
      errors.push({ type: 'entity', index: i, reason: '`id` must be a valid UUID v4' }); continue;
    }
    const tags: string[] = Array.isArray(item['tags']) ? (item['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
    const description: string | undefined = typeof item['description'] === 'string' ? item['description'] : undefined;
    const properties: Record<string, string | number | boolean> =
      item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties'])
        ? (item['properties'] as Record<string, string | number | boolean>)
        : {};
    try {
      // Schema validation per entity
      if (bulkValidation !== 'off' && bulkMeta) {
        const sv = validateEntity(bulkMeta, { name, type, properties });
        if (sv.length > 0) {
          if (bulkValidation === 'strict') { errors.push({ type: 'entity', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
          for (const v of sv) errors.push({ type: 'entity', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
        }
      }
      // Check for existing entity by ID (if supplied) to determine inserted vs updated
      const existing = rawId
        ? await col<EntityDoc>(`${targetSpace}_entities`).findOne({ _id: rawId, spaceId: targetSpace } as never)
        : null;
      const result = await upsertEntity(targetSpace, name, type, tags, properties, description, rawId);
      if (existing) { updated.entities++; } else { inserted.entities++; }
      if (result.warning) { errors.push({ type: 'entity', index: i, reason: result.warning }); }
    } catch (err) {
      errors.push({ type: 'entity', index: i, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── edges ──────────────────────────────────────────────────────────────────
  for (let i = 0; i < rawEdges.length; i++) {
    const item = rawEdges[i] as Record<string, unknown>;
    const from  = typeof item['from']  === 'string' ? item['from'].trim()  : '';
    const to    = typeof item['to']    === 'string' ? item['to'].trim()    : '';
    const label = typeof item['label'] === 'string' ? item['label'].trim() : '';
    if (!from)  { errors.push({ type: 'edge', index: i, reason: 'missing required field: from' });  continue; }
    if (isStrictLinkage(targetSpace) && !UUID_V4_RE.test(from)) { errors.push({ type: 'edge', index: i, reason: '`from` must be a valid UUID v4 (entity ID), not a name' }); continue; }
    if (!to)    { errors.push({ type: 'edge', index: i, reason: 'missing required field: to' });    continue; }
    if (isStrictLinkage(targetSpace) && !UUID_V4_RE.test(to)) { errors.push({ type: 'edge', index: i, reason: '`to` must be a valid UUID v4 (entity ID), not a name' }); continue; }
    if (!label) { errors.push({ type: 'edge', index: i, reason: 'missing required field: label' }); continue; }
    const weight:      number | undefined = typeof item['weight'] === 'number' ? item['weight'] : undefined;
    const edgeType:    string | undefined = typeof item['type']   === 'string' ? item['type']   : undefined;
    const description: string | undefined = typeof item['description'] === 'string' ? item['description'] : undefined;
    const tags: string[] | undefined = Array.isArray(item['tags']) ? (item['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    const properties: Record<string, string | number | boolean> | undefined =
      item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties'])
        ? (item['properties'] as Record<string, string | number | boolean>)
        : undefined;
    try {
      // Schema validation per edge
      if (bulkValidation !== 'off' && bulkMeta) {
        const sv = validateEdge(bulkMeta, { label, properties });
        if (sv.length > 0) {
          if (bulkValidation === 'strict') { errors.push({ type: 'edge', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
          for (const v of sv) errors.push({ type: 'edge', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
        }
      }
      const existing = await col<EdgeDoc>(`${targetSpace}_edges`).findOne({ spaceId: targetSpace, from, to, label } as never);
      await upsertEdge(targetSpace, from, to, label, weight, edgeType, description, properties, tags);
      if (existing) { updated.edges++; } else { inserted.edges++; }
    } catch (err) {
      errors.push({ type: 'edge', index: i, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── chrono ─────────────────────────────────────────────────────────────────
  for (let i = 0; i < rawChrono.length; i++) {
    const item = rawChrono[i] as Record<string, unknown>;
    const title   = typeof item['title']   === 'string' ? item['title'].trim()   : '';
    const type    = typeof item['type']    === 'string' ? item['type']           : '';
    const startsAt = typeof item['startsAt'] === 'string' ? item['startsAt']     : '';
    if (!title)   { errors.push({ type: 'chrono', index: i, reason: 'missing required field: title' });   continue; }
    if (!CHRONO_TYPES.has(type as ChronoType)) {
      errors.push({ type: 'chrono', index: i, reason: '`type` must be one of: event, deadline, plan, prediction, milestone' });
      continue;
    }
    if (!startsAt) { errors.push({ type: 'chrono', index: i, reason: 'missing required field: startsAt' }); continue; }
    const endsAt:      string | undefined = typeof item['endsAt']      === 'string' ? item['endsAt']      : undefined;
    const status:      ChronoStatus | undefined = typeof item['status'] === 'string' && CHRONO_STATUSES.has(item['status'] as ChronoStatus) ? item['status'] as ChronoStatus : undefined;
    const confidence:  number | undefined = typeof item['confidence'] === 'number' ? item['confidence']   : undefined;
    const description: string | undefined = typeof item['description'] === 'string' ? item['description'] : undefined;
    const tags: string[] | undefined = Array.isArray(item['tags']) ? (item['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    const entityIds: string[] | undefined = Array.isArray(item['entityIds']) ? (item['entityIds'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    const memoryIds: string[] | undefined = Array.isArray(item['memoryIds']) ? (item['memoryIds'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    if (entityIds && isStrictLinkage(targetSpace)) {
      const invalidEIds = entityIds.filter(id => !UUID_V4_RE.test(id));
      if (invalidEIds.length > 0) { errors.push({ type: 'chrono', index: i, reason: '`entityIds` must contain valid UUID v4 values (entity IDs), not names' }); continue; }
    }
    if (memoryIds && isStrictLinkage(targetSpace)) {
      const invalidMIds = memoryIds.filter(id => !UUID_V4_RE.test(id));
      if (invalidMIds.length > 0) { errors.push({ type: 'chrono', index: i, reason: '`memoryIds` must contain valid UUID v4 values (memory IDs), not names' }); continue; }
    }
    const properties: Record<string, string | number | boolean> | undefined =
      item['properties'] != null && typeof item['properties'] === 'object' && !Array.isArray(item['properties'])
        ? (item['properties'] as Record<string, string | number | boolean>)
        : undefined;
    try {
      // Schema validation per chrono
      if (bulkValidation !== 'off' && bulkMeta) {
        const sv = validateChrono(bulkMeta, { type, properties });
        if (sv.length > 0) {
          if (bulkValidation === 'strict') { errors.push({ type: 'chrono', index: i, reason: `schema_violation: ${sv.map(v => v.reason).join('; ')}` }); continue; }
          for (const v of sv) errors.push({ type: 'chrono', index: i, reason: `schema_warning: ${v.field} — ${v.reason}` });
        }
      }
      await createChrono(targetSpace, {
        title, type: type as ChronoType, startsAt, endsAt, status, confidence,
        description, tags, entityIds, memoryIds, properties,
      });
      inserted.chrono++;
    } catch (err) {
      errors.push({ type: 'chrono', index: i, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  res.status(207).json({ inserted, updated, errors });
});
