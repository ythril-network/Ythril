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
import { col, asDoc } from '../db/mongo.js';
import type { ClientSession } from 'mongodb';
import { withAllocatedSeqs } from '../util/seq.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { readStoredById } from '../db/read-by-id.js';
import { getConfig } from '../config/loader.js';
import { edgeIdFor } from './edge-id.js';
import { withoutVector } from './read-projection.js';
import type { EdgeDoc } from '../config/types.js';
import { removeWithTombstones } from './tombstones.js';
import { spaceCollection } from '../db/space-collection.js';
import { rekeyedRow, FUNCTIONAL_GUARD } from '../sync/local-only-fields.js';

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
 * Move an edge onto the id `(from, to, label)` derives, when that is not the id it is already under — one move
 * through `rekeyEdges`, which is the one implementation (see its docblock for the rules).
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
 * @param functionalGuard the write guard the moved row is stamped with — the value `guardFor` computed for its NEW subject
 *                   (`brain/write-plan/plan-edge.ts`), which this never derives: the key and the condition for having one live in
 *                   that one function. `undefined`: the row carries no guard (the old one is dropped whatever the caller says).
 *                   A caller that passes one moves a single edge, by label.
 * @returns `null` when the derived id is the one already stored — the caller does its ordinary update.
 */
export async function rekeyEdge(
  spaceId: string,
  existing: EdgeDoc,
  next: { from?: string; to?: string; label?: string },
  alsoSet: Record<string, unknown> = {},
  alsoUnset: readonly string[] = [],
  session?: ClientSession,
  functionalGuard?: string,
): Promise<EdgeRekey | null> {
  const [moved] = await rekeyEdges(spaceId, [{ existing, next }], alsoSet, alsoUnset, session, functionalGuard);
  return moved ?? null;
}

/** One edge a `rekeyEdges` call is asked to move: the stored document, and the identity to move it onto. */
export interface EdgeMove {
  existing: EdgeDoc;
  next: { from?: string; to?: string; label?: string };
}


/**
 * Move many edges onto the ids their identities derive — THE re-key, for one edge (`rekeyEdge`) or a merge's
 * thousands (`Q-107` part 3a). Each move is decided exactly as one is, and the writes are one command per chunk:
 * a delete, the tombstones, the inserts.
 *
 * Every caller runs this inside a transaction under the horizon hold (`inHeldTransaction`), because the seq
 * block's release here precedes the commit.
 *
 * @returns one entry per move, in order: the re-key, or `null` where the edge stays under its id — the derived id
 *          is the one it already has, or a PEER authored it (see below). The caller writes those in place.
 */
