import { v4 as uuidv4 } from 'uuid';
import { col, isVectorSearchAvailable, mFilter, mDoc, mUpdate, mBulk } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { NotFoundError } from '../util/errors.js';
import { embed } from './embedding.js';
import { getConfig, getEmbeddingConfig } from '../config/loader.js';
import { needsReindex } from '../spaces/spaces.js';
import { applyDeleteFields } from './delete-fields.js';
import type { MemoryDoc, EntityDoc, TombstoneDoc } from '../config/types.js';

// ── Prefiltered recall ────────────────────────────────────────────────────

/**
 * A single filter operator applied to one field.
 * Multiple operators on the same field are AND-ed together (e.g. gt+lt for a range).
 */
export interface FilterOperator {
  eq?: string | number | boolean;
  ne?: string | number | boolean;
  in?: Array<string | number | boolean>;
  exists?: boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

/**
 * Map of dot-notation field paths to their filter operator(s).
 * Keys must start with `properties.`, `tags`, `type`, or `name`.
 */
export type FilterExpression = Record<string, FilterOperator>;

const ALLOWED_FILTER_KEY_PREFIXES = ['properties.', 'tags', 'type', 'name'] as const;

/**
 * Validate that all filter keys use allowed prefixes (injection prevention).
 * Returns an error message string, or null if valid.
 */
export function validateFilterExpression(filter: FilterExpression): string | null {
  for (const key of Object.keys(filter)) {
    const allowed = ALLOWED_FILTER_KEY_PREFIXES.some(
      prefix => key === prefix || key.startsWith(prefix + '.') || (prefix.endsWith('.') && key.startsWith(prefix)),
    );
    if (!allowed) {
      return `Filter key '${key}' is not allowed. Keys must start with: properties., tags, type, or name.`;
    }
  }
  return null;
}

/** Convert a FilterExpression to a MongoDB match document. */
export function buildMongoFilter(filter: FilterExpression): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, op] of Object.entries(filter)) {
    const mongoOp: Record<string, unknown> = {};
    if (op.eq !== undefined) mongoOp['$eq'] = op.eq;
    if (op.ne !== undefined) mongoOp['$ne'] = op.ne;
    if (op.in !== undefined) mongoOp['$in'] = op.in;
    if (op.exists !== undefined) mongoOp['$exists'] = op.exists;
    if (op.gt !== undefined) mongoOp['$gt'] = op.gt;
    if (op.gte !== undefined) mongoOp['$gte'] = op.gte;
    if (op.lt !== undefined) mongoOp['$lt'] = op.lt;
    if (op.lte !== undefined) mongoOp['$lte'] = op.lte;
    if (Object.keys(mongoOp).length > 0) {
      result[key] = mongoOp;
    }
  }
  return result;
}

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
    .find(mFilter<EntityDoc>({ _id: { $in: entityIds } }), { projection: { name: 1 } })
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
  type?: string,
): Promise<MemoryDoc> {
  const names = entityNames ?? await resolveEntityNames(spaceId, entityIds);
  const embedText = memoryEmbedText(fact, tags, names, description, properties);
  const embResult = await embed(embedText);
  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const doc: MemoryDoc = {
    _id: uuidv4(),
    spaceId,
    fact,
    embedding: embResult.vector,
    tags,
    entityIds,
    matchedText: embedText,
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    embeddingModel: embResult.model,
  };
  if (type !== undefined) doc.type = type;
  if (description !== undefined) doc.description = description;
  if (properties !== undefined) doc.properties = properties;
  await col<MemoryDoc>(`${spaceId}_memories`).insertOne(mDoc<MemoryDoc>(doc));
  return doc;
}

export type RecallKnowledgeType = 'memory' | 'entity' | 'edge' | 'chrono' | 'file';

