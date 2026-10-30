/**
 * Removing records, with the tombstones that tell peers to remove them too — all or nothing per chunk, for the four record shapes.
 *
 * ## Why a module
 *
 * Four paths removed a record and each spelled it by hand: `deleteFact`, `deleteChrono`, `deleteEntity` (read the seq, stamp, delete, retire the
 * embed job, THEN write the tombstone as a second write) and `deleteEdge` / the entity cascade (`Q-107` part 3b, which made the edge's one transaction).
 * The three that deleted and tombstoned in two writes had the defect `Q-313` names: a tombstone that failed after its delete left the record gone
 * here and alive on every peer, and the next pull brought it back; and a TTL sweep, which deletes through them, repeated it per record. A hub of
 * 1 500 edges was also some 7 500 round trips. One remover, the edge one generalised: what differs per kind is a parameter (the collection, what runs
 * once the removal committed), never a second function.
 *
 * ## What it guarantees, and the order
 *
 *  1. **A chunk is ONE transaction under the record-position floor** (`inHeldTransaction`): the stored seqs read by id, the record's unresolved versions
 *     (`removeForksOf`, each behind a tombstone issued here), one delete, and the tombstones (each carrying the deleted record's `seq` as
 *     `originalSeq`) land together or not at all. A refusal inside — a version at the ceiling (`record_version_at_ceiling`), a tombstone the store
 *     refused — aborts the chunk and leaves the record where it was. A commit whose reply was lost is read back inside the hold.
 *  2. **After each chunk committed, never inside it:** one batched `retireEmbedJobs` (the record is gone, so its job has nothing to embed, and a job gone
 *     terminal would outlive it for ever), what the unresolved versions leave (their jobs and the links they start), the kind's own cascade
 *     ({@link AFTER_REMOVAL}: a fact's and a chrono entry's links FROM it, an entity's face labels) and one `<kind>.deleted` per removed record, the
 *     contract a subscriber mirrors the graph by. A failure to retire is said and never undone: the removal stands. The kind's cascade is thrown, as
 *     it always was: the record is gone and a caller that survived it would answer a delete whose links are still owed. **The events go out either way**
 *     (a `finally`): the records are gone and tombstoned once the chunk committed, so a subscriber is told whatever the cascade did, and a failed cascade still fails the call.
 *
 * A chunk none of whose ids is stored is one read and nothing more (no transaction, no position floor), so a 404 delete and a TTL race cost what they cost before the transaction.
 *
 * A record already removed by somebody else is simply not in the answer; a failure part-way leaves the chunks before it removed and the rest untouched,
 * so a re-run continues. The TTL sweep deletes through the per-kind deleters, so it inherits all of this and needs nothing of its own.
 */
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { andPredicates } from '../db/and-predicates.js';
import { inChunks } from '../util/chunks.js';
import { log, peerText } from '../util/log.js';
import { nextUnheldPosition } from '../util/position-clock.js';
import { recordPositions } from '../sync/record-position-stream.js';
import { inHeldTransaction } from './held-transaction.js';
import { removeWithTombstones } from './tombstones.js';
import { removeForksOf, settleRemovedForks } from './forks.js';
import { retireEmbedJobs } from './embed-queue.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { TOMBSTONE_COLLECTION } from '../config/types-knowledge.js';

/** The record shapes that are removed with a tombstone through this module. */
export type RemovableKind = 'fact' | 'chrono' | 'entity' | 'edge';

/**
 * Records removed per transaction: small enough that a chunk never nears the hold's deadline, large enough that a hub
 * costs a handful of round trips per chunk rather than five per record.
 */
export const RECORD_REMOVAL_CHUNK = 500;

/**
 * What a kind needs once its removal committed, besides the embed jobs every kind retires: the one place the per-kind difference lives. A kind with
 * nothing to add says so with a function that does nothing, so a new kind cannot be added without deciding.
 */
export const AFTER_REMOVAL: Readonly<Record<RemovableKind, (spaceId: string, ids: readonly string[], actor: WebhookActor | undefined, began: number) => Promise<void>>> = {
  // The links a deleted fact or chrono entry STARTS describe a connection whose subject no longer exists, and nothing else would ever remove them.
  // Links pointing AT one belong to the readers' slice: removing them would delete another record's data.
  fact: async (spaceId, ids) => { await (await import('./links.js')).removeLinksFromMany(spaceId, ids, 'fact'); },
  chrono: async (spaceId, ids) => { await (await import('./links.js')).removeLinksFromMany(spaceId, ids, 'chrono'); },
  // Erasure has to reach the biometric copy too (`unlabelFacesForEntities`). Imported where it runs: `entities.ts` removes through this module.
  entity: async (spaceId, ids, actor, began) => {
    await (await import('./entities.js')).unlabelFacesForEntities(spaceId, [...ids]);
    // An edge or link written to the entity after its remover read the references (Q-305): taken back here, in the one place every door's delete passes,
    // so none can omit it, and only what landed once the removal began (`began`) — a TTL or orphan-fork delete has no guard, and an older row is not a straggler.
    // A merge's absorbed entity is settled by `executeMerge`, which moves them instead.
    const { settleReferencesToRemovedEntity } = await import('./gone-entity-references.js');
    for (const id of ids) await settleReferencesToRemovedEntity(spaceId, id, { removalBegan: began, ...(actor ? { actor } : {}) });
  },
  edge: async () => {},
};

