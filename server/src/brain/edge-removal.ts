/**
 * Removing edges, with the tombstones that tell peers to remove them too — all or nothing per chunk.
 *
 * ## Why a module
 *
 * Two paths removed edges and each spelled it by hand: `deleteEdge` (one edge: read its seq, delete it, retire its
 * embed job, write its tombstone, emit `edge.deleted`) and the entity cascade, which called `deleteEdge` once per
 * edge. Both did the delete and the tombstone as two separate writes, so a tombstone that failed after its delete
 * left the edge gone here and alive on every peer — and the next pull brought it back. A hub of 1 500 edges was also
 * some 7 500 round trips (`Q-107` part 3b).
 *
 * ## What it guarantees, and the order
 *
 *  1. **A chunk is ONE transaction under the seq horizon hold** (`inHeldTransaction`): the stored seqs read by id, one
 *     delete, and the tombstones (`writeTombstones`, each carrying the deleted edge's `seq` as `originalSeq`) land
 *     together or not at all. A commit whose reply was lost is read back inside the hold.
 *  2. **After each chunk committed, never inside it:** one batched `retireEmbedJobs` — the record is gone, so its job
 *     has nothing to embed, and a job gone terminal would outlive it for ever — and one `edge.deleted` per removed
 *     edge, the contract a subscriber mirrors the graph by.
 *
 * An edge already removed by somebody else is simply not in the answer; a failure part-way leaves the chunks before
 * it removed and the rest untouched, so a re-run continues.
 */
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { inChunks } from '../util/chunks.js';
import { log, peerText } from '../util/log.js';
import { inHeldTransaction } from './held-transaction.js';
import { removeWithTombstones } from './tombstones.js';
import { retireEmbedJobs } from './embed-queue.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { EdgeDoc } from '../config/types.js';

/**
 * Edges removed per transaction: small enough that a chunk never nears the hold's deadline, large enough that a hub
 * costs a handful of round trips per chunk rather than five per edge.
 */
export const EDGE_REMOVAL_CHUNK = 500;

/** Remove `ids` (edges of `spaceId`) with their tombstones; returns the ids that were stored and are now gone. */
export async function removeEdges(spaceId: string, ids: readonly string[], actor?: WebhookActor): Promise<Set<string>> {
  const gone = new Set<string>();
  for (const chunk of inChunks(ids, EDGE_REMOVAL_CHUNK)) {
    const removed = await removeEdgeChunk(spaceId, chunk);
    if (removed.size === 0) continue;
    for (const id of removed) gone.add(id);
    try {
      await retireEmbedJobs(spaceId, 'edge', [...removed]);
    } catch (err) {
      log.warn(`edge removal: ${removed.size} edge(s) were deleted in '${peerText(spaceId)}' but their embed jobs were not retired: `
        + `${err instanceof Error ? peerText(err.message) : peerText(String(err))}`);
    }
    if (actor) for (const _id of removed) emitWebhookEvent({ event: 'edge.deleted', spaceId, entry: { _id }, ...actor });
  }
  return gone;
}

/** One chunk: its stored seqs, the delete and the tombstones, in ONE held transaction (see the module docblock). */
async function removeEdgeChunk(spaceId: string, ids: readonly string[]): Promise<Set<string>> {
  const collName = spaceCollection(spaceId, 'edges');
  return inHeldTransaction(spaceId, 'edge.remove', async (session) => {
    const stored = await readStoredById<Pick<EdgeDoc, '_id' | 'seq'>>(collName, ids, { seq: 1 }, { session, filter: { spaceId } });
    if (stored.size === 0) return new Set<string>();
    await removeWithTombstones(spaceId, 'edges',
      [...stored.values()].map(e => ({ _id: e._id, type: 'edge' as const, originalSeq: e.seq })), { session, filter: { spaceId } });
    return new Set(stored.keys());
  }, {
    // A commit whose answer was lost may have landed: it did when none of the chunk's edges is stored any more.
    landed: async (gone) => gone.size === 0 || (await readStoredById(collName, [...gone], { _id: 1 })).size === 0,
  });
}
