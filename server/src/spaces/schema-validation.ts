/**
 * Schema validation engine for space meta definitions.
 *
 * Validates write operations against a space's `meta` block using the
 * per-type `typeSchemas` structure — each entity type / edge label /
 * fact type / chrono type owns its own property schemas, naming pattern,
 * required flags. It does NOT constrain tags: `TypeSchema` has no tag field, and the space-wide
 * suggestion list was retired in #365 — see the note further down.
 *
 * Validation is driven by `validationMode`:
 *   - "off"    → no validation (default)
 *   - "warn"   → validation runs, violations returned as warnings
 *   - "strict" → validation runs, violations cause 400 rejection
 */

import type { SpaceMeta, PropertySchema, TypeSchema, KnowledgeType } from '../config/types.js';
import { getSchemaLibrary, getConfig } from '../config/loader.js';
import { hasReDoSRisk, MAX_PATTERN_LENGTH, REDOS_REFUSAL } from '../util/redos.js';

// ── Violation type ─────────────────────────────────────────────────────────

export interface SchemaViolation {
  field: string;
  value: unknown;
  reason: string;
}

// ── Library ref resolution ─────────────────────────────────────────────────

/**
 * Resolve a single TypeSchema that may contain a `$ref` pointer to a library entry.
 * Returns the resolved inline schema, or `undefined` if the reference cannot be found.
 * Returns the schema unchanged when no `$ref` is present.
 */
export function resolveTypeSchema(schema: TypeSchema | undefined): TypeSchema | undefined {
  if (!schema) return schema;
  const ref = schema.$ref;
  if (!ref) return schema;

  // Resolve library reference
  if (ref.startsWith('library:')) {
    const name = ref.slice('library:'.length);
    const library = getSchemaLibrary();
    const entry = library.find(e => e.name === name);
    return entry ? entry.schema : undefined;
  }

  // Unknown ref format — treat as unresolved (return empty schema)
  return undefined;
}

/**
 * Return a copy of the SpaceMeta with all `$ref` TypeSchema entries resolved from
 * the instance schema library.  Unresolvable refs produce a TypeSchema with
 * `_unresolvedRef` set so that subsequent validate* calls can surface a violation
 * instead of silently passing with no constraints.
 *
 * This is the preferred integration point: call `resolveMetaRefs(meta)` once before
 * passing meta to the validate functions, so validation operates on fully-resolved schemas.
 */
