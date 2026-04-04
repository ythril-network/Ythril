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
): Promise<EdgeDoc> {
  const collection = col<EdgeDoc>(`${spaceId}_edges`);
  const existing = await collection.findOne({ spaceId, from, to, label } as never);

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  // Embed the edge label (best-effort)
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const embResult = await embed(label);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
  } catch { /* embedding unavailable — edge stored without vector */ }

  if (existing) {
    await collection.updateOne(
      { _id: (existing as EdgeDoc)._id } as never,
      { $set: { ...(weight !== undefined ? { weight } : {}), ...(type !== undefined ? { type } : {}), updatedAt: now, seq, ...embeddingFields } } as never,
    );
    return { ...(existing as EdgeDoc), seq, updatedAt: now, ...(weight !== undefined ? { weight } : {}), ...(type !== undefined ? { type } : {}), ...embeddingFields };
  }

  const doc: EdgeDoc = {
    _id: uuidv4(),
    spaceId,
    from,
    to,
    label,
    ...(type !== undefined ? { type } : {}),
    ...(weight !== undefined ? { weight } : {}),
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
