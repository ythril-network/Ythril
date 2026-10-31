/**
 * Does a stored record STILL HOLD A DERIVED FIELD (its vector, that vector's model, or its `matchedText`)? The one answer, in the
 * three spellings the store and the code need (Q-656).
 *
 * ## What it prevents
 *
 * A derived row (a chunk, a caption, a converted copy) whose text cannot be built is owed nothing, but the worker clears whatever
 * derived field it still holds, so the backfill has to know the row is there. The candidate query, the walk's aggregation and the
 * worker each wrote that in their own words (`$exists`, `$ne [{$type}, 'missing']`, `f in doc`), over a field list each took
 * from `UNSET_DERIVED` by hand. They agreed today, and one of them dropping the "present even as `null`" reading (`$exists`
 * counts a `null`, `$type` of a `null` is `'null'`, `in` counts it) would leave a row nobody clears and nobody queues. One
 * meaning, PRESENT EVEN AS `null`, over the field list the worker unsets, in:
 *
 * - {@link HOLDS_DERIVED}: a query fragment (`find`, `$match`, `$or` arm);
 * - {@link holdsDerivedExpr}: an aggregation expression (`$addFields`, `$project`);
 * - {@link holdsDerived}: the test on a document already read.
 *
 * `a-held-derived-field-is-asked-in-one-module` refuses a spelling of it anywhere else in `server/src`.
 */
import { UNSET_DERIVED } from '../sync/local-only-fields.js';

/** The derived fields, the worker's own list (`UNSET_DERIVED`'s keys). */
const FIELDS: readonly string[] = Object.freeze(Object.keys(UNSET_DERIVED));

/** The records holding any derived field, present even as `null`, as a query fragment. */
export const HOLDS_DERIVED: Readonly<Record<string, unknown>> = Object.freeze({ $or: FIELDS.map(f => ({ [f]: { $exists: true } })) });

/** Whether the record holds any derived field, present even as `null`, as an aggregation expression. */
export const holdsDerivedExpr: Readonly<Record<string, unknown>> = Object.freeze({
  $or: FIELDS.map(f => ({ $ne: [{ $type: `$${f}` }, 'missing'] })),
});

/** Whether a document read from the store holds any derived field, present even as `null`. */
export function holdsDerived(doc: Readonly<Record<string, unknown>>): boolean {
  return FIELDS.some(f => f in doc);
}
