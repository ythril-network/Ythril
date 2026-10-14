/**
 * What a move carries, and in what order — decided by READING, before anything is written.
 *
 * ## The question it answers
 *
 * *"Which rows, links and jobs go to which new ids when `src` moves to `dst`; what is already standing at those ids; and how are they
 * grouped so each transaction stays under the byte budget?"* The cascade (`files/move-cascade.ts`) applies the answer; this decides
 * it, so the refusal of a collision happens before a byte or a tombstone is written (a move refused AFTER its bytes moved is a move
 * stranded).
 *
 * ## One selection, the delete's
 *
 * The rows a file leaves are `rowsOfFiles` (`files/derived-rows.ts`), the same selection a delete removes: the caption and face rows
 * under an extracted image and the children of an arrived sidecar included. Orphans move too: a directory's roots are its live file
 * rows AND every parent a derived row under it names, so a chunk whose file row is gone is carried, not left at a path that no
 * longer exists.
 *
 * ## What the destination holds decides the outcome (the truth table is {@link holdsAtDestination}'s)
 *
 *  - **nothing**: the rows move;
 *  - **a flagged row** (the audit record a soft delete leaves): it is removed, in the transaction of the batch that carries the
 *    file, and the moved record is the live row there — writing a path clears its flag;
 *  - **debris** (a derived row whose parent is gone or flagged): removed in the same transaction, since nothing live owns it;
 *  - **a live thing's rows** at an id the moved set takes: before the bytes, REFUSED (`DestinationExists`, nothing written): a move
 *    never replaces anything. After them (the finish of an owed move) the moved set's OWN rows at those ids are replaced (a late write at
 *    an id its batch already moved), and rows of ANY OTHER live file refuse the finish (`DestinationHeldAfterMove`), which strands
 *    nothing: the move stays owed until that file is gone.
 *
 * ## Batches
 *
 * Rows are grouped by the file they belong to (a file, its chunks, its sidecars and what hangs under them move in one
 * transaction), and groups are packed under the byte budget (`moveTiming().txnBytes`). A file larger than the budget is split by row
 * id range: its rows only ever move to ids derived from their own, so a split leaves no row at neither id. The sizes are the stored
 * documents' own (`$bsonSize`), read in the same chunks as everything else.
 */
