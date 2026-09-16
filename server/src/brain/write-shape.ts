/**
 * What a field VALUE must look like — one table per record type, read by every door that writes one.
 *
 * ## The defect class this closes, and why it is nine defects rather than one bug
 *
 * A create door and its update door are written months apart by different hands, and they drift in one
 * direction: the create is written first, carefully, and the update is written to be permissive so a caller
 * can send one field. Nine of those drifts were measured (`W-14`..`W-22`) and every one of them is the same
 * shape — the same field, two doors, two rules, and the weaker one wins for whoever happened to use it.
 *
 * The worst of them stored `{"title": 42, "startsAt": {"$gte": "…"}}` on a chrono entry through `PATCH`,
 * fields the create door refuses and `validateDeleteFields` will not even let you DELETE because they are
 * required. A `$gte` object in a date field is not a typo landing in a record; it is a query operator sitting
 * where a string belongs.
 *
 * ## SHAPE is shared, REQUIREDNESS is not — the split that makes one table possible
 *
 * A create and an update legitimately differ about whether a field must be PRESENT: a create demands `fact`,
 * an update must not, or every `PATCH` becomes a full replace. They must never differ about what the value
 * has to LOOK LIKE if it is there.
 *
 * So this table answers exactly one question per field — *given a value, is it acceptable?* — and
 * requiredness stays at the create door where it belongs. All nine measured defects are shape or existence
 * defects, which is what makes this the right seam rather than a convenient one.
 *
 * ## The messages are the CREATE doors' messages, verbatim
 *
 * Not reworded during the unification. A caller matching on a refusal string is depending on it, and an
 * update door that starts refusing is a large enough change without also changing what it says. Where a
 * create and an update already said different things, the create's wording wins: it is the one that has been
 * refusing all along, so it is the one somebody could already be matching on.
 *
 * ## What this deliberately does NOT do
 *
 * **It does not check requiredness, and it never will.** A door asking "is this field required" from a table
 * that cannot see whether the request is a create is a door that will get it wrong.
 *
 * **It does not widen the property-value rule.** `04-brain-api.md` states the carve-out deliberately: only
 * entities refuse a nested property value. Facts, edges and chrono entries check the CONTAINER is a plain
 * object and stop there. Widening it would refuse writes that work today, which is a product decision and
 * not this module's to take.
 *
 * **It does not check a value against the space's schema.** That is `validationMode`, it is per-space, and it
 * runs inside the write functions where a violation can be recorded rather than refused.
 */
import { primitivePropertyError } from './property-values.js';
import { REF_KINDS } from '../config/types-knowledge.js';
import { CHRONO_STATUSES } from '../config/types.js';
import type { KnowledgeType } from '../config/types-knowledge.js';

/**
 * A record type this module holds a table for — the four knowledge types, DERIVED.
 *
 * Written out as a union it was a fifth place the four names live, and
 * `one-definition-of-the-knowledge-types.test.js` caught it on the commit that introduced it. That is the
 * gate working: a fifth type added later would gain a table here only if somebody remembered, and a record
 * type with no shape rules is one whose create and update can drift apart again.
 */
export type ShapedType = KnowledgeType;

/** One field's rule: a refusal, or `null` when the value is acceptable. Never called with `undefined`. */
type Check = (v: unknown) => string | null;

/** The cap on a fact's `fact`. Declared once — it was written out at three sites and absent from two more. */
export const MAX_FACT_LENGTH = 50_000;



// ── the small checks the tables are built from ──────────────────────────────────────────────

const str = (field: string): Check => v =>
  typeof v === 'string' ? null : `\`${field}\` must be a string`;

const nonEmptyStr = (field: string): Check => v =>
  typeof v === 'string' && v.trim() ? null : `\`${field}\` must be a non-empty string`;

const strArray = (field: string): Check => v =>
  Array.isArray(v) && v.every(t => typeof t === 'string')
    ? null : `\`${field}\` must be an array of strings`;

const unit = (field: string): Check => v =>
  typeof v === 'number' && v >= 0 && v <= 1
    ? null : `\`${field}\` must be a number between 0 and 1`;

