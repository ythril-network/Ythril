import { col, asBulk } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { reserveSeqBlock } from '../util/seq.js';
import type { TombstoneDoc } from '../config/types.js';

/**
 * Wiping every record of one type in a space, tombstone per document.
 *
 * ## Why this is one function and was four
 *
 * `bulkDeleteEntities`, `bulkDeleteFacts`, `bulkDeleteEdges` and `bulkDeleteChrono` were the same thirty
 * lines with a different collection name and a different tombstone `type` (`R-4`). Four copies of one rule in
 * four of the largest files in the server is the defect class this repo produces most, and the subtle part —
 * the seq-block reservation below — is exactly the kind that gets optimised correctly in one copy and left
 * alone in three.
 *
 * ## A wipe is not a delete
 *
 * It is a delete **plus one tombstone per document**, because a peer holding those records has to be told they
 * are gone. A wipe that empties the collection and writes no tombstones is one the next sync cycle silently
 * UNDOES, record by record, from the peer's copy — and the operator sees the records reappear hours later with
 * nothing in any log to explain it.
 *
 * ## The seq block is reserved in ONE round trip, and that is a correctness edge as well as a speed one
 *
 * This used to call `nextSeq()` per document — one sequential awaited round trip each — so a 100k-document
 * wipe paid 100k of them before the delete even began. Gaps in the reserved range are harmless because sync
 * compares seqs with `>`; **reuse would not be**, which is why the block is taken up front and never rolled
 * back on failure. A rewrite to one seq per tombstone reads as simpler and is wrong at scale.
 *
 * ## The three things that legitimately differ, and none of them is a webhook
 *
 * Measured while writing `the-bulk-wipe-writes-a-tombstone-per-record-db.test.js`, because the tracker row had
 * this wrong: it said the four differed in webhook emission, and not one of them emits a webhook.
 *
 *  - **`afterDelete`** — the ENTITY wipe clears every face label in the space, wholesale rather than by id
 *    list. Its own reason: on a 100k-entity wipe an `$in` would build a 100k-element query for a filter that
 *    means "all of them". Dropping it leaves file-meta records pointing at entities that do not exist.
 *  - **`sort`** — the MEMORY wipe orders newest-first, so recently written records land near the front of the
 *    generated tombstone seq range even on a very large collection.
 *  - The projected fields differed and did not matter: only fact's sort key was ever read, so this projects
 *    `_id` alone.
 */
export interface WipeOptions {
  /**
   * How to order the documents before their tombstone seqs are handed out. Only facts use it.
   *
   * A sort of the ids, not of the delete: `deleteMany({})` takes the whole collection either way.
   *
   * Typed locally rather than as the driver's `Sort`, which is a wide union covering forms nothing here needs.
   * `brain/` imports exactly one type from `mongodb` (`ClientSession`) and this is not a reason to make it two.
   */
  sort?: Record<string, 1 | -1>;
  /**
   * Run after the collection is emptied and its tombstones are written.
   *
   * For a cascade the wipe owns — the entity wipe's face labels — rather than for anything a caller could do
   * itself afterwards. It runs only when something was actually deleted, which matches what the four copies
   * did: the early return on an empty collection came first.
   */
  afterDelete?: () => Promise<void>;
}

/**
 * Delete every record in `${spaceId}_${collection}`, writing a `type` tombstone for each.
 *
 * @returns how many records were deleted — 0 on an empty collection, with nothing written at all. That early
 *   return is not a formality: `reserveSeqBlock(spaceId, 0)` and an empty `bulkWrite` are both errors rather
 *   than no-ops.
 */
export async function wipeSpaceCollection(
  spaceId: string,
  collection: string,
  type: TombstoneDoc['type'],
  opts: WipeOptions = {},
): Promise<number> {
  const coll = col<{ _id: string }>(`${spaceId}_${collection}`);
  const cursor = coll.find({}, { projection: { _id: 1 } });
  if (opts.sort) cursor.sort(opts.sort);
  const ids = await cursor.toArray();
  if (ids.length === 0) return 0;

  const now = new Date().toISOString();
  const instanceId = getConfig().instanceId;

  // One reservation for the whole range — see the module docblock. Never one per document.
  const firstSeq = await reserveSeqBlock(spaceId, ids.length);
  let seqCursor = firstSeq;

  const tombstones: TombstoneDoc[] = ids.map(doc => ({
    _id: doc._id,
    type,
    spaceId,
    deletedAt: now,
    instanceId,
    seq: seqCursor++,
  }));

  await col<TombstoneDoc>(`${spaceId}_tombstones`).bulkWrite(asBulk<TombstoneDoc>(
    tombstones.map(t => ({ replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true } })),
  ));
  await coll.deleteMany({});
  if (opts.afterDelete) await opts.afterDelete();
  return ids.length;
}
