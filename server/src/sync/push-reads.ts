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
 *  - **one stored read per family**, projected to what the planner compares;
 *  - for facts that may FORK only — none on a fork-free page — **one sibling aggregate** over the `{ forkOf: 1 }`
 *    index (`spaces/lifecycle.ts`), which also names the forks already stored, and a **chain walk level by
 *    level** with `$in`, at most `MAX_FORK_DEPTH` reads.
 */
import { FILE_HASH_PROJECTION, fileContentHash } from '../brain/merkle.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import type { TombstoneType } from '../config/types.js';
import { forkCandidates, MAX_FORK_DEPTH, CONVERGE_BLANKED, type HeldTombstone, type ArrivalDoc, type PlannedFamily, type StoredCopy } from './upsert-plan.js';

/**
 * The tombstone held per record id — its seq, its issuer and the upstream it was stored for (`storedVia`) — per
 * tombstone type, for every id the request carries.
 */
export async function readPageTombstones(
  spaceId: string, ids: readonly string[],
): Promise<Map<TombstoneType, Map<string, HeldTombstone>>> {
  const rows = await readStoredById<{ type?: TombstoneType; seq?: number; instanceId?: string; storedVia?: string }>(
    spaceCollection(spaceId, 'tombstones'), ids, { type: 1, seq: 1, instanceId: 1, storedVia: 1 });
  const out = new Map<TombstoneType, Map<string, HeldTombstone>>();
  for (const [id, t] of rows) {
    if (t.type === undefined || typeof t.seq !== 'number') continue;
    if (!out.has(t.type)) out.set(t.type, new Map());
    out.get(t.type)!.set(id, {
      seq: t.seq,
      ...(typeof t.instanceId === 'string' ? { issuer: t.instanceId } : {}),
      ...(typeof t.storedVia === 'string' ? { storedVia: t.storedVia } : {}),
    });
  }
  return out;
}

/** The stored copies the planner compares a page against: the seq, and for facts the text and the fork parent. */
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
  const fields: Record<string, 1> = family === 'facts' ? { seq: 1, fact: 1, forkOf: 1 } : { seq: 1 };
  return readStoredById<StoredCopy>(spaceCollection(spaceId, family), docs.map(d => d._id), fields);
}

/**
 * The fork context of a facts page: how many forks each candidate parent already has, which fork ids are already
 * stored, and the `forkOf` of every ancestor above the candidates. Empty, and nothing read, when no fact can fork.
 */
export async function readForkContext(
  spaceId: string, docs: readonly ArrivalDoc[], stored: ReadonlyMap<string, StoredCopy>,
): Promise<{ forkParent?: Map<string, string | undefined>; siblings?: Map<string, number>; existingForks?: Set<string> }> {
  const candidates = forkCandidates(docs, stored);
  if (candidates.length === 0) return {};
  const facts = spaceCollection(spaceId, 'facts');

  const groups = await col<{ _id: string; forkOf?: string }>(facts).aggregate<{ _id: string; n: number; ids: string[] }>([
    { $match: asFilter({ forkOf: { $in: candidates } }) },
    { $group: { _id: '$forkOf', n: { $sum: 1 }, ids: { $push: '$_id' } } },
  ]).toArray();
  const siblings = new Map(groups.map(g => [String(g._id), g.n]));
  const existingForks = new Set(groups.flatMap(g => g.ids.map(String)));

  const forkParent = new Map<string, string | undefined>();
  let frontier = new Set<string>();
  for (const c of candidates) {
    const parent = stored.get(c)?.forkOf;
    if (parent) frontier.add(parent);
    for (const d of docs) if (d._id === c && d.forkOf) frontier.add(d.forkOf);
  }
  for (let level = 0; level < MAX_FORK_DEPTH && frontier.size > 0; level++) {
    const ids = [...frontier].filter(id => !forkParent.has(id) && !stored.has(id));
    if (ids.length === 0) break;
    const rows = await readStoredById<{ forkOf?: string }>(facts, ids, { forkOf: 1 });
    frontier = new Set();
    for (const id of ids) {
      const parent = rows.get(id)?.forkOf;
      forkParent.set(id, parent);
      if (parent) frontier.add(parent);
    }
  }
  return { forkParent, siblings, existingForks };
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
  await col(spaceCollection(spaceId, 'tombstones')).deleteMany(asFilter({
    type, $or: items.map(i => (i.via !== undefined ? { _id: i.id, storedVia: i.via } : { _id: i.id, seq: { $lt: i.below } })),
  }));
}