import { col, asFilter } from '../db/mongo.js';
import { READ_CHUNK, readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { inChunks } from '../util/chunks.js';
import { inOneCommandChunks } from '../db/one-command.js';
import { escapeRegex } from '../util/redos.js';
import { MAX_ANCESTRY } from '../brain/suppress-embeddings.js';
import { fileLinkSourcesUnder } from '../brain/link-adjacency.js';
import type { FileMetaDoc } from '../config/types.js';
import { rekeyedRow } from '../sync/local-only-fields.js';
import { rootsOfDirectory, rowsOfFiles } from './derived-rows.js';
import { jobIdsOwnedBy } from './media/job-queue.js';
import { idAfterMove, movedId, movedRoot, parentOfSidecar, sidecarsOwnedBy, CONVERTED_ROOT, EXTRACTED_ROOT, type PathKind } from './moved-paths.js';

/** One row a move carries. */
export interface PlannedRow {
  from: string;
  to: string;
  /** The top-most row it hangs under in the carried set (itself for a file row): rows of one group travel in one transaction when they fit. */
  group: string;
  /** Its stored size in bytes. */
  bytes: number;
  /** Whether it is a file's own row (no parent), as against a row derived from one. */
  top: boolean;
}

/** What one transaction of a move carries. */
export interface MoveBatch {
  rows: PlannedRow[];
  /** The file ids whose link rows this batch converges onto their new ids. */
  linkFiles: string[];
  /** The jobs this batch re-keys. */
  jobIds: string[];
  /** The ids among this batch's new ids that hold a flagged audit row (`flagged`), and those whose row the batch's transaction replaces (`replaced`): debris, and — once the bytes have moved — the move's own late rows. Never a live file's. */
  flagged: string[];
  replaced: string[];
}

export interface MovePlan {
  src: string;
  dst: string;
  kind: PathKind;
  rows: PlannedRow[];
  /** The ids of the plan's new ids that hold a flagged audit row, those the batch's transaction deletes to take them, and those another file's record holds. */
  flaggedAtDestination: ReadonlySet<string>;
  replacedAtDestination: ReadonlySet<string>;
  refusedAtDestination: readonly HeldId[];
  /** File ids at `src` whose links follow: every file row carried, and every file under `src` that is the `from` of a link row. */
  linkFiles: string[];
  jobIds: string[];
}

/**
 * A row as it is stored at its new id: a plain re-key of the stored row (`rekeyedRow`: a record written HERE, nobody's delivery, none
 * of the old path's sync agreement), its `path` the new id, its parent and its converted-Markdown pointer re-rooted by the SAME rule
 * as its id. The pointer is set here, by the row that holds it, so the move writes none by a scan on a field that has no index.
 * Everything else, the `seq`, the author and the stored `updatedAt`, is the stored row's: this write stamps no version, so it must not
 * move the timestamp read beside the version.
 */
export function rebuiltFileRow(row: FileMetaDoc, to: string, src: string, dst: string): FileMetaDoc {
  const parent = row.parentFileId === undefined ? undefined : idAfterMove(row.parentFileId, src, dst);
  const converted = row.convertedFileId === undefined ? undefined : idAfterMove(row.convertedFileId, src, dst);
  const patch: Pick<FileMetaDoc, '_id' | 'path'> & Partial<Pick<FileMetaDoc, 'parentFileId' | 'convertedFileId'>> = { _id: to, path: to };
  if (parent !== undefined) patch['parentFileId'] = parent;
  if (converted !== undefined) patch['convertedFileId'] = converted;
  return rekeyedRow(row, patch) as FileMetaDoc;
}

/** Each id's parent, flag and stored size, in chunks: one aggregation per chunk, projecting a size instead of the document. */
async function rowFacts(spaceId: string, ids: readonly string[]): Promise<Array<{ _id: string; parentFileId?: string; deletedAt?: string; bytes: number }>> {
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const out: Array<{ _id: string; parentFileId?: string; deletedAt?: string; bytes: number }> = [];
  for (const part of inChunks([...ids], READ_CHUNK)) {
    const rows = await files.aggregate([
      { $match: { _id: { $in: part } } },
      { $project: { parentFileId: 1, deletedAt: 1, bytes: { $bsonSize: '$$ROOT' } } },
    ]).toArray();
    out.push(...rows as typeof out);
  }
  return out;
}

/** Whether any file row stands under one of the prefixes the moved set's ids can take at the destination of a DIRECTORY. */
async function anythingUnderDestination(spaceId: string, dst: string): Promise<boolean> {
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const root = movedRoot(dst);
  for (const prefix of [`${root}/`, `${CONVERTED_ROOT}${root}/`, `${EXTRACTED_ROOT}${root}/`, `${root}#`]) {
    if (await files.findOne(asFilter<FileMetaDoc>({ _id: { $regex: `^${escapeRegex(prefix)}` } }), { projection: { _id: 1 } }) !== null) return true;
  }
  return false;
}

/** When a plan is read, relative to the move's bytes: before them a refusal costs nothing; after them it strands a move whose bytes have gone. */
export type PlanPhase = 'before-the-bytes' | 'after-the-bytes';

/** An id the moved set takes, which another file's record holds: `heldBy` is the top of its chain, the file whose record it is. */
export interface HeldId { id: string; heldBy: string }

/** What stands at the ids a move takes, as {@link holdsAtDestination} classifies it. */
export interface DestinationHolds {
  /** Ids holding a flagged audit row: removed in the batch's transaction. */
  flagged: Set<string>;
  /** Ids the batch's transaction deletes to take them: debris, and (after the bytes) the move's own rows. */
  replaced: Set<string>;
  /** Ids the phase refuses on. */
  refused: HeldId[];
}

/** Whether `id` is `root`, or anything that belongs to it: under it, a chunk of it, or its sidecar (`movedId` answers it for every spelling). */
const belongsTo = (id: string, root: string): boolean => movedId(id, root, root) !== null;

/**
 * What stands at the ids `rows` take, and what the PHASE does about it — the one classification, asked before the bytes (a refusal that
 * costs nothing), after them (the finish of an owed move) and for ONE batch whose plan went stale. Nothing throws from here: the callers
 * say what a refusal is (`DestinationExists` before the bytes, `DestinationHeldAfterMove` after).
 *
 * ## The truth table
 *
 * For each planned row whose new id is not itself moving, the stored row there is:
 *
 *  - a **flagged** audit row (a soft delete's record): `flagged`, removed by the batch's transaction; writing a path clears its flag;
 *  - a row with **no parent** (a file's own row): `foreign` — a live file's record at an id the move takes. A row of the moved file
 *    cannot be here: its id is no longer in the plan once its batch moved it;
 *  - a row **derived** from another (its `parentFileId` chain followed to its end, at most `MAX_ANCESTRY` levels):
 *      - the chain ends at a row that is absent or flagged: **debris**, the rows a deleted file left, removed by the transaction;
 *      - it ends at a live row inside the DESTINATION's own subtree (`belongsTo(top, dst)`): **own** — a row this move's earlier batch
 *        carried and re-rooted under the destination (`rebuiltFileRow`), or a late write at an old id whose same id was carried;
 *      - it ends at a live row elsewhere, or does not end within the levels read (a cycle): **foreign**, refused. A chain that cannot
 *        be followed is never read as debris: debris is deleted, and what cannot be explained is not.
 *
 * ## What the phase does with it
 *
 *  - `before-the-bytes`: `refused` = foreign and own (a live thing's rows are at the destination before anything moved: nothing there
 *    is the move's); `replaced` = debris.
 *  - `after-the-bytes`: `refused` = foreign; `replaced` = debris and own. A straggler (a late writer's row at an OLD id whose chunk id
 *    the batch already moved: the same id at both ids) classifies own and is replaced: the straggler's row moves and wins.
 *
 * ## Cost
 *
 * One `$in` read of the rows at the new ids, then one per level of ancestry over the DISTINCT parent ids, never one per row; a
 * directory's destination is probed by prefix first, so the common case (nothing there) reads no ids at all.
 */
export async function holdsAtDestination(
  spaceId: string, rows: readonly PlannedRow[], to: string, kind: PathKind, phase: PlanPhase,
): Promise<DestinationHolds> {
  const holds: DestinationHolds = { flagged: new Set(), replaced: new Set(), refused: [] };
  if (rows.length === 0 || (kind === 'directory' && !await anythingUnderDestination(spaceId, to))) return holds;
  const moving = new Set(rows.map(r => r.from));
  const filesColl = spaceCollection(spaceId, 'files');
  type Held = { _id: string; parentFileId?: string; deletedAt?: string };
  const fields = { parentFileId: 1, deletedAt: 1 } as const;
  const atDestination = await readStoredById<Held>(filesColl, rows.map(r => r.to).filter(id => !moving.has(id)), fields);

  // Each derived row's chain, one level per read. `looking` maps a row at the destination to the id of the parent now being read.
  let looking = new Map<string, string>();
  const refuse = (id: string, heldBy: string): void => { holds.refused.push({ id, heldBy }); };
  for (const [id, hit] of atDestination) {
    if (hit.deletedAt !== undefined) holds.flagged.add(id);
    else if (hit.parentFileId === undefined) refuse(id, id);
    else looking.set(id, hit.parentFileId);
  }
  for (let level = 0; level < MAX_ANCESTRY && looking.size > 0; level++) {
    const parents = await readStoredById<Held>(filesColl, [...looking.values()], fields);
    const next = new Map<string, string>();
    for (const [id, at] of looking) {
      const parent = parents.get(at);
      if (parent === undefined || parent.deletedAt !== undefined) holds.replaced.add(id);
      else if (parent.parentFileId !== undefined) next.set(id, parent.parentFileId);
      else if (!belongsTo(at, to)) refuse(id, at);
      else if (phase === 'after-the-bytes') holds.replaced.add(id);
      else refuse(id, at);
    }
    looking = next;
  }
  for (const [id, at] of looking) refuse(id, at);
  return holds;
}

/**
 * Decide what moves where, and what the destination holds — reads only. `kind` is what `src` IS (read from the disk by the caller).
 * Run once before the bytes (so a refusal costs nothing) and once after them (so the rows carried are those there are NOW, not those
 * before a late conversion); `phase` says which, and what the destination's holds mean for it ({@link holdsAtDestination}). It does not
 * throw for rows that stand at the destination: it hands them back in `refusedAtDestination`, and its callers refuse.
 */
export async function planMove(spaceId: string, src: string, dst: string, kind: PathKind, phase: PlanPhase): Promise<MovePlan> {
  const from = movedRoot(src);
  const to = movedRoot(dst);
  if (!from || !to) throw new RangeError('A move needs two paths below the space root');

  // The roots: a file's own id; a directory's are the delete's too (`rootsOfDirectory`).
  const roots = kind === 'file' ? [from] : await rootsOfDirectory(spaceId, from);
  const { ids } = await rowsOfFiles(spaceId, roots, await sidecarsOwnedBy(spaceId, from, kind));

  const facts = (await rowFacts(spaceId, [...ids])).filter(r => r.deletedAt === undefined);
  const byId = new Map(facts.map(r => [r._id, r]));
  const groupOf = (id: string): string => {
    let at = id;
    for (let depth = 0; depth < MAX_ANCESTRY; depth++) {
      const parent = byId.get(at)?.parentFileId;
      if (parent === undefined || !byId.has(parent)) break;
      at = parent;
    }
    return at;
  };
  const rows: PlannedRow[] = facts.map(r => ({
    from: r._id, to: idAfterMove(r._id, from, to), group: groupOf(r._id), bytes: r.bytes, top: r.parentFileId === undefined,
  })).sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const { flagged, replaced, refused } = await holdsAtDestination(spaceId, rows, to, kind, phase);

  // Links follow every file row carried, and every file under the source that holds links (a deleted file leaves its links behind).
  const linkFiles = new Set<string>(rows.filter(r => r.top).map(r => r.from));
  if (kind === 'file') linkFiles.add(from);
  else for (const f of await fileLinkSourcesUnder(spaceId, from)) linkFiles.add(f);

  return { src: from, dst: to, kind, rows, flaggedAtDestination: flagged, replacedAtDestination: replaced, refusedAtDestination: refused, linkFiles: [...linkFiles].sort(), jobIds: await jobIdsOwnedBy(spaceId, from, kind) };
}

/**
 * Pack the plan into batches under `budget` bytes: groups stay whole when they fit, a group over the budget is cut by row id into
 * slices that each fit (a single row over the budget is a slice of its own). Links and jobs ride with the batch that carries their
 * file's row; any without one (links of a file that has no row, a job whose file row is gone) ride with the first batch.
 */
export function batchesOf(plan: MovePlan, budget: number): MoveBatch[] {
  const groups = new Map<string, PlannedRow[]>();
  for (const r of plan.rows) { const g = groups.get(r.group); if (g) g.push(r); else groups.set(r.group, [r]); }
  // The greedy packing is `inOneCommandChunks`'s, over the groups and then, for a group that is over the budget by itself (it is alone
  // in its chunk, by that function's rule), over its rows: what stays here is that a group is kept whole when it fits.
  const total = (group: readonly PlannedRow[]): number => group.reduce((n, r) => n + r.bytes, 0);
  const pack = { maxItems: Number.MAX_SAFE_INTEGER, maxBytes: budget };
  const slices = inOneCommandChunks([...groups.values()], { ...pack, bytesOf: total }).flatMap(chunk =>
    chunk.length === 1 && total(chunk[0]!) > budget
      ? inOneCommandChunks(chunk[0]!, { ...pack, bytesOf: r => r.bytes })
      : [chunk.flat()]);
  const batches: MoveBatch[] = slices.map(rows => ({ rows, linkFiles: [], jobIds: [], flagged: [], replaced: [] }));
  if (batches.length === 0) batches.push({ rows: [], linkFiles: [], jobIds: [], flagged: [], replaced: [] });
  const batchOfFile = new Map<string, MoveBatch>();
  for (const b of batches) for (const r of b.rows) {
    if (r.top && !batchOfFile.has(r.from)) batchOfFile.set(r.from, b);
    if (plan.flaggedAtDestination.has(r.to)) b.flagged.push(r.to);
    if (plan.replacedAtDestination.has(r.to)) b.replaced.push(r.to);
  }
  for (const f of plan.linkFiles) (batchOfFile.get(f) ?? batches[0]!).linkFiles.push(f);
  for (const j of plan.jobIds) (batchOfFile.get(parentOfSidecar(j)?.parent ?? j) ?? batches[0]!).jobIds.push(j);
  return batches.filter(b => b.rows.length > 0 || b.linkFiles.length > 0 || b.jobIds.length > 0);
}