/** Fields shared by every knowledge-type recall result. */
interface RecallBase {
  _id: string;
  spaceId: string;
  score: number;
  createdAt?: string;
  updatedAt?: string;
  seq?: number;
  embeddingModel?: string;
  tags?: string[];
  description?: string;
  properties?: Record<string, string | number | boolean>;
  /** Pre-embedding source text — the exact string fed to the embedding model for this document. */
  matchedText?: string;
}

export interface RecallMemory extends RecallBase {
  type: 'memory';
  fact: string;
  entityIds?: string[];
}

export interface RecallEntity extends RecallBase {
  type: 'entity';
  name: string;
  /** Entity type (named `entityType` to avoid conflict with the `type` discriminator). */
  entityType: string;
}

export interface RecallEdge extends RecallBase {
  type: 'edge';
  from: string;
  to: string;
  label: string;
  weight?: number;
  /** Edge relationship type (named `edgeType` to avoid conflict with the `type` discriminator). */
  edgeType?: string;
}

export interface RecallChrono extends RecallBase {
  type: 'chrono';
  title: string;
  /** Chrono type (event/deadline/plan/prediction/milestone). Named `chronoType` to
   *  avoid conflict with the `type` discriminator field. */
  chronoType: string;
  startsAt: string;
  /** Chrono status (upcoming/active/completed/overdue/cancelled). */
  status?: string;
  entityIds?: string[];
}

export interface RecallFile extends RecallBase {
  type: 'file';
  path: string;
  sizeBytes?: number;
  /** Set on chunk records: the H2/H3 heading that opened this chunk (null for paragraph-chunked txt). */
  headingText?: string | null;
  /** Set on chunk records: the Markdown body of this chunk. */
  content?: string;
  /** Set on chunk and _converted/ records: _id of the parent file's filemeta record. */
  parentFileId?: string;
  /** Set on chunk records: 0-based position within the document. */
  chunkIndex?: number;
  /** Set on media chunk records: 'image' | 'audio' | 'video'. */
  mediaType?: 'image' | 'audio' | 'video';
  /** Set on media file records: current async embedding status. */
  embeddingStatus?: 'pending' | 'processing' | 'complete' | 'failed' | 'skipped' | 'disabled';
  /** Set on audio/video chunk records: start time of the chunk in milliseconds. */
  chunkOffsetMs?: number;
  /** Set on audio/video chunk records: duration of the chunk in milliseconds. */
  chunkDurationMs?: number;
  /** Inline parent file metadata — populated on chunk records when parentFileId is present. */
  parentFile?: { path: string; description?: string; tags?: string[] };
}

/** Discriminated union of all knowledge-type recall results. Narrow by `result.type`. */
export type RecallResult = RecallMemory | RecallEntity | RecallEdge | RecallChrono | RecallFile;

