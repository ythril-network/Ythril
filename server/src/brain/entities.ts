import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { embed } from './embedding.js';
import { getConfig } from '../config/loader.js';
import type { EntityDoc, TombstoneDoc } from '../config/types.js';

function authorRef() {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Derive the text to embed for an entity (name + type + tags + description + properties). */
function entityEmbedText(
  name: string,
  type: string,
  tags: string[] = [],
  description?: string,
  properties: Record<string, string | number | boolean> = {},
): string {
  const parts: string[] = [name, type];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  const propEntries = Object.entries(properties);
  if (propEntries.length > 0) {
    parts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
  }
  return parts.join(' ');
}

/**
 * Upsert an entity by (name + type). If it exists, updates tags, properties, and seq.
 * Returns the upserted document.
 */
export async function upsertEntity(
  spaceId: string,
  name: string,
  type: string,
  tags: string[] = [],
  properties: Record<string, string | number | boolean> = {},
  description?: string,
): Promise<EntityDoc> {
  const collection = col<EntityDoc>(`${spaceId}_entities`);
  const existing = await collection.findOne({ spaceId, name, type } as never);

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  // Embed the entity text (best-effort — if embedding fails we still store the entity)
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const mergedTags = existing ? Array.from(new Set([...((existing as EntityDoc).tags ?? []), ...tags])) : tags;
    const mergedProps = existing ? { ...((existing as EntityDoc).properties ?? {}), ...properties } : properties;
    const effectiveDesc = description ?? (existing as EntityDoc | null)?.description;
    const embResult = await embed(entityEmbedText(name, type, mergedTags, effectiveDesc, mergedProps));
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
  } catch { /* embedding unavailable — entity stored without vector */ }

  if (existing) {
    const updatedTags = Array.from(new Set([...((existing as EntityDoc).tags ?? []), ...tags]));
    const mergedProps = { ...((existing as EntityDoc).properties ?? {}), ...properties };
    const $set: Record<string, unknown> = { tags: updatedTags, properties: mergedProps, updatedAt: now, seq, ...embeddingFields };
    if (description !== undefined) $set['description'] = description;
    await collection.updateOne(
      { _id: (existing as EntityDoc)._id } as never,
      { $set } as never,
    );
    return { ...(existing as EntityDoc), tags: updatedTags, properties: mergedProps, updatedAt: now, seq, ...embeddingFields, ...(description !== undefined ? { description } : {}) };
  }

  const doc: EntityDoc = {
    _id: uuidv4(),
    spaceId,
    name,
    type,
    tags,
    properties,
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
    ...embeddingFields,
  };
  if (description !== undefined) doc.description = description;
  await collection.insertOne(doc as never);
  return doc;
}

/** Find an entity by exact ID */
export async function getEntityById(spaceId: string, id: string): Promise<EntityDoc | null> {
  return col<EntityDoc>(`${spaceId}_entities`).findOne({ _id: id, spaceId } as never) as Promise<EntityDoc | null>;
}

/** Update an existing entity by ID. Partial update — only supplied fields are changed. Re-embeds when any content field changes. */
export async function updateEntityById(
  spaceId: string,
  id: string,
  updates: { name?: string; type?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean> },
): Promise<EntityDoc | null> {
  const collection = col<EntityDoc>(`${spaceId}_entities`);
  const existing = await collection.findOne({ _id: id, spaceId } as never) as EntityDoc | null;
  if (!existing) return null;

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now, seq };

  const newName = updates.name ?? existing.name;
  const newType = updates.type ?? existing.type;
  const newDesc = updates.description !== undefined ? updates.description : existing.description;
  const newTags = updates.tags !== undefined
    ? Array.from(new Set([...(existing.tags ?? []), ...updates.tags]))
    : existing.tags ?? [];
  const newProps = updates.properties !== undefined
    ? { ...(existing.properties ?? {}), ...updates.properties }
    : existing.properties ?? {};

  if (updates.name !== undefined) $set['name'] = newName;
  if (updates.type !== undefined) $set['type'] = newType;
  if (updates.description !== undefined) $set['description'] = newDesc;
  if (updates.tags !== undefined) $set['tags'] = newTags;
  if (updates.properties !== undefined) $set['properties'] = newProps;

  // Re-embed whenever any content field changes
  try {
    const embResult = await embed(entityEmbedText(newName, newType, newTags, newDesc, newProps));
    $set['embedding'] = embResult.vector;
    $set['embeddingModel'] = embResult.model;
  } catch { /* embedding unavailable — keep existing embedding */ }

  await collection.updateOne({ _id: id } as never, { $set } as never);
  return {
    ...existing,
    name: newName,
    type: newType,
    tags: newTags,
    properties: newProps,
    updatedAt: now,
    seq,
    ...(updates.description !== undefined ? { description: newDesc } : {}),
    ...('embedding' in $set ? { embedding: $set['embedding'] as number[], embeddingModel: $set['embeddingModel'] as string } : {}),
  } as EntityDoc;
}

/** List entities with optional filter */
export async function listEntities(
  spaceId: string,
  filter: Record<string, unknown> = {},
  limit = 50,
  skip = 0,
): Promise<EntityDoc[]> {
  return col<EntityDoc>(`${spaceId}_entities`)
    .find({ ...filter, spaceId } as never)
    .skip(skip)
    .limit(limit)
    .toArray() as Promise<EntityDoc[]>;
}

/** Delete an entity and write tombstone */
export async function deleteEntity(
  spaceId: string,
  entityId: string,
): Promise<boolean> {
  const seq = await nextSeq(spaceId);
  const result = await col<EntityDoc>(`${spaceId}_entities`).deleteOne({
    _id: entityId,
    spaceId,
  } as never);
  if (result.deletedCount === 0) return false;

  const tombstone: TombstoneDoc = {
    _id: entityId,
    type: 'entity',
    spaceId,
    deletedAt: new Date().toISOString(),
    instanceId: getConfig().instanceId,
    seq,
  };
  await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
    { _id: entityId } as never,
    tombstone as never,
    { upsert: true },
  );
  return true;
}

/** Bulk-delete all entities in a space, writing a tombstone per deleted doc. */
export async function bulkDeleteEntities(spaceId: string): Promise<number> {
  const coll = col<EntityDoc>(`${spaceId}_entities`);
  const ids = await coll.find({}, { projection: { _id: 1 } }).toArray();
  if (ids.length === 0) return 0;

  const now = new Date().toISOString();
  const instanceId = getConfig().instanceId;
  const tombstones: TombstoneDoc[] = [];

  for (const doc of ids) {
    const seq = await nextSeq(spaceId);
    tombstones.push({
      _id: doc._id,
      type: 'entity',
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
