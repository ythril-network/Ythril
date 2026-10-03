import type { ClientSession } from 'mongodb';
import { col, asFilter, asBulk } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import type { TombstoneDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
import { settledSeqRange, withAllocatedSeqs } from '../util/seq.js';
import { inChunks } from '../util/chunks.js';

/*
 * A tombstone a PEER delivered is applied by `applyPeerTombstones` (`sync/tombstone-apply.ts`), not here: this
 * module issues and lists this instance's own, and is imported by every local delete, so the peer rules and the
 * arrival machinery they share stay out of its import graph.
 */

/**
 * List tombstones with seq greater than the given watermark — settled seqs only, because every caller moves
 * a cursor to the last seq it is handed and a tombstone committed below that cursor is never offered again.
 */
export async function listTombstones(
  spaceId: string,
  sinceSeq: number,
  limit = 200,
  type?: TombstoneDoc['type'],
): Promise<TombstoneDoc[]> {
  const filter: Record<string, unknown> = { seq: await settledSeqRange(spaceId, sinceSeq) };
  if (type) filter['type'] = type;
  return col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'))
    .find(asFilter<TombstoneDoc>(filter))
    .sort({ seq: 1 })
    .limit(limit)
    .toArray() as Promise<TombstoneDoc[]>;
}

/**
 * The tombstone THIS instance issues for a record it removed — every local delete writes it here.
 *
 * It was hand-written nine times, each allocating its seq separately from the write. Two things a copy
 * drops: the seq must be taken AT the write (`withSeq`, `Q-196`), and `originalSeq` must ride along when the
 * deleted record had one — the pull filters a tombstone out for a peer whose watermark never reached the
 * record, and without it that peer is sent deletions for records it never had.
 */
export function tombstoneDoc(
  spaceId: string, seq: number,
  t: { _id: string; type: TombstoneDoc['type']; originalSeq?: number | undefined; deletedAt?: string },
): TombstoneDoc {
  return {
    _id: t._id, type: t.type, spaceId, deletedAt: t.deletedAt ?? new Date().toISOString(),
    instanceId: getConfig().instanceId, seq,
    ...(t.originalSeq !== undefined ? { originalSeq: t.originalSeq } : {}),
  };
}

/** Issue one local tombstone: allocate its seq at the write and upsert it (see `tombstoneDoc`). */
export async function writeTombstone(
  spaceId: string,
  t: { _id: string; type: TombstoneDoc['type']; originalSeq?: number | undefined; deletedAt?: string },
  session?: ClientSession,
): Promise<void> {
  await writeTombstones(spaceId, [{ ...t, originalSeq: t.originalSeq }], session);
}

/**
 * A tombstone as `writeTombstones` takes it. `originalSeq` is a REQUIRED key whose value may be `undefined`: the
 * deleted record's seq is the half `tombstoneDoc` calls forgettable, and a batch writer that let it be omitted
 * is how the merge's duplicate-edge tombstones and the link reconcile's shipped without it. A caller that has no
 * seq to give says so out loud, at the call.
 */
export interface IssuedTombstone {
  _id: string;
  type: TombstoneDoc['type'];
  originalSeq: number | undefined;
  deletedAt?: string;
}

/** Tombstones per bulk write: a hub's cascade or merge issues thousands, and one command per row was the cost. */
const TOMBSTONE_CHUNK = 1_000;

/**
 * Issue many local tombstones: ONE seq block for all of them, taken at the write, and one bulk write per chunk.
 *
 * Extracted from the link reconcile in `write-plan/commit.ts`, the one batched copy, so the merge and the entity
 * cascade stop issuing a seq and a round trip per deleted row. A seq PER ROW, never one shared: the seq-paged
 * readers continue from the last item's seq with `seq > since`, so two tombstones sharing one at a page boundary
 * would leave the rest unreachable. `session` puts the rows in the caller's transaction — the cascade's delete and
 * its tombstones commit together or not at all.
 */
export async function writeTombstones(
  spaceId: string, tombs: readonly IssuedTombstone[], session?: ClientSession,
): Promise<void> {
  if (tombs.length === 0) return;
  const coll = col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'));
  const deletedAt = new Date().toISOString();
  await withAllocatedSeqs(spaceId, tombs.length, async (first) => {
    let next = first;
    for (const chunk of inChunks(tombs, TOMBSTONE_CHUNK)) {
      await coll.bulkWrite(asBulk<TombstoneDoc>(chunk.map(t => ({
        replaceOne: {
          filter: { _id: t._id },
          replacement: tombstoneDoc(spaceId, next++, { deletedAt, ...t }),
          upsert: true,
        },
      }))), { ordered: false, ...(session ? { session } : {}) });
    }
  }, 'tombstone.write');
}
