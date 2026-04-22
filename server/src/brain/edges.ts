import { v4 as uuidv4 } from 'uuid';
import { col, mFilter, mDoc, mUpdate, mBulk } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getConfig } from '../config/loader.js';
import { applyDeleteFields } from './delete-fields.js';
import { getEntityById } from './entities.js';
import type { EdgeDoc, EntityDoc, TombstoneDoc } from '../config/types.js';

export interface TraverseNode {
  _id: string;
  name: string;
  type: string;
  depth: number;
}

export interface TraverseEdge {
  _id: string;
  from: string;
  to: string;
  label: string;
}

export interface TraverseResult {
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  truncated: boolean;
}

function authorRef() {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Resolve entity IDs to names for embedding. Falls back to the raw ID if the entity is not found. */
async function resolveEdgeEntityNames(spaceId: string, fromId: string, toId: string): Promise<[string, string]> {
  const [fromDoc, toDoc] = await Promise.all([
    getEntityById(spaceId, fromId),
    getEntityById(spaceId, toId),
  ]);
  return [fromDoc?.name ?? fromId, toDoc?.name ?? toId];
}

/** Derive the text to embed for an edge (tags + from + label + to + optional type + optional description). */
function edgeEmbedText(
  from: string,
  label: string,
  to: string,
  tags: string[] = [],
  type?: string,
  description?: string,
): string {
  const parts: string[] = [];
  if (tags.length > 0) parts.push(tags.join(' '));
  parts.push(from, label, to);
  if (type?.trim()) parts.push(type.trim());
  if (description?.trim()) parts.push(description.trim());
  return parts.join(' ');
}

/**
 * Upsert a directed edge (from → to with label).
 * One edge per (from, to, label) triplet.
 */
export async function upsertEdge(
  spaceId: string,
  from: string,
  to: string,
  label: string,
  weight?: number,
  type?: string,
  description?: string,
  properties?: Record<string, string | number | boolean>,
  tags?: string[],
): Promise<EdgeDoc> {
  const collection = col<EdgeDoc>(`${spaceId}_edges`);
  const existing = await collection.findOne(mFilter<EdgeDoc>({ spaceId, from, to, label }));

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  const effectiveDesc = description ?? (existing as EdgeDoc | null)?.description;
  const effectiveType = type ?? (existing as EdgeDoc | null)?.type;
  const effectiveTags = tags !== undefined
    ? Array.from(new Set([...((existing as EdgeDoc | null)?.tags ?? []), ...tags]))
    : ((existing as EdgeDoc | null)?.tags ?? []);

  // Embed the edge text (best-effort) — resolve entity names so the vector captures semantics
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const [fromName, toName] = await resolveEdgeEntityNames(spaceId, from, to);
    const embResult = await embed(edgeEmbedText(fromName, label, toName, effectiveTags, effectiveType, effectiveDesc));
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
  } catch { /* embedding unavailable — edge stored without vector */ }

  if (existing) {
    const $set: Record<string, unknown> = { updatedAt: now, seq, ...embeddingFields };
    if (weight !== undefined) $set['weight'] = weight;
    if (type !== undefined) $set['type'] = type;
    if (description !== undefined) $set['description'] = description;
    // When tags are provided, persist the merged result; otherwise leave existing tags unchanged
    if (tags !== undefined) $set['tags'] = effectiveTags;
    if (properties !== undefined) {
      const mergedProps = { ...((existing as EdgeDoc).properties ?? {}), ...properties };
      $set['properties'] = mergedProps;
    }
    await collection.updateOne(
      mFilter<EdgeDoc>({ _id: (existing as EdgeDoc)._id }),
      mUpdate<EdgeDoc>({ $set }),
    );
    return {
      ...(existing as EdgeDoc),
      seq,
      updatedAt: now,
      ...(weight !== undefined ? { weight } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags: effectiveTags } : {}),
      ...(properties !== undefined ? { properties: { ...((existing as EdgeDoc).properties ?? {}), ...properties } } : {}),
      ...embeddingFields,
    };
  }

  const doc: EdgeDoc = {
    _id: uuidv4(),
    spaceId,
    from,
    to,
    label,
    tags: tags ?? [],
    ...(type !== undefined ? { type } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(properties !== undefined ? { properties } : {}),
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    ...embeddingFields,
  };
  await collection.insertOne(mDoc<EdgeDoc>(doc));
  return doc;
}

