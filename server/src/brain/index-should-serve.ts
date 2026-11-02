/**
 * Does this collection hold a record its vector index should be serving? (Q-326, Q-327; bundle-72)
 *
 * ## What it is for
 *
 * A vector index that answers nothing — absent, dropped, still being built, or refusing — says nothing about whether
 * the collection is empty. The reader that got the refusal or the empty window asks THIS, and only then: when no record
 * the index should serve exists, the empty answer is complete (a new collection, B1 and B2: a search straight after a
 * space's first write answers empty with no reason); when one exists, the answer may be missing it and must say so
 * (`index_not_ready` / `index_unavailable` on a recall, a deferred face on the gallery).
 *
 * ## The defect it prevents
 *
 * Every refusal read as "this collection holds nothing": a recall over an index being rebuilt answered a confident empty
 * list over thousands of records, and the gallery stored a labelled person's face unlabelled for good. The same read
 * was spelled once already, inside `predicate-recall.ts` `indexIsBehind`, for the ids a stage-2 batch did not return;
 * recall, predicate recall and the face gallery now ask this one copy.
 *
 * ## How it reads
 *
 * - An EXACT `findOne` with an `_id` projection, never `estimatedDocumentCount` (B11, `spaces/record-presence.ts`): the
 *   estimate is read from collection metadata and can say zero after an unclean shutdown, which is exactly when an
 *   index is being rebuilt and the answer matters.
 * - Only a record that CARRIES a vector at `vectorPath` counts: one not embedded yet is not the index's to serve.
 * - `maxAge` (recall): only a record older than the fresh-write window counts. A younger one is found by the recall's
 *   fresh-write scan, so a new collection's first seconds are not "degraded" (O1; `indexIsBehind` ruled the same way).
 *   A record with no `updatedAt` counts as aged, the safe side. Without it (the gallery, which has no fresh-write scan)
 *   any record counts, so a face labelled seconds ago is waited for.
 * - `ids` narrows to those records (stage 2's "is any of these missing"), `filter` to a predicate (labelled faces).
 * - Bounded by `maxTimeMS`; a timeout or any failure of the read answers `true`. The safe side: the answer is flagged
 *   "may be missing", or the face is deferred, rather than a confident empty answer read from a read that never ran.
 */
import { col } from '../db/mongo.js';
import { andPredicates } from '../db/and-predicates.js';
import { FRESH_WINDOW_MS } from './fresh-writes.js';

export interface IndexShouldServeOptions {
  /** Only these records (the ids a batch of the index did not return). */
  ids?: string[];
  /** Only records satisfying this predicate (the gallery: a labelled face). */
  filter?: Record<string, unknown>;
  /** Only records older than the fresh-write window — set by recall, whose fresh-write scan finds the younger ones. */
  maxAge?: boolean;
  /** The bound on the read. A timeout answers `true`. */
  maxTimeMS: number;
}

/** True when `collName` holds a record carrying a vector at `vectorPath` that its index should serve (or the read failed). */
export async function holdsRecordTheIndexShouldServe(
  collName: string,
  vectorPath: string,
  { ids, filter, maxAge, maxTimeMS }: IndexShouldServeOptions,
): Promise<boolean> {
  if (ids && ids.length === 0) return false;
  const cutoff = new Date(Date.now() - FRESH_WINDOW_MS).toISOString();
  try {
    const one = await col(collName).findOne(andPredicates(
      filter,
      ids ? { _id: { $in: ids } } : undefined,
      { [vectorPath]: { $type: 'array' }, ...(maxAge ? { updatedAt: { $not: { $gte: cutoff } } } : {}) },
    )!, { projection: { _id: 1 }, maxTimeMS });
    return one !== null;
  } catch {
    return true;
  }
}
