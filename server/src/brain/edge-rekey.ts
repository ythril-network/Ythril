/**
 * Moving an edge onto the id its identity derives, when that identity has changed.
 *
 * ## Why this exists
 *
 * An edge's `_id` is `uuidv5` over `(from, to, label)`, so two peers creating the same relationship arrive at
 * the same id without talking and the sync collision becomes an idempotent no-op. Mongo's `_id` is immutable,
 * though, and two paths change what an edge IS: `merge.ts` relinks an endpoint, and `updateEdgeById` accepts
 * a new label. After either the stored id no longer equalled its derivation, so the next peer to create that
 * triplet derived the correct id, inserted, and hit the unique index — the exact defect the derivation
 * removes, surviving on the two paths that matter most.
 *
 * ## Why delete-and-insert is safe here
 *
 * The old id and the new id are different documents, so the delete and the insert never touch the same row.
 * What matters is the seq:
 *
 * - The **tombstone** propagates through `/api/sync/tombstones`, which applies no `originalSeq` filter. That
 *   filter belongs to the tombstone STUBS appended to the docs stream and is a dedup for that stream, not the
 *   delete channel — so a peer learns of the delete whatever its cursor.
 * - The **insert** takes its seq AFTER the tombstone's. A peer that pulls the tombstone and stops has advanced
 *   its cursor past the delete; with the insert above that cursor it picks the edge up on the next pull, and
 *   the window is a sync cycle. Below it, the peer would keep only the delete — the one ordering that loses
 *   the edge, and the reason both seqs are taken explicitly here rather than reused.
 *
 * A peer applying the incoming edge skips it when `tombstone.seq >= incoming.seq`. A fresh seq is always above
 * any tombstone, so an edge later re-keyed BACK onto a previous id is re-created rather than suppressed by the
 * tombstone the first re-key left behind.
 *
 * **`renameFileMeta` is not the model, despite being named as one.** It deletes and re-inserts with no
 * tombstone and no new seq, on the stated grounds that file meta is best-effort and disk is the source of
 * truth. Copying it would leave every peer holding the edge under its old id for ever, beside the new one.
 *
 * ## Its own module rather than a function in `edges.ts`
 *
 * Two reasons, and the second is the load-bearing one. `edges.ts` was at its 650-line ceiling. And `merge.ts`
 * is the other caller — importing it from `edges.ts` would put the two biggest brain modules in a runtime
 * dependency for the sake of one function, where a leaf both can reach costs nothing.
 */
