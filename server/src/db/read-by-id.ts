/**
 * The stored copies of a set of ids — one projected `$in` read per chunk, the one spelling of it.
 *
 * ## Why a module (`Q-211`)
 *
 * Every read of stored records by a list of ids goes through here: the write commit's seq read-back, the arrival
 * writer, the push door's reads, the graph walks, recall's hydration of fresh hits, the reference checks, and the
 * rest. `a-record-is-read-by-id-through-one-reader.test.js` finds every `_id: { $in }` read in the tree and fails
 * on one that is not this module's, unless its defining function is allowlisted with the reason it asks a
 * different question.
 *
 * The hand-written copies each went wrong in its own way, for an id list nobody had handed it yet:
 *
 * - **The chunk.** An unbounded `$in` over a 50 000-record import is one enormous query, and the chunk is the line
 *   that looks like boilerplate. `brain/walk-reads.ts` had a second reader with no chunk at all.
 * - **The projection.** A copy with no projection fetches a vector to compare a seq.
 * - **The predicate.** A copy that SPREADS a caller's filter beside `_id` (`{ _id: { $in }, ...extra }`) lets the
 *   caller's own `_id` key REPLACE the id restriction instead of narrowing it. Here a predicate is ANDed
 *   (`andPredicates`), never spread.
 * - **The deadline.** The walk's reader gave each read `maxTimeMS` from what was left of the walk's budget; the
 *   canonical one had no deadline, so moving onto it would have lost the bound. Each chunk gets its own.
 *
 * ## What it guarantees
 *
 * - **Chunked** (`READ_CHUNK` ids per query), whatever the caller hands it, with at most `READ_PARALLEL` chunks in
 *   flight. Inside a session the chunks run one at a time, because a driver session is not used concurrently.
 * - **Projected**: the caller names the fields it reads (`fields`, an inclusion), or asks for `'all'`, which is
 *   every field but the never-returned ones (`NEVER_RETURNED_PROJECTION`). The one exception is named for its one
 *   question: `'carried'`, the stored document whole, vector included, for a WRITER that carries a stored document
 *   forward under a new id (the edge re-key of a merge) — a read that answers a caller never asks for it.
 * - **A Map keyed by the stored `_id` as a string** (`readStoredById`), never a plain object: an id is
 *   peer-supplied text, and `__proto__` as a key of a plain object is a prototype write rather than an entry. Or
 *   rows in the CALLER's id order (`readRowsById`), each id once, so the answer never depends on which chunk or
 *   which index plan a row came from.
 */
import type { ClientSession } from 'mongodb';
import { col, asFilter } from './mongo.js';
import { andPredicates } from './and-predicates.js';
import { inChunks } from '../util/chunks.js';
import { mapLimit } from '../util/map-limit.js';
import { NEVER_RETURNED_PROJECTION } from '../brain/read-projection.js';

/** Ids per read. One chunk is one page of the largest sync door, so a page costs one read. */
export const READ_CHUNK = 500;

/**
 * Chunks of one read in flight at once. A 50 000-id read is a hundred chunks: one at a time is a hundred round trips
 * end to end, all at once is a hundred queries queued on one connection pool that every request shares.
 */
export const READ_PARALLEL = 4;

/** Milliseconds a read may still take, from its caller's deadline. Throws once it is spent; `undefined` is unbounded. */
export type TimeLeft = () => number | undefined;

/**
 * The fields a reader returns: an inclusion of the ones the caller reads, `'all'` but the never-returned ones, or
 * `'carried'` — every stored field, the vector included, for a writer re-inserting the document it read (a re-key
 * carries the edge's vector across; `'all'` would drop it, and the edge would leave recall until it re-embedded).
 */
export type ReadFields = Readonly<Record<string, 1>> | 'all' | 'carried';

export interface ReadByIdOptions {
  /**
   * A predicate the rows must also satisfy (a `spaceId`, a class scope), or several, ANDed with the id restriction
   * and with each other. It is part of the QUERY, not a filter over what comes back, so an index can use it.
   */
  filter?: Readonly<Record<string, unknown>> | readonly (Readonly<Record<string, unknown>> | undefined)[];
  /** The session the read belongs to (a transaction's read-back). Its chunks then run one at a time. */
  session?: ClientSession;
  /** The caller's deadline. Asked before each chunk, whose `maxTimeMS` is what is left. */
  timeLeft?: TimeLeft;
}

/** Every stored row for `ids` (each id once), chunk by chunk, in no particular order. */
async function readChunks<T extends object>(
  collName: string, ids: readonly string[], fields: ReadFields, opts: ReadByIdOptions,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const coll = col<{ _id: string }>(collName);
  const projection = fields === 'carried' ? undefined : fields === 'all' ? NEVER_RETURNED_PROJECTION : { _id: 1, ...fields };
  const predicates = Array.isArray(opts.filter) ? opts.filter : [opts.filter as Readonly<Record<string, unknown>> | undefined];
  const { session, timeLeft } = opts;
  const chunks = await mapLimit(inChunks(unique, READ_CHUNK), session ? 1 : READ_PARALLEL, async (chunk) => {
    const ms = timeLeft?.();
    const query = andPredicates({ _id: { $in: chunk } }, ...predicates)!;
    return await coll.find(asFilter<{ _id: string }>(query), {
      ...(projection ? { projection } : {}), ...(session ? { session } : {}), ...(ms !== undefined ? { maxTimeMS: ms } : {}),
    }).toArray();
  });
  return chunks.flat() as unknown as T[];
}

/**
 * Read the stored copy of each id that exists, keyed by its `_id`.
 *
 * @param collName the full collection name (`spaceCollection(...)`)
 * @param ids the ids to read; repeats are read once
 * @param fields the fields the caller reads, as a projection of `1`s (`_id` always comes back), or `'all'`
 * @param opts a predicate ANDed with the ids, a session, a deadline
 */
export async function readStoredById<T extends object>(
  collName: string,
  ids: readonly string[],
  fields: ReadFields,
  opts: ReadByIdOptions = {},
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (const d of await readChunks<T & { _id: unknown }>(collName, ids, fields, opts)) out.set(String(d._id), d);
  return out;
}

/**
 * The same read as rows, in the order the caller named the ids (each id once; an id with no row is absent).
 *
 * For a caller that wants a list. The order is the caller's, never the chunking's or the index plan's, so the
 * answer for one id list is the same answer however it was read.
 */
export async function readRowsById<T extends object>(
  collName: string,
  ids: readonly string[],
  fields: ReadFields,
  opts: ReadByIdOptions = {},
): Promise<T[]> {
  const byId = await readStoredById<T>(collName, ids, fields, opts);
  const out: T[] = [];
  for (const id of new Set(ids)) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}
