/**
 * Does a stored record HOLD A VECTOR? The one answer, in the three spellings the store and the code need (Q-656).
 *
 * ## What it prevents
 *
 * The backfill, the suppression sweep, the completeness count and the worker each wrote "has a vector" in their own words:
 * `embedding: { $exists: true }`, `{ $isArray: '$embedding' }`, `Array.isArray(doc['embedding']) && length > 0`. They disagreed on
 * the two shapes a stored field can take besides a vector: `embedding: null` (a failed write or an import left it) and
 * `embedding: []`. `$exists: false` missed the null and `$isArray` called the empty array a vector, while the worker counts
 * neither as one, so a record with `embedding: null` was queued by neither backfill walk. One definition, a NON-EMPTY array, in:
 *
 * - {@link HOLDS_VECTOR} / {@link HOLDS_NO_VECTOR}: a query fragment (`find`, `$match`, `countDocuments`);
 * - {@link holdsVectorExpr}: an aggregation expression (`$addFields`, `$project`), short-circuit so `$size` never sees a non-array;
 * - {@link holdsVector}: the test on a document already read.
 *
 * `faceEmbedding` is another index of another model and is not this question. Imports nothing, so every module can ask it
 * (`a-stored-vector-is-asked-for-in-one-module` refuses a spelling of it anywhere else in `server/src`).
 */

/** The records that hold a vector, as a query fragment: the field's first element exists, so only a non-empty array matches. */
export const HOLDS_VECTOR: Readonly<Record<string, unknown>> = Object.freeze({ 'embedding.0': { $exists: true } });

/** The records that hold NO vector: the field absent, `null`, `[]`, or anything that is not a non-empty array. */
export const HOLDS_NO_VECTOR: Readonly<Record<string, unknown>> = Object.freeze({ 'embedding.0': { $exists: false } });

/** Whether the record holds a vector, as an aggregation expression. `$and` short-circuits, so `$size` is asked of an array only. */
export const holdsVectorExpr: Readonly<Record<string, unknown>> = Object.freeze({
  $and: [{ $isArray: '$embedding' }, { $gt: [{ $size: '$embedding' }, 0] }],
});

/** Whether a document read from the store holds a vector. */
export function holdsVector(doc: Readonly<Record<string, unknown>>): boolean {
  const v = doc['embedding'];
  return Array.isArray(v) && v.length > 0;
}
