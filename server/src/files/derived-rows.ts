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
 * The roots and every row beneath them down to `MAX_ANCESTRY` levels (`brain/suppress-embeddings.ts`: how far up `parentFileId` a
 * derived record looks for its owner, so nothing is deeper), read a level at a time by the `parentFileId` index, one `$in` per
 * `READ_CHUNK`. A row reached twice is counted once. A root that has no row, or no children, is still returned: the answer is
 * "these and what descends from them", whether or not they are stored.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { inChunks } from '../util/chunks.js';
import { MAX_ANCESTRY } from '../brain/suppress-embeddings.js';

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
