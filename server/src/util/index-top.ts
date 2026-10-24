/**
 * "What is the highest value of this field across these collections" — answered by reading one document from the top of an index.
 *
 * ## The question it answers
 *
 * The highest stored `seq` below a cap (the version floor, `util/version-stamp.ts`), the highest stored `pos` of a space (the
 * records stream's seed, `sync/record-position-stream.ts`) and the highest published `positionAt` of a space's file tombstones (the
 * file stream's seed, `files/tombstones.ts`) are the same read: one `find` per collection sorted descending on the field, limited to
 * one document, the largest of the answers. It was written twice (`highestStoredSeq`, the file-tombstone `clockOf`) before a third
 * site needed it.
 *
 * ## What a copy drops
 *
 *  - **The read is served by the index and reads one document per collection**: a sort on the field alone is any index that leads with
 *    it (every keyset index here does), read backwards, so a tie needs no second key. A `$group` or an in-memory max would scan the
 *    collection, on every first write of every space after a start.
 *  - **A document without the field is not a candidate**: `match` is the caller's predicate on the field itself (`{ $type: 'number' }`,
 *    `{ $exists: true }`, a cap), so a row that carries none cannot answer `0` for a collection that has a larger one elsewhere.
 *  - **A failed read is the caller's**: nothing here catches. A reader that swallowed it would seed a clock or a floor from nothing.
 *
 * It takes the collections themselves, not their names: a collection that one module owns (the file tombstones, `files/tombstone-store.ts`)
 * is handed over by that module's own accessor, never named here.
 */
import type { Collection, Document } from 'mongodb';
import { asFilter } from '../db/mongo.js';

/**
 * The largest `field` value held by any of `collections` that satisfies `match` (a predicate on `field`, e.g. `{ $exists: true }`),
 * or `undefined` when none holds one. Values compare as the store compares them, so a collection's field must be of one type
 * (numbers or ISO text), which `match` is there to say.
 */
export async function highestStored<V extends number | string>(
  collections: ReadonlyArray<{ readonly find: unknown }>, field: string, match: Record<string, unknown>,
): Promise<V | undefined> {
  const tops = await Promise.all(collections.map(async (coll) => {
    // Any typed collection: the read is by field name, and what it returns is the caller's `V`.
    const [top] = await (coll as unknown as Collection<Document>)
      .find(asFilter<Document>({ [field]: match }), { projection: { [field]: 1 } })
      .sort({ [field]: -1 }).limit(1).toArray();
    return top?.[field] as V | undefined;
  }));
  let highest: V | undefined;
  for (const t of tops) if (t !== undefined && (highest === undefined || t > highest)) highest = t;
  return highest;
}
