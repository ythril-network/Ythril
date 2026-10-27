/**
 * What the page accept planner (`planArrivals`, `sync/upsert-plan.ts`) is told, read in a number of queries
 * that does not grow with the page — and the one write it decides that is not a record's, the stale-tombstone
 * cleanup (`Q-107` part 1 §2, §4). The pull reads through it too since `Q-204`: one planner, one set of reads.
 *
 * ## Why the reads are their own module
 *
 * The push door processed a page one document at a time: a tombstone read, a record read, a fork-chain walk of
 * one `findOne` per hop, and a sibling `countDocuments` with no index behind it — four round trips per document
 * before the write, 801 commands for a 200-document page. The planner is pure so that the decision can be made
 * once for the whole page; these are the reads that feed it, each one per page:
 *
 *  - **one tombstone read per request**, every family's ids in one `$in` (a tombstone's `_id` is its record's);
 *  - **one stored read per family**, projected to what the planner compares: the seq and the fork link, and — only for
 *    the ids whose stored seq EQUALS an arriving one — a second read of the body, because a body is asked only at an
 *    equal seq and most arrivals are newer or older;
 *  - for records that may FORK only — none on a fork-free page, of any family that forks — **one sibling aggregate**
 *    over the `{ forkOf: 1 }` index (`spaces/space-indexes.ts`), UNCAPPED for the read (it names every fork id stored for
 *    the candidate parents, so the match of a re-delivery by id can never fall outside a window), and a **chain walk
 *    level by level** with `$in`, at most `MAX_FORK_DEPTH` reads.
 */
import type { ClientSession } from 'mongodb';
import { FILE_HASH_PROJECTION, fileContentHash } from '../brain/merkle.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import type { TombstoneType } from '../config/types.js';
import { forkCandidates, isForkingFamily, bodyHashesOf, MAX_FORK_DEPTH, CONVERGE_BLANKED, type BodyHashes, type HeldTombstone, type ArrivalDoc, type PlannedFamily, type StoredCopy } from './upsert-plan.js';
import { authoredContentHash, bodyProjectionOf } from './authored-content.js';
import { TOMBSTONE_COLLECTION } from '../config/types-knowledge.js';
import { assertSpaceTakesWrites } from '../spaces/space-write-gate.js';

/**
 * The tombstone held per record id — its seq, its issuer and the upstream it was stored for (`storedVia`) — per
 * tombstone type, for every id the request carries.
 */
export async function readPageTombstones(
  spaceId: string, ids: readonly string[], session?: ClientSession,
): Promise<Map<TombstoneType, Map<string, HeldTombstone>>> {
  const rows = await readStoredById<{ type?: TombstoneType; seq?: number; instanceId?: string; storedVia?: string; issuedHere?: boolean; deletedAt?: string }>(
    spaceCollection(spaceId, 'tombstones'), ids, { type: 1, seq: 1, instanceId: 1, storedVia: 1, issuedHere: 1, deletedAt: 1 }, session ? { session } : {});
  const out = new Map<TombstoneType, Map<string, HeldTombstone>>();
  for (const [id, t] of rows) {
    if (t.type === undefined || typeof t.seq !== 'number') continue;
    if (!out.has(t.type)) out.set(t.type, new Map());
    out.get(t.type)!.set(id, {
      seq: t.seq,
      ...(typeof t.instanceId === 'string' ? { issuer: t.instanceId } : {}),
      ...(typeof t.storedVia === 'string' ? { storedVia: t.storedVia } : {}),
      // Whether THIS instance issued it (a resolve's or a delete's own tombstone), and when it was decided: the arrival half of Q-624 §9a reads both.
      issuedHere: t.issuedHere === true,
      ...(typeof t.deletedAt === 'string' ? { deletedAt: t.deletedAt } : {}),
    });
  }
  return out;
}

/** The stored copies the planner compares a page against: the seq and the fork link, and for a family that forks the hash of the body at an equal seq. */
export async function readPushStored(
  spaceId: string, family: PlannedFamily, docs: readonly ArrivalDoc[],
): Promise<Map<string, StoredCopy>> {
  /*
   * A FILE row is read with its AUTHORED half, not just its seq (`Q-419`).
   *
   * The planner has one more question to ask of a file than of any other family: an arriving copy at the seq we
   * already hold, from the peer that authored both, identical but for the timestamp, is a drift to converge rather
   * than a copy to skip. Deciding that needs the author, the timestamp, and a hash of everything else the wire
   * carries — so the read asks for the hash's own projection and the hash is computed here, once per row, rather
   * than handing the planner the fields and a second definition of what a file row's content is.
   */
  if (family === 'files') {
    const rows = await readStoredById<Record<string, unknown>>(
      spaceCollection(spaceId, family), docs.map(d => d._id), FILE_HASH_PROJECTION as unknown as Record<string, 1>);
    return new Map([...rows].map(([id, row]) => [id, {
      ...(typeof row['seq'] === 'number' ? { seq: row['seq'] } : {}),
      ...(row['author'] !== undefined ? { author: row['author'] as { instanceId?: string } } : {}),
      ...(typeof row['updatedAt'] === 'string' ? { updatedAt: row['updatedAt'] } : {}),
      contentHash: fileContentHash(row, CONVERGE_BLANKED),
    } satisfies StoredCopy]));
  }
  if (!isForkingFamily(family)) return readStoredById<StoredCopy>(spaceCollection(spaceId, family), docs.map(d => d._id), { seq: 1 });
  const collection = spaceCollection(spaceId, family);
  const base = await readStoredById<StoredCopy>(collection, docs.map(d => d._id), { seq: 1, forkOf: 1 });
  // The body only where it can be asked: a stored copy at the seq an arriving copy of the same id carries.
  const arriving = new Map<string, Set<number>>();
  for (const d of docs) (arriving.get(d._id) ?? arriving.set(d._id, new Set()).get(d._id)!).add(d.seq);
  const equal = [...base].filter(([id, row]) => typeof row.seq === 'number' && arriving.get(id)?.has(row.seq)).map(([id]) => id);
  if (equal.length === 0) return base;
  const bodies = await readStoredById<Record<string, unknown>>(collection, equal, bodyProjectionOf(family));
  for (const [id, row] of bodies) base.set(id, { ...base.get(id)!, bodyHash: authoredContentHash(family, row) });
  return base;
}

