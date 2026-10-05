import type { ClientSession } from 'mongodb';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import type { TombstoneDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
import { settledSeqRange, withSeq } from '../util/seq.js';

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
 * A tombstone as the writers take it. `originalSeq` is a REQUIRED key whose value may be `undefined`: the deleted
 * record's seq is the half `tombstoneDoc` calls forgettable, and a writer that let the key be omitted is how a
 * tombstone ships without it. A caller that has no seq to give says so out loud, at the call.
 */
export interface IssuedTombstone {
  _id: string;
  type: TombstoneDoc['type'];
  originalSeq: number | undefined;
  deletedAt?: string;
}

/**
 * The tombstone THIS instance issues for a record it removed — every local delete writes it here.
 *
 * It was hand-written nine times, each allocating its seq separately from the write. Two things a copy
 * drops: the seq must be taken AT the write (`withSeq`, `Q-196`), and `originalSeq` must ride along when the
 * deleted record had one — the pull filters a tombstone out for a peer whose watermark never reached the
 * record, and without it that peer is sent deletions for records it never had.
 */
export function tombstoneDoc(spaceId: string, seq: number, t: IssuedTombstone): TombstoneDoc {
  return {
    _id: t._id, type: t.type, spaceId, deletedAt: t.deletedAt ?? new Date().toISOString(),
    instanceId: getConfig().instanceId, seq,
    ...(t.originalSeq !== undefined ? { originalSeq: t.originalSeq } : {}),
  };
}

/** Issue one local tombstone: allocate its seq at the write and upsert it (see `tombstoneDoc`). */
export async function writeTombstone(
  spaceId: string,
  t: IssuedTombstone,
  session?: ClientSession,
): Promise<void> {
  await withSeq(spaceId, (seq) => col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones')).replaceOne(
    asFilter<TombstoneDoc>({ _id: t._id }), asDoc<TombstoneDoc>(tombstoneDoc(spaceId, seq, t)),
    { upsert: true, ...(session ? { session } : {}) },
  ));
}
