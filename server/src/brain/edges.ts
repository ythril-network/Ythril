import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getConfig } from '../config/loader.js';
import type { EdgeDoc, TombstoneDoc } from '../config/types.js';

function authorRef() {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
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
  const existing = await collection.findOne({ spaceId, from, to, label } as never);

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  const effectiveDesc = description ?? (existing as EdgeDoc | null)?.description;
  const effectiveType = type ?? (existing as EdgeDoc | null)?.type;
  const effectiveTags = tags !== undefined
    ? Array.from(new Set([...((existing as EdgeDoc | null)?.tags ?? []), ...tags]))
    : ((existing as EdgeDoc | null)?.tags ?? []);

  // Embed the edge text (best-effort)
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const embResult = await embed(edgeEmbedText(from, label, to, effectiveTags, effectiveType, effectiveDesc));
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
      { _id: (existing as EdgeDoc)._id } as never,
      { $set } as never,
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
  await collection.insertOne(doc as never);
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
    .find(q as never)
    .skip(skip)
    .limit(limit)
    .toArray() as Promise<EdgeDoc[]>;
}

/** Delete an edge by ID and write tombstone */
export async function deleteEdge(spaceId: string, edgeId: string): Promise<boolean> {
  const seq = await nextSeq(spaceId);
  const result = await col<EdgeDoc>(`${spaceId}_edges`).deleteOne({
    _id: edgeId,
    spaceId,
  } as never);
  if (result.deletedCount === 0) return false;

  const tombstone: TombstoneDoc = {
    _id: edgeId,
    type: 'edge',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    { _id: edgeId } as never,
    tombstone as never,
    { upsert: true },
  );
  return true;
}

/** Find an edge by exact ID */
export async function getEdgeById(spaceId: string, id: string): Promise<EdgeDoc | null> {
  return col<EdgeDoc>(`${spaceId}_edges`).findOne({ _id: id, spaceId } as never) as Promise<EdgeDoc | null>;
}

/** Update an existing edge by ID. Partial update — only supplied fields are changed. Re-embeds when any content field changes. */
export async function updateEdgeById(
  spaceId: string,
  id: string,
  updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string },
): Promise<EdgeDoc | null> {
  const collection = col<EdgeDoc>(`${spaceId}_edges`);
  const existing = await collection.findOne({ _id: id, spaceId } as never) as EdgeDoc | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };

  const newLabel = updates.label ?? existing.label;
  const newDesc = updates.description !== undefined ? updates.description : existing.description;
  const newTags = updates.tags !== undefined
    ? Array.from(new Set([...(existing.tags ?? []), ...updates.tags]))
    : existing.tags ?? [];
  const newProps = updates.properties !== undefined
    ? { ...(existing.properties ?? {}), ...updates.properties }
    : existing.properties;
  const newType = updates.type !== undefined ? updates.type : existing.type;
  const newWeight = updates.weight !== undefined ? updates.weight : existing.weight;

  if (updates.label !== undefined) $set['label'] = newLabel;
  if (updates.description !== undefined) $set['description'] = newDesc;
  if (updates.tags !== undefined) $set['tags'] = newTags;
  if (updates.properties !== undefined) $set['properties'] = newProps;
  if (updates.type !== undefined) $set['type'] = newType;
  if (updates.weight !== undefined) $set['weight'] = newWeight;

  // Re-embed whenever any content field changes
  try {
    const embResult = await embed(edgeEmbedText(existing.from, newLabel, existing.to, newTags, newType, newDesc));
    $set['embedding'] = embResult.vector;
    $set['embeddingModel'] = embResult.model;
  } catch { /* embedding unavailable — keep existing embedding */ }

  await collection.updateOne({ _id: id } as never, { $set } as never);
  return {
    ...existing,
    label: newLabel,
    tags: newTags,
    updatedAt: now,
    seq,
    ...(updates.description !== undefined ? { description: newDesc } : {}),
    ...(updates.properties !== undefined ? { properties: newProps } : {}),
    ...(updates.type !== undefined ? { type: newType } : {}),
    ...(updates.weight !== undefined ? { weight: newWeight } : {}),
    ...('embedding' in $set ? { embedding: $set['embedding'] as number[], embeddingModel: $set['embeddingModel'] as string } : {}),
  } as EdgeDoc;
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
  await col<TombstoneDoc>(`${spaceId}_tombstones`).bulkWrite(ops as never);
  await coll.deleteMany({});
  return ids.length;
}