export async function rekeyEdges(
  spaceId: string,
  moves: readonly EdgeMove[],
  alsoSet: Record<string, unknown> = {},
  alsoUnset: readonly string[] = [],
  session?: ClientSession,
  functionalGuard?: string,
): Promise<Array<EdgeRekey | null>> {
  const instanceId = getConfig().instanceId;
  const planned = moves.map(({ existing, next }) => {
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
     * ── ONLY THE AUTHOR MAY MOVE IT ─────────────────────────────────────────────────────────────────────
     *
     * A peer applies a tombstone only when `authorises` (`sync/deletion-authority.ts`) says so: the delivering peer
     * proved it issued the tombstone AND wrote the document, or — on a pub/sub or tree network — the delivering peer
     * is the receiver's direct UPSTREAM and delivered the document itself. A re-key issues the tombstone as THIS
     * instance, and a receiver that is not downstream of it (a mesh peer, the upstream of this instance) holds
     * nothing it delivered, so only an edge THIS instance authored is one every receiver will delete. The decision
     * is spelled here rather than asked of the module because it is the SENDING side's question — which of its
     * own rows are safe to move — and it is stricter than `tombstoneGoverns` on purpose: an edge with an EMPTY
     * author is the issuer's to delete as far as a receiver is concerned, and is still not moved here.
     *
     * Edges replicate carrying their ORIGINAL author, so a tombstone this instance issues for an edge a peer
     * authored is dropped by that peer — while the insert half propagates normally, because the edges pull has
     * no author filter and the docs stream's tombstone stubs are skipped by the sync engine. The peer would
     * keep the old row AND gain the new one: two rows for one relationship, and the old one still asserting a
     * relationship that no longer exists. That is worse than the limit this function removes.
     *
     * Issuing the tombstone under `existing.author.instanceId` instead does not work either: it clears the
     * author check and then fails the issuer proof, which requires the DELIVERING peer to be the issuer — a
     * tombstone relayed on behalf of another author is declined and logged as cross-instance delete forgery.
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
    if (author !== undefined && author !== instanceId) return null;
    return { existing, from, to, label, newId };
  });
  const moving = planned.filter((m): m is NonNullable<typeof m> => m !== null);
  if (moving.length === 0) return planned.map(() => null);

  const collName = spaceCollection(spaceId, 'edges');
  const coll = col<EdgeDoc>(collName);
  // BEFORE anything is written. After the delete, a refused move would have destroyed the edge it declined to
  // relocate. Two moves onto ONE id are the same refusal: the second insert would hit the unique index.
  const taken = await readStoredById<{ _id: string }>(collName, moving.map(m => m.newId), { _id: 1 }, session ? { session } : {});
  const claimed = new Set<string>();
  for (const m of moving) {
    if (taken.has(m.newId) || claimed.has(m.newId)) throw new EdgeIdentityTaken(m.newId, m.from, m.to, m.label);
    claimed.add(m.newId);
  }

  const now = new Date().toISOString();
  const n = moving.length;
  // One block of 2n, taken in THIS ORDER — see the module docblock. Every tombstone gets a seq below every
  // insert; reversing them is the one ordering that loses an edge on a peer.
  const written = await withAllocatedSeqs(spaceId, 2 * n, async (tombSeq) => {
    const insertSeq = tombSeq + n;
    const opts = session ? { session } : {};

    // The old rows go, their tombstones at `tombSeq…` — the block's lower half (`removeWithTombstones`).
    await removeWithTombstones(spaceId, 'edges',
      moving.map(m => ({ _id: m.existing._id, type: 'edge' as const, deletedAt: now, originalSeq: m.existing.seq })),
      { session, firstSeq: tombSeq });

    // The stored document carried forward, not rebuilt: `createdAt`, `author`, `tags`, `description` and
    // `properties` describe the relationship, and the relationship did not change — only which entities it
    // connects, or what it is called. Rebuilding would reset an edge's provenance on every entity merge.
    const stored = moving.map(({ existing, newId, from, to, label }, i) => {
      // `rekeyedRow`: a row under a NEW id is a record written here, so it is stamped as nobody's delivery — the
      // upstream that delivered the OLD row has no claim on what this instance made of it (`sync/local-only-fields.ts`).
      const doc = rekeyedRow({ ...existing, ...alsoSet }, { _id: newId, from, to, label, updatedAt: now, seq: insertSeq + i }) as unknown as EdgeDoc;
      // The write guard (`Q-439`), AFTER the drop `rekeyedRow` made: the OLD marker named the old `(from, label)` and is gone, and
      // a move onto a label that is functional in a strict space is stamped for its NEW one. Never through `alsoSet`, which the
      // drop would erase too. A merge passes no guard: it reports a functional breach and must never fail on the guard.
      if (functionalGuard !== undefined) doc[FUNCTIONAL_GUARD] = functionalGuard;
      // BEFORE the write, never on the copy that is returned. Removing them from the response alone is what made
      // a GET immediately contradict the 200 that created the row.
      for (const key of alsoUnset) delete (doc as unknown as Record<string, unknown>)[key];
      return doc;
    });
    for (const chunk of inChunks(stored, ROWS_PER_BULK_COMMAND)) {
      await coll.insertMany(chunk.map(d => asDoc<EdgeDoc>(d)), { ordered: true, ...opts });
    }
    return stored;
  }, 'edge.rekey');

  /*
   * INSERTED with its vector, RETURNED without one.
   *
   * The stored document must keep the embedding — dropping it would blank the vector on every entity merge
   * and take the edge out of recall until the queue caught up. But `merge.ts` reads its edges with their
   * vectors, so the documents reaching here can carry 768-float arrays, and `updateEdgeById` sends what this
   * returns straight back as its 200. `upsertEdge` leaked exactly this way, measured against the live stack,
   * and the fix was the same shape: strip at the return, not at the write.
   */
  const byPrevious = new Map(moving.map((m, i) => [m.existing._id, { edge: withoutVector(written[i]!), previousId: m.existing._id }]));
  return planned.map(p => (p === null ? null : byPrevious.get(p.existing._id) ?? null));
}