/**
 * The fork context of a page of a family that forks: how many forks each candidate parent already has, EVERY fork id already stored for them,
 * the `forkOf` of every ancestor above the candidates, and which parents a page's own fork rows name are held here. A candidate is a record that may
 * fork (a different body at an equal seq) or the parent of a fork row the page carries. Empty, and nothing read, when no record can fork.
 */
export async function readForkContext(
  spaceId: string, kind: PlannedFamily, docs: readonly ArrivalDoc[], stored: ReadonlyMap<string, StoredCopy>, hashOf: BodyHashes = bodyHashesOf(kind),
): Promise<{ forkParent?: Map<string, string | undefined>; siblings?: Map<string, number>; existingForks?: Set<string>; heldParents?: Set<string> }> {
  const forking = forkCandidates(kind, docs, stored, hashOf);
  const named = [...new Set(docs.flatMap(d => (d.forkOf === undefined ? [] : [d.forkOf])))];
  const candidates = [...new Set([...forking, ...named])];
  if (candidates.length === 0) return {};
  const records = spaceCollection(spaceId, kind);

  const groups = await col<{ _id: string; forkOf?: string }>(records).aggregate<{ _id: string; n: number; ids: string[] }>([
    { $match: asFilter({ forkOf: { $in: candidates } }) },
    { $group: { _id: '$forkOf', n: { $sum: 1 }, ids: { $push: '$_id' } } },
  ]).toArray();
  const siblings = new Map(groups.map(g => [String(g._id), g.n]));
  const existingForks = new Set(groups.flatMap(g => g.ids.map(String)));
  const pending = named.filter(id => !stored.has(id));
  const heldParents = new Set((pending.length === 0 ? new Map() : await readStoredById<{ _id: string }>(records, pending, { _id: 1 })).keys());

  const forkParent = new Map<string, string | undefined>();
  let frontier = new Set<string>();
  for (const c of forking) {
    const parent = stored.get(c)?.forkOf;
    if (parent) frontier.add(parent);
    for (const d of docs) if (d._id === c && d.forkOf) frontier.add(d.forkOf);
  }
  for (let level = 0; level < MAX_FORK_DEPTH && frontier.size > 0; level++) {
    const ids = [...frontier].filter(id => !forkParent.has(id) && !stored.has(id));
    if (ids.length === 0) break;
    const rows = await readStoredById<{ forkOf?: string }>(records, ids, { forkOf: 1 });
    frontier = new Set();
    for (const id of ids) {
      const parent = rows.get(id)?.forkOf;
      forkParent.set(id, parent);
      if (parent) frontier.add(parent);
    }
  }
  return { forkParent, siblings, existingForks, heldParents };
}

/**
 * Delete the stale tombstones an arrival superseded — each bounded by the seq that superseded it, so a tombstone
 * written meanwhile at a higher seq is never the one removed. Called only for records that LANDED, or whose
 * stored copy is already above the tombstone.
 *
 * An item carrying `via` is the other kind: a tombstone stored for the upstream that delivered the version
 * (`storedVia`, `upsert-plan.ts`). Its seq is the issuer's clock and proves nothing against this version, so it is
 * bounded by WHO it was stored for instead — a tombstone this instance issued meanwhile, or stored for someone else,
 * carries another `storedVia` (or none) and is never the one removed. Without it the tombstone stays served: a child
 * whose copy this node delivered would apply it and lose the newer version this node holds.
 */
export async function deleteSupersededTombstones(
  spaceId: string, type: TombstoneType, items: ReadonlyArray<{ id: string; below: number; via?: string }>,
): Promise<void> {
  if (items.length === 0) return;
  assertSpaceTakesWrites(spaceId, TOMBSTONE_COLLECTION[type]);
  await col(spaceCollection(spaceId, 'tombstones')).deleteMany(asFilter({
    type, $or: items.map(i => (i.via !== undefined ? { _id: i.id, storedVia: i.via } : { _id: i.id, seq: { $lt: i.below } })),
  }));
}
