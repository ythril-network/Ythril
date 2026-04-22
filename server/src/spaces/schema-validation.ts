/**
 * Schema validation engine for space meta definitions.
 *
 * Validates write operations against a space's `meta` block using the
 * per-type `typeSchemas` structure — each entity type / edge label /
 * memory type / chrono type owns its own property schemas, naming pattern,
 * required flags, and tag suggestions.
 *
 * Validation is driven by `validationMode`:
 *   - "off"    → no validation (default)
 *   - "warn"   → validation runs, violations returned as warnings
 *   - "strict" → validation runs, violations cause 400 rejection
 */

import type { SpaceMeta, PropertySchema, TypeSchema } from '../config/types.js';
import { getSchemaLibrary } from '../config/loader.js';

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
 * the instance schema library.  Unresolvable refs become empty schemas.
 *
 * This is the preferred integration point: call `resolveMetaRefs(meta)` once before
 * passing meta to the validate functions, so validation operates on fully-resolved schemas.
 */
export function resolveMetaRefs(meta: SpaceMeta): SpaceMeta {
  if (!meta.typeSchemas) return meta;

  const library = getSchemaLibrary();
  if (library.length === 0) return meta;

  let changed = false;
  const resolvedTypeSchemas: typeof meta.typeSchemas = {};

  for (const [kt, ktMap] of Object.entries(meta.typeSchemas) as [string, Record<string, TypeSchema>][]) {
    let ktChanged = false;
    const resolvedKtMap: Record<string, TypeSchema> = {};
    for (const [typeName, typeSchema] of Object.entries(ktMap)) {
      if (typeSchema.$ref) {
        const resolved = resolveTypeSchema(typeSchema);
        resolvedKtMap[typeName] = resolved ?? {};
        ktChanged = true;
      } else {
        resolvedKtMap[typeName] = typeSchema;
      }
    }
    resolvedTypeSchemas[kt as 'entity' | 'memory' | 'edge' | 'chrono'] = resolvedKtMap;
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
  entity: { name?: string; type?: string; properties?: Record<string, unknown>; tags?: string[] },
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

  // Naming pattern for the entity's type
  if (entity.name && entity.type && typeSchema?.namingPattern) {
    if (!safeRegexTest(typeSchema.namingPattern, entity.name)) {
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
export function validateEdge(
  meta: SpaceMeta,
  edge: { label?: string; properties?: Record<string, unknown>; tags?: string[] },
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  if (!meta) return violations;

  const edgeSchemas = meta.typeSchemas?.edge;

  // Edge label allowlist
  if (edge.label && edgeSchemas && Object.keys(edgeSchemas).length > 0) {
    if (!Object.prototype.hasOwnProperty.call(edgeSchemas, edge.label)) {
      violations.push({
        field: 'label',
        value: edge.label,
        reason: `not in edgeLabels allowlist: ${Object.keys(edgeSchemas).join(', ')}`,
      });
    }
  }

  const typeSchema = edge.label ? edgeSchemas?.[edge.label] : undefined;
  violations.push(...validatePropertiesAgainstSchema(typeSchema, edge.properties));

  return violations;
}

/**
 * Validate a memory write against the space meta schema.
 */
export function validateMemory(
  meta: SpaceMeta,
  memory: { type?: string; properties?: Record<string, unknown>; tags?: string[] },
): SchemaViolation[] {
  if (!meta) return [];
  const typeSchema = memory.type ? meta.typeSchemas?.memory?.[memory.type] : undefined;
  return validatePropertiesAgainstSchema(typeSchema, memory.properties);
}

/**
 * Validate a chrono write against the space meta schema.
 */
export function validateChrono(
  meta: SpaceMeta,
  chrono: { type?: string; properties?: Record<string, unknown>; tags?: string[] },
): SchemaViolation[] {
  if (!meta) return [];
  const typeSchema = chrono.type ? meta.typeSchemas?.chrono?.[chrono.type] : undefined;
  return validatePropertiesAgainstSchema(typeSchema, chrono.properties);
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
  if (ts?.memory && Object.keys(ts.memory).length > 0) {
    parts.push(`Memory types: ${Object.keys(ts.memory).join(', ')}`);
  }
  if (ts?.chrono && Object.keys(ts.chrono).length > 0) {
    parts.push(`Chrono types: ${Object.keys(ts.chrono).join(', ')}`);
  }
  if (meta.tagSuggestions?.length) {
    parts.push(`Suggested tags: ${meta.tagSuggestions.join(', ')}`);
  }
  if (parts.length > 0) {
    parts.push('Call get_space_meta for full schema and usage notes.');
  }
  return parts.join('\n');
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Validate required properties and property value schemas against a TypeSchema.
 * Returns an empty array when typeSchema is undefined (no constraints).
 */
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
    if (!safeRegexTest(schema.pattern, value)) {
      violations.push({ field, value, reason: `does not match pattern: ${schema.pattern}` });
    }
  }

  return violations;
}

/**
 * Detect regex patterns susceptible to catastrophic backtracking (ReDoS).
 * Rejects patterns with nested quantifiers like (a+)+, (a*)*b, (a|a)+, etc.
 * This is a conservative heuristic — it may block some safe patterns, which
 * is the correct fail-safe direction for user-supplied regexes.
 */
const NESTED_QUANTIFIER_RE = /([+*])\)([+*?]|\{)/;
const ALTERNATION_QUANTIFIER_RE = /\([^)]*\|[^)]*\)([+*?]|\{)/;

function hasReDoSRisk(pattern: string): boolean {
  return NESTED_QUANTIFIER_RE.test(pattern) || ALTERNATION_QUANTIFIER_RE.test(pattern);
}

/**
 * Test a regex pattern against a value with comprehensive ReDoS protection:
 * 1. Length limits on both pattern (500) and value (10K)
 * 2. Structural analysis rejecting nested quantifiers / alternation+quantifier
 * 3. Fail-safe: returns false (non-matching → reported as violation) on any issue
 */
function safeRegexTest(pattern: string, value: string): boolean {
  if (pattern.length > 500 || value.length > 10_000) return false;
  if (hasReDoSRisk(pattern)) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}
