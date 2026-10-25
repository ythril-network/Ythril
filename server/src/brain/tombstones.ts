import type { ClientSession } from 'mongodb';
import { col, asFilter, asBulk } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import type { TombstoneDoc } from '../config/types.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { andPredicates } from '../db/and-predicates.js';
import { versionsFor, type VersionAllocation, type VersionReadOptions } from '../util/version-stamp.js';
import { withLandingStamp, localRow, type LocalLanding } from '../sync/record-position-stream.js';
import { TOMBSTONE_LOCAL_FIELDS } from '../sync/local-only-fields.js';
import { readAfterPosition, type PositionStart, type PositionRead } from '../util/position-keyset.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { TOMBSTONE_COLLECTION, type BrainCollection } from '../config/types-knowledge.js';
import { admitSpaceWrite } from '../spaces/space-write-gate.js';

/*
 * A tombstone a PEER delivered is applied by `applyPeerTombstones` (`sync/tombstone-apply.ts`), not here: this
 * module issues and lists this instance's own, and is imported by every local delete, so the peer rules and the
 * arrival machinery they share stay out of its import graph.
 */

/**
 * The fields of a stored tombstone that never leave this instance: derived from `TOMBSTONE_LOCAL_FIELDS` (`sync/local-only-fields.ts`: how
 * it reached here, whether this instance issued it, and its position), so a fifth local field is withheld by being named once.
 */
const LOCAL_TOMBSTONE_FIELDS_EXCLUDED: Readonly<Record<string, 0>> =
  Object.fromEntries([...TOMBSTONE_LOCAL_FIELDS].map(f => [f, 0 as const]));

/**
 * One page of tombstones that come after a POSITION, below the settled cap (`util/position-keyset.ts`), each with the position it sits at: what a
 * position-paged `GET /tombstones` and the mesh push read: the one reader of tombstones by position. The local fields (`TOMBSTONE_LOCAL_FIELDS`) are excluded
 * HERE, so what leaves the instance cannot carry them whatever the caller forgot, and `extra` narrows what is read (the push's selection).
 */
export async function listTombstonesAfterPosition(
  spaceId: string, after: PositionStart, limit: number, extra?: Readonly<Record<string, unknown>>,
): Promise<PositionRead<TombstoneDoc>> {
  return readAfterPosition<TombstoneDoc>(spaceId, 'tombstones', after, { limit, extra, projection: LOCAL_TOMBSTONE_FIELDS_EXCLUDED });
}

/**
 * The tombstone THIS instance issues for a record it removed — every local delete writes it here.
 *
 * It was hand-written nine times, each allocating its seq separately from the write. Two things a copy
 * drops: the stamp must be taken BEFORE the record is removed (`stampTombstones`: a delete of a record whose version is at the ceiling is
 * refused, not half done), and `originalSeq` must ride along when the deleted record had one — the pull filters a tombstone out
 * for a peer whose watermark never reached the record, and without it that peer is sent deletions for records it never had.
 *
 * `stamp` is the landing of this write (`withLandingStamp`): the tombstone's version, the position it was taken at and the version that
 * position is for. `writtenHere` is not a tombstone's: whether this instance issued one is its own mark (`issuedHere: true`, stamped here and nowhere else, asked through `sync/issued-here.ts`).
 */
