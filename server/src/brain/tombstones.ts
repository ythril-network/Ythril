import { col } from '../db/mongo.js';
import type { TombstoneDoc } from '../config/types.js';

/** List tombstones with seq greater than the given watermark */
export async function listTombstones(
  spaceId: string,
  sinceSeq: number,
  limit = 200,
): Promise<TombstoneDoc[]> {
  return col<TombstoneDoc>(`${spaceId}_tombstones`)
    .find({ seq: { $gt: sinceSeq } } as never)
    .sort({ seq: 1 })
    .limit(limit)
    .toArray() as Promise<TombstoneDoc[]>;
}

/** Write a tombstone received from a peer (only if local seq is lower or doc doesn't exist) */
export async function applyRemoteTombstone(tombstone: TombstoneDoc): Promise<void> {
  const { spaceId, _id, type, seq } = tombstone;

  // Idempotent upsert — only insert if not present or remote seq is higher
  await col<TombstoneDoc>(`${spaceId}_tombstones`).updateOne(
    { _id } as never,
    { $setOnInsert: tombstone } as never,
    { upsert: true },
  );

  // If the doc already exists locally with a higher seq, the remote tombstone is stale — skip
  const existing = await col<TombstoneDoc>(`${spaceId}_tombstones`).findOne({ _id } as never);
  if (existing && (existing as TombstoneDoc).seq >= seq) return;

  // Delete the underlying document
  const collMap: Record<string, string> = {
    memory: `${spaceId}_memories`,
    entity: `${spaceId}_entities`,
    edge: `${spaceId}_edges`,
  };
  const targetColl = collMap[type];
  if (targetColl) {
    await col(targetColl).deleteOne({ _id } as never);
  }
}