export function resolveMetaRefs(meta: SpaceMeta): SpaceMeta {
  if (!meta.typeSchemas) return meta;

  let changed = false;
  const resolvedTypeSchemas: typeof meta.typeSchemas = {};

  for (const [kt, ktMap] of Object.entries(meta.typeSchemas) as [string, Record<string, TypeSchema>][]) {
    let ktChanged = false;
    const resolvedKtMap: Record<string, TypeSchema> = {};
    for (const [typeName, typeSchema] of Object.entries(ktMap)) {
      if (typeSchema.$ref) {
        const resolved = resolveTypeSchema(typeSchema);
        // Unresolvable ref → stamp _unresolvedRef so validate* functions can surface a violation
        resolvedKtMap[typeName] = resolved ?? { _unresolvedRef: typeSchema.$ref };
        ktChanged = true;
      } else {
        resolvedKtMap[typeName] = typeSchema;
      }
    }
    resolvedTypeSchemas[kt as KnowledgeType] = resolvedKtMap;
    if (ktChanged) changed = true;
  }

  if (!changed) return meta;
  return { ...meta, typeSchemas: resolvedTypeSchemas };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate an entity write against the space meta schema.
 */
export function validateEntity(
  meta: SpaceMeta,
  entity: { name?: string; type?: string; properties?: Record<string, unknown> },
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  if (!meta) return violations;

  const entitySchemas = meta.typeSchemas?.entity;

  // Entity type allowlist (if any types are defined, entity.type must be one of them)
  if (entity.type && entitySchemas && Object.keys(entitySchemas).length > 0) {
    if (!Object.prototype.hasOwnProperty.call(entitySchemas, entity.type)) {
      violations.push({
        field: 'type',
        value: entity.type,
        reason: `not in entityTypes allowlist: ${Object.keys(entitySchemas).join(', ')}`,
      });
    }
  }

  // Per-type schema (naming pattern + required + property schemas)
  const typeSchema = entity.type ? entitySchemas?.[entity.type] : undefined;

  // Broken $ref check — must come before any further typeSchema access
  violations.push(...checkUnresolvedRef(typeSchema));
  if (typeSchema?._unresolvedRef) return violations;

  /*
   * Naming pattern for the entity's type — THE SECOND PLACE A PATTERN IS RUN, and it has to answer the same
   * way as the first.
   *
   * `Q-7` was fixed in `validateValue` first, and this site would have kept reporting a declined pattern as
   * "does not match naming pattern" — one rule, two implementations, and the weaker one wins silently for
   * whichever collection happens to use it.
   */
  if (entity.name && entity.type && typeSchema?.namingPattern) {
    const outcome = testPattern(typeSchema.namingPattern, entity.name);
    if (outcome === 'not-evaluated') {
      violations.push({
        field: 'name',
        value: entity.name,
        reason: `naming pattern for type '${entity.type}' not evaluated, so nothing was checked: `
          + `${typeSchema.namingPattern} — ${REDOS_REFUSAL}`,
      });
    } else if (outcome === 'no-match') {
      violations.push({
        field: 'name',
        value: entity.name,
        reason: `does not match naming pattern for type '${entity.type}': ${typeSchema.namingPattern}`,
      });
    }
  }

  // Required properties + property schemas
  violations.push(...validatePropertiesAgainstSchema(typeSchema, entity.properties));

  return violations;
}

/**
 * Validate an edge write against the space meta schema.
 */
/**
 * Edge labels the SERVER itself writes, which an allowlist permits without naming them.
 *
 * Owner's ruling, 2026-08-29: an edge the server writes is subject to the allowlist like any other — but the
 * allowlist should be correct by construction rather than by an operator remembering. Since 2026-08-29
 * `upsertEdge` validates (no caller can reach the collection around it), so without this a space that declared
 * an edge allowlist and did not happen to name `supersedes` would have its contradiction machinery start
 * failing — punishing exactly the operators who took the schema seriously.
 *
 * **Permitted by construction rather than seeded into each space**, which was the other way to read the
 * ruling. Seeding writes the label into new spaces' schemas and leaves every EXISTING space wrong, needing a
 * backfill — the same gap `ensure-query-indexes.ts` already has, where an addition reaches only spaces created
 * afterwards. This form has no migration and no space left behind.
 *
 * It is not an exemption from validation: a server-written edge is still checked against its type schema's
 * `propertySchemas` like any other. Only the LABEL is taken as given, because the label is the server's, not
 * the caller's.
 *
 * Keep this list minimal and keep it here rather than importing from the writers: a value that decides what a
 * schema permits should not be reachable only through the module that happens to write it.
 */
export const SERVER_WRITTEN_EDGE_LABELS: ReadonlySet<string> = new Set([
  // Written by the contradiction-resolution path when a reviewer picks a winner (`api/contradictions.ts`).
  'supersedes',
]);

/**
 * What the CALLER resolved about an edge's endpoints, so this function can stay pure and synchronous.
 *
 * Every field is optional and an absent one is NOT a violation. That is the load-bearing rule: this module is
 * imported from `dist` by two gates that call it with plain objects, and `classifyEdgeUpsertAgainst` is reached
 * from paths that legitimately have not looked anything up — the bulk importer may reference a record created
 * earlier in the same payload. Reporting on information the caller did not supply is how a validator becomes
 * something people switch off.
 *
 * STRINGS, never ids and never a database handle. Making this async would break both of those gates, and the
 * only async caller (`classifyEdgeUpsert`) already does a round trip it can widen.
 */
export interface ResolvedEdgeEnds {
  /**
   * The `type` of the entity at `from`.
   *
   * **`null` and `undefined` are different**, and collapsing them is a hole rather than a simplification.
   * `null` means RESOLVED and it has no type, which an `endpoints` list matches with `UNTYPED`; `undefined`
   * means the caller did not look, and is never a violation. Written as one value, every untyped entity slips
   * past every endpoint rule — silently, and worst in the spaces least finished with their typing.
   */
  fromType?: string | null;
  /** The same for `to`. */
  toType?: string | null;
  /**
   * How many OTHER edges already carry this label from this same subject.
   *
   * A count rather than a boolean so the reason can say how many, and named for what it counts: on an update
   * the edge being written is excluded by the caller, because an edge is not its own duplicate.
   */
  otherEdgesFromSubject?: number;
}

/** `UNTYPED` in an `endpoints` list means an entity with no `type`. */
const UNTYPED = 'UNTYPED';

/**
 * Does `type` satisfy one side of an `endpoints` declaration?
 *
 * `entity:person` and `person` are the same member — the prefix is reserved so the vocabulary can widen if
 * fact or chrono links ever become edges, and accepting it now makes that widening a no-op for anyone already
 * writing it.
 */
function endpointAllows(allowed: readonly string[], type: string | null): boolean {
  const wanted = type ?? UNTYPED;
  return allowed.some(a => (a.startsWith('entity:') ? a.slice('entity:'.length) : a) === wanted);
}

export function validateEdge(
  meta: SpaceMeta,
  edge: { label?: string; properties?: Record<string, unknown> },
  resolved: ResolvedEdgeEnds = {},
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  if (!meta) return violations;

  const edgeSchemas = meta.typeSchemas?.edge;

  // Edge label allowlist
  if (edge.label && edgeSchemas && Object.keys(edgeSchemas).length > 0) {
    if (!SERVER_WRITTEN_EDGE_LABELS.has(edge.label)
      && !Object.prototype.hasOwnProperty.call(edgeSchemas, edge.label)) {
      violations.push({
        field: 'label',
        value: edge.label,
        reason: `not in edgeLabels allowlist: ${Object.keys(edgeSchemas).join(', ')}`,
      });
    }
  }

  /*
   * The endpoint types and the cardinality, both of which need what the CALLER resolved.
   *
   * Each check is skipped when the information is absent rather than treated as a failure — see
   * `ResolvedEdgeEnds`. The two are reported independently so an operator fixing one end does not have to
   * re-run to discover the other, which is the same reasoning the write path already uses for `from`/`to`
   * existence.
   */
  const labelSchema = edge.label ? edgeSchemas?.[edge.label] : undefined;
  if (labelSchema) {
    const ends = labelSchema.endpoints;
    if (ends?.from && resolved.fromType !== undefined && !endpointAllows(ends.from, resolved.fromType)) {
      violations.push({
        field: 'fromType',
        value: resolved.fromType,
        reason: `'${edge.label}' declares its from endpoint as one of: ${ends.from.join(', ')}`,
      });
    }
    if (ends?.to && resolved.toType !== undefined && !endpointAllows(ends.to, resolved.toType)) {
      violations.push({
        field: 'toType',
        value: resolved.toType,
        reason: `'${edge.label}' declares its to endpoint as one of: ${ends.to.join(', ')}`,
      });
    }
    if (labelSchema.functional && (resolved.otherEdgesFromSubject ?? 0) > 0) {
      violations.push({
        field: 'functional',
        value: resolved.otherEdgesFromSubject,
        reason: `'${edge.label}' is declared functional: one subject may have at most one. `
          + `${resolved.otherEdgesFromSubject} other edge(s) with this label already start here`,
      });
    }
  }

  const typeSchema = edge.label ? edgeSchemas?.[edge.label] : undefined;
  violations.push(...checkUnresolvedRef(typeSchema));
  if (!typeSchema?._unresolvedRef) {
    violations.push(...validatePropertiesAgainstSchema(typeSchema, edge.properties));
  }

  return violations;
}

/**
 * Validate a fact write against the space meta schema.
 *
 * ## The allowlist, and why it took a ruling rather than a bugfix
 *
 * Entities, edges and chrono entries each refuse a type outside the set their space declares. Facts did
 * not — while `types-knowledge.ts` stated the rule for both kinds it covers, and two integration-guide pages
 * said so outright. That reads like a documented-but-unimplemented feature, and it was nearly fixed as one.
 *
 * What stopped it: the absence was PINNED as deliberate, and the CHANGELOG carried a reason. The facts
 * tab's `type` control is free text with suggestions rather than a closed select **because** the server
 * accepted any string — a select would have been "stricter than the API", which is the mirror of the gap that
 * work was closing. Two shipped promises pointing opposite ways is a product decision, not a defect.
 *
 * **Owner ruled A on 2026-08-30:** the keys are the allowlist. The UI argument was a consequence of the gap
 * rather than a reason for it, and it inverts cleanly now the server constrains the type — so the control
 * becomes a select wherever a space declares fact types.
 *
 * ## What it can newly refuse, which is bounded
 *
 * The same condition the other three use: **only when the space declares at least one fact type schema.** A
 * space with no `typeSchemas.fact` is untouched, and a space with one had already been promised this.
 */
export function validateFact(
  meta: SpaceMeta,
  fact: { type?: string; properties?: Record<string, unknown> },
): SchemaViolation[] {
  if (!meta) return [];
  const violations: SchemaViolation[] = [];

  const factSchemas = meta.typeSchemas?.fact;

  // Fact type allowlist (if any types are defined, fact.type must be one of them)
  if (fact.type && factSchemas && Object.keys(factSchemas).length > 0) {
    if (!Object.prototype.hasOwnProperty.call(factSchemas, fact.type)) {
      violations.push({
        field: 'type',
        value: fact.type,
        reason: `not in memoryTypes allowlist: ${Object.keys(factSchemas).join(', ')}`,
      });
    }
  }

  const typeSchema = fact.type ? factSchemas?.[fact.type] : undefined;
  const refViolations = checkUnresolvedRef(typeSchema);
  if (refViolations.length) return [...violations, ...refViolations];
  return [...violations, ...validatePropertiesAgainstSchema(typeSchema, fact.properties)];
}

/**
 * Return the set of allowed chrono type names for a space.
 * If the space defines custom `typeSchemas.chrono` keys, those are the
 * allowed types; otherwise falls back to the 5 built-in global types.
 */
export function getAllowedChronoTypes(meta: SpaceMeta | undefined): Set<string> {
  const customTypes = meta?.typeSchemas?.chrono;
  if (customTypes && Object.keys(customTypes).length > 0) {
    return new Set(Object.keys(customTypes));
  }
  return new Set(['event', 'deadline', 'plan', 'prediction', 'milestone']);
}

/**
 * Validate a chrono write against the space meta schema.
 */
export function validateChrono(
  meta: SpaceMeta,
  chrono: { type?: string; properties?: Record<string, unknown> },
): SchemaViolation[] {
  if (!meta) return [];
  const violations: SchemaViolation[] = [];

  const chronoSchemas = meta.typeSchemas?.chrono;

  // Chrono type allowlist (if custom types are defined, chrono.type must be one of them)
  if (chrono.type && chronoSchemas && Object.keys(chronoSchemas).length > 0) {
    if (!Object.prototype.hasOwnProperty.call(chronoSchemas, chrono.type)) {
      violations.push({
        field: 'type',
        value: chrono.type,
        reason: `not in chronoTypes allowlist: ${Object.keys(chronoSchemas).join(', ')}`,
      });
    }
  }

  const typeSchema = chrono.type ? chronoSchemas?.[chrono.type] : undefined;
  const refViolations = checkUnresolvedRef(typeSchema);
  if (refViolations.length) return [...violations, ...refViolations];
  return [...violations, ...validatePropertiesAgainstSchema(typeSchema, chrono.properties)];
}

/**
 * Build a compact schema summary string for MCP instructions.
 */
export function buildSchemaSummary(meta: SpaceMeta): string {
  const parts: string[] = [];
  const ts = meta.typeSchemas;
  if (ts?.entity && Object.keys(ts.entity).length > 0) {
    parts.push(`Entity types: ${Object.keys(ts.entity).join(', ')}`);
  }
  if (ts?.edge && Object.keys(ts.edge).length > 0) {
    parts.push(`Edge labels: ${Object.keys(ts.edge).join(', ')}`);
  }
  if (ts?.fact && Object.keys(ts.fact).length > 0) {
    parts.push(`Fact types: ${Object.keys(ts.fact).join(', ')}`);
  }
  if (ts?.chrono && Object.keys(ts.chrono).length > 0) {
    parts.push(`Chrono types: ${Object.keys(ts.chrono).join(', ')}`);
  }
  // `meta.tagSuggestions` used to be summarised here. Retired in #365 — one editable list applying to
  // every type in the space, so it steered what agents tagged with while being easy to set once and
  // forget — and REMOVED from every surface in 3.0.
  //
  // A value already in config.json is still left untouched rather than deleted. The meta merge reads
  // an absent field as "not stated", so nothing rewrites it away; it is simply inert, and no request
  // can put a new one there.
  if (parts.length > 0) {
    parts.push('Call get_space_meta for full schema and usage notes.');
  }
  return parts.join('\n');
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Emit a violation when the resolved TypeSchema carries an `_unresolvedRef` marker,
 * meaning the `$ref` pointed to a library entry that no longer exists.
 * Returns an empty array when the schema is fine.
 */
function checkUnresolvedRef(typeSchema: TypeSchema | undefined): SchemaViolation[] {
  if (!typeSchema?._unresolvedRef) return [];
  return [{
    field: '$ref',
    value: typeSchema._unresolvedRef,
    reason: `schema library entry '${typeSchema._unresolvedRef.slice('library:'.length)}' not found — update or remove this $ref`,
  }];
}

/**
 * Validate required properties and property value schemas against a TypeSchema.
 * Returns an empty array when typeSchema is undefined (no constraints).
 */
/**
 * Fill in properties the caller omitted, from the type schema's declared defaults.
 *
 * ## Why this exists at all
 *
 * `PropertySchema.default` was declared in the interface, documented in the integration guide, and editable in
 * the settings UI — and **read by nothing in the entire server**. An operator could set it, save it, and it did
 * nothing, for ever, with no hint that it had not taken. Owner, 2026-08-29: *"thats not a decicion, thats a
 * bugfix"* — the product already promised the behaviour, so the only question was where to put it.
 *
 * ## Applied on INSERT, not on update, and that is deliberate
 *
 * "On write when the property is absent" reads either way, and one reading is dangerous: on an update, a
 * property the caller has just removed with `deleteFields` is *absent*, so filling it from the default would
 * resurrect what somebody deliberately deleted. Silently undoing a deletion is worse than a default that does
 * not apply, so a default seeds a record when it is created and never fights an edit afterwards.
 *
 * ## It runs BEFORE validation, which is the whole point
 *
 * A property that is `required` and has a `default` must not be a violation — the default is what satisfies the
 * requirement. Running this after validation would refuse writes the schema was designed to accept.
 */
export function applyPropertyDefaults(
  typeSchema: TypeSchema | undefined,
  properties: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  const declared = typeSchema?.propertySchemas;
  if (!declared) return properties;

  const withDefaults = { ...(properties ?? {}) };
  let filled = false;
  for (const [key, schema] of Object.entries(declared)) {
    if (schema.default === undefined) continue;
    if (withDefaults[key] !== undefined) continue;   // the caller said something; never override it
    withDefaults[key] = schema.default;
    filled = true;
  }
  // Returning the original when nothing was filled keeps `undefined` meaning "no properties at all", which
  // several write paths distinguish from an empty object.
  return filled ? withDefaults : properties;
}

function validatePropertiesAgainstSchema(
  typeSchema: TypeSchema | undefined,
  properties?: Record<string, unknown>,
): SchemaViolation[] {
  if (!typeSchema?.propertySchemas) return [];
  const violations: SchemaViolation[] = [];
  const props = properties ?? {};

  for (const [key, schema] of Object.entries(typeSchema.propertySchemas)) {
    const val = props[key];

    // Required check (inline flag on PropertySchema)
    if (schema.required) {
      if (val === undefined || val === null || val === '') {
        violations.push({
          field: `properties.${key}`,
          value: val ?? null,
          reason: `required property '${key}' is missing or empty`,
        });
        continue; // skip further checks for missing required field
      }
    }

    if (val === undefined || val === null) continue; // not present, no further checks

    violations.push(...validateValue(`properties.${key}`, val, schema));
  }

  return violations;
}

/**
 * Validate a single value against a PropertySchema.
 */
function validateValue(field: string, value: unknown, schema: PropertySchema): SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  // Type check — 'date' is stored as ISO string, so validate as string
  if (schema.type) {
    const expectedJsType = schema.type === 'date' ? 'string' : schema.type;
    if (typeof value !== expectedJsType) {
      violations.push({ field, value, reason: `expected type '${schema.type}', got '${typeof value}'` });
      return violations; // no point checking further if type is wrong
    }
  }

  // Enum check
  if (schema.enum && schema.enum.length > 0) {
    if (!schema.enum.includes(value as string | number | boolean)) {
      violations.push({ field, value, reason: `must be one of: ${schema.enum.join(', ')}` });
    }
  }

  // Numeric range
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push({ field, value, reason: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push({ field, value, reason: `must be <= ${schema.maximum}` });
    }
  }

  // String pattern (also applies to 'date' values stored as strings)
  if (typeof value === 'string' && schema.pattern) {
    /*
     * THREE outcomes, not two, and collapsing the first two into "does not match" was `Q-7`.
     *
     * A pattern the instance declines to run — too long, or a backtracking risk — used to report exactly what
     * a genuinely non-matching value reports. Every record of that type was then rejected, permanently, with
     * an error naming the operator's DATA while the cause was a schema that had never been applied.
     *
     * Saving such a pattern is now refused (`SchemaPatternZ` in `spaces/body-schemas.ts`), so this path is
     * for schemas stored before that existed. It stays honest about them rather than assuming they cannot
     * occur.
     */
    const outcome = testPattern(schema.pattern, value);
    if (outcome === 'not-evaluated') {
      violations.push({ field, value, reason: `pattern not evaluated, so nothing was checked: ${schema.pattern} — ${REDOS_REFUSAL}` });
    } else if (outcome === 'no-match') {
      violations.push({ field, value, reason: `does not match pattern: ${schema.pattern}` });
    }
  }

  return violations;
}

/**
 * Test a pattern against a value, distinguishing "did not match" from "was never run".
 *
 * The protections are unchanged and deliberately kept — a length cap on both sides, and a structural check
 * for the backtracking shapes (`hasReDoSRisk`, shared via `util/redos.ts`) — because a stored schema must not
 * be able to hang the server on a hostile value.
 *
 * **What changed is the ANSWER, and that was the whole of `Q-7`.** Returning `false` for a pattern that was
 * declined said the same thing as returning `false` for a value that failed it, so a schema which could never
 * be applied looked exactly like data that was wrong. Three outcomes make the two separable by the caller,
 * and by the operator reading the violation.
 */
type PatternOutcome = 'match' | 'no-match' | 'not-evaluated';

function testPattern(pattern: string, value: string): PatternOutcome {
  if (pattern.length > MAX_PATTERN_LENGTH || value.length > 10_000) return 'not-evaluated';
  if (hasReDoSRisk(pattern)) return 'not-evaluated';
  try {
    return new RegExp(pattern).test(value) ? 'match' : 'no-match';
  } catch {
    // An invalid regex is a broken schema, not a failing value, and it is reported the same way.
    return 'not-evaluated';
  }
}

/**
 * Look up the meta block for a space from config, with library refs resolved. Returns undefined if none.
 *
 * Lived in `api/brain/_shared.ts` until the upsert-validation fix, which needed it from `brain/bulk.ts`.
 * `brain/` does not import `api/` — a layering worth keeping — and this function is not an HTTP concern:
 * it reads config and resolves schema refs, both of which live here. `_shared.ts` re-exports it, so no
 * route changed.
 */
export function getSpaceMeta(spaceId: string): SpaceMeta | undefined {
  const cfg = getConfig();
  const meta = cfg.spaces.find(s => s.id === spaceId)?.meta;
  if (!meta) return undefined;
  return resolveMetaRefs(meta);
}

/**
 * Apply schema validation to a write operation.
 * Returns { blocked: true, violations } when strict mode rejects the write.
 * Returns { blocked: false, warnings } when warn mode lets the write through.
 * Returns { blocked: false, warnings: [] } when validation is off or no meta.
 *
 * One definition, because the alternative is each write path deciding for itself what `strict` means.
 */
export function applyValidation(
  meta: SpaceMeta | undefined,
  violations: SchemaViolation[],
): { blocked: boolean; warnings: SchemaViolation[] } {
  if (!meta || !meta.validationMode || meta.validationMode === 'off' || violations.length === 0) {
    return { blocked: false, warnings: [] };
  }
  if (meta.validationMode === 'strict') {
    return { blocked: true, warnings: violations };
  }
  // warn mode
  return { blocked: false, warnings: violations };
}
