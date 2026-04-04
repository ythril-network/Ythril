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

/** Derive the text to embed for an entity (name + type). */
function entityEmbedText(name: string, type: string): string {
  return `${name} ${type}`;
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
): Promise<EntityDoc> {
  const collection = col<EntityDoc>(`${spaceId}_entities`);
  const existing = await collection.findOne({ spaceId, name, type } as never);

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  // Embed the entity text (best-effort — if embedding fails we still store the entity)
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const embResult = await embed(entityEmbedText(name, type));
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
  } catch { /* embedding unavailable — entity stored without vector */ }

  if (existing) {
    const updatedTags = Array.from(new Set([...((existing as EntityDoc).tags ?? []), ...tags]));
    const mergedProps = { ...((existing as EntityDoc).properties ?? {}), ...properties };
    await collection.updateOne(
      { _id: (existing as EntityDoc)._id } as never,
      { $set: { tags: updatedTags, properties: mergedProps, updatedAt: now, seq, ...embeddingFields } } as never,
    );
    return { ...(existing as EntityDoc), tags: updatedTags, properties: mergedProps, updatedAt: now, seq, ...embeddingFields };
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
  await collection.insertOne(doc as never);
  return doc;
}

/** Find an entity by exact ID */
export async function getEntityById(spaceId: string, id: string): Promise<EntityDoc | null> {
  return col<EntityDoc>(`${spaceId}_entities`).findOne({ _id: id, spaceId } as never) as Promise<EntityDoc | null>;
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