/**
 * Remove `ids` (records of `kind` in `spaceId`) with their tombstones; returns the ids that were stored and are now gone. The space is asked whether it
 * takes writes of this kind's collection by the delete itself (`removeWithTombstones` is an admitted, counted unit), so a refusal aborts the chunk and
 * nothing is removed.
 *
 * `opts.filter` narrows what is removed to the stored rows that also match it, ANDed into the read of the chunk's seqs and into the delete: the writer's
 * take-back of an edge removes it only while it still names the entity that is gone (Q-305), so a row moved or rewritten meanwhile is not removed.
 */
export async function removeRecords(
  spaceId: string, kind: RemovableKind, ids: readonly string[], actor?: WebhookActor, opts: { filter?: Record<string, unknown> } = {},
): Promise<Set<string>> {
  const gone = new Set<string>();
  const filter = andPredicates({ spaceId }, opts.filter)!;
  let began: number | undefined;
  for (const chunk of inChunks(ids, RECORD_REMOVAL_CHUNK)) {
    // Read outside any transaction first: a removal of ids that are not stored (a 404 delete, a TTL race, a take-back another writer made first) is one read,
    // and opens no transaction and no position floor only to read nothing.
    if ((await readStoredById(spaceCollection(spaceId, TOMBSTONE_COLLECTION[kind]), chunk, { _id: 1 }, { filter })).size === 0) continue;
    // The record position the removal begins at: a stamp taken now (never held: nothing pages by it), so any position handed out later is above it. What a
    // kind's cascade takes back as a straggler is bounded by it (less a lookback that covers a write already in flight), so a removal with no guard of its own
    // cannot take rows older than itself.
    began ??= await nextUnheldPosition(recordPositions, spaceId);
    const { removed, forks } = await removeChunk(spaceId, kind, chunk, opts.filter);
    if (removed.size === 0) continue;
    for (const id of removed) gone.add(id);
    try {
      await retireEmbedJobs(spaceId, kind, [...removed]);
    } catch (err) {
      log.warn(`${kind} removal: ${removed.size} ${kind}(s) were deleted in '${peerText(spaceId)}' but their embed jobs were not retired: ${peerText(err)}`);
    }
    try {
      if (forks.length > 0) await settleRemovedForks(spaceId, kind, forks);
      await AFTER_REMOVAL[kind](spaceId, [...removed], actor, began);
    } finally {
      // The records are gone and their tombstones are written, whatever the cascade after them did: the event a subscriber mirrors the graph by is sent either way,
      // and a failed cascade still fails the call (the throw leaves through here).
      if (actor) for (const _id of removed) emitWebhookEvent({ event: `${kind}.deleted`, spaceId, entry: { _id }, ...actor });
    }
  }
  return gone;
}

/** One chunk: its stored seqs, the forks, the delete and the tombstones, in ONE held transaction (see the module docblock). */
async function removeChunk(
  spaceId: string, kind: RemovableKind, ids: readonly string[], narrowedTo?: Record<string, unknown>,
): Promise<{ removed: Set<string>; forks: string[] }> {
  const family = TOMBSTONE_COLLECTION[kind];
  const collName = spaceCollection(spaceId, family);
  const filter = andPredicates({ spaceId }, narrowedTo)!;
  return inHeldTransaction(spaceId, `${kind}.remove`, async (session) => {
    const stored = await readStoredById<{ _id: string; seq?: number }>(collName, ids, { seq: 1 }, { session, filter });
    if (stored.size === 0) return { removed: new Set<string>(), forks: [] };
    // The records' unresolved versions go with them, each behind a tombstone issued here, in this transaction (Q-624 §7).
    const forks = await removeForksOf(spaceId, kind, [...stored.keys()], { session });
    await removeWithTombstones(spaceId, family,
      [...stored.values()].map(r => ({ _id: r._id, type: kind, originalSeq: r.seq })), { session, filter });
    return { removed: new Set(stored.keys()), forks };
  }, {
    // A commit whose answer was lost may have landed: it did when none of the chunk's records is stored any more.
    landed: async ({ removed }) => removed.size === 0 || (await readStoredById(collName, [...removed], { _id: 1 })).size === 0,
  });
}