/** List edges for a space, optionally filtering by from/to entity */
export async function listEdges(
  spaceId: string,
  filter: { from?: string; to?: string; label?: string } = {},
  limit = 50,
  skip = 0,
): Promise<EdgeDoc[]> {
  const q: Record<string, string> = { spaceId };
  if (filter.from) q['from'] = filter.from;
  if (filter.to) q['to'] = filter.to;
  if (filter.label) q['label'] = filter.label;
  return col<EdgeDoc>(`${spaceId}_edges`)
    .find(mFilter<EdgeDoc>(q))
    .sort({ seq: -1, createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .toArray() as Promise<EdgeDoc[]>;
}

/** Delete an edge by ID and write tombstone */
export async function deleteEdge(spaceId: string, edgeId: string): Promise<boolean> {
  const existing = await col<EdgeDoc>(`${spaceId}_edges`)
    .findOne(mFilter<EdgeDoc>({ _id: edgeId, spaceId }), { projection: { seq: 1 } }) as { seq?: number } | null;
  const seq = await nextSeq(spaceId);
  const result = await col<EdgeDoc>(`${spaceId}_edges`).deleteOne({
    _id: edgeId,
    spaceId,
  });
  if (result.deletedCount === 0) return false;

  const tombstone: TombstoneDoc = {
    _id: edgeId,
    type: 'edge',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
    ...(existing?.seq !== undefined ? { originalSeq: existing.seq } : {}),
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    mFilter<TombstoneDoc>({ _id: edgeId }),
    mDoc<TombstoneDoc>(tombstone),
    { upsert: true },
  );
  return true;
}

/** Find an edge by exact ID */
export async function getEdgeById(spaceId: string, id: string): Promise<EdgeDoc | null> {
  return col<EdgeDoc>(`${spaceId}_edges`).findOne(mFilter<EdgeDoc>({ _id: id, spaceId })) as Promise<EdgeDoc | null>;
}

/** Update an existing edge by ID. Partial update — only supplied fields are changed. Re-embeds when any content field changes. */
export async function updateEdgeById(
  spaceId: string,
  id: string,
  updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string },
  deleteFieldsPaths?: string[],
): Promise<EdgeDoc | null> {
  const collection = col<EdgeDoc>(`${spaceId}_edges`);
  const existing = await collection.findOne(mFilter<EdgeDoc>({ _id: id, spaceId })) as EdgeDoc | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };
  const $unset: Record<string, unknown> = {};

  const newLabel = updates.label ?? existing.label;
  let newDesc = updates.description !== undefined ? updates.description : existing.description;
  let newTags = updates.tags !== undefined
    ? Array.from(new Set([...(existing.tags ?? []), ...updates.tags]))
    : existing.tags ?? [];
  let newProps: Record<string, string | number | boolean> | undefined = updates.properties !== undefined
    ? { ...(existing.properties ?? {}), ...updates.properties }
    : existing.properties != null ? { ...existing.properties } : {};
  let newType = updates.type !== undefined ? updates.type : existing.type;
  let newWeight: number | undefined = updates.weight !== undefined ? updates.weight : existing.weight;

  // Apply deleteFields after merge
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    const merged: Record<string, unknown> = {
      description: newDesc,
      tags: newTags,
      properties: newProps,
      weight: newWeight,
    };
    applyDeleteFields(merged, deleteFieldsPaths);

    if (!('description' in merged)) {
      newDesc = undefined;
      $unset['description'] = '';
    } else {
      newDesc = merged['description'] as string | undefined;
    }
    if (!('tags' in merged)) {
      newTags = [];
      $unset['tags'] = '';
    } else {
      newTags = merged['tags'] as string[];
    }
    if (!('properties' in merged)) {
      newProps = undefined;
      $unset['properties'] = '';
    } else {
      newProps = merged['properties'] as Record<string, string | number | boolean>;
    }
    if (!('weight' in merged)) {
      newWeight = undefined;
      $unset['weight'] = '';
    } else {
      newWeight = merged['weight'] as number;
    }
  }

  if (updates.label !== undefined) $set['label'] = newLabel;
  if (updates.description !== undefined || (deleteFieldsPaths && !$unset['description'])) $set['description'] = newDesc;
  if (updates.tags !== undefined || (deleteFieldsPaths && !$unset['tags'])) $set['tags'] = newTags;
  if (updates.properties !== undefined || (deleteFieldsPaths && !$unset['properties'])) $set['properties'] = newProps;
  if (updates.type !== undefined) $set['type'] = newType;
  if (updates.weight !== undefined || (deleteFieldsPaths && !$unset['weight'])) $set['weight'] = newWeight;

  // Re-embed whenever any content field changes — resolve entity names for semantic signal
  try {
    const [fromName, toName] = await resolveEdgeEntityNames(spaceId, existing.from, existing.to);
    const embResult = await embed(edgeEmbedText(fromName, newLabel, toName, newTags, newType, newDesc));
    $set['embedding'] = embResult.vector;
    $set['embeddingModel'] = embResult.model;
  } catch { /* embedding unavailable — keep existing embedding */ }

  const updateOp: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) updateOp['$unset'] = $unset;
  await collection.updateOne(mFilter<EdgeDoc>({ _id: id }), mUpdate<EdgeDoc>(updateOp));

  const result = {
    ...existing,
    label: newLabel,
    tags: newTags,
    updatedAt: now,
    seq,
    ...(updates.description !== undefined ? { description: newDesc } : {}),
    ...(updates.properties !== undefined || (deleteFieldsPaths && !$unset['properties']) ? { properties: newProps } : {}),
    ...(updates.type !== undefined ? { type: newType } : {}),
    ...(updates.weight !== undefined ? { weight: newWeight } : {}),
    ...('embedding' in $set ? { embedding: $set['embedding'] as number[], embeddingModel: $set['embeddingModel'] as string } : {}),
  } as EdgeDoc;

  // Apply deleteFields to the returned doc for consistency
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    applyDeleteFields(result as unknown as Record<string, unknown>, deleteFieldsPaths);
  }

  return result;
}

