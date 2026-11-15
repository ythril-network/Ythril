/**
 * The clause that matches the records of ONE type of a kind (bundle-268, Q-744 design r3 §7.1, r4 §K): `{ <type field>: { $eq: T, $not: {
 * $type: 'array' } } }`, the type field being the kind's (`TYPE_FIELD`: `label` for an edge, `type` otherwise).
 *
 * ## What it prevents
 *
 * **An array that holds T read as a record of T.** On a field holding an array, MongoDB's `$eq` (and `$type`) match an ELEMENT, so `{ type: 'T' }`
 * also matches `['T', 'X']`, a record no type of the schema names: the stamp reads count it unclassified, and a type list would count it again
 * under T. `$type: 'array'` tests the field itself, so the guard keeps exactly the string `'T'` (probe V7). The guard lives here, so no caller
 * that builds a type clause can leave it out.
 *
 * The client builds the same clause for the Brain's "Type:" chip and the history's deep link (`client/src/app/core/type-field.ts`);
 * `the-client-type-field-is-the-servers` holds the two equal over one fixture.
 */
import { TYPE_FIELD } from '../brain/ttl.js';
import type { KnowledgeType } from '../config/types-knowledge.js';

/** The guarded equality a type name is matched by, on any type field. */
export const guardedTypeValue = (type: string): { $eq: string; $not: { $type: 'array' } } => ({ $eq: type, $not: { $type: 'array' } });

/** The guarded membership a list of type names is matched by, on any type field: the list form of {@link guardedTypeValue}. */
export const guardedTypeList = (types: readonly string[]): { $in: string[]; $not: { $type: 'array' } } => ({ $in: [...types], $not: { $type: 'array' } });

/**
 * The type match of a read over the STAMP INDEX: the plain `type` while that index holds no array-valued type field (`mayHoldArrays: false`,
 * read from its multikey flag: no stamped record then holds an array, so the plain match is exact and stays answered from the keys), and the
 * guarded one otherwise (bundle-268 design r4 amend "one rule"). The choice is made here, so no stamp reader picks the plain match blind.
 */
export const stampedTypeValue = (type: string, mayHoldArrays: boolean): string | ReturnType<typeof guardedTypeValue> =>
  (mayHoldArrays ? guardedTypeValue(type) : type);

/** {@link stampedTypeValue} for a list of names: `{ $in }` while no array can be there, the guarded {@link guardedTypeList} otherwise. */
export const stampedTypeList = (types: readonly string[], mayHoldArrays: boolean): { $in: string[] } | ReturnType<typeof guardedTypeList> =>
  (mayHoldArrays ? guardedTypeList(types) : { $in: [...types] });

/** The records of `kind` whose type is exactly the string `type`: an array that holds it is not one of them. */
export function typeClauseOf(kind: KnowledgeType, type: string): Record<string, { $eq: string; $not: { $type: 'array' } }> {
  return { [TYPE_FIELD[kind]]: guardedTypeValue(type) };
}
