import { col, mFilter, mDoc, mUpdate } from '../db/mongo.js';
import type { TombstoneDoc } from '../config/types.js';

/** List tombstones with seq greater than the given watermark */
export async function listTombstones(
  spaceId: string,
  sinceSeq: number,
  limit = 200,
  type?: TombstoneDoc['type'],
): Promise<TombstoneDoc[]> {
  const filter: Record<string, unknown> = { seq: { $gt: sinceSeq } };
  if (type) filter['type'] = type;
  return col<TombstoneDoc>(`${spaceId}_tombstones`)
    .find(mFilter<TombstoneDoc>(filter))
    .sort({ seq: 1 })
    .limit(limit)
    .toArray() as Promise<TombstoneDoc[]>;
}

/** Write a tombstone received from a peer (only if local seq is lower or doc doesn't exist) */
export async function applyRemoteTombstone(tombstone: TombstoneDoc): Promise<void> {
  const { spaceId, _id, type, seq } = tombstone;

  // Idempotent upsert — only insert if not present or remote seq is higher
  await col<TombstoneDoc>(`${spaceId}_tombstones`).updateOne(
    mFilter<TombstoneDoc>({ _id }),
    mUpdate<TombstoneDoc>({ $setOnInsert: tombstone }),
    { upsert: true },
  );

  // If the doc already exists locally with a strictly higher seq, the remote tombstone is stale — skip
  // Note: equal seq means we just inserted it above (or it already existed at same seq), so still apply.
  const existing = await col<TombstoneDoc>(`${spaceId}_tombstones`).findOne(mFilter<TombstoneDoc>({ _id }));
  if (existing && (existing as TombstoneDoc).seq > seq) return;

  // Delete the underlying document — but only if it was authored by the same
  // instance that issued the tombstone. This prevents a remote tombstone from
  // deleting locally-authored content (critical for pubsub subscribers who
  // may have their own data alongside publisher-pushed content).
  const collMap: Record<string, string> = {
    memory: `${spaceId}_memories`,
    entity: `${spaceId}_entities`,
    edge: `${spaceId}_edges`,
    chrono: `${spaceId}_chrono`,
  };
  const targetColl = collMap[type];
  if (targetColl) {
    const localDoc = await col(targetColl).findOne(mFilter({ _id })) as { author?: { instanceId?: string } } | null;
    // If the local doc has an author and it doesn't match the tombstone issuer, skip deletion.
    // Documents without author metadata (legacy) are deleted as before.
    if (localDoc?.author?.instanceId && tombstone.instanceId &&
        localDoc.author.instanceId !== tombstone.instanceId) {
      return;
    }
    await col(targetColl).deleteOne(mFilter({ _id }));
  }
}
