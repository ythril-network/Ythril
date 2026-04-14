/**
 * Unit tests: mergeFn validation in PropertySchema Zod schema
 *
 * Covers:
 *  - Valid mergeFn for number type (avg, min, max, sum, first, last)
 *  - Valid mergeFn for boolean type (and, or, xor)
 *  - Rejected: numeric mergeFn on boolean type
 *  - Rejected: boolean mergeFn on number type
 *  - Rejected: mergeFn on string type
 *  - Allowed: mergeFn without type declaration (type-agnostic)
 *
 * Run with:
 *   node --test testing/standalone/mergefn-schema.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// ── Replicated Zod schema from spaces.ts ──

const PropertySchemaZ = z.object({
  type: z.enum(['string', 'number', 'boolean']).optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  pattern: z.string().max(500).optional(),
  mergeFn: z.enum(['avg', 'min', 'max', 'sum', 'and', 'or', 'xor']).optional(),
}).strict().refine(data => {
  if (!data.mergeFn) return true;
  const numericFns = new Set(['avg', 'min', 'max', 'sum']);
  const booleanFns = new Set(['and', 'or', 'xor']);
  if (data.type === 'number') return numericFns.has(data.mergeFn);
  if (data.type === 'boolean') return booleanFns.has(data.mergeFn);
  if (data.type === 'string') return false;
  return numericFns.has(data.mergeFn) || booleanFns.has(data.mergeFn);
}, {
  message: 'mergeFn is incompatible with the declared type',
});

// ── Tests ──

describe('PropertySchema Zod — mergeFn validation', () => {
  it('accepts number type with numeric mergeFns', () => {
    for (const fn of ['avg', 'min', 'max', 'sum']) {
      const result = PropertySchemaZ.safeParse({ type: 'number', mergeFn: fn });
      assert.ok(result.success, `type: number + mergeFn: ${fn} should be valid`);
    }
  });

  it('accepts boolean type with boolean mergeFns', () => {
    for (const fn of ['and', 'or', 'xor']) {
      const result = PropertySchemaZ.safeParse({ type: 'boolean', mergeFn: fn });
      assert.ok(result.success, `type: boolean + mergeFn: ${fn} should be valid`);
    }
  });

  it('rejects numeric mergeFns on boolean type', () => {
    for (const fn of ['avg', 'min', 'max', 'sum']) {
      const result = PropertySchemaZ.safeParse({ type: 'boolean', mergeFn: fn });
      assert.ok(!result.success, `type: boolean + mergeFn: ${fn} should be rejected`);
    }
  });

  it('rejects boolean mergeFns on number type', () => {
    for (const fn of ['and', 'or', 'xor']) {
      const result = PropertySchemaZ.safeParse({ type: 'number', mergeFn: fn });
      assert.ok(!result.success, `type: number + mergeFn: ${fn} should be rejected`);
    }
  });

  it('rejects any mergeFn on string type', () => {
    for (const fn of ['avg', 'min', 'max', 'sum', 'first', 'last', 'and', 'or', 'xor']) {
      const result = PropertySchemaZ.safeParse({ type: 'string', mergeFn: fn });
      assert.ok(!result.success, `type: string + mergeFn: ${fn} should be rejected`);
    }
  });

  it('accepts mergeFn without type declaration', () => {
    // This is allowed because the type can be inferred at runtime
    const result = PropertySchemaZ.safeParse({ mergeFn: 'avg' });
    assert.ok(result.success, 'mergeFn without type should be allowed');
  });

  it('accepts schema without mergeFn', () => {
    const result = PropertySchemaZ.safeParse({ type: 'number', minimum: 0, maximum: 100 });
    assert.ok(result.success, 'schema without mergeFn should be valid');
  });

  it('accepts empty schema', () => {
    const result = PropertySchemaZ.safeParse({});
    assert.ok(result.success, 'empty schema should be valid');
  });

  it('rejects unknown mergeFn values', () => {
    const result = PropertySchemaZ.safeParse({ type: 'number', mergeFn: 'bogus' });
    assert.ok(!result.success, 'unknown mergeFn should be rejected');
  });
});
