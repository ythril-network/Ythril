import { col } from '../db/mongo.js';
import type { SpaceCounterDoc } from '../config/types.js';

/**
 * Returns the next monotonic sequence number for a space.
 * Safe for concurrent callers — uses findOneAndUpdate with $inc.
 */
export async function nextSeq(spaceId: string): Promise<number> {
  const counters = col<SpaceCounterDoc>('ytrai_counters');
  const result = await counters.findOneAndUpdate(
    { _id: spaceId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!result) throw new Error(`Failed to increment sequence counter for space ${spaceId}`);
  return result.seq;
}