/** Bulk-delete all edges in a space, writing a tombstone per deleted doc. */
export async function bulkDeleteEdges(spaceId: string): Promise<number> {
  const coll = col<EdgeDoc>(`${spaceId}_edges`);
  const ids = await coll.find({}, { projection: { _id: 1 } }).toArray();
  if (ids.length === 0) return 0;

  const now = new Date().toISOString();
  const instanceId = getConfig().instanceId;
  const tombstones: TombstoneDoc[] = [];

  for (const doc of ids) {
    const seq = await nextSeq(spaceId);
    tombstones.push({
      _id: doc._id,
      type: 'edge',
      spaceId,
      deletedAt: now,
      instanceId,
      seq,
    });
  }

  const ops = tombstones.map(t => ({
    replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true },
  }));
  await col<TombstoneDoc>(`${spaceId}_tombstones`).bulkWrite(mBulk<TombstoneDoc>(ops));
  await coll.deleteMany({});
  return ids.length;
}

/**
 * BFS graph traversal from a starting entity.
 *
 * @param memberIds  Space IDs to search for edges and entities (supports proxy spaces).
 * @param startId    UUID of the starting entity.
 * @param direction  Follow edges from the node (outbound), to the node (inbound), or both.
 * @param edgeLabels If provided, only traverse edges with one of these labels.
 * @param maxDepth   Maximum hop count from startId (hard cap enforced by caller).
 * @param limit      Maximum total nodes to return.
 */
