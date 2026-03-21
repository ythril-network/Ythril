import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getConfig, getEmbeddingConfig } from '../config/loader.js';
import { needsReindex } from '../spaces/spaces.js';
import type { MemoryDoc, TombstoneDoc } from '../config/types.js';

function authorRef() {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Store a new memory with semantic embedding */
export async function remember(
  spaceId: string,
  fact: string,
  entityIds: string[] = [],
  tags: string[] = [],
): Promise<MemoryDoc> {
  const embResult = await embed(fact);
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
  await col<MemoryDoc>(`${spaceId}_memories`).insertOne(doc as never);
  return doc;
}

export interface RecallResult {
  _id: string;
  spaceId: string;
  fact: string;
  score: number;
  tags: string[];
  entityIds: string[];
  createdAt: string;
  seq: number;
  embeddingModel: string;
}

/** Semantic recall using $vectorSearch (Atlas Local) */
export async function recall(
  spaceId: string,
  query: string,
  topK = 10,
): Promise<RecallResult[]> {
  if (needsReindex(spaceId)) {
    const embCfg = getEmbeddingConfig();
    throw new Error(
      `Space '${spaceId}' has embeddings from a different model than the currently configured '${embCfg.model}'. ` +
      `Semantic recall is disabled until re-indexed. Call POST /api/brain/spaces/${spaceId}/reindex.`,
    );
  }
  const embResult = await embed(query, 'query');
  const embCfg = getEmbeddingConfig();

  const pipeline = [
    {
      $vectorSearch: {
        index: `${spaceId}_memories_embedding`,
        path: 'embedding',
        queryVector: embResult.vector,
        numCandidates: Math.min(topK * 15, 1000),
        limit: topK,
      },
    },
    {
      $project: {
        _id: 1,
        spaceId: 1,
        fact: 1,
        tags: 1,
        entityIds: 1,
        createdAt: 1,
        seq: 1,
        embeddingModel: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  void embCfg; // used in index init, not here
  const docs = await col<MemoryDoc>(`${spaceId}_memories`)
    .aggregate<RecallResult>(pipeline)
    .toArray();
  return docs;
}

/** Semantic recall across multiple spaces (parallel) */
export async function recallGlobal(
  spaceIds: string[],
  query: string,
  topK = 10,
): Promise<RecallResult[]> {
  const results = await Promise.all(spaceIds.map(id => recall(id, query, topK)));
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
  await col<TombstoneDoc>(`${spaceId}_tombstones`).insertOne(tombstone as never);
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
    .skip(skip)
    .limit(limit)
    .toArray();
}

/** Count memories in a space */
export async function countMemories(spaceId: string): Promise<number> {
  return col<MemoryDoc>(`${spaceId}_memories`).countDocuments();
}

// Allowed top-level query operators for the structured query tool
const ALLOWED_OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex',
  '$all', '$elemMatch', '$size', '$mod',
]);

function sanitizeFilter(filter: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error('Filter too deeply nested');
  if (Array.isArray(filter)) return filter.map(v => sanitizeFilter(v, depth + 1));
  if (filter !== null && typeof filter === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(filter as Record<string, unknown>)) {
      if (key.startsWith('$') && !ALLOWED_OPERATORS.has(key)) {
        throw new Error(`Operator '${key}' is not allowed in queries`);
      }
      out[key] = sanitizeFilter(val, depth + 1);
    }
    return out;
  }
  return filter;
}

const ALLOWED_COLLECTIONS = new Set(['memories', 'entities', 'edges']);

/** Structured read-only query (operator whitelist enforced) */
export async function queryBrain(
  spaceId: string,
  collectionName: 'memories' | 'entities' | 'edges',
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