const plainObject = (field: string): Check => v =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? null : `\`${field}\` must be a plain object`;

const oneOf = (field: string, allowed: readonly string[]): Check => v =>
  typeof v === 'string' && allowed.includes(v)
    ? null : `\`${field}\` must be one of: ${allowed.join(', ')}`;

/** The container rule plus the entity-only value rule, in that order — a non-object cannot have its values read. */
const entityProperties: Check = v => plainObject('properties')(v) ?? primitivePropertyError(v);

// ── the four tables ─────────────────────────────────────────────────────────────────────────

/**
 * Every field whose VALUE is constrained, per record type.
 *
 * A field absent from a table is one no door constrains — `id` is checked where identity is decided, and
 * `type` on a chrono entry is checked against the SPACE's allowlist, which this module cannot see.
 */
const SHAPE: Record<ShapedType, Record<string, Check>> = {
  fact: {
    // `nonEmptyStr` and not `str`: the create door has always refused `''`, and the update door refused it
    // too. Only the LENGTH cap was missing from the update, on both surfaces.
    fact: v => nonEmptyStr('fact')(v)
      ?? (typeof v === 'string' && v.length > MAX_FACT_LENGTH
        ? '`fact` must not exceed 50 000 characters' : null),
    type: str('type'),
    tags: strArray('tags'),
    entityIds: strArray('entityIds'),
    description: str('description'),
    properties: plainObject('properties'),
  },
  chrono: {
    title: nonEmptyStr('title'),
    startsAt: str('startsAt'),
    endsAt: str('endsAt'),
    status: oneOf('status', [...CHRONO_STATUSES]),
    confidence: unit('confidence'),
    tags: strArray('tags'),
    entityIds: strArray('entityIds'),
    memoryIds: strArray('memoryIds'),
    description: str('description'),
    properties: plainObject('properties'),
  },
  entity: {
    name: nonEmptyStr('name'),
    // The one field where the four doors disagreed about REQUIREDNESS as well as shape, and the shape half
    // is here: three doors demand a non-empty type and the REST create defaulted it to `''`. A typeless
    // entity is one `validateEntity` can never check, because `type` is what selects the schema.
    type: nonEmptyStr('type'),
    tags: strArray('tags'),
    description: str('description'),
    properties: entityProperties,
  },
  edge: {
    label: nonEmptyStr('label'),
    // 0–1, which both MCP doors have always enforced and neither REST door did. `CLAUDE.md`'s parity rule
    // settles which way that resolves without a judgement call: same parameters, same caps, same refusals.
    weight: unit('weight'),
    type: str('type'),
    description: str('description'),
    tags: strArray('tags'),
    properties: plainObject('properties'),
    fromKind: oneOf('fromKind', REF_KINDS),
    toKind: oneOf('toKind', REF_KINDS),
  },
};

/** The fields this module constrains for a type — exported so a gate can check a door covers them. */
export const shapedFields = (type: ShapedType): readonly string[] => Object.keys(SHAPE[type]);

/**
 * The first refusal for a body's field VALUES, or `null` when every value present is acceptable.
 *
 * **Only fields that are PRESENT.** An absent field is not a shape problem, and a `PATCH` naming one field
 * must not be told about the nine it did not send.
 *
 * **`undefined` is treated as absent, `null` is not.** `{"description": undefined}` does not survive JSON, so
 * a door seeing it got it from a destructure with no value — that is absence. `{"description": null}` is a
 * caller having sent something, and it is not a string.
 *
 * A returned string rather than a throw, matching `primitivePropertyError` and `arrayWriteError`: a REST
 * door answers `400` with it and an MCP handler throws it, and the doors' existing catch blocks already
 * carry `SchemaViolationError`, which means something else entirely — a violation of the SPACE's schema,
 * which a space in `warn` mode records and stores. This is refused in every mode.
 */
export function shapeError(type: ShapedType, body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  for (const [field, check] of Object.entries(SHAPE[type])) {
    if (!(field in rec) || rec[field] === undefined) continue;
    const err = check(rec[field]);
    if (err) return err;
  }
  return null;
}
