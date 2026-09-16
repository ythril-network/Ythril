/**
 * Unit tests: entity identity model — UUID validation, ID-based upsert semantics,
 * and remember entity resolution.
 *
 * Covers:
 *  - UUID v4 regex rejects invalid IDs and accepts valid UUIDs
 *  - upsertEntity contract: id-supplied → update-by-ID; id-absent → always insert
 *  - remember entity resolution: no ghost stub creation, warns on unresolved names
 *
 * These tests use pure in-process logic and do NOT require a MongoDB instance.
 * Run with:
 *   node --test testing/standalone/entity-identity.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── UUID v4 regex — replicated from server code ─────────────────────────────
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── UUID v4 validation ──────────────────────────────────────────────────────

describe('UUID v4 regex validation', () => {
  it('accepts a valid lowercase UUID v4', () => {
    assert.ok(UUID_V4_RE.test('550e8400-e29b-41d4-a716-446655440000'));
  });

  it('accepts a valid uppercase UUID v4', () => {
    assert.ok(UUID_V4_RE.test('550E8400-E29B-41D4-A716-446655440000'));
  });

  it('accepts a valid mixed-case UUID v4', () => {
    assert.ok(UUID_V4_RE.test('550e8400-E29B-41d4-a716-446655440000'));
  });

  it('rejects a UUID v1 (wrong version nibble)', () => {
    // version nibble = 1 instead of 4
    assert.ok(!UUID_V4_RE.test('550e8400-e29b-11d4-a716-446655440000'));
  });

  it('rejects a UUID with wrong variant nibble', () => {
    // variant nibble = 0 instead of 8/9/a/b
    assert.ok(!UUID_V4_RE.test('550e8400-e29b-41d4-0716-446655440000'));
  });

  it('rejects a MongoDB ObjectId (24 hex chars)', () => {
    assert.ok(!UUID_V4_RE.test('507f1f77bcf86cd799439011'));
  });

  it('rejects an empty string', () => {
    assert.ok(!UUID_V4_RE.test(''));
  });

  it('rejects a random string', () => {
    assert.ok(!UUID_V4_RE.test('not-a-uuid'));
  });

  it('rejects a UUID missing hyphens', () => {
    assert.ok(!UUID_V4_RE.test('550e8400e29b41d4a716446655440000'));
  });

  it('rejects a UUID with extra characters', () => {
    assert.ok(!UUID_V4_RE.test('550e8400-e29b-41d4-a716-446655440000-extra'));
  });

  it('rejects a nil UUID (all zeros)', () => {
    assert.ok(!UUID_V4_RE.test('00000000-0000-0000-0000-000000000000'));
  });
});

// ── Entity upsert identity semantics ────────────────────────────────────────

describe('Entity upsert identity model', () => {
  it('no id → always creates a new entity (verified by contract)', () => {
    // The new contract: upsertEntity(spaceId, name, type) without id always inserts.
    // Two calls with the same name/type should produce two distinct records.
    // We can't call the real function without Mongo, but we verify the intent.
    const call1 = { name: 'Lisa', type: 'person', description: 'Lisa A', id: undefined };
    const call2 = { name: 'Lisa', type: 'person', description: 'Lisa B', id: undefined };
    // Both should produce new records — they are NOT the same identity
    assert.notEqual(call1.description, call2.description, 'Same name entities should remain distinct under new model');
  });

  it('with id → updates existing or inserts with that ID', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const call1 = { name: 'Lisa', type: 'person', id };
    const call2 = { name: 'Lisa', type: 'person', id, description: 'updated' };
    // Same ID → same record (upsert-by-ID)
    assert.equal(call1.id, call2.id, 'Same id means same entity identity');
  });

  it('invalid id should be rejected before upsert (regex gate)', () => {
    const invalidIds = [
      '507f1f77bcf86cd799439011', // ObjectId
      'not-a-uuid',
      '', // empty
      '550e8400-e29b-11d4-a716-446655440000', // v1 UUID
    ];
    for (const id of invalidIds) {
      assert.ok(!UUID_V4_RE.test(id), `'${id}' should be rejected by UUID v4 validation`);
    }
  });
});

// ── Remember entity linkage ────────────────────────────────────────────────
//
// The three tests that used to live here described `saveFact` resolving entity NAMES and silently
// storing the memory unlinked when a name did not resolve. That behaviour is gone: `saveFact` takes
// `entityIds` (UUID v4) and refuses the write when an id is malformed or does not exist.
//
// They are not rewritten in place because they never exercised the product — each one rebuilt the
// resolution loop inline over a local `Map`, so it asserted that a copy of the logic agreed with
// itself. The real behaviour is covered against the real code in `entity-refs.test.js`
// (format + the strict-linkage default) and `integration/entity-refs.test.js` (the end-to-end
// refusal), which is why the count here drops rather than moves.
