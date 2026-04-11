/**
 * Schema validation engine for space meta definitions.
 *
 * Validates write operations against a space's `meta` block —
 * entity types, edge labels, naming patterns, required properties,
 * and property value constraints.
 *
 * Validation is driven by `validationMode`:
 *   - "off"    → no validation (default)
 *   - "warn"   → validation runs, violations returned as warnings
 *   - "strict" → validation runs, violations cause 400 rejection
 */

import type { SpaceMeta, KnowledgeType, PropertySchema } from '../config/types.js';

// ── Violation type ─────────────────────────────────────────────────────────

export interface SchemaViolation {
  field: string;
  value: unknown;
  reason: string;
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

  // Entity type allowlist
  if (entity.type && meta.entityTypes?.length) {
    if (!meta.entityTypes.includes(entity.type)) {
      violations.push({
        field: 'type',
        value: entity.type,
        reason: `not in entityTypes allowlist: ${meta.entityTypes.join(', ')}`,
      });
    }
  }

  // Naming pattern for the entity's type
  if (entity.name && entity.type && meta.namingPatterns?.[entity.type]) {
    const pattern = meta.namingPatterns[entity.type]!;
    if (!safeRegexTest(pattern, entity.name)) {
      violations.push({
        field: 'name',
        value: entity.name,
        reason: `does not match naming pattern for type '${entity.type}': ${pattern}`,
      });
    }
  }

  // Required properties + property schemas for 'entity'
  violations.push(...validateProperties(meta, 'entity', entity.properties));

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

  // Edge label allowlist
  if (edge.label && meta.edgeLabels?.length) {
    if (!meta.edgeLabels.includes(edge.label)) {
      violations.push({
        field: 'label',
        value: edge.label,
        reason: `not in edgeLabels allowlist: ${meta.edgeLabels.join(', ')}`,
      });
    }
  }

  // Required properties + property schemas for 'edge'
  violations.push(...validateProperties(meta, 'edge', edge.properties));

  return violations;
}

/**
 * Validate a memory write against the space meta schema.
 */
export function validateMemory(
  meta: SpaceMeta,
  memory: { properties?: Record<string, unknown>; tags?: string[] },
): SchemaViolation[] {
  if (!meta) return [];
  return validateProperties(meta, 'memory', memory.properties);
}

/**
 * Validate a chrono write against the space meta schema.
 */
export function validateChrono(
  meta: SpaceMeta,
  chrono: { properties?: Record<string, unknown>; tags?: string[] },
): SchemaViolation[] {
  if (!meta) return [];
  return validateProperties(meta, 'chrono', chrono.properties);
}

/**
 * Build a compact schema summary string for MCP instructions.
 */
export function buildSchemaSummary(meta: SpaceMeta): string {
  const parts: string[] = [];
  if (meta.entityTypes?.length) {
    parts.push(`Entity types: ${meta.entityTypes.join(', ')}`);
  }
  if (meta.edgeLabels?.length) {
    parts.push(`Edge labels: ${meta.edgeLabels.join(', ')}`);
  }
  if (meta.requiredProperties) {
    for (const [kt, props] of Object.entries(meta.requiredProperties)) {
      if (props && props.length > 0) {
        parts.push(`Required properties (${kt}): ${props.join(', ')}`);
      }
    }
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
 * Validate required properties and property value schemas for a knowledge type.
 */
function validateProperties(
  meta: SpaceMeta,
  knowledgeType: KnowledgeType,
  properties?: Record<string, unknown>,
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  const props = properties ?? {};

  // Required properties
  const required = meta.requiredProperties?.[knowledgeType];
  if (required) {
    for (const key of required) {
      const val = props[key];
      if (val === undefined || val === null || val === '') {
        violations.push({
          field: `properties.${key}`,
          value: val ?? null,
          reason: `required property '${key}' is missing or empty`,
        });
      }
    }
  }

  // Property value schemas
  const schemas = meta.propertySchemas?.[knowledgeType];
  if (schemas) {
    for (const [key, schema] of Object.entries(schemas)) {
      const val = props[key];
      if (val === undefined || val === null) continue; // not present — only required check catches missing
      violations.push(...validateValue(`properties.${key}`, val, schema));
    }
  }

  return violations;
}

/**
 * Validate a single value against a PropertySchema.
 */
function validateValue(field: string, value: unknown, schema: PropertySchema): SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  // Type check
  if (schema.type) {
    if (typeof value !== schema.type) {
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

  // String pattern
  if (typeof value === 'string' && schema.pattern) {
    if (!safeRegexTest(schema.pattern, value)) {
      violations.push({ field, value, reason: `does not match pattern: ${schema.pattern}` });
    }
  }

  return violations;
}

/**
 * Test a regex pattern against a value, guarding against ReDoS by using a
 * timeout-safe approach (simple length limit on pattern and value).
 * Returns false (fail-safe) when inputs exceed size limits — the value will
 * be reported as non-matching rather than silently allowed through.
 */
function safeRegexTest(pattern: string, value: string): boolean {
  // Fail-safe: reject oversized inputs rather than silently allowing them
  if (pattern.length > 500 || value.length > 10_000) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // Invalid regex — treat as non-matching (report as violation)
    return false;
  }
}
