import { v4 as uuidv4 } from 'uuid';
import { col, isVectorSearchAvailable } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getConfig, getEmbeddingConfig } from '../config/loader.js';
import { needsReindex } from '../spaces/spaces.js';
import type { MemoryDoc, EntityDoc, TombstoneDoc } from '../config/types.js';

function authorRef() {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Derive the text to embed for a memory (tags + entity names + fact + description + properties). */
function memoryEmbedText(
  fact: string,
  tags: string[] = [],
  entityNames: string[] = [],
  description?: string,
  properties?: Record<string, string | number | boolean>,
): string {
  const parts: string[] = [];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (entityNames.length > 0) parts.push(entityNames.join(' '));
  parts.push(fact);
  if (description?.trim()) parts.push(description.trim());
  if (properties) {
    const propEntries = Object.entries(properties);
    if (propEntries.length > 0) {
      parts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
    }
  }
  return parts.join(' ');
}

/** Resolve entity IDs to their names from the database. */
async function resolveEntityNames(spaceId: string, entityIds: string[]): Promise<string[]> {
  if (entityIds.length === 0) return [];
  const docs = await col<EntityDoc>(`${spaceId}_entities`)
    .find({ _id: { $in: entityIds } } as never, { projection: { name: 1 } })
    .toArray() as Array<{ name: string }>;
  return docs.map(d => d.name);
}

/** Store a new memory with semantic embedding */
export async function remember(
  spaceId: string,
  fact: string,
  entityIds: string[] = [],
  tags: string[] = [],
  description?: string,
  properties?: Record<string, string | number | boolean>,
  entityNames?: string[],
): Promise<MemoryDoc> {
  const names = entityNames ?? await resolveEntityNames(spaceId, entityIds);
  const embResult = await embed(memoryEmbedText(fact, tags, names, description, properties));
  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const doc: MemoryDoc = {
    _id: uuidv4(),
    spaceId,
    fact,
    embedding: embResult.vector,
    tags,
    entityIds,
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    embeddingModel: embResult.model,
  };
  if (description !== undefined) doc.description = description;
  if (properties !== undefined) doc.properties = properties;
  await col<MemoryDoc>(`${spaceId}_memories`).insertOne(doc as never);
  return doc;
}

export type RecallKnowledgeType = 'memory' | 'entity' | 'edge' | 'chrono' | 'file';

export interface RecallResult {
  _id: string;
  spaceId: string;
  /** Discriminates the knowledge type of the result. */
  type: RecallKnowledgeType;
  score: number;
  createdAt?: string;
  seq?: number;
  embeddingModel?: string;
  tags?: string[];
  // shared optional fields
  description?: string;
  properties?: Record<string, string | number | boolean>;
  // memory-specific
  fact?: string;
  entityIds?: string[];
  // entity-specific
  name?: string;
  /** Entity type string (named `entityType` to avoid conflict with the `type` discriminator). */
  entityType?: string;
  // edge-specific
  from?: string;
  to?: string;
  label?: string;
  weight?: number;
  // chrono-specific
  title?: string;
  kind?: string;
  startsAt?: string;
  // file-specific
  path?: string;
  sizeBytes?: number;
}

/** Semantic recall using $vectorSearch (Atlas Local / Atlas / MongoDB 8.2+) */
export async function recall(
  spaceId: string,
  query: string,
  topK = 10,
  tags?: string[],
  types?: RecallKnowledgeType[],
  minPerType?: Partial<Record<RecallKnowledgeType, number>>,
  minScore?: number,
): Promise<RecallResult[]> {
  if (!isVectorSearchAvailable()) {
    throw new Error(
      'Semantic recall is unavailable: $vectorSearch is not supported by the connected MongoDB. ' +
      'Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas.',
    );
  }
  if (needsReindex(spaceId)) {
    const embCfg = getEmbeddingConfig();
    throw new Error(
      `Space '${spaceId}' has embeddings from a different model than the currently configured '${embCfg.model}'. ` +
      `Semantic recall is disabled until re-indexed. Call POST /api/brain/spaces/${spaceId}/reindex.`,
    );
  }
  const embResult = await embed(query, 'query');
  const embCfg = getEmbeddingConfig();
  void embCfg; // used in index init, not here

  const activeTypes: RecallKnowledgeType[] = (types && types.length > 0)
    ? types
    : ['memory', 'entity', 'edge', 'chrono', 'file'];

  // Phase 1: for each type with a minPerType floor > 0, guarantee that many results
  const guaranteed: RecallResult[] = [];
  const guaranteedIds = new Set<string>();
  if (minPerType) {
    const floorSearches = Object.entries(minPerType)
      .filter(([t, floor]) => activeTypes.includes(t as RecallKnowledgeType) && (floor ?? 0) > 0)
      .map(([t, floor]) =>
        recallByType(spaceId, t as RecallKnowledgeType, embResult.vector, floor!, tags),
      );
    const floorResults = (await Promise.all(floorSearches)).flat();
    for (const r of floorResults) {
      if (!guaranteedIds.has(r._id)) {
        guaranteedIds.add(r._id);
        guaranteed.push(r);
      }
    }
  }

  // Phase 2: run the global unrestricted search for all active types
  const perTypeK = Math.ceil(topK * 1.5);
  const searches = activeTypes.map(t => recallByType(spaceId, t, embResult.vector, perTypeK, tags));
  const allResults = (await Promise.all(searches)).flat();
  allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Fill remaining slots (topK - guaranteedCount) from global results, skipping already-guaranteed
  const fillSlots = Math.max(0, topK - guaranteed.length);
  const fill: RecallResult[] = [];
  for (const r of allResults) {
    if (fill.length >= fillSlots) break;
    if (!guaranteedIds.has(r._id)) fill.push(r);
  }

  // Combine guaranteed + fill, sort by score, apply minScore filter, return
  const final = [...guaranteed, ...fill];
  final.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (minScore != null && minScore > 0) {
    return final.filter(r => (r.score ?? 0) >= minScore);
  }
  return final;
}

/** Maps knowledge types to their MongoDB collection suffixes. */
const KNOWLEDGE_COLLECTION: Record<RecallKnowledgeType, string> = {
  memory: 'memories',
  entity: 'entities',
  edge: 'edges',
  chrono: 'chrono',
  file: 'files',
};

/** Run $vectorSearch against a single collection and map results to RecallResult. */
async function recallByType(
  spaceId: string,
  knowledgeType: RecallKnowledgeType,
  queryVector: number[],
  topK: number,
  tags?: string[],
): Promise<RecallResult[]> {
  const collSuffix = KNOWLEDGE_COLLECTION[knowledgeType];
  const collName = `${spaceId}_${collSuffix}`;
  const indexName = `${spaceId}_${collSuffix}_embedding`;

  const pipeline: object[] = [
    {
      $vectorSearch: {
        index: indexName,
        path: 'embedding',
        queryVector,
        numCandidates: Math.min(topK * 15, 1000),
        limit: topK,
      },
    },
  ];

  // Tags filter applies to all types that have tags
  if (tags && tags.length > 0) {
    pipeline.push({ $match: { tags: { $all: tags } } });
  }

  pipeline.push({ $addFields: { _knowledgeType: knowledgeType, score: { $meta: 'vectorSearchScore' } } });

  // Project type-specific fields, always exclude embedding vector
  const commonProject = { _id: 1, spaceId: 1, _knowledgeType: 1, score: 1, createdAt: 1, seq: 1, embeddingModel: 1 };
  let typeProject: Record<string, number> = {};
  if (knowledgeType === 'memory') {
    typeProject = { fact: 1, tags: 1, entityIds: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'entity') {
    typeProject = { name: 1, type: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'edge') {
    typeProject = { from: 1, to: 1, label: 1, weight: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'chrono') {
    typeProject = { title: 1, description: 1, kind: 1, startsAt: 1, tags: 1, entityIds: 1, properties: 1 };
  } else if (knowledgeType === 'file') {
    typeProject = { path: 1, description: 1, tags: 1, sizeBytes: 1, properties: 1 };
  }
  pipeline.push({ $project: { ...commonProject, ...typeProject } });

  try {
    const docs = await col(collName).aggregate<Record<string, unknown>>(pipeline).toArray();
    return docs.map(d => mapToRecallResult(d, knowledgeType));
  } catch {
    // If this collection has no vector index yet (e.g. old data), return empty
    return [];
  }
}

function mapToRecallResult(doc: Record<string, unknown>, knowledgeType: RecallKnowledgeType): RecallResult {
  const base: RecallResult = {
    _id: doc['_id'] as string,
    spaceId: doc['spaceId'] as string,
    type: knowledgeType,
    score: doc['score'] as number,
    createdAt: doc['createdAt'] as string | undefined,
    seq: doc['seq'] as number | undefined,
    embeddingModel: doc['embeddingModel'] as string | undefined,
  };
  if (knowledgeType === 'memory') {
    base.fact = doc['fact'] as string | undefined;
    base.tags = doc['tags'] as string[] | undefined;
    base.entityIds = doc['entityIds'] as string[] | undefined;
    base.description = doc['description'] as string | undefined;
    base.properties = doc['properties'] as Record<string, string | number | boolean> | undefined;
  } else if (knowledgeType === 'entity') {
    base.name = doc['name'] as string | undefined;
    base.entityType = doc['type'] as string | undefined;
    base.tags = doc['tags'] as string[] | undefined;
    base.description = doc['description'] as string | undefined;
    base.properties = doc['properties'] as Record<string, string | number | boolean> | undefined;
  } else if (knowledgeType === 'edge') {
    base.from = doc['from'] as string | undefined;
    base.to = doc['to'] as string | undefined;
    base.label = doc['label'] as string | undefined;
    base.weight = doc['weight'] as number | undefined;
    base.tags = doc['tags'] as string[] | undefined;
    base.description = doc['description'] as string | undefined;
    base.properties = doc['properties'] as Record<string, string | number | boolean> | undefined;
  } else if (knowledgeType === 'chrono') {
    base.title = doc['title'] as string | undefined;
    base.description = doc['description'] as string | undefined;
    base.kind = doc['kind'] as string | undefined;
    base.startsAt = doc['startsAt'] as string | undefined;
    base.tags = doc['tags'] as string[] | undefined;
    base.entityIds = doc['entityIds'] as string[] | undefined;
    base.properties = doc['properties'] as Record<string, string | number | boolean> | undefined;
  } else if (knowledgeType === 'file') {
    base.path = doc['path'] as string | undefined;
    base.description = doc['description'] as string | undefined;
    base.tags = doc['tags'] as string[] | undefined;
    base.sizeBytes = doc['sizeBytes'] as number | undefined;
    base.properties = doc['properties'] as Record<string, string | number | boolean> | undefined;
  }
  return base;
}

/** Semantic recall across multiple spaces (parallel) */
export async function recallGlobal(
  spaceIds: string[],
  query: string,
  topK = 10,
  tags?: string[],
  types?: RecallKnowledgeType[],
  minPerType?: Partial<Record<RecallKnowledgeType, number>>,
  minScore?: number,
): Promise<RecallResult[]> {
  const results = await Promise.all(spaceIds.map(id => recall(id, query, topK, tags, types, minPerType, minScore)));
  const flat = results.flat();
  // Sort by score descending, deduplicate by _id
  const seen = new Set<string>();
  const deduped: RecallResult[] = [];
  for (const r of flat.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (!seen.has(r._id)) {
      seen.add(r._id);
      deduped.push(r);
    }
  }
  return deduped.slice(0, topK);
}

/** Update an existing memory's fact, tags, entityIds, description, or properties. Re-embeds when content fields change. */
export async function updateMemory(
  spaceId: string,
  memoryId: string,
  updates: { fact?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean> },
): Promise<MemoryDoc | null> {
  const existing = await col<MemoryDoc>(`${spaceId}_memories`).findOne({ _id: memoryId, spaceId } as never) as MemoryDoc | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };

  if (updates.fact !== undefined) $set['fact'] = updates.fact;
  if (updates.tags !== undefined) $set['tags'] = updates.tags;
  if (updates.entityIds !== undefined) $set['entityIds'] = updates.entityIds;
  if (updates.description !== undefined) $set['description'] = updates.description;
  if (updates.properties !== undefined) $set['properties'] = updates.properties;

  // Re-embed whenever any content field changes
  const contentChanged =
    updates.fact !== undefined ||
    updates.tags !== undefined ||
    updates.entityIds !== undefined ||
    updates.description !== undefined ||
    updates.properties !== undefined;
  if (contentChanged) {
    const newFact = updates.fact ?? existing.fact;
    const newTags = updates.tags ?? existing.tags;
    const newEntityIds = updates.entityIds ?? existing.entityIds;
    const newDesc = updates.description !== undefined ? updates.description : existing.description;
    const newProps = updates.properties ?? existing.properties;
    const entityNames = await resolveEntityNames(spaceId, newEntityIds);
    try {
      const embResult = await embed(memoryEmbedText(newFact, newTags, entityNames, newDesc, newProps));
      $set['embedding'] = embResult.vector;
      $set['embeddingModel'] = embResult.model;
    } catch { /* embedding unavailable — keep existing embedding */ }
  }

  await col<MemoryDoc>(`${spaceId}_memories`).updateOne(
    { _id: memoryId } as never,
    { $set } as never,
  );
  return { ...existing, ...($set as Partial<MemoryDoc>) } as MemoryDoc;
}

/** Delete a memory and record a tombstone */
export async function deleteMemory(
  spaceId: string,
  memoryId: string,
): Promise<boolean> {
  const seq = await nextSeq(spaceId);
  const result = await col<MemoryDoc>(`${spaceId}_memories`).deleteOne({
    _id: memoryId,
    spaceId,
  });
  if (result.deletedCount === 0) return false;

  const tombstone: TombstoneDoc = {
    _id: memoryId,
    type: 'memory',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    { _id: memoryId } as never,
    tombstone as never,
    { upsert: true },
  );
  return true;
}

/** List memories (no embedding, paginated) */
export async function listMemories(
  spaceId: string,
  filter: Record<string, unknown> = {},
  limit = 20,
  skip = 0,
) {
  return col<MemoryDoc>(`${spaceId}_memories`)
    .find(filter as never)
    .project({ embedding: 0 })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/** Count memories in a space */
export async function countMemories(spaceId: string): Promise<number> {
  return col<MemoryDoc>(`${spaceId}_memories`).countDocuments();
}

/** Bulk-delete all memories in a space, writing a tombstone per deleted doc. */
export async function bulkDeleteMemories(spaceId: string): Promise<number> {
  const coll = col<MemoryDoc>(`${spaceId}_memories`);
  const ids = await coll.find({}, { projection: { _id: 1 } }).toArray();
  if (ids.length === 0) return 0;

  const now = new Date().toISOString();
  const instanceId = getConfig().instanceId;
  const tombstones: TombstoneDoc[] = [];

  for (const doc of ids) {
    const seq = await nextSeq(spaceId);
    tombstones.push({
      _id: doc._id,
      type: 'memory',
      spaceId,
      deletedAt: now,
      instanceId,
      seq,
    });
  }

  const ops = tombstones.map(t => ({
    replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true },
  }));
  await col<TombstoneDoc>(`${spaceId}_tombstones`).bulkWrite(ops as never);
  await coll.deleteMany({});
  return ids.length;
}

// Allowed top-level query operators for the structured query tool
const ALLOWED_OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
  '$all', '$elemMatch', '$size', '$mod',
]);

// Valid MongoDB regex flags (i=case-insensitive, m=multiline, s=dotAll, x=extended)
const VALID_OPTIONS_RE = /^[imsx]+$/;

function sanitizeFilter(filter: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error('Filter too deeply nested');
  if (Array.isArray(filter)) return filter.map(v => sanitizeFilter(v, depth + 1));
  if (filter !== null && typeof filter === 'object') {
    const entries = Object.entries(filter as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      if (key.startsWith('$') && !ALLOWED_OPERATORS.has(key)) {
        throw new Error(`Operator '${key}' is not allowed in queries`);
      }
      out[key] = sanitizeFilter(val, depth + 1);
    }
    // $options must only appear alongside $regex and contain valid flags
    if ('$options' in out) {
      if (!('$regex' in out)) {
        throw new Error("'$options' is only allowed alongside '$regex'");
      }
      if (typeof out['$options'] !== 'string' || !VALID_OPTIONS_RE.test(out['$options'] as string)) {
        throw new Error("'$options' must be a string of valid regex flags (i, m, s, x)");
      }
    }
    return out;
  }
  return filter;
}

const ALLOWED_COLLECTIONS = new Set(['memories', 'entities', 'edges', 'chrono', 'files']);

/** Structured read-only query (operator whitelist enforced) */
export async function queryBrain(
  spaceId: string,
  collectionName: 'memories' | 'entities' | 'edges' | 'chrono' | 'files',
  filter: Record<string, unknown>,
  projection?: Record<string, unknown>,
  limit = 20,
  maxTimeMS = 5000,
) {
  if (!ALLOWED_COLLECTIONS.has(collectionName)) {
    throw new Error(`Unknown collection '${collectionName}'`);
  }
  const safeFilter = sanitizeFilter(filter) as Record<string, never>;
  const safeMaxTime = Math.min(maxTimeMS, 30_000);
  const collName = `${spaceId}_${collectionName}`;
  let cursor = col(collName)
    .find(safeFilter)
    .maxTimeMS(safeMaxTime)
    .limit(Math.min(limit, 100));

  if (projection) {
    cursor = cursor.project(projection as Record<string, never>);
  }
  // Always exclude embedding vectors from query results
  cursor = cursor.project({ embedding: 0 } as never);
  return cursor.toArray();
}
