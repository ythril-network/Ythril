/**
 * The ONE table of schemas this instance must refuse, whichever door they arrive by (`Q-215`, `Q-216`; R6-16).
 *
 * ## The question it answers
 *
 * *"What is a type schema this instance will not store?"* — answered once, because the answer used to be written once PER DOOR.
 * The inline door (space PATCH, `schema_update`, the two schema PUTs) parsed through `TypeSchemaZ`; the schema library carried a
 * hand-built copy of it that accepted a ReDoS naming pattern, did not know the collection a type sits under, and a peer's
 * passed `meta_change` round reached the stores with no parse at all. Each door was individually defensible and the gap was only
 * visible from outside, which is why the rows live here and every door's test reads them rather than keeping a list of its own.
 *
 * ## What a row is
 *
 * `{ id, kind, type, schema, mentions, doors }`: the type schema, the knowledge-type collection it is filed under, a pattern the
 * refusal must match (a refusal for the WRONG reason — the strict-object "unrecognized key" a door answers for a field it simply
 * has not heard of — is the very difference this table exists to expose, so a reason is part of the row), and the doors the row
 * applies to. `'structure'` rows are refused by the shape of the schema itself and so apply to every door that stores one;
 * `'ref'` rows are about a `$ref` and so apply only where a reference is saved.
 *
 * ## What is NOT here, on purpose
 *
 * - `retention` on a library entry: the one deliberate difference of the library door, asserted by `library-retention-refusal`.
 * - A rule that fails to compile (F-46): rows for it are listed in {@link PLACEHOLDER_ROWS} and become real when a type schema
 *   accepts a `rules` field. A row that cannot be driven yet is listed rather than omitted, so the plan's table is whole.
 *
 * ## The guards a hand-written copy drops
 *
 * - **The floor.** {@link INVALID_SCHEMAS} asserts it is not empty when a caller reads it through {@link invalidRows}.
 * - **A reason per row.** "Refused" is not enough: an unknown-key refusal is also a refusal.
 */
import assert from 'node:assert/strict';

/** A quantified group holding a quantifier: `safeRegexTest` declines to RUN it, so a stored one rejects every record for ever. */
export const REDOS_PATTERN = '^D[0-9]+:[0-9]+(,D[0-9]+:[0-9]+)*$';

/** One character past the 500 a stored pattern may be. */
export const OVERLONG_PATTERN = 'x'.repeat(501);

/** What a refusal for a risky pattern says (`REDOS_REFUSAL` in `util/redos.ts`), in the words that identify it. */
export const REDOS_REASON = /redos|too complex|cannot be evaluated|unsafe|catastrophic|backtrack/i;
/** What a refusal for a pattern over the length cap says. */
export const OVERLONG_REASON = /500|too long|at most|characters|string must contain/i;

/** The doors a SHAPE refusal applies to: every place a type schema is stored from a caller or a peer. */
export const STRUCTURE_DOORS = Object.freeze([
  'space-patch', 'mcp-schema-update', 'put-schema', 'put-single-type',
  'library-post', 'library-put', 'library-patch',
  'peer-layer-pull', 'round-conclusion', 'round-adoption',
]);

/** Rows refused by the shape of the schema, the same on every door in {@link STRUCTURE_DOORS}. */
export const INVALID_SCHEMAS = Object.freeze([
  {
    id: 'a ReDoS naming pattern', kind: 'entity', type: 'RedosNamed', mentions: REDOS_REASON,
    schema: { namingPattern: REDOS_PATTERN },
  },
  {
    id: 'a ReDoS property pattern', kind: 'fact', type: 'RedosProp', mentions: REDOS_REASON,
    schema: { propertySchemas: { turn: { type: 'string', pattern: REDOS_PATTERN } } },
  },
  {
    id: 'an overlong naming pattern', kind: 'entity', type: 'OverlongNamed', mentions: OVERLONG_REASON,
    schema: { namingPattern: OVERLONG_PATTERN },
  },
  {
    id: 'an overlong property pattern', kind: 'fact', type: 'OverlongProp', mentions: OVERLONG_REASON,
    schema: { propertySchemas: { turn: { type: 'string', pattern: OVERLONG_PATTERN } } },
  },
  {
    // The collection-scope rule needs to know the collection, which a type object alone cannot say.
    id: 'endpoints on an entity type', kind: 'entity', type: 'EntityWithEndpoints', mentions: /edge/i,
    schema: { endpoints: { from: ['person'] } },
  },
  {
    id: 'functional on a fact type', kind: 'fact', type: 'FactFunctional', mentions: /edge/i,
    schema: { functional: true },
  },
  {
    id: 'a due-moment policy on an entity type', kind: 'entity', type: 'EntityDue', mentions: /chrono/i,
    schema: { whenDuePasses: 'nothing' },
  },
]);

/** The library entry a `$ref` row points at, and the kind it is filed under. */
export const EDGE_ENTRY = Object.freeze({
  name: 'edge-shape', knowledgeType: 'edge', typeName: 'reports_to',
  schema: { endpoints: { from: ['person'], to: ['person'] } },
});
/** An entry of the kind a `$ref` row is correct about, the control for the wrong-kind row. */
export const ENTITY_ENTRY = Object.freeze({
  name: 'person-shape', knowledgeType: 'entity', typeName: 'person',
  schema: { description: 'a person', propertySchemas: { email: { type: 'string' } } },
});

/**
 * Rows about a library `$ref` of the wrong kind. `door` names the saves they apply to: a space saving `$ref` (the four inline doors)
 * and the library changing the kind of an entry a space already references. Never inside the shared parse — a peer's library is its own.
 */
export const REF_ROWS = Object.freeze([
  { id: 'an entity type referencing an edge entry', kind: 'entity', type: 'RefToAnEdgeEntry', ref: EDGE_ENTRY.name, mentions: /edge|kind|knowledge/i },
]);

/** Rows that cannot be driven until a type schema accepts a `rules` field (F-46); listed so the plan's table is whole. */
export const PLACEHOLDER_ROWS = Object.freeze([
  { id: 'a rule that does not compile', until: 'F-46', schema: { rules: { broken: { rule: 'self.x ==', message: 'm' } } } },
]);

/** The rows, with the floor a caller cannot forget. */
export function invalidRows() {
  assert.ok(INVALID_SCHEMAS.length >= 5, `the invalid-schema table shrank to ${INVALID_SCHEMAS.length} row(s)`);
  return INVALID_SCHEMAS;
}

/** `{ typeSchemas: { <kind>: { <type>: <schema> } } }` — a row as the meta a door is handed. */
export const metaOf = (row) => ({ typeSchemas: { [row.kind]: { [row.type]: row.schema } } });

/** A library entry body for a row, as `POST /api/schema-library` takes it. */
export const entryBodyOf = (row, name = 'fixture-entry') => ({
  name, knowledgeType: row.kind, typeName: row.type, schema: row.schema,
});