/** Semantic recall using $vectorSearch (Atlas Local / Atlas / MongoDB 8.2+) */
export async function recall(
  spaceId: string,
  query: string,
  topK = 10,
  tags?: string[],
  types?: RecallKnowledgeType[],
  minPerType?: Partial<Record<RecallKnowledgeType, number>>,
  minScore?: number,
  filter?: FilterExpression,
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
        recallByType(spaceId, t as RecallKnowledgeType, embResult.vector, floor!, tags, filter),
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
  const searches = activeTypes.map(t => recallByType(spaceId, t, embResult.vector, perTypeK, tags, filter));
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

  // Enrich file chunk results with inline parent metadata
  await enrichFileChunksWithParent(spaceId, final);

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
  filter?: FilterExpression,
): Promise<RecallResult[]> {
  const collSuffix = KNOWLEDGE_COLLECTION[knowledgeType];
  const collName = `${spaceId}_${collSuffix}`;
  const indexName = `${spaceId}_${collSuffix}_embedding`;

  // $vectorSearch native `filter` requires each field to be declared as type:"filter"
  // in the index definition — infeasible for dynamic properties.* fields.
  //
  // When filtering, use ENN (exact: true): MongoDB exhaustively scores ALL documents,
  // then we $match the full scored set, then re-limit to topK.
  // ANN + post-$match is wrong: it discards matching docs that fall below ANN's topK
  // before filtering even runs. MongoDB docs recommend ENN for selective pre-filter cases.
  //
  // When no filter/tags: standard ANN for performance (unchanged behaviour).
  const hasFilter = filter != null && Object.keys(filter).length > 0;
  const hasTags = tags != null && tags.length > 0;
  const needsPostMatch = hasFilter || hasTags;

  const pipeline: object[] = [];

  if (needsPostMatch) {
    // ENN: exhaustive search across all documents. limit is set high enough to
    // pass all candidates through to the $match stages; topK is re-applied after.
    const ennLimit = Math.min(10000, Math.max(topK * 100, 1000));
    pipeline.push({
      $vectorSearch: {
        index: indexName,
        path: 'embedding',
        queryVector,
        exact: true,
        limit: ennLimit,
      },
    });
    if (hasTags) {
      pipeline.push({ $match: { tags: { $all: tags } } });
    }
    if (hasFilter) {
      pipeline.push({ $match: buildMongoFilter(filter!) });
    }
    pipeline.push({ $limit: topK });
  } else {
    // ANN: approximate search, no post-filtering needed.
    pipeline.push({
      $vectorSearch: {
        index: indexName,
        path: 'embedding',
        queryVector,
        numCandidates: Math.min(topK * 15, 1000),
        limit: topK,
      },
    });
  }

  pipeline.push({ $addFields: { _knowledgeType: knowledgeType, score: { $meta: 'vectorSearchScore' } } });

  // Project type-specific fields, always exclude embedding vector
  const commonProject = { _id: 1, spaceId: 1, _knowledgeType: 1, score: 1, createdAt: 1, updatedAt: 1, seq: 1, embeddingModel: 1, matchedText: 1 };
  let typeProject: Record<string, number> = {};
  if (knowledgeType === 'memory') {
    typeProject = { fact: 1, tags: 1, entityIds: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'entity') {
    typeProject = { name: 1, type: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'edge') {
    typeProject = { from: 1, to: 1, label: 1, weight: 1, type: 1, tags: 1, description: 1, properties: 1 };
  } else if (knowledgeType === 'chrono') {
    typeProject = { title: 1, description: 1, type: 1, status: 1, startsAt: 1, tags: 1, entityIds: 1, properties: 1 };
  } else if (knowledgeType === 'file') {
    typeProject = { path: 1, description: 1, tags: 1, sizeBytes: 1, properties: 1, headingText: 1, content: 1, parentFileId: 1, chunkIndex: 1, mediaType: 1, embeddingStatus: 1, chunkOffsetMs: 1, chunkDurationMs: 1 };
  }
  pipeline.push({ $project: { ...commonProject, ...typeProject } });

  try {
    const docs = await col(collName).aggregate<Record<string, unknown>>(pipeline).toArray();
    return docs.map(d => mapToRecallResult(d, knowledgeType));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only swallow "index not found" errors (e.g. new space with no data yet).
    // All other errors are rethrown so they surface to the caller.
    if (/index.*not.*found|no.*such.*index|search.*index/i.test(msg)) {
      return [];
    }
    throw err;
  }
}

function mapToRecallResult(doc: Record<string, unknown>, knowledgeType: RecallKnowledgeType): RecallResult {
  const base: RecallBase = {
    _id: doc['_id'] as string,
    spaceId: doc['spaceId'] as string,
    score: doc['score'] as number,
    createdAt: doc['createdAt'] as string | undefined,
    updatedAt: doc['updatedAt'] as string | undefined,
    seq: doc['seq'] as number | undefined,
    embeddingModel: doc['embeddingModel'] as string | undefined,
    tags: doc['tags'] as string[] | undefined,
    description: doc['description'] as string | undefined,
    properties: doc['properties'] as Record<string, string | number | boolean> | undefined,
    matchedText: doc['matchedText'] as string | undefined,
  };
  switch (knowledgeType) {
    case 'memory':
      return { ...base, type: 'memory', fact: doc['fact'] as string, entityIds: doc['entityIds'] as string[] | undefined };
    case 'entity':
      return { ...base, type: 'entity', name: doc['name'] as string, entityType: doc['type'] as string };
    case 'edge':
      return { ...base, type: 'edge', from: doc['from'] as string, to: doc['to'] as string, label: doc['label'] as string, weight: doc['weight'] as number | undefined, edgeType: doc['type'] as string | undefined };
    case 'chrono':
      return { ...base, type: 'chrono', title: doc['title'] as string, chronoType: doc['type'] as string, startsAt: doc['startsAt'] as string, status: doc['status'] as string | undefined, entityIds: doc['entityIds'] as string[] | undefined };
    case 'file':
      return { ...base, type: 'file', path: doc['path'] as string, sizeBytes: doc['sizeBytes'] as number | undefined, headingText: doc['headingText'] as string | null | undefined, content: doc['content'] as string | undefined, parentFileId: doc['parentFileId'] as string | undefined, chunkIndex: doc['chunkIndex'] as number | undefined, mediaType: doc['mediaType'] as 'image' | 'audio' | 'video' | undefined, embeddingStatus: doc['embeddingStatus'] as RecallFile['embeddingStatus'], chunkOffsetMs: doc['chunkOffsetMs'] as number | undefined, chunkDurationMs: doc['chunkDurationMs'] as number | undefined };
  }
}

/**
 * For file chunk results that have a parentFileId, batch-fetch the parent
 * file document and attach `parentFile: { path, description?, tags? }` inline.
 * Non-chunk file results and non-file results are left unchanged.
 */
async function enrichFileChunksWithParent(spaceId: string, results: RecallResult[]): Promise<void> {
  const fileChunks = results.filter(
    (r): r is RecallFile => r.type === 'file' && typeof r.parentFileId === 'string',
  );
  if (fileChunks.length === 0) return;

  const parentIds = [...new Set(fileChunks.map(r => r.parentFileId as string))];

  // Batch-fetch parent file docs — projection only (no embedding field)
  const parents = (await col(`${spaceId}_files`)
    .find(mFilter({ _id: { $in: parentIds } }), { projection: { path: 1, description: 1, tags: 1 } })
    .toArray()) as unknown as Array<{ _id: string; path?: string; description?: string; tags?: string[] }>;

  const parentMap = new Map(parents.map(p => [p._id, p]));

  for (const chunk of fileChunks) {
    const parent = parentMap.get(chunk.parentFileId as string);
    if (parent) {
      chunk.parentFile = {
        path: parent.path ?? (parent._id),
        ...(parent.description ? { description: parent.description } : {}),
        ...(parent.tags?.length ? { tags: parent.tags } : {}),
      };
    }
  }
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
  filter?: FilterExpression,
): Promise<RecallResult[]> {
  const results = await Promise.all(spaceIds.map(id => recall(id, query, topK, tags, types, minPerType, minScore, filter)));
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

/** Retrieve the stored embedding vector for an entry by its ID and knowledge type. */
async function getEntryEmbedding(
  spaceId: string,
  entryId: string,
  entryType: RecallKnowledgeType,
): Promise<{ vector: number[]; doc: Record<string, unknown> } | null> {
  const collSuffix = KNOWLEDGE_COLLECTION[entryType];
  const collName = `${spaceId}_${collSuffix}`;
  const doc = await col(collName).findOne(
    mFilter({ _id: entryId, spaceId }),
    { projection: { embedding: 1, _id: 1, spaceId: 1, name: 1, fact: 1, label: 1, title: 1, path: 1, type: 1, description: 1 } },
  ) as Record<string, unknown> | null;
  if (!doc) return null;
  const vector = doc['embedding'] as number[] | undefined;
  if (!vector || !Array.isArray(vector) || vector.length === 0) return null;
  return { vector, doc };
}

export interface FindSimilarResult {
  source: RecallResult;
  results: RecallResult[];
}

/**
 * Find entries with high vector similarity to an existing entry.
 * Uses the entry's stored embedding vector directly — no re-embedding.
 */
export async function findSimilar(
  spaceId: string,
  entryId: string,
  entryType: RecallKnowledgeType,
  topK = 10,
  targetTypes?: RecallKnowledgeType[],
  minScore?: number,
  crossSpaceIds?: string[],
): Promise<FindSimilarResult> {
  if (!isVectorSearchAvailable()) {
    throw new Error(
      'Vector search is unavailable: $vectorSearch is not supported by the connected MongoDB. ' +
      'Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas.',
    );
  }

  // Fetch the source entry's stored embedding
  const entry = await getEntryEmbedding(spaceId, entryId, entryType);
  if (!entry) {
    throw new NotFoundError(`Entry '${entryId}' not found in space '${spaceId}' (type: ${entryType}), or has no embedding.`);
  }

  const activeTypes: RecallKnowledgeType[] = (targetTypes && targetTypes.length > 0)
    ? targetTypes
    : ['memory', 'entity', 'edge', 'chrono', 'file'];

  // Fetch topK+1 to account for self-match removal
  const fetchK = topK + 1;

  // Determine which spaces to search
  const searchSpaces = crossSpaceIds && crossSpaceIds.length > 0 ? crossSpaceIds : [spaceId];

  const allResults: RecallResult[] = [];
  for (const sid of searchSpaces) {
    if (needsReindex(sid)) continue; // skip spaces needing reindex
    const searches = activeTypes.map(t => recallByType(sid, t, entry.vector, fetchK));
    const spaceResults = (await Promise.all(searches)).flat();
    allResults.push(...spaceResults);
  }

  // Sort by score descending, exclude self-match, deduplicate
  allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seen = new Set<string>();
  const filtered: RecallResult[] = [];
  for (const r of allResults) {
    if (r._id === entryId) continue; // exclude self
    if (seen.has(r._id)) continue;
    seen.add(r._id);
    if (minScore != null && minScore > 0 && (r.score ?? 0) < minScore) continue;
    filtered.push(r);
    if (filtered.length >= topK) break;
  }

  // Build source summary
  const source = mapToRecallResult(entry.doc, entryType);
  source.score = 1.0;

  return { source, results: filtered };
}

/** Update an existing memory's fact, tags, entityIds, description, or properties. Re-embeds when content fields change. */
export async function updateMemory(
  spaceId: string,
  memoryId: string,
  updates: { fact?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean>; type?: string },
  deleteFieldsPaths?: string[],
): Promise<MemoryDoc | null> {
  const existing = await col<MemoryDoc>(`${spaceId}_memories`).findOne(mFilter<MemoryDoc>({ _id: memoryId, spaceId })) as MemoryDoc | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };
  const $unset: Record<string, unknown> = {};

  if (updates.fact !== undefined) $set['fact'] = updates.fact;
  if (updates.tags !== undefined) $set['tags'] = updates.tags;
  if (updates.entityIds !== undefined) $set['entityIds'] = updates.entityIds;
  if (updates.description !== undefined) $set['description'] = updates.description;
  if (updates.properties !== undefined) $set['properties'] = updates.properties;
  if (updates.type !== undefined) $set['type'] = updates.type;

  // Apply deleteFields after merge
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    // Build a merged view for deleteFields application
    const merged: Record<string, unknown> = {
      fact: updates.fact ?? existing.fact,
      tags: updates.tags ?? existing.tags,
      entityIds: updates.entityIds ?? existing.entityIds,
      description: updates.description !== undefined ? updates.description : existing.description,
      properties: updates.properties ?? (existing.properties != null ? { ...existing.properties } : {}),
    };
    applyDeleteFields(merged, deleteFieldsPaths);

    // Reflect deletions into $set/$unset
    for (const field of ['description', 'tags', 'entityIds', 'properties']) {
      if (!(field in merged)) {
        $unset[field] = '';
        delete $set[field];
      } else if (deleteFieldsPaths.some(p => p === field || p.startsWith(field + '.'))) {
        $set[field] = merged[field];
      }
    }
  }

  // Re-embed whenever any content field changes
  const contentChanged =
    updates.fact !== undefined ||
    updates.tags !== undefined ||
    updates.entityIds !== undefined ||
    updates.description !== undefined ||
    updates.properties !== undefined ||
    (deleteFieldsPaths && deleteFieldsPaths.length > 0);
  if (contentChanged) {
    const newFact = ($set['fact'] as string) ?? existing.fact;
    const newTags = ($set['tags'] as string[]) ?? existing.tags;
    const newEntityIds = ($set['entityIds'] as string[]) ?? existing.entityIds;
    const newDesc = 'description' in $set ? ($set['description'] as string | undefined) : existing.description;
    const newProps = ($set['properties'] as Record<string, string | number | boolean>) ?? existing.properties;
    const entityNames = await resolveEntityNames(spaceId, newEntityIds);
    try {
      const embedText = memoryEmbedText(newFact, newTags, entityNames, newDesc, newProps);
      const embResult = await embed(embedText);
      $set['embedding'] = embResult.vector;
      $set['embeddingModel'] = embResult.model;
      $set['matchedText'] = embedText;
    } catch { /* embedding unavailable — keep existing embedding */ }
  }

  const updateOp: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
  await col<MemoryDoc>(`${spaceId}_memories`).updateOne(
    mFilter<MemoryDoc>({ _id: memoryId }),
    mUpdate<MemoryDoc>(updateOp),
  );

  const result = { ...existing, ...($set as Partial<MemoryDoc>) } as MemoryDoc;

  // Apply deleteFields to the returned doc for consistency
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    applyDeleteFields(result as unknown as Record<string, unknown>, deleteFieldsPaths);
  }

  return result;
}

