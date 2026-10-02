/**
 * The stored copies of a set of ids — one projected `$in` read per chunk, the one spelling of it.
 *
 * ## Why a module
 *
 * Its callers: the write commit's read-back of the seqs it guards against (`brain/write-plan/commit.ts`), the
 * arrival writer's read of the stored copies of a page (`sync/arrivals.ts`, `batchUpsertBySeq` and the duplicate
 * read-back), and the push door's reads of tombstones, stored copies and fork ancestors (`sync/push-reads.ts`).
 * The copy that goes wrong is the one that forgets the chunk: an unbounded `$in` over a 50 000-record import is
 * one enormous query, and the chunk is the line that looks like boilerplate. Other `_id: { $in }` reads in the
 * tree predate this module and are not yet on it.
 *
 * ## What it guarantees
 *
 * - **Chunked** (`READ_CHUNK` ids per query), whatever the caller hands it.
 * - **A Map keyed by the stored `_id` as a string**, never a plain object: an id is peer-supplied text, and
 *   `__proto__` as a key of a plain object is a prototype write rather than an entry.
 * - **Projected**: the caller names the fields it reads, so a vector is never fetched to compare a seq.
 */
import { col, asFilter } from './mongo.js';
import { inChunks } from '../util/chunks.js';

/** Ids per read. One chunk is one page of the largest sync door, so a page costs one read. */
export const READ_CHUNK = 500;

/**
 * Read the stored copy of each id that exists, projected to `fields` (plus `_id`).
 *
 * @param collName the full collection name (`spaceCollection(...)`)
 * @param ids the ids to read; repeats are read once
 * @param fields the fields the caller needs, as a projection of `1`s
 */
export async function readStoredById<T extends object>(
  collName: string,
  ids: readonly string[],
  fields: Readonly<Record<string, 1>>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const unique = [...new Set(ids)];
  const coll = col<{ _id: string }>(collName);
  for (const chunk of inChunks(unique, READ_CHUNK)) {
    const docs = await coll.find(asFilter<{ _id: string }>({ _id: { $in: chunk } as unknown as string }),
      { projection: { _id: 1, ...fields } }).toArray();
    for (const d of docs) out.set(String(d._id), d as unknown as T);
  }
  return out;
}