import { col, asFilter, asDoc } from '../db/mongo.js';
import type { ClientSession } from 'mongodb';
import { nextSeq } from '../util/seq.js';
import { getConfig } from '../config/loader.js';
import { edgeIdFor } from './edge-id.js';
import { withoutVector } from './read-projection.js';
import type { EdgeDoc, TombstoneDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

/**
 * The result of a re-key. `null` where the identity did not change, so a caller can fall through to its
 * ordinary update instead of branching on a boolean it has to interpret.
 */
export interface EdgeRekey {
  /** The document as it is now stored, WITHOUT its vector — see the strip in `rekeyEdge`. */
  edge: EdgeDoc;
  /** The id it used to be under, which now has a tombstone. */
  previousId: string;
}

/**
 * The embed-queue work a re-key leaves for its caller: retire `previousId`, enqueue `edge._id`.
 *
 * ## Why the caller does it and not `rekeyEdge`
 *
 * `enqueueEmbedJob` and `retireEmbedJob` take no session, so inside `merge.ts`'s `withTransaction` they
 * commit immediately while the edge itself is still uncommitted — and `enqueueEmbedJob` then calls
 * `markSpaceMayHaveWork`, which wakes the worker synchronously. The merge transaction continues through
 * fact, chrono and file relinking and an `await embed(...)` round trip before it commits, so the woken
 * worker has ample time to claim the job, fail to see the insert, report `gone`, and have that treated as
 * success — deleting the job. The transaction then commits an edge with no vector and no job, and nothing
 * re-enqueues it.
 *
 * Retiring inside the transaction is wrong in the mirror direction: an abort would roll the delete back and
 * leave the surviving edge with its job already removed.
 *
 * So the queue is touched AFTER the write is durable, by whoever knows when that is. `updateEdgeById` has no
 * transaction and can do it immediately; `merge.ts` does it once `withTransaction` has returned.
 */
export function embedQueueWorkFor(rekey: EdgeRekey): { retire: string; enqueue: string } {
  return { retire: rekey.previousId, enqueue: rekey.edge._id };
}

/**
 * Thrown when the identity an edge is being moved onto is already taken by another edge.
 *
 * A raw `E11000` from the driver reaches the caller as a five-line Mongo error naming an index, which says
 * nothing about what they did. `merge.ts` already resolves this case upstream — `detectDuplicateEdges` finds
 * the absorbed edges whose post-relink triplet a survivor already holds and deletes them rather than
 * relinking — so this is the guard for the case upstream missed, and it should say which edge is in the way.
 */
export class EdgeIdentityTaken extends Error {
  constructor(readonly existingId: string, from: string, to: string, label: string) {
    super(`an edge already connects ${from} -[${label}]-> ${to} (${existingId})`);
    this.name = 'EdgeIdentityTaken';
  }
}

/**
 * Move an edge onto the id `(from, to, label)` derives, when that is not the id it is already under.
 *
 * @param next     the identity to move onto. Fields it omits keep their stored value.
 * @param alsoSet   extra fields to write onto the re-inserted document, as the caller's own update would have.
 * @param alsoUnset fields the caller's update REMOVES — its `$unset` keys. Not optional in spirit, only in
 *                  signature: a re-key builds the new document from the stored one, so a removal it is not
 *                  told about is spread straight back in, and the caller is handed a response with the field
 *                  deleted while the row keeps it. It carries more than `deleteFields` — `_expireAt` for a
 *                  `ttlDays: null`, and the pre-3.1 suppression key — and the TTL case is the one that loses
 *                  data: the owner is told with a 200 that the edge no longer expires, and the sweep removes
 *                  it on the original schedule.
 * @returns `null` when the derived id is the one already stored — the caller does its ordinary update.
 */
export async function rekeyEdge(
  spaceId: string,
  existing: EdgeDoc,
  next: { from?: string; to?: string; label?: string },
  alsoSet: Record<string, unknown> = {},
  alsoUnset: readonly string[] = [],
  session?: ClientSession,
): Promise<EdgeRekey | null> {
  const from = next.from ?? existing.from;
  const to = next.to ?? existing.to;
  const label = next.label ?? existing.label;
  // The kinds come from the STORED edge: a rekey moves an endpoint or renames a label, and neither changes
  // what kind of record an endpoint is. Omitting them here would derive the pre-M-3 id and rekey every
  // widened edge onto a collision.
  const newId = edgeIdFor(from, to, label, existing.fromKind, existing.toKind);
  // The common case by far is an ordinary field patch. Delete-and-inserting one would write a tombstone and
  // briefly remove the edge from every peer for a description edit.
  if (newId === existing._id) return null;

  /*
   * ── ONLY THE AUTHOR MAY MOVE IT ───────────────────────────────────────────────────────────────────────
   *
   * `applyRemoteTombstone` deletes the underlying document **only if it was authored by the instance that
   * issued the tombstone**. That guard exists so a remote tombstone cannot delete locally-authored content,
   * it is what protects a pubsub subscriber's own data, and it returns silently.
   *
   * Edges replicate carrying their ORIGINAL author, so a tombstone this instance issues for an edge a peer
   * authored is dropped by that peer — while the insert half propagates normally, because the edges pull has
   * no author filter and the docs stream's tombstone stubs are skipped by the sync engine. The peer would
   * keep the old row AND gain the new one: two rows for one relationship, and the old one still asserting a
   * relationship that no longer exists. That is worse than the limit this function removes.
   *
   * Issuing the tombstone under `existing.author.instanceId` instead does not work either: it clears this
   * guard and then fails the check below it, which requires the DELIVERING peer to be the issuer — a
   * tombstone relayed on behalf of another author is refused and logged as cross-instance delete forgery.
   *
   * So an edge authored elsewhere is not moved. The caller falls through to its ordinary in-place update,
   * which is what happened before this function existed and which converges — the edge simply keeps an id
   * its identity no longer derives, exactly the documented limit, now narrowed to edges we did not write.
   *
   * Lifting it needs a delete a peer can apply without authorship: a tombstone that names its successor and
   * is applied as a MOVE. That is a change to a sync contract two other parties consume, and it is not
   * smuggled in behind a bug fix.
   */
  const author = existing.author?.instanceId;
  if (author !== undefined && author !== getConfig().instanceId) return null;

  const coll = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));
  // BEFORE anything is written. After the delete, a refused move would have destroyed the edge it declined
  // to relocate.
  const taken = await coll.findOne(asFilter<EdgeDoc>({ _id: newId }), { projection: { _id: 1 }, session });
  if (taken) throw new EdgeIdentityTaken(newId, from, to, label);

  const now = new Date().toISOString();
  // Taken in THIS ORDER — see the docblock. Reversing them is the one ordering that loses the edge on a peer.
  const tombSeq = await nextSeq(spaceId);
  const insertSeq = await nextSeq(spaceId);

  await coll.deleteOne(asFilter<EdgeDoc>({ _id: existing._id }), { session });
  await col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones')).replaceOne(
    asFilter<TombstoneDoc>({ _id: existing._id }),
    asDoc<TombstoneDoc>({
      _id: existing._id, type: 'edge', spaceId, deletedAt: now,
      instanceId: getConfig().instanceId, seq: tombSeq,
      ...(existing.seq !== undefined ? { originalSeq: existing.seq } : {}),
    }),
    { upsert: true, session },
  );

  // The stored document carried forward, not rebuilt: `createdAt`, `author`, `tags`, `description` and
  // `properties` describe the relationship, and the relationship did not change — only which entities it
  // connects, or what it is called. Rebuilding would reset an edge's provenance on every entity merge.
  const stored = { ...existing, ...alsoSet, _id: newId, from, to, label, updatedAt: now, seq: insertSeq } as EdgeDoc;
  // BEFORE the write, never on the copy that is returned. Removing them from the response alone is what made
  // a GET immediately contradict the 200 that created the row.
  for (const key of alsoUnset) delete (stored as unknown as Record<string, unknown>)[key];
  await coll.insertOne(asDoc<EdgeDoc>(stored), { session });

  /*
   * INSERTED with its vector, RETURNED without one.
   *
   * The stored document must keep the embedding — dropping it would blank the vector on every entity merge
   * and take the edge out of recall until the queue caught up. But `merge.ts` reads its edges unprojected, so
   * the document reaching here can carry a 768-float array, and `updateEdgeById` sends what this returns
   * straight back as its 200. `upsertEdge` leaked exactly this way, measured against the live stack, and the
   * fix was the same shape: strip at the return, not at the write.
   */
  return { edge: withoutVector(stored), previousId: existing._id };
}
