/**
 * Unit tests: deleteFields utility
 *
 * Covers:
 *  - validateDeleteFields: rejects non-arrays, non-strings, empty strings, system fields
 *  - applyDeleteFields: top-level deletion, nested deletion, non-existent path is a no-op
 *  - Combined: deleteFields + merge behaviour
 *
 * These tests use pure in-process logic and do NOT require a MongoDB instance.
 * Run with:
 *   node --test testing/standalone/delete-fields.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Replicated logic (matches server/src/brain/delete-fields.ts) ──────────

const SYSTEM_FIELDS = new Set([
  'id', '_id', 'name', 'type', 'spaceId', 'createdAt', 'updatedAt',
]);

function validateDeleteFields(deleteFields) {
  if (deleteFields === undefined || deleteFields === null) return { ok: true };
  if (!Array.isArray(deleteFields)) {
    return { ok: false, error: '`deleteFields` must be an array of strings' };
  }
  for (const p of deleteFields) {
    if (typeof p !== 'string' || !p.trim()) {
      return { ok: false, error: '`deleteFields` entries must be non-empty strings' };
    }
    const topLevel = p.split('.')[0];
    if (SYSTEM_FIELDS.has(topLevel)) {
      return { ok: false, error: `Cannot delete system field '${topLevel}' via deleteFields` };
    }
  }
  return { ok: true };
}

function applyDeleteFields(obj, deleteFields) {
  const affected = new Set();
  for (const path of deleteFields) {
    const segments = path.split('.');
    if (segments.length === 0) continue;
    affected.add(segments[0]);
    if (segments.length === 1) {
      delete obj[segments[0]];
    } else {
      let current = obj;
      for (let i = 0; i < segments.length - 1; i++) {
        if (current == null || typeof current !== 'object' || Array.isArray(current)) {
          current = undefined;
          break;
        }
        current = current[segments[i]];
      }
      if (current != null && typeof current === 'object' && !Array.isArray(current)) {
        delete current[segments[segments.length - 1]];
      }
    }
  }
  return affected;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('validateDeleteFields', () => {
  it('accepts undefined (no deleteFields)', () => {
    const r = validateDeleteFields(undefined);
    assert.equal(r.ok, true);
  });

  it('accepts null (no deleteFields)', () => {
    const r = validateDeleteFields(null);
    assert.equal(r.ok, true);
  });

  it('accepts a valid string array', () => {
    const r = validateDeleteFields(['properties.oldKey', 'description']);
    assert.equal(r.ok, true);
  });

  it('rejects non-array values', () => {
    const r = validateDeleteFields('properties.foo');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('must be an array'));
  });

  it('rejects arrays with non-string entries', () => {
    const r = validateDeleteFields([123]);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('non-empty strings'));
  });

  it('rejects arrays with empty string entries', () => {
    const r = validateDeleteFields(['']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('non-empty strings'));
  });

  it('rejects system field: id', () => {
    const r = validateDeleteFields(['id']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'id'"));
  });

  it('rejects system field: _id', () => {
    const r = validateDeleteFields(['_id']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'_id'"));
  });

  it('rejects system field: name', () => {
    const r = validateDeleteFields(['name']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'name'"));
  });

  it('rejects system field: type', () => {
    const r = validateDeleteFields(['type']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'type'"));
  });

  it('rejects system field: spaceId', () => {
    const r = validateDeleteFields(['spaceId']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'spaceId'"));
  });

  it('rejects system field: createdAt', () => {
    const r = validateDeleteFields(['createdAt']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'createdAt'"));
  });

  it('rejects system field: updatedAt', () => {
    const r = validateDeleteFields(['updatedAt']);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'updatedAt'"));
  });

  it('allows non-system top-level fields', () => {
    const r = validateDeleteFields(['description', 'properties', 'tags', 'weight']);
    assert.equal(r.ok, true);
  });

  it('allows nested paths under properties', () => {
    const r = validateDeleteFields(['properties.oldKey', 'properties.nested.deep']);
    assert.equal(r.ok, true);
  });
});

describe('applyDeleteFields', () => {
  it('deletes a top-level field', () => {
    const obj = { description: 'old', properties: { a: 1 } };
    applyDeleteFields(obj, ['description']);
    assert.equal(obj.description, undefined);
    assert.deepEqual(obj.properties, { a: 1 });
  });

  it('deletes a nested field (properties.oldKey)', () => {
    const obj = { properties: { oldKey: 'val', keepKey: 'keep' } };
    applyDeleteFields(obj, ['properties.oldKey']);
    assert.equal(obj.properties.oldKey, undefined);
    assert.equal(obj.properties.keepKey, 'keep');
    assert.ok(!('oldKey' in obj.properties));
  });

  it('deletes multiple fields at once', () => {
    const obj = { description: 'old', properties: { a: 1, b: 2, c: 3 } };
    applyDeleteFields(obj, ['description', 'properties.a', 'properties.c']);
    assert.equal(obj.description, undefined);
    assert.ok(!('description' in obj));
    assert.ok(!('a' in obj.properties));
    assert.equal(obj.properties.b, 2);
    assert.ok(!('c' in obj.properties));
  });

  it('non-existent path is a no-op', () => {
    const obj = { properties: { a: 1 } };
    applyDeleteFields(obj, ['properties.nonexistent']);
    assert.deepEqual(obj, { properties: { a: 1 } });
  });

  it('non-existent top-level field is a no-op', () => {
    const obj = { properties: { a: 1 } };
    applyDeleteFields(obj, ['somefield']);
    assert.deepEqual(obj, { properties: { a: 1 } });
  });

  it('deletes entire properties map', () => {
    const obj = { description: 'hi', properties: { a: 1, b: 2 } };
    applyDeleteFields(obj, ['properties']);
    assert.ok(!('properties' in obj));
    assert.equal(obj.description, 'hi');
  });

  it('handles deeply nested paths (3 levels)', () => {
    const obj = { properties: { nested: { deep: 'val', keep: 'yes' } } };
    applyDeleteFields(obj, ['properties.nested.deep']);
    assert.ok(!('deep' in obj.properties.nested));
    assert.equal(obj.properties.nested.keep, 'yes');
  });

  it('returns affected top-level keys', () => {
    const obj = { description: 'old', properties: { a: 1 } };
    const affected = applyDeleteFields(obj, ['description', 'properties.a']);
    assert.ok(affected.has('description'));
    assert.ok(affected.has('properties'));
  });

  it('handles null intermediate value gracefully', () => {
    const obj = { properties: null };
    // Should not throw
    applyDeleteFields(obj, ['properties.a']);
    assert.deepEqual(obj, { properties: null });
  });

  it('handles missing intermediate object gracefully', () => {
    const obj = {};
    // Should not throw
    applyDeleteFields(obj, ['properties.a']);
    assert.deepEqual(obj, {});
  });
});

describe('deleteFields combined with merge (simulated)', () => {
  it('deleteFields before merge: deleting a key then merging new properties', () => {
    // Simulate existing entity
    const existing = { name: 'Test', properties: { oldKey: 'val', keepKey: 'keep' } };

    // Step 1: Apply deleteFields
    applyDeleteFields(existing, ['properties.oldKey']);

    // Step 2: Merge new properties
    const newProps = { newKey: 'new' };
    existing.properties = { ...existing.properties, ...newProps };

    assert.ok(!('oldKey' in existing.properties));
    assert.equal(existing.properties.keepKey, 'keep');
    assert.equal(existing.properties.newKey, 'new');
  });

  it('deleteFields does not affect unrelated fields', () => {
    const existing = {
      name: 'Test',
      description: 'Original',
      tags: ['a', 'b'],
      properties: { tier: 'core', extra: 'yes' },
    };

    applyDeleteFields(existing, ['properties.extra']);

    assert.equal(existing.name, 'Test');
    assert.equal(existing.description, 'Original');
    assert.deepEqual(existing.tags, ['a', 'b']);
    assert.equal(existing.properties.tier, 'core');
    assert.ok(!('extra' in existing.properties));
  });
});
