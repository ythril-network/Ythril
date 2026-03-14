import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
import { getConfig } from '../config/loader.js';
import type { EntityDoc, TombstoneDoc } from '../config/types.js';

function authorRef() {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/**
 * Upsert an entity by (name + type). If it exists, updates tags and seq.
 * Returns the upserted document.
 */
export async function upsertEntity(
  spaceId: string,
  name: string,
  type: string,
  tags: string[] = [],
): Promise<EntityDoc> {
  const collection = col<EntityDoc>(`${spaceId}_entities`);
  const existing = await collection.findOne({ spaceId, name, type } as never);

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  if (existing) {
    const updatedTags = Array.from(new Set([...((existing as EntityDoc).tags ?? []), ...tags]));
    await collection.updateOne(
      { _id: (existing as EntityDoc)._id } as never,
      { $set: { tags: updatedTags, updatedAt: now, seq } } as never,
    );
    return { ...(existing as EntityDoc), tags: updatedTags, updatedAt: now, seq };
  }

  const doc: EntityDoc = {
    _id: uuidv4(),
    spaceId,
    name,
    type,
    tags,
    author: authorRef(),
    createdAt: now,
    updatedAt: now,
    seq,
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
): Promise<EntityDoc[]> {
  return col<EntityDoc>(`${spaceId}_entities`)
    .find({ ...filter, spaceId } as never)
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
  await col<TombstoneDoc>(`${spaceId}_tombstones`).insertOne(tombstone as never);
  return true;
}
