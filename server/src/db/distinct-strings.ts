/**
 * The distinct string values one field holds among the documents that match a filter — however many there are.
 *
 * ## The question it answers
 *
 * "Which different values does `field` take over these documents?" For the callers that ask it of a field a user's data fills (a
 * directory's file ids, the files links start from), the answer grows with the data.
 *
 * ## What it prevents
 *
 * The driver's `distinct` answers in ONE reply, and a reply is capped at 16 MB: a directory with enough files under it failed its
 * move, its abandon and its delete with a size error, where the cursor read this replaced had no such ceiling. The values are read here
 * as an aggregation's cursor, batch after batch, so the only bound is memory for the values themselves, which the caller needs anyway.
 *
 * ## What it guarantees, and no more
 *
 * - Every matching document's value is returned exactly once. A failure throws: a partial answer is never returned, because a caller
 *   that moves or deletes by what it was told would act on part of a directory.
 * - Only string values are returned: a document where the field is absent, null or not a string contributes nothing. The field is
 *   one string per document, never an array of them.
 * - The filter is the caller's, combined with that rule by `$and`, so a filter that names the field itself (a prefix `$regex` on it) is
 *   not overwritten.
 * - The grouping may spill to disk, so a large distinct set is not refused for the aggregation's memory limit.
 * - `hint` names the index the read must use: a collection without it FAILS the read instead of scanning the collection, for a caller
 *   that would rather fail than pay a collection scan (or act on an answer read some other way).
 * - `maxTimeMS` bounds the read for a caller under a deadline; past it the read throws the store's `MaxTimeMSExpired`, never a partial set.
 */
import type { Collection, Document, Filter } from 'mongodb';

export async function distinctStringsOf<T extends Document>(
  collection: Collection<T>, field: string, filter: Filter<T>, opts: { hint?: string; maxTimeMS?: number } = {},
): Promise<string[]> {
  if (!field || field.startsWith('$')) throw new RangeError('distinctStringsOf: the field is a document path, not an expression');
  // With no filter of the caller's, the group runs alone and the strings are kept here: a whole-collection distinct then reads ONE KEY PER
  // VALUE of an index on the field (DISTINCT_SCAN), where any `$match`, even the `$type` one, plans a walk of every key (bundle-268 probe t9:
  // 9 keys against 20,000). A group's `_id` is the field's whole value, so an array value is dropped like any other non-string.
  const unfiltered = Object.keys(filter as Document).length === 0;
  const cursor = collection.aggregate<{ _id: unknown }>([
    ...(unfiltered ? [] : [{ $match: { $and: [filter as Document, { [field]: { $type: 'string' } }] } }]),
    { $group: { _id: `$${field}` } },
  ], { allowDiskUse: true, ...(opts.hint !== undefined ? { hint: opts.hint } : {}), ...(opts.maxTimeMS !== undefined ? { maxTimeMS: opts.maxTimeMS } : {}) });
  const values: string[] = [];
  for await (const group of cursor) if (typeof group._id === 'string') values.push(group._id);
  return values;
}