/** Delete a memory and record a tombstone */
export async function deleteMemory(
  spaceId: string,
  memoryId: string,
): Promise<boolean> {
  const existing = await col<MemoryDoc>(`${spaceId}_memories`)
    .findOne(mFilter<MemoryDoc>({ _id: memoryId, spaceId }), { projection: { seq: 1 } }) as { seq?: number } | null;
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
    ...(existing?.seq !== undefined ? { originalSeq: existing.seq } : {}),
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    mFilter<TombstoneDoc>({ _id: memoryId }),
    mDoc<TombstoneDoc>(tombstone),
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
    .find(mFilter<MemoryDoc>(filter))
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
  // Deterministic newest-first ordering keeps recently written docs near the
  // front of the generated tombstone seq range even under very large datasets.
  const ids = await coll
    .find({}, { projection: { _id: 1, createdAt: 1, seq: 1 } })
    .sort({ createdAt: -1, _id: -1 })
    .toArray() as { _id: string; createdAt: string; seq?: number }[];
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
      ...(doc.seq !== undefined ? { originalSeq: doc.seq } : {}),
    });
  }

  const ops = tombstones.map(t => ({
    replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true },
  }));
  await col<TombstoneDoc>(`${spaceId}_tombstones`).bulkWrite(mBulk<TombstoneDoc>(ops));
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
    // Deterministic newest-first ordering keeps recent writes visible under
    // the default limit even when historical datasets grow large.
    .sort({ seq: -1, updatedAt: -1, createdAt: -1, _id: -1 })
    .limit(Math.min(limit, 100));

  if (projection) {
    cursor = cursor.project(projection as Record<string, never>);
  }
  // Always exclude embedding vectors from query results
  cursor = cursor.project({ embedding: 0 });
  return cursor.toArray();
}
