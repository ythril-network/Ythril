/**
 * Unit tests: entity merge logic
 *
 * Covers:
 *  - MergePlan computation: property conflicts, absorbed-only properties
 *  - Resolution validation: numeric fn, boolean fn, survivor/absorbed/custom
 *  - Resolution application: all merge functions (avg, min, max, sum, first, last, and, or, xor)
 *  - Custom values for string/other types
 *  - Edge cases: no conflicts, all conflicts resolved, invalid resolutions
 *  - mergeFn compatibility: numeric fns on numbers, boolean fns on booleans, reject mismatches
 *
 * These tests use pure in-process logic and do NOT require a MongoDB instance.
 * Run with:
 *   node --test testing/standalone/entity-merge.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Replicated merge logic (matches server/src/brain/merge.ts) ──

const NUMERIC_FNS = {
  avg:   (a, b) => (a + b) / 2,
  min:   (a, b) => Math.min(a, b),
  max:   (a, b) => Math.max(a, b),
  sum:   (a, b) => a + b,
};

const BOOLEAN_FNS = {
  and: (a, b) => a && b,
  or:  (a, b) => a || b,
  xor: (a, b) => a !== b,
};

const VALID_NUMERIC_FNS = new Set(['avg', 'min', 'max', 'sum']);
const VALID_BOOLEAN_FNS = new Set(['and', 'or', 'xor']);

function validateResolution(resolution, type, hasCustomValue) {
  if (resolution === 'survivor' || resolution === 'absorbed') return null;
  if (resolution === 'custom') {
    if (!hasCustomValue) return 'resolution "custom" requires a customValue';
    return null;
  }
  if (resolution.startsWith('fn:')) {
    const fnName = resolution.slice(3);
    if (type === 'number') {
      if (!VALID_NUMERIC_FNS.has(fnName)) return `unknown numeric merge function: ${fnName}`;
      return null;
    }
    if (type === 'boolean') {
      if (!VALID_BOOLEAN_FNS.has(fnName)) return `unknown boolean merge function: ${fnName}`;
      return null;
    }
    return `fn: resolutions require type "number" or "boolean", got "${type}"`;
  }
  return `unknown resolution: ${resolution}`;
}

function applyResolutions(survivorProps, absorbedProps, conflicts, absorbedOnly) {
  const result = { ...survivorProps };

  for (const p of absorbedOnly) {
    result[p.key] = p.value;
  }

  for (const c of conflicts) {
    const resolution = c.resolution;
    if (resolution === 'survivor') {
      continue;
    } else if (resolution === 'absorbed') {
      result[c.key] = c.absorbedValue;
    } else if (resolution === 'custom') {
      if (c.customValue !== undefined) {
        result[c.key] = c.customValue;
      }
    } else if (resolution.startsWith('fn:')) {
      const fnName = resolution.slice(3);
      if (c.type === 'number' && NUMERIC_FNS[fnName]) {
        result[c.key] = NUMERIC_FNS[fnName](c.survivorValue, c.absorbedValue);
      } else if (c.type === 'boolean' && BOOLEAN_FNS[fnName]) {
        result[c.key] = BOOLEAN_FNS[fnName](c.survivorValue, c.absorbedValue);
      }
    }
  }

  return result;
}

function resolvePropertyType(key, value, schemas) {
  const schema = schemas?.[key];
  if (schema?.type) return schema.type;
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return t;
  if (value !== null && typeof value === 'object') return 'object';
  return 'unknown';
}

function computeConflicts(survivorProps, absorbedProps, entitySchemas, resolutionMap = new Map()) {
  const propertyConflicts = [];
  const absorbedOnlyProperties = [];

  for (const key of Object.keys(absorbedProps)) {
    if (key in survivorProps) {
      if (survivorProps[key] !== absorbedProps[key]) {
        const type = resolvePropertyType(key, survivorProps[key], entitySchemas);
        const suggestedFn = entitySchemas?.[key]?.mergeFn;
        const res = resolutionMap.get(key);
        const resolved = !!res;

        propertyConflicts.push({
          key,
          type,
          survivorValue: survivorProps[key],
          absorbedValue: absorbedProps[key],
          ...(suggestedFn ? { suggestedFn } : {}),
          resolved,
          ...(resolved ? { resolution: res.resolution, ...(res.customValue !== undefined ? { customValue: res.customValue } : {}) } : {}),
        });
      }
    } else {
      absorbedOnlyProperties.push({ key, value: absorbedProps[key] });
    }
  }

  return { propertyConflicts, absorbedOnlyProperties };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Entity merge — conflict detection', () => {
  it('detects property conflicts between two entities', () => {
    const survivor = { score: 80, name: 'Alice' };
    const absorbed = { score: 95, name: 'Bob', extra: 'info' };
    const { propertyConflicts, absorbedOnlyProperties } = computeConflicts(survivor, absorbed, {});

    assert.equal(propertyConflicts.length, 2, 'Should have 2 conflicts (score and name)');
    assert.equal(absorbedOnlyProperties.length, 1, 'Should have 1 absorbed-only (extra)');
    assert.equal(absorbedOnlyProperties[0].key, 'extra');
    assert.equal(absorbedOnlyProperties[0].value, 'info');
  });

  it('no conflicts when properties are identical', () => {
    const survivor = { score: 80, active: true };
    const absorbed = { score: 80, active: true };
    const { propertyConflicts, absorbedOnlyProperties } = computeConflicts(survivor, absorbed, {});

    assert.equal(propertyConflicts.length, 0);
    assert.equal(absorbedOnlyProperties.length, 0);
  });

  it('absorbed-only properties are detected', () => {
    const survivor = { name: 'Alice' };
    const absorbed = { name: 'Alice', extra1: 'a', extra2: 42 };
    const { propertyConflicts, absorbedOnlyProperties } = computeConflicts(survivor, absorbed, {});

    assert.equal(propertyConflicts.length, 0);
    assert.equal(absorbedOnlyProperties.length, 2);
  });

  it('uses schema type over inferred type', () => {
    const schemas = { score: { type: 'number' } };
    const survivor = { score: 80 };
    const absorbed = { score: 95 };
    const { propertyConflicts } = computeConflicts(survivor, absorbed, schemas);

    assert.equal(propertyConflicts.length, 1);
    assert.equal(propertyConflicts[0].type, 'number');
  });

  it('infers type from value when schema has no type', () => {
    const survivor = { active: true };
    const absorbed = { active: false };
    const { propertyConflicts } = computeConflicts(survivor, absorbed, {});

    assert.equal(propertyConflicts.length, 1);
    assert.equal(propertyConflicts[0].type, 'boolean');
  });

  it('includes suggestedFn from schema', () => {
    const schemas = { score: { type: 'number', mergeFn: 'avg' } };
    const survivor = { score: 80 };
    const absorbed = { score: 100 };
    const { propertyConflicts } = computeConflicts(survivor, absorbed, schemas);

    assert.equal(propertyConflicts.length, 1);
    assert.equal(propertyConflicts[0].suggestedFn, 'avg');
  });

  it('marks conflicts as resolved when resolution is provided', () => {
    const survivor = { score: 80 };
    const absorbed = { score: 100 };
    const resMap = new Map([['score', { key: 'score', resolution: 'fn:avg' }]]);
    const { propertyConflicts } = computeConflicts(survivor, absorbed, {}, resMap);

    assert.equal(propertyConflicts.length, 1);
    assert.equal(propertyConflicts[0].resolved, true);
    assert.equal(propertyConflicts[0].resolution, 'fn:avg');
  });
});

describe('Entity merge — resolution validation', () => {
  it('accepts "survivor" for any type', () => {
    assert.equal(validateResolution('survivor', 'number', false), null);
    assert.equal(validateResolution('survivor', 'string', false), null);
    assert.equal(validateResolution('survivor', 'boolean', false), null);
  });

  it('accepts "absorbed" for any type', () => {
    assert.equal(validateResolution('absorbed', 'number', false), null);
    assert.equal(validateResolution('absorbed', 'string', false), null);
  });

  it('accepts "custom" when customValue is present', () => {
    assert.equal(validateResolution('custom', 'string', true), null);
  });

  it('rejects "custom" without customValue', () => {
    const err = validateResolution('custom', 'string', false);
    assert.ok(err);
    assert.ok(err.includes('customValue'));
  });

  it('accepts numeric fn for number type', () => {
    for (const fn of ['avg', 'min', 'max', 'sum']) {
      assert.equal(validateResolution(`fn:${fn}`, 'number', false), null, `fn:${fn} should be valid for number`);
    }
  });

  it('accepts boolean fn for boolean type', () => {
    for (const fn of ['and', 'or', 'xor']) {
      assert.equal(validateResolution(`fn:${fn}`, 'boolean', false), null, `fn:${fn} should be valid for boolean`);
    }
  });

  it('rejects numeric fn for boolean type', () => {
    const err = validateResolution('fn:avg', 'boolean', false);
    assert.ok(err);
  });

  it('rejects boolean fn for number type', () => {
    const err = validateResolution('fn:and', 'number', false);
    assert.ok(err);
  });

  it('rejects fn for string type', () => {
    const err = validateResolution('fn:avg', 'string', false);
    assert.ok(err);
  });

  it('rejects unknown resolution', () => {
    const err = validateResolution('bogus', 'string', false);
    assert.ok(err);
    assert.ok(err.includes('unknown resolution'));
  });

  it('rejects unknown fn name', () => {
    const err = validateResolution('fn:bogus', 'number', false);
    assert.ok(err);
    assert.ok(err.includes('unknown numeric'));
  });
});

describe('Entity merge — resolution application', () => {
  it('keeps survivor value for "survivor" resolution', () => {
    const conflicts = [{ key: 'name', type: 'string', survivorValue: 'Alice', absorbedValue: 'Bob', resolved: true, resolution: 'survivor' }];
    const result = applyResolutions({ name: 'Alice' }, { name: 'Bob' }, conflicts, []);
    assert.equal(result.name, 'Alice');
  });

  it('uses absorbed value for "absorbed" resolution', () => {
    const conflicts = [{ key: 'name', type: 'string', survivorValue: 'Alice', absorbedValue: 'Bob', resolved: true, resolution: 'absorbed' }];
    const result = applyResolutions({ name: 'Alice' }, { name: 'Bob' }, conflicts, []);
    assert.equal(result.name, 'Bob');
  });

  it('uses custom value for "custom" resolution', () => {
    const conflicts = [{ key: 'name', type: 'string', survivorValue: 'Alice', absorbedValue: 'Bob', resolved: true, resolution: 'custom', customValue: 'Carol' }];
    const result = applyResolutions({ name: 'Alice' }, { name: 'Bob' }, conflicts, []);
    assert.equal(result.name, 'Carol');
  });

  it('applies fn:avg correctly', () => {
    const conflicts = [{ key: 'score', type: 'number', survivorValue: 80, absorbedValue: 100, resolved: true, resolution: 'fn:avg' }];
    const result = applyResolutions({ score: 80 }, { score: 100 }, conflicts, []);
    assert.equal(result.score, 90);
  });

  it('applies fn:min correctly', () => {
    const conflicts = [{ key: 'score', type: 'number', survivorValue: 80, absorbedValue: 100, resolved: true, resolution: 'fn:min' }];
    const result = applyResolutions({ score: 80 }, { score: 100 }, conflicts, []);
    assert.equal(result.score, 80);
  });

  it('applies fn:max correctly', () => {
    const conflicts = [{ key: 'score', type: 'number', survivorValue: 80, absorbedValue: 100, resolved: true, resolution: 'fn:max' }];
    const result = applyResolutions({ score: 80 }, { score: 100 }, conflicts, []);
    assert.equal(result.score, 100);
  });

  it('applies fn:sum correctly', () => {
    const conflicts = [{ key: 'count', type: 'number', survivorValue: 5, absorbedValue: 3, resolved: true, resolution: 'fn:sum' }];
    const result = applyResolutions({ count: 5 }, { count: 3 }, conflicts, []);
    assert.equal(result.count, 8);
  });

  it('applies fn:and correctly', () => {
    const conflicts = [{ key: 'active', type: 'boolean', survivorValue: true, absorbedValue: false, resolved: true, resolution: 'fn:and' }];
    const result = applyResolutions({ active: true }, { active: false }, conflicts, []);
    assert.equal(result.active, false);
  });

  it('applies fn:or correctly', () => {
    const conflicts = [{ key: 'active', type: 'boolean', survivorValue: false, absorbedValue: true, resolved: true, resolution: 'fn:or' }];
    const result = applyResolutions({ active: false }, { active: true }, conflicts, []);
    assert.equal(result.active, true);
  });

  it('applies fn:xor correctly', () => {
    const conflicts = [{ key: 'active', type: 'boolean', survivorValue: true, absorbedValue: true, resolved: true, resolution: 'fn:xor' }];
    const result = applyResolutions({ active: true }, { active: true }, conflicts, []);
    assert.equal(result.active, false);
  });

  it('adds absorbed-only properties', () => {
    const absorbed = [{ key: 'extra', value: 'info' }, { key: 'count', value: 42 }];
    const result = applyResolutions({ name: 'Alice' }, {}, [], absorbed);
    assert.equal(result.name, 'Alice');
    assert.equal(result.extra, 'info');
    assert.equal(result.count, 42);
  });

  it('handles mixed conflicts and absorbed-only properties', () => {
    const conflicts = [
      { key: 'score', type: 'number', survivorValue: 80, absorbedValue: 100, resolved: true, resolution: 'fn:avg' },
      { key: 'name', type: 'string', survivorValue: 'Alice', absorbedValue: 'Bob', resolved: true, resolution: 'absorbed' },
    ];
    const absorbed = [{ key: 'extra', value: true }];
    const result = applyResolutions({ score: 80, name: 'Alice' }, { score: 100, name: 'Bob', extra: true }, conflicts, absorbed);

    assert.equal(result.score, 90);
    assert.equal(result.name, 'Bob');
    assert.equal(result.extra, true);
  });
});

describe('Entity merge — mergeFn compatibility', () => {
  it('number type accepts numeric fns', () => {
    const numericFns = ['avg', 'min', 'max', 'sum'];
    for (const fn of numericFns) {
      assert.equal(validateResolution(`fn:${fn}`, 'number', false), null);
    }
  });

  it('boolean type accepts boolean fns', () => {
    const boolFns = ['and', 'or', 'xor'];
    for (const fn of boolFns) {
      assert.equal(validateResolution(`fn:${fn}`, 'boolean', false), null);
    }
  });

  it('number type rejects boolean fns', () => {
    for (const fn of ['and', 'or', 'xor']) {
      assert.ok(validateResolution(`fn:${fn}`, 'number', false), `fn:${fn} should be rejected for number`);
    }
  });

  it('boolean type rejects numeric fns', () => {
    for (const fn of ['avg', 'min', 'max', 'sum']) {
      assert.ok(validateResolution(`fn:${fn}`, 'boolean', false), `fn:${fn} should be rejected for boolean`);
    }
  });

  it('string type rejects all fns', () => {
    for (const fn of ['avg', 'min', 'max', 'sum', 'and', 'or', 'xor']) {
      assert.ok(validateResolution(`fn:${fn}`, 'string', false), `fn:${fn} should be rejected for string`);
    }
  });
});

describe('Entity merge — edge case handling', () => {
  it('empty survivor and absorbed properties produce no conflicts', () => {
    const { propertyConflicts, absorbedOnlyProperties } = computeConflicts({}, {}, {});
    assert.equal(propertyConflicts.length, 0);
    assert.equal(absorbedOnlyProperties.length, 0);
  });

  it('survivor-only properties are preserved (not listed as conflicts)', () => {
    const survivor = { name: 'Alice', extra: 'info' };
    const absorbed = { name: 'Bob' };
    const { propertyConflicts, absorbedOnlyProperties } = computeConflicts(survivor, absorbed, {});

    assert.equal(propertyConflicts.length, 1); // only 'name'
    assert.equal(absorbedOnlyProperties.length, 0);
  });

  it('all conflicts resolved means fullyResolved is true', () => {
    const survivor = { score: 80, name: 'Alice' };
    const absorbed = { score: 100, name: 'Bob' };
    const resMap = new Map([
      ['score', { key: 'score', resolution: 'fn:avg' }],
      ['name', { key: 'name', resolution: 'survivor' }],
    ]);
    const { propertyConflicts } = computeConflicts(survivor, absorbed, {}, resMap);

    const fullyResolved = propertyConflicts.every(c => c.resolved);
    assert.equal(fullyResolved, true);
  });

  it('partial resolution leaves some conflicts unresolved', () => {
    const survivor = { score: 80, name: 'Alice' };
    const absorbed = { score: 100, name: 'Bob' };
    const resMap = new Map([['score', { key: 'score', resolution: 'fn:avg' }]]);
    const { propertyConflicts } = computeConflicts(survivor, absorbed, {}, resMap);

    const fullyResolved = propertyConflicts.every(c => c.resolved);
    assert.equal(fullyResolved, false);
    assert.equal(propertyConflicts.find(c => c.key === 'score').resolved, true);
    assert.equal(propertyConflicts.find(c => c.key === 'name').resolved, false);
  });
});
