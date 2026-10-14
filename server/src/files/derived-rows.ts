/**
 * Which file rows descend from some file rows — the one walk down `parentFileId`.
 *
 * ## What it prevents
 *
 * A file's derived rows are not all its children. A conversion writes chunk rows and sidecar rows whose `parentFileId` is the
 * file, and the media worker then writes a caption chunk and face chunks for each extracted image whose `parentFileId` is the
 * IMAGE: two levels down, owned by the file and named by nothing the file's own id selects. The vector sweep walked down to
 * `MAX_ANCESTRY` to reach them (`dropFileVectors`); the delete read only the first level, so a deleted document left every
 * caption and every face record of its images behind, still searchable, with no file to belong to (bundle-71, Q-349). Two
 * walks over the same tree, one of them short, is how a derived row outlives its file — so both ask here.
 *
 * ## The rule
 *
 * The roots and every row beneath them down to `MAX_ANCESTRY` levels (`files/ancestry.ts`: how far up `parentFileId` a
 * derived record looks for its owner, so nothing is deeper), read a level at a time by the `parentFileId` index, one `$in` per
 * `READ_CHUNK`. A row reached twice is counted once. A root that has no row, or no children, is still returned: the answer is
 * "these and what descends from them", whether or not they are stored.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { distinctStringsOf } from '../db/distinct-strings.js';
import { inChunks } from '../util/chunks.js';
import { MAX_ANCESTRY } from './ancestry.js';
import { escapeRegex } from '../util/redos.js';
import { idsUnder, movedRoot, type Sidecar } from './moved-paths.js';
import { LIVE_FILE_ROW } from './live-file-row.js';
import type { FileMetaDoc } from '../config/types.js';

/** `roots` and the ids of every file row derived from them, however deep (to `MAX_ANCESTRY`). */
export async function rowsDerivedFrom(spaceId: string, roots: readonly string[]): Promise<Set<string>> {
  const reached = new Set(roots);
  if (reached.size === 0) return reached;
  const files = col<Record<string, unknown>>(spaceCollection(spaceId, 'files'));
  let frontier = [...reached];
  for (let depth = 0; depth < MAX_ANCESTRY && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const part of inChunks(frontier, READ_CHUNK)) {
      const rows = await files.find(asFilter({ parentFileId: { $in: part } }), { projection: { _id: 1 } }).toArray();
      for (const r of rows) { const id = String(r['_id']); if (!reached.has(id)) { reached.add(id); next.push(id); } }
    }
    frontier = next;
  }
  return reached;
}

/** What a file (or a directory's files) leaves, as rows: see {@link rowsOfFiles}. */
export interface FileRowSet {
  /** The rows standing at the sidecars' own paths: derived rows (with their parent) and ARRIVED top-level rows (no parent). */
  atSidecars: ReadonlyArray<Pick<FileMetaDoc, '_id' | 'parentFileId'>>;
  /** The roots, the rows at the sidecars' paths and every row derived from either, at every level. Ids only: a root with no row is in it. */
  ids: ReadonlySet<string>;
}

/**
 * THE one answer to "what rows does a file leave" — the selection a delete removes and a move carries.
 *
 * ## What it prevents
 *
 * A delete and a move that each select these rows their own way miss what only the other reaches: the caption and face rows of an
 * extracted image, and a child of an arrived converted sidecar. A moved file's delete would then find nothing to remove and leave
 * them, searchable, belonging to nothing (Q-314). One selection serves both, so the weaker one cannot win.
 *
 * ## The rule
 *
 * `roots` are file ids (whether or not they have a row); `owned` are the sidecars those files own (`sidecarsOwnedBy`, or
 * `sidecarsOf` for a directory's two trees). The rows standing at a sidecar's own path are read (a converted file by id, a tree by
 * its prefix with the slash, so `d` is not `d2`), and everything that derives from a root or from one of those rows is
 * {@link rowsDerivedFrom}. Reads only: what the caller does with the set (remove it, re-key it) is the caller's.
 */
export async function rowsOfFiles(spaceId: string, roots: readonly string[], owned: readonly Sidecar[]): Promise<FileRowSet> {
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  // The rows at the sidecars' own paths: a converted file by id, a tree by prefix (with its slash, so `d` is not `d2`).
  const atSidecars = owned.length === 0 ? [] : await files.find(
    asFilter<FileMetaDoc>({ $or: idsUnder(owned) }),
    { projection: { _id: 1, parentFileId: 1 } },
  ).toArray() as Array<Pick<FileMetaDoc, '_id' | 'parentFileId'>>;
  return { atSidecars, ids: await rowsDerivedFrom(spaceId, [...roots, ...atSidecars.map(r => r._id)]) };
}

/**
 * Remove the ROWS derived from `ids` (every row whose parent is one of them): the row half of taking away what a file left, shared by the
 * delete of a file's conversion (`deleteConversionArtifacts`) and by a peer's tombstone that removes only a record (`removeOnlyTheRecordNamed`),
 * so neither spells the delete a second way. `ids` is {@link rowsOfFiles}'s set, which holds every level, so the caption and face rows beneath an
 * extracted image go with it. It removes no bytes and not the roots' own rows, and a caller revokes the claims of the jobs first.
 */
export async function deleteRowsDerivedFrom(spaceId: string, ids: ReadonlySet<string>): Promise<void> {
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  for (const part of inChunks([...ids], READ_CHUNK)) {
    await files.deleteMany(asFilter<FileMetaDoc>({ parentFileId: { $in: part } }));
  }
}

/**
 * THE one answer to "the roots of everything a directory holds": the live file rows under `dir/` and every parent a derived row under
 * `dir/` names — so a derived row whose own parent has no row (an orphan: the file it came from is gone) still has a root, and the
 * walk down from the roots ({@link rowsOfFiles}) reaches it.
 *
 * ## What it prevents
 *
 * Taking only the top-level rows by id prefix would never reach an orphan derived row a move carried (re-rooted under the
 * destination): the walk would begin at rows, and the orphan's parent is not one. So a directory's roots are selected the way a move
 * takes them, and one selection of "what a directory holds" serves the move and the delete, never a weaker one beside it.
 *
 * `dir` is a path as the stores key it (`movedRoot`), without its slash: the slash is added here, so `d` never takes `d2`. Reads only.
 * An empty `dir` is refused: it would name every row in the space.
 */
export async function rootsOfDirectory(spaceId: string, dir: string): Promise<string[]> {
  const root = movedRoot(dir);
  if (!root) throw new RangeError('A directory\'s roots are asked of a path, and this one is empty');
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const prefix = `^${escapeRegex(`${root}/`)}`;
  const live = (await files.find(asFilter<FileMetaDoc>({ _id: { $regex: prefix }, ...LIVE_FILE_ROW }), { projection: { _id: 1 } }).toArray()).map(r => String(r._id));
  const parents = await distinctStringsOf(files, 'parentFileId', asFilter<FileMetaDoc>({ parentFileId: { $regex: prefix } }));
  return [...new Set([...live, ...parents])];
}
