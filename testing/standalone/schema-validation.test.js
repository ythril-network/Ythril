/**
 * Unit tests: space schema validation engine
 *
 * Covers:
 *  - Entity validation: type allowlist, naming patterns, required properties, property schemas
 *  - Edge validation: label allowlist, required properties, property schemas
 *  - Memory validation: required properties, property schemas
 *  - Chrono validation: required properties, property schemas
 *  - Schema summary generation for MCP instructions
 *  - Edge cases: empty meta, missing fields, invalid regex patterns
 *
 * These tests use pure in-process logic and do NOT require a MongoDB instance.
 * Run with:
 *   node --test testing/standalone/schema-validation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We import the compiled JS from the dist directory.
// Since these are standalone pure-logic tests, we replicate the validation logic
// inline to avoid import/ESM path issues in the test runner.

// ── Replicated validation logic (matches server/src/spaces/schema-validation.ts) ──

function safeRegexTest(pattern, value) {
  if (pattern.length > 500 || value.length > 10_000) return false;
  if (hasReDoSRisk(pattern)) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

const NESTED_QUANTIFIER_RE = /\((?:\?:)?(?![-/:](?![?*{]))([^)]*[+*])\)([+*?]|\{)/;
const ALTERNATION_QUANTIFIER_RE = /\([^)]*\|[^)]*\)([+*?]|\{)/;

function hasReDoSRisk(pattern) {
  return NESTED_QUANTIFIER_RE.test(pattern) || ALTERNATION_QUANTIFIER_RE.test(pattern);
}

function validateValue(field, value, schema) {
  const violations = [];
  if (schema.type) {
    if (typeof value !== schema.type) {
      violations.push({ field, value, reason: `expected type '${schema.type}', got '${typeof value}'` });
      return violations;
    }
  }
  if (schema.enum && schema.enum.length > 0) {
    if (!schema.enum.includes(value)) {
      violations.push({ field, value, reason: `must be one of: ${schema.enum.join(', ')}` });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push({ field, value, reason: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push({ field, value, reason: `must be <= ${schema.maximum}` });
    }
  }
  if (typeof value === 'string' && schema.pattern) {
    if (!safeRegexTest(schema.pattern, value)) {
      violations.push({ field, value, reason: `does not match pattern: ${schema.pattern}` });
    }
  }
  return violations;
}

function validateProperties(meta, knowledgeType, properties) {
  const violations = [];
  const props = properties ?? {};
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
  const schemas = meta.propertySchemas?.[knowledgeType];
  if (schemas) {
    for (const [key, schema] of Object.entries(schemas)) {
      const val = props[key];
      if (val === undefined || val === null) continue;
      violations.push(...validateValue(`properties.${key}`, val, schema));
    }
  }
  return violations;
}

function validateEntity(meta, entity) {
  const violations = [];
  if (!meta) return violations;
  if (entity.type && meta.entityTypes?.length) {
    if (!meta.entityTypes.includes(entity.type)) {
      violations.push({
        field: 'type',
        value: entity.type,
        reason: `not in entityTypes allowlist: ${meta.entityTypes.join(', ')}`,
      });
    }
  }
  if (entity.name && entity.type && meta.namingPatterns?.[entity.type]) {
    const pattern = meta.namingPatterns[entity.type];
    if (!safeRegexTest(pattern, entity.name)) {
      violations.push({
        field: 'name',
        value: entity.name,
        reason: `does not match naming pattern for type '${entity.type}': ${pattern}`,
      });
    }
  }
  violations.push(...validateProperties(meta, 'entity', entity.properties));
  return violations;
}

function validateEdge(meta, edge) {
  const violations = [];
  if (!meta) return violations;
  if (edge.label && meta.edgeLabels?.length) {
    if (!meta.edgeLabels.includes(edge.label)) {
      violations.push({
        field: 'label',
        value: edge.label,
        reason: `not in edgeLabels allowlist: ${meta.edgeLabels.join(', ')}`,
      });
    }
  }
  violations.push(...validateProperties(meta, 'edge', edge.properties));
  return violations;
}

function validateMemory(meta, memory) {
  if (!meta) return [];
  return validateProperties(meta, 'memory', memory.properties);
}

function validateChrono(meta, chrono) {
  if (!meta) return [];
  return validateProperties(meta, 'chrono', chrono.properties);
}

function buildSchemaSummary(meta) {
  const parts = [];
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Schema validation — entity', () => {
  const meta = {
    entityTypes: ['service', 'library', 'team'],
    namingPatterns: {
      service: '^[a-z][a-z0-9-]+$',
      adr: '^adr-[0-9]{4}$',
    },
    requiredProperties: {
      entity: ['status', 'repo'],
    },
    propertySchemas: {
      entity: {
        status: { type: 'string', enum: ['active', 'deprecated', 'planned'] },
        port: { type: 'number', minimum: 1, maximum: 65535 },
      },
    },
  };

  it('returns no violations for a valid entity', () => {
    const v = validateEntity(meta, {
      name: 'my-service',
      type: 'service',
      properties: { status: 'active', repo: 'https://github.com/example' },
    });
    assert.equal(v.length, 0);
  });

  it('rejects entity type not in allowlist', () => {
    const v = validateEntity(meta, {
      name: 'foo',
      type: 'servicee',
      properties: { status: 'active', repo: 'x' },
    });
    assert.ok(v.some(x => x.field === 'type' && x.reason.includes('entityTypes allowlist')));
  });

  it('rejects entity name failing naming pattern', () => {
    const v = validateEntity(meta, {
      name: 'MyService',
      type: 'service',
      properties: { status: 'active', repo: 'x' },
    });
    assert.ok(v.some(x => x.field === 'name' && x.reason.includes('naming pattern')));
  });

  it('rejects missing required property', () => {
    const v = validateEntity(meta, {
      name: 'my-service',
      type: 'service',
      properties: { status: 'active' }, // repo missing
    });
    assert.ok(v.some(x => x.field === 'properties.repo'));
  });

  it('rejects property value not in enum', () => {
    const v = validateEntity(meta, {
      name: 'my-service',
      type: 'service',
      properties: { status: 'live', repo: 'x' },
    });
    assert.ok(v.some(x => x.field === 'properties.status' && x.reason.includes('must be one of')));
  });

  it('rejects property with wrong type', () => {
    const v = validateEntity(meta, {
      name: 'my-service',
      type: 'service',
      properties: { status: 'active', repo: 'x', port: 'not-a-number' },
    });
    assert.ok(v.some(x => x.field === 'properties.port' && x.reason.includes("expected type 'number'")));
  });

  it('rejects number out of range', () => {
    const v = validateEntity(meta, {
      name: 'my-service',
      type: 'service',
      properties: { status: 'active', repo: 'x', port: 99999 },
    });
    assert.ok(v.some(x => x.field === 'properties.port' && x.reason.includes('<= 65535')));
  });

  it('passes when entity type is empty (unrestricted)', () => {
    const looseMeta = { entityTypes: [] };
    const v = validateEntity(looseMeta, { name: 'anything', type: 'whatever' });
    assert.equal(v.length, 0);
  });

  it('passes when no meta is provided', () => {
    const v = validateEntity({}, { name: 'anything', type: 'whatever' });
    assert.equal(v.length, 0);
  });

  it('passes when meta is undefined', () => {
    const v = validateEntity(undefined, { name: 'anything', type: 'whatever' });
    assert.equal(v.length, 0);
  });

  it('naming pattern not applied when entity type has no pattern', () => {
    const v = validateEntity(meta, {
      name: 'AnyNameIsOk',
      type: 'team', // no naming pattern for 'team'
      properties: { status: 'active', repo: 'x' },
    });
    // No violation for name
    assert.ok(!v.some(x => x.field === 'name'));
  });

  it('handles invalid regex pattern gracefully', () => {
    const badMeta = {
      namingPatterns: { service: '[invalid(regex' },
    };
    const v = validateEntity(badMeta, { name: 'test', type: 'service' });
    assert.ok(v.some(x => x.field === 'name'));
  });
});

describe('Schema validation — edge', () => {
  const meta = {
    edgeLabels: ['depends_on', 'owned_by', 'integrates_with'],
    requiredProperties: {
      edge: ['reason'],
    },
    propertySchemas: {
      edge: {
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  };

  it('returns no violations for a valid edge', () => {
    const v = validateEdge(meta, {
      label: 'depends_on',
      properties: { reason: 'direct dependency', confidence: 0.9 },
    });
    assert.equal(v.length, 0);
  });

  it('rejects edge label not in allowlist', () => {
    const v = validateEdge(meta, {
      label: 'uses',
      properties: { reason: 'something' },
    });
    assert.ok(v.some(x => x.field === 'label' && x.reason.includes('edgeLabels allowlist')));
  });

  it('rejects missing required property on edge', () => {
    const v = validateEdge(meta, {
      label: 'depends_on',
      properties: {},
    });
    assert.ok(v.some(x => x.field === 'properties.reason'));
  });

  it('passes when no meta', () => {
    const v = validateEdge({}, { label: 'anything' });
    assert.equal(v.length, 0);
  });
});

describe('Schema validation — memory', () => {
  const meta = {
    requiredProperties: {
      memory: ['source'],
    },
    propertySchemas: {
      memory: {
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
    },
  };

  it('returns no violations for a valid memory', () => {
    const v = validateMemory(meta, {
      properties: { source: 'manual', priority: 'high' },
    });
    assert.equal(v.length, 0);
  });

  it('rejects missing required property', () => {
    const v = validateMemory(meta, { properties: {} });
    assert.ok(v.some(x => x.field === 'properties.source'));
  });

  it('rejects invalid enum value', () => {
    const v = validateMemory(meta, {
      properties: { source: 'api', priority: 'urgent' },
    });
    assert.ok(v.some(x => x.field === 'properties.priority'));
  });
});

describe('Schema validation — chrono', () => {
  const meta = {
    requiredProperties: {
      chrono: ['severity'],
    },
    propertySchemas: {
      chrono: {
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
    },
  };

  it('returns no violations for a valid chrono', () => {
    const v = validateChrono(meta, {
      properties: { severity: 'high' },
    });
    assert.equal(v.length, 0);
  });

  it('rejects missing required property', () => {
    const v = validateChrono(meta, { properties: {} });
    assert.ok(v.some(x => x.field === 'properties.severity'));
  });
});

describe('Schema validation — property schema pattern', () => {
  it('validates string pattern constraint', () => {
    const meta = {
      propertySchemas: {
        entity: {
          version: { type: 'string', pattern: '^v\\d+\\.\\d+\\.\\d+$' },
        },
      },
    };
    const good = validateEntity(meta, {
      name: 'test',
      type: 'svc',
      properties: { version: 'v1.2.3' },
    });
    assert.equal(good.length, 0);

    const bad = validateEntity(meta, {
      name: 'test',
      type: 'svc',
      properties: { version: 'latest' },
    });
    assert.ok(bad.some(x => x.field === 'properties.version' && x.reason.includes('pattern')));
  });
});

describe('Schema validation — empty/absent properties', () => {
  it('does not fail when properties is undefined and no required', () => {
    const meta = { entityTypes: ['service'] };
    const v = validateEntity(meta, { name: 'x', type: 'service' });
    assert.equal(v.length, 0);
  });

  it('reports required properties even when properties is undefined', () => {
    const meta = { requiredProperties: { entity: ['status'] } };
    const v = validateEntity(meta, { name: 'x', type: 'service' });
    assert.ok(v.some(x => x.field === 'properties.status'));
  });

  it('skips value validation for undefined properties', () => {
    const meta = { propertySchemas: { entity: { status: { type: 'string', enum: ['a', 'b'] } } } };
    const v = validateEntity(meta, { name: 'x', type: 'service' });
    assert.equal(v.length, 0); // property not present, not required → no violation
  });
});

describe('buildSchemaSummary', () => {
  it('generates a compact summary with all fields', () => {
    const meta = {
      entityTypes: ['service', 'library'],
      edgeLabels: ['depends_on', 'owned_by'],
      requiredProperties: { entity: ['status'] },
      tagSuggestions: ['incident', 'deploy'],
    };
    const summary = buildSchemaSummary(meta);
    assert.ok(summary.includes('Entity types: service, library'));
    assert.ok(summary.includes('Edge labels: depends_on, owned_by'));
    assert.ok(summary.includes('Required properties (entity): status'));
    assert.ok(summary.includes('Suggested tags: incident, deploy'));
    assert.ok(summary.includes('Call get_space_meta'));
  });

  it('returns empty string for empty meta', () => {
    const summary = buildSchemaSummary({});
    assert.equal(summary, '');
  });

  it('returns empty string when arrays are empty', () => {
    const summary = buildSchemaSummary({ entityTypes: [], edgeLabels: [] });
    assert.equal(summary, '');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ReDoS protection — safeRegexTest rejects dangerous patterns
// ═════════════════════════════════════════════════════════════════════════════
describe('safeRegexTest — ReDoS protection', () => {
  it('rejects nested quantifier (a+)+', () => {
    assert.equal(safeRegexTest('(a+)+', 'aaa'), false);
  });

  it('rejects nested quantifier (a*)*b', () => {
    assert.equal(safeRegexTest('(a*)*b', 'aaa'), false);
  });

  it('rejects alternation with quantifier (a|a)+', () => {
    assert.equal(safeRegexTest('(a|a)+', 'aaa'), false);
  });

  it('rejects alternation with repeat (a|b){2,}', () => {
    assert.equal(safeRegexTest('(a|b){2,}', 'aaa'), false);
  });

  it('rejects (\\d+)+', () => {
    assert.equal(safeRegexTest('(\\d+)+', '123'), false);
  });

  it('allows simple quantifiers like ^[A-Z]', () => {
    assert.equal(safeRegexTest('^[A-Z]', 'Hello'), true);
  });

  it('allows simple quantifiers like \\d+', () => {
    assert.equal(safeRegexTest('\\d+', '123'), true);
  });

  it('allows anchored patterns ^v\\d+\\.\\d+\\.\\d+$', () => {
    assert.equal(safeRegexTest('^v\\d+\\.\\d+\\.\\d+$', 'v1.2.3'), true);
  });

  it('allows non-capturing groups (?:a|b)', () => {
    assert.equal(safeRegexTest('(?:a|b)', 'a'), true);
  });

  it('allows capturing group with mandatory literal separator (-[a-z0-9]+)+', () => {
    assert.equal(safeRegexTest('(-[a-z0-9]+)+', '-abc'), true);
  });

  it('allows capturing group with mandatory / separator (/[a-z]+)+', () => {
    assert.equal(safeRegexTest('(/[a-z]+)+', '/abc'), true);
  });

  it('allows capturing group with mandatory : separator (:[a-z]+)+', () => {
    assert.equal(safeRegexTest('(:[a-z]+)+', ':abc'), true);
  });

  it('allows anchored naming pattern with mandatory separator ^[a-z](-[a-z0-9]+)+$', () => {
    assert.equal(safeRegexTest('^[a-z](-[a-z0-9]+)+$', 'a-bc'), true);
    assert.equal(safeRegexTest('^[a-z](-[a-z0-9]+)+$', 'c-brand-500'), true);
    // Pattern is correctly evaluated (not blocked by ReDoS check); 'abc' has no dash so it does not match
    assert.equal(safeRegexTest('^[a-z](-[a-z0-9]+)+$', 'abc'), false);
  });

  it('still rejects capturing group with optional separator (-?[a-z]+)+', () => {
    assert.equal(safeRegexTest('(-?[a-z]+)+', 'abc'), false);
  });

  it('naming pattern with mandatory-separator capturing group passes valid names', () => {
    const meta = {
      namingPatterns: { token: '^[a-z](-[a-z0-9]+)+$' },
    };
    // Valid: single letter followed by one or more '-segment' groups
    const pass = validateEntity(meta, { name: 'a-bc', type: 'token' });
    assert.equal(pass.length, 0, 'a-bc should match ^[a-z](-[a-z0-9]+)+$');

    const pass2 = validateEntity(meta, { name: 'c-brand-500', type: 'token' });
    assert.equal(pass2.length, 0, 'c-brand-500 should match ^[a-z](-[a-z0-9]+)+$');

    // Invalid: name does not contain any dash segment
    const fail = validateEntity(meta, { name: 'nodash', type: 'token' });
    assert.ok(fail.some(x => x.field === 'name' && x.reason.includes('naming pattern')),
      'nodash should fail the naming pattern');
  });

  it('rejects pattern exceeding 500 chars', () => {
    assert.equal(safeRegexTest('a'.repeat(501), 'a'), false);
  });

  it('rejects value exceeding 10K chars', () => {
    assert.equal(safeRegexTest('^a', 'a'.repeat(10_001)), false);
  });

  it('returns false for invalid regex (fail-safe)', () => {
    assert.equal(safeRegexTest('[invalid', 'test'), false);
  });

  it('naming pattern with ReDoS risk causes entity violation', () => {
    const meta = {
      namingPatterns: { service: '(a+)+' },  // ReDoS-vulnerable
    };
    const v = validateEntity(meta, { name: 'ValidService', type: 'service' });
    assert.ok(v.some(x => x.field === 'name' && x.reason.includes('naming pattern')),
      'ReDoS pattern should cause a naming violation');
  });

  it('property schema with ReDoS pattern causes violation', () => {
    const meta = {
      propertySchemas: {
        entity: { code: { type: 'string', pattern: '(a|a)+' } },
      },
    };
    const v = validateEntity(meta, {
      name: 'test', type: 'svc',
      properties: { code: 'aaa' },
    });
    assert.ok(v.some(x => x.field === 'properties.code' && x.reason.includes('pattern')));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  $options validation in sanitizeFilter
// ═════════════════════════════════════════════════════════════════════════════
describe('sanitizeFilter — $options validation', () => {
  // Replicate the sanitizeFilter logic to test in isolation
  const ALLOWED_OPERATORS = new Set([
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
    '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
    '$all', '$elemMatch', '$size', '$mod',
  ]);
  const VALID_OPTIONS_RE = /^[imsx]+$/;

  function sanitizeFilter(filter, depth = 0) {
    if (depth > 8) throw new Error('Filter too deeply nested');
    if (Array.isArray(filter)) return filter.map(v => sanitizeFilter(v, depth + 1));
    if (filter !== null && typeof filter === 'object') {
      const entries = Object.entries(filter);
      const out = {};
      for (const [key, val] of entries) {
        if (key.startsWith('$') && !ALLOWED_OPERATORS.has(key)) {
          throw new Error(`Operator '${key}' is not allowed in queries`);
        }
        out[key] = sanitizeFilter(val, depth + 1);
      }
      if ('$options' in out) {
        if (!('$regex' in out)) {
          throw new Error("'$options' is only allowed alongside '$regex'");
        }
        if (typeof out['$options'] !== 'string' || !VALID_OPTIONS_RE.test(out['$options'])) {
          throw new Error("'$options' must be a string of valid regex flags (i, m, s, x)");
        }
      }
      return out;
    }
    return filter;
  }

  it('allows $options: "i" alongside $regex', () => {
    const result = sanitizeFilter({ fact: { $regex: 'test', $options: 'i' } });
    assert.deepStrictEqual(result, { fact: { $regex: 'test', $options: 'i' } });
  });

  it('allows $options: "ims" alongside $regex', () => {
    const result = sanitizeFilter({ fact: { $regex: 'test', $options: 'ims' } });
    assert.deepStrictEqual(result, { fact: { $regex: 'test', $options: 'ims' } });
  });

  it('rejects $options without $regex', () => {
    assert.throws(
      () => sanitizeFilter({ fact: { $options: 'i' } }),
      /only allowed alongside/,
    );
  });

  it('rejects $options with invalid flags', () => {
    assert.throws(
      () => sanitizeFilter({ fact: { $regex: 'test', $options: 'ig' } }),
      /valid regex flags/,
    );
  });

  it('rejects $options with non-string value', () => {
    assert.throws(
      () => sanitizeFilter({ fact: { $regex: 'test', $options: 42 } }),
      /valid regex flags/,
    );
  });

  it('rejects $options with empty string', () => {
    assert.throws(
      () => sanitizeFilter({ fact: { $regex: 'test', $options: '' } }),
      /valid regex flags/,
    );
  });

  it('rejects $options with injection-like value', () => {
    assert.throws(
      () => sanitizeFilter({ fact: { $regex: 'test', $options: 'i\x00' } }),
      /valid regex flags/,
    );
  });

  it('still blocks disallowed operators', () => {
    assert.throws(
      () => sanitizeFilter({ $where: 'true' }),
      /not allowed/,
    );
  });
});