export async function traverseGraph(
  memberIds: string[],
  startId: string,
  direction: 'outbound' | 'inbound' | 'both' = 'outbound',
  edgeLabels?: string[],
  maxDepth = 3,
  limit = 100,
): Promise<TraverseResult> {
  const visited = new Set<string>([startId]);
  // frontier: nodes whose outgoing edges we need to explore at the current depth
  let frontier: string[] = [startId];
  let frontierSet = new Set<string>(frontier);
  let currentDepth = 0;
  const resultNodes: TraverseNode[] = [];
  const resultEdges: TraverseEdge[] = [];

  const labelFilter = edgeLabels && edgeLabels.length > 0
    ? { label: { $in: edgeLabels } }
    : {};

  while (frontier.length > 0 && currentDepth < maxDepth) {
    // Batch-fetch all edges for the current frontier across all member spaces
    const adjacentEdges: EdgeDoc[] = [];
    for (const mid of memberIds) {
      let q: Record<string, unknown>;
      if (direction === 'outbound') {
        q = { spaceId: mid, from: { $in: frontier }, ...labelFilter };
      } else if (direction === 'inbound') {
        q = { spaceId: mid, to: { $in: frontier }, ...labelFilter };
      } else {
        q = { spaceId: mid, $or: [{ from: { $in: frontier } }, { to: { $in: frontier } }], ...labelFilter };
      }
      const edges = await col<EdgeDoc>(`${mid}_edges`).find(mFilter<EdgeDoc>(q)).toArray() as EdgeDoc[];
      adjacentEdges.push(...edges);
    }

    // Collect new neighbor IDs (not yet visited) and their traversed edges
    const newNeighborIds: string[] = [];
    const edgesForNewNeighbors: EdgeDoc[] = [];
    for (const edge of adjacentEdges) {
      let neighborId: string;
      if (direction === 'outbound') {
        neighborId = edge.to;
      } else if (direction === 'inbound') {
        neighborId = edge.from;
      } else {
        // For 'both', skip if both ends are in the current frontier (same-level connection)
        if (frontierSet.has(edge.from) && frontierSet.has(edge.to)) continue;
        neighborId = frontierSet.has(edge.from) ? edge.to : edge.from;
      }
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      newNeighborIds.push(neighborId);
      edgesForNewNeighbors.push(edge);
    }

    if (newNeighborIds.length === 0) break;

    // Batch-fetch entity docs for all new neighbors
    const entityMap = new Map<string, EntityDoc>();
    for (const mid of memberIds) {
      const entities = await col<EntityDoc>(`${mid}_entities`)
        .find(mFilter<EntityDoc>({ _id: { $in: newNeighborIds }, spaceId: mid }))
        .toArray() as EntityDoc[];
      for (const e of entities) entityMap.set(e._id, e);
    }

    // Build results for this depth level
    const nextFrontier: string[] = [];
    for (let i = 0; i < newNeighborIds.length; i++) {
      const neighborId = newNeighborIds[i];
      const entity = entityMap.get(neighborId);
      if (!entity) continue;

      const edge = edgesForNewNeighbors[i];
      resultEdges.push({ _id: edge._id, from: edge.from, to: edge.to, label: edge.label });
      resultNodes.push({ _id: entity._id, name: entity.name, type: entity.type, depth: currentDepth + 1 });

      if (resultNodes.length >= limit) {
        return { nodes: resultNodes, edges: resultEdges, truncated: true };
      }

      nextFrontier.push(neighborId);
    }

    frontier = nextFrontier;
    frontierSet = new Set<string>(frontier);
    currentDepth++;
  }

  return { nodes: resultNodes, edges: resultEdges, truncated: false };
}
