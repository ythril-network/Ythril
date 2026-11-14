/**
 * Where each knowledge kind keeps its type name, and the clause that finds a type's records: the client twin of the server's
 * `TYPE_FIELD` (server/src/brain/ttl.ts) and `typeClauseOf` (server/src/spaces/type-field-clause.ts).
 *
 * An edge's type is its `label`; every other kind's is `type`. A reader that asked `record.type` of an edge would read the edge's
 * free-text `type` field instead of its relation, which is the slip this table prevents.
 *
 * `typeClauseOf` guards the array: `$eq` alone matches an array that holds the name among others (`['T', 'X']`), and such a record
 * is not a record of T (design r4 §K, amend V7). `the-client-type-field-is-the-servers.test.js` holds both answers equal to the
 * server's over one fixture, so the two sides cannot drift.
 *
 * Plain TypeScript with no import, so Node can load it by stripping its types (the T9 test does).
 */

/** The knowledge kinds that carry a type name. */
export type TypedKind = 'entity' | 'fact' | 'edge' | 'chrono';

/** The field a kind's records keep their type name in. */
export const TYPE_FIELD: Readonly<Record<TypedKind, 'type' | 'label'>> = {
  entity: 'type', fact: 'type', edge: 'label', chrono: 'type',
};

/** The type name a record of `kind` carries, or `undefined` when it carries none or carries something that is not a name. */
export function typeNameOf(kind: TypedKind, record: object): string | undefined {
  const v = (record as Record<string, unknown>)[TYPE_FIELD[kind]];
  return typeof v === 'string' ? v : undefined;
}

/** The records of `kind` whose type is `type`, never an array that merely holds it. */
export function typeClauseOf(kind: TypedKind, type: string): Record<string, { $eq: string; $not: { $type: 'array' } }> {
  return { [TYPE_FIELD[kind]]: { $eq: type, $not: { $type: 'array' } } };
}
