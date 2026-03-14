import { v4 as uuidv4 } from 'uuid';
import { col } from '../db/mongo.js';
import { nextSeq } from '../util/seq.js';
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
): Promise<EdgeDoc> {
  const collection = col<EdgeDoc>(`${spaceId}_edges`);
  const existing = await collection.findOne({ spaceId, from, to, label } as never);

  const seq = await nextSeq(spaceId);
  const now = new Date().toISOString();

  if (existing) {
    await collection.updateOne(
      { _id: (existing as EdgeDoc)._id } as never,
      { $set: { ...(weight !== undefined ? { weight } : {}), seq } } as never,
    );
    return { ...(existing as EdgeDoc), seq, ...(weight !== undefined ? { weight } : {}) };
  }

  const doc: EdgeDoc = {
    _id: uuidv4(),
    spaceId,
    from,
    to,
    label,
    ...(weight !== undefined ? { weight } : {}),
    author: authorRef(),
    createdAt: now,
    seq,
  };
  await collection.insertOne(doc as never);
  return doc;
}

/** List edges for a space, optionally filtering by from/to entity */
export async function listEdges(
  spaceId: string,
  filter: { from?: string; to?: string; label?: string } = {},
  limit = 50,
): Promise<EdgeDoc[]> {
  const q: Record<string, string> = { spaceId };
  if (filter.from) q['from'] = filter.from;
  if (filter.to) q['to'] = filter.to;
  if (filter.label) q['label'] = filter.label;
  return col<EdgeDoc>(`${spaceId}_edges`)
    .find(q as never)
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
  await col<TombstoneDoc>(`${spaceId}_tombstones`).insertOne(tombstone as never);
  return true;
}