export function tombstoneDoc(
  spaceId: string, stamp: Pick<LocalLanding, 'seq' | 'pos' | 'posAtSeq'>,
  t: { _id: string; type: TombstoneDoc['type']; originalSeq?: number | undefined; deletedAt?: string },
): TombstoneDoc {
  return {
    _id: t._id, type: t.type, spaceId, deletedAt: t.deletedAt ?? new Date().toISOString(),
    instanceId: getConfig().instanceId, issuedHere: true, seq: stamp.seq, pos: stamp.pos, posAtSeq: stamp.posAtSeq,
    ...(t.originalSeq !== undefined ? { originalSeq: t.originalSeq } : {}),
  };
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

/**
 * The versions the tombstones of `tombs` will carry, taken BEFORE the records are removed (`versionsFor`): above the record each buries
 * (`originalSeq`, and the stored copy while it is still here) and above any tombstone already held for the id. A delete whose version
 * would be above the ceiling throws `RecordVersionAtCeiling` HERE, with nothing deleted; every caller that removes a record asks this
 * first and hands the answer to `writeTombstones` / `removeWithTombstones`, which REQUIRE it, so no writer can stamp after the destructive step.
 */
export async function stampTombstones(
  spaceId: string, tombs: readonly Pick<IssuedTombstone, '_id' | 'type' | 'originalSeq'>[], opts: Pick<VersionReadOptions, 'session'> = {},
): Promise<VersionAllocation[]> {
  return versionsFor(spaceId, tombs.map(t => t._id), {
    parts: [...new Set(tombs.map(t => TOMBSTONE_COLLECTION[t.type]))],
    known: new Map(tombs.map(t => [t._id, t.originalSeq] as const)),
    ...(opts.session ? { session: opts.session } : {}),
  });
}

/**
 * Issue one local tombstone, under the version `stampTombstones` took for it before the record was removed (`versions`, one per
 * tombstone, in order): see `writeTombstones`.
 */
export async function writeTombstone(
  spaceId: string,
  t: { _id: string; type: TombstoneDoc['type']; originalSeq?: number | undefined; deletedAt?: string },
  versions: readonly VersionAllocation[],
  session?: ClientSession,
): Promise<void> {
  await writeTombstones(spaceId, [{ ...t, originalSeq: t.originalSeq }], versions, session);
}

/**
 * Issue many local tombstones: ONE block of positions for all of them, taken at the write, and one bulk write per chunk.
 *
 * Extracted from the link reconcile in `write-plan/commit.ts`, the one batched copy, so the merge and the entity
 * cascade stop issuing a stamp and a round trip per deleted row. A version PER ROW and a position per row, never one shared: a
 * pager continues from the last row's position, so two tombstones sharing one at a page boundary would leave the rest unreachable.
 * `session` puts the rows in the caller's transaction — the cascade's delete and its tombstones commit together or not at all (the caller
 * holds the transaction's floor, `inHeldTransaction`, so a reader is never paged past them before the commit).
 *
 * `versions` is REQUIRED, one per tombstone in order, from `stampTombstones` (or from the caller's own `versionsFor` when it stamps its
 * tombstones with other rows of one write — the edge re-key). It is taken before the destructive step, so a refusal leaves nothing half done.
 */
export async function writeTombstones(
  spaceId: string, tombs: readonly IssuedTombstone[], versions: readonly VersionAllocation[], session?: ClientSession,
): Promise<void> {
  if (tombs.length === 0) return;
  if (versions.length !== tombs.length) throw new Error(`writeTombstones: ${tombs.length} tombstone(s) were given ${versions.length} version(s)`);
  // A tombstone belongs to the family of the record it buries: a wipe of that family refuses it, and an act of it waits for it
  // (`admitSpaceWrite`: asked and counted in one step, released however the write ends).
  await admitSpaceWrite(spaceId, familiesOf(tombs), async () => {
    const coll = col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'));
    const deletedAt = new Date().toISOString();
    await withLandingStamp(spaceId, versions.map(v => localRow(v.version)), async (patches) => {
      let next = 0;
      for (const chunk of inChunks(tombs, ROWS_PER_BULK_COMMAND)) {
        await coll.bulkWrite(asBulk<TombstoneDoc>(chunk.map(t => ({
          replaceOne: {
            filter: { _id: t._id },
            replacement: tombstoneDoc(spaceId, patches[next++]!, { deletedAt, ...t }),
            upsert: true,
          },
        }))), { ordered: false, ...(session ? { session } : {}) });
      }
    }, 'tombstone.write');
  });
}

/** The families of the records a set of tombstones bury (`TOMBSTONE_COLLECTION`), each once. */
function familiesOf(tombs: readonly IssuedTombstone[]): BrainCollection[] {
  return [...new Set(tombs.map(t => TOMBSTONE_COLLECTION[t.type]))];
}

/**
 * Delete rows of one of a space's collections by id, a command per `ROWS_PER_BULK_COMMAND`, and issue their
 * tombstones — the one spelling of "chunked `$in` delete, then `writeTombstones`" (bundle-30 I6, C11: the merge's
 * duplicate edges and moved links, the re-key's moved edges and the edge removal each wrote it by hand). `filter`
 * narrows the delete (ANDed, never spread beside the id); `session` is `writeTombstones`'.
 *
 * It stamps the tombstones BEFORE it deletes (`stampTombstones`), so a row whose version is at the ceiling refuses the whole removal with
 * `record_version_at_ceiling` and nothing is half deleted — the forgettable half, inside. A caller that stamps its tombstones together with
 * other rows of one write (the edge re-key: every tombstone below every insert) passes the `versions` it took.
 */
export async function removeWithTombstones(
  spaceId: string, part: SpacePart, tombs: readonly IssuedTombstone[],
  { session, filter, versions: given }: { session?: ClientSession; filter?: Record<string, unknown>; versions?: readonly VersionAllocation[] } = {},
): Promise<void> {
  if (tombs.length === 0) return;
  const versions = given ?? await stampTombstones(spaceId, tombs, session ? { session } : {});
  await admitSpaceWrite(spaceId, familiesOf(tombs), async () => {
    const coll = col<{ _id: string }>(spaceCollection(spaceId, part));
    for (const chunk of inChunks(tombs, ROWS_PER_BULK_COMMAND)) {
      await coll.deleteMany(asFilter<{ _id: string }>(andPredicates({ _id: { $in: chunk.map(t => t._id) } }, filter) as never),
        session ? { session } : {});
    }
    await writeTombstones(spaceId, tombs, versions, session);
  });
}
