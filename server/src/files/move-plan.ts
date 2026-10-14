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
 * ## What the destination holds decides the outcome (the truth table)
 *
 *  - **nothing**: the rows move;
 *  - **a flagged row** (the audit record a soft delete leaves): it is removed, in the transaction of the batch that carries the
 *    file, and the moved record is the live row there — writing a path clears its flag;
 *  - **a live file's rows at the ids the moved set takes** (a rename onto an existing file replaces it): replaced, in the same
 *    transaction. Rows of the replaced file at ids the moved set does not take are left, as ever;
 *  - **rows of ANOTHER file at an id the moved set takes**: refused, `DestinationTakenByOther`, with nothing written. A derived row
 *    at a moved id belongs to the occupant when its parent is itself an id the moved set takes; otherwise it belongs to someone else.
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
import { DestinationExists } from './act-answers.js';
import { rootsOfDirectory, rowsOfFiles } from './derived-rows.js';
import { jobIdsOwnedBy } from './media/job-queue.js';
import { idAfterMove, movedRoot, parentOfSidecar, sidecarsOwnedBy, CONVERTED_ROOT, EXTRACTED_ROOT, type PathKind } from './moved-paths.js';

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
  /** The ids of this batch's new ids that hold a flagged audit row, and those that hold a live occupant's row. */
  flagged: string[];
  replaced: string[];
}

export interface MovePlan {
  src: string;
  dst: string;
  kind: PathKind;
  rows: PlannedRow[];
  flaggedAtDestination: ReadonlySet<string>;
  replacedAtDestination: ReadonlySet<string>;
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

/**
 * What stands at the ids `rows` take, classified by the truth table in the module docblock: the flagged audit rows to remove and the
 * live occupant's rows to replace. Throws `DestinationTakenByOther` for rows of another file. A directory's destination is probed by
 * prefix first, so the common case (nothing there) reads no ids at all. Also asked again for ONE batch whose plan went stale.
 */
export async function holdsAtDestination(
  spaceId: string, rows: readonly PlannedRow[], to: string, kind: PathKind,
): Promise<{ flagged: Set<string>; replaced: Set<string> }> {
  const flagged = new Set<string>();
  const replaced = new Set<string>();
  if (rows.length === 0 || (kind === 'directory' && !await anythingUnderDestination(spaceId, to))) return { flagged, replaced };
  const moving = new Set(rows.map(r => r.from));
  const takes = new Set(rows.map(r => r.to));
  const held = await readStoredById<{ _id: string; parentFileId?: string; deletedAt?: string }>(
    spaceCollection(spaceId, 'files'), rows.map(r => r.to).filter(id => !moving.has(id)), { parentFileId: 1, deletedAt: 1 });
  for (const r of rows) {
    const hit = held.get(r.to);
    if (!hit) continue;
    if (hit.deletedAt !== undefined) flagged.add(r.to);
    else if (hit.parentFileId === undefined || takes.has(hit.parentFileId)) replaced.add(r.to);
    else {
      throw new DestinationExists(to, 'rows');
    }
  }
  return { flagged, replaced };
}

/**
 * Decide what moves where, and what the destination holds — reads only. `kind` is what `src` IS (read from the disk by the caller).
 * Throws `DestinationTakenByOther` when rows of another file stand at an id the moved set takes. Run once before the bytes (so the
 * refusal costs nothing) and once after them (so the rows carried are those there are NOW, not those before a late conversion).
 */
export async function planMove(spaceId: string, src: string, dst: string, kind: PathKind): Promise<MovePlan> {
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

  const { flagged, replaced } = await holdsAtDestination(spaceId, rows, to, kind);

  // Links follow every file row carried, and every file under the source that holds links (a deleted file leaves its links behind).
  const linkFiles = new Set<string>(rows.filter(r => r.top).map(r => r.from));
  if (kind === 'file') linkFiles.add(from);
  else for (const f of await fileLinkSourcesUnder(spaceId, from)) linkFiles.add(f);

  return { src: from, dst: to, kind, rows, flaggedAtDestination: flagged, replacedAtDestination: replaced, linkFiles: [...linkFiles].sort(), jobIds: await jobIdsOwnedBy(spaceId, from, kind) };
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
