/**
 * Unit tests: strict link enforcement — ID-based references only,
 * DELETE blocked when backlinks exist.
 *
 * Covers:
 *  - UUID v4 regex rejects non-UUID reference values (from/to on edges,
 *    entityIds/memoryIds on chrono and memories)
 *  - Backlink detection logic: entity referenced by edges, memories, or chrono
 *    entries should block deletion
 *  - 409 Conflict payload shape: lists blocking item IDs and types
 *
 * These tests use pure in-process logic and do NOT require a MongoDB instance.
 * Run with:
 *   node --test testing/standalone/strict-link-enforcement.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// ── UUID v4 regex — replicated from server code ─────────────────────────────
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Reference ID validation ─────────────────────────────────────────────────

describe('Reference fields must be valid UUIDs', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid UUID v4 in edge from/to', () => {
    assert.ok(UUID_V4_RE.test(validUUID));
  });

  it('rejects display name in edge from', () => {
    assert.ok(!UUID_V4_RE.test('my-entity-name'));
  });

  it('rejects display name in edge to', () => {
    assert.ok(!UUID_V4_RE.test('User Service'));
  });

  it('rejects partial UUID (too short)', () => {
    assert.ok(!UUID_V4_RE.test('550e8400-e29b-41d4'));
  });

  it('rejects UUID v1 as reference', () => {
    assert.ok(!UUID_V4_RE.test('550e8400-e29b-11d4-a716-446655440000'));
  });

  it('rejects empty string as reference', () => {
    assert.ok(!UUID_V4_RE.test(''));
  });

  it('accepts lowercase UUID', () => {
    assert.ok(UUID_V4_RE.test('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'));
  });

  it('accepts uppercase UUID', () => {
    assert.ok(UUID_V4_RE.test('A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D'));
  });
});

// ── Backlink detection logic ────────────────────────────────────────────────

describe('Backlink detection for delete protection', () => {
  // Simulate the backlink query: given an entity ID, check if edges, memories,
  // or chrono entries reference it.

  function findBacklinks(entityId, data) {
    const backlinks = [];
    // Check edges referencing this entity in from/to
    for (const edge of (data.edges ?? [])) {
      if (edge.from === entityId || edge.to === entityId) {
        backlinks.push({ type: 'edge', _id: edge._id });
      }
    }
    // Check memories referencing this entity in entityIds
    for (const mem of (data.facts ?? [])) {
      if ((mem.entityIds ?? []).includes(entityId)) {
        backlinks.push({ type: 'fact', _id: mem._id });
      }
    }
    // Check chrono entries referencing this entity in entityIds
    for (const chrono of (data.chrono ?? [])) {
      if ((chrono.entityIds ?? []).includes(entityId)) {
        backlinks.push({ type: 'chrono', _id: chrono._id });
      }
    }
    return backlinks;
  }

  it('no backlinks → delete permitted', () => {
    const entityId = '550e8400-e29b-41d4-a716-446655440000';
    const data = { edges: [], facts: [], chrono: [] };
    const backlinks = findBacklinks(entityId, data);
    assert.equal(backlinks.length, 0);
  });

  it('entity referenced by edge.from → delete blocked', () => {
    const entityId = '550e8400-e29b-41d4-a716-446655440000';
    const data = {
      edges: [{ _id: 'edge-1', from: entityId, to: 'other-id', label: 'related' }],
      facts: [],
      chrono: [],
    };
    const backlinks = findBacklinks(entityId, data);
    assert.equal(backlinks.length, 1);
    assert.deepEqual(backlinks[0], { type: 'edge', _id: 'edge-1' });
  });

  it('entity referenced by edge.to → delete blocked', () => {
    const entityId = '550e8400-e29b-41d4-a716-446655440000';
    const data = {
      edges: [{ _id: 'edge-2', from: 'other-id', to: entityId, label: 'related' }],
      facts: [],
      chrono: [],
    };
    const backlinks = findBacklinks(entityId, data);
    assert.equal(backlinks.length, 1);
    assert.deepEqual(backlinks[0], { type: 'edge', _id: 'edge-2' });
  });

  it('entity referenced by fact.entityIds → delete blocked', () => {
    const entityId = '550e8400-e29b-41d4-a716-446655440000';
    const data = {
      edges: [],
      facts: [{ _id: 'mem-1', entityIds: [entityId] }],
      chrono: [],
    };
    const backlinks = findBacklinks(entityId, data);
    assert.equal(backlinks.length, 1);
    assert.deepEqual(backlinks[0], { type: 'fact', _id: 'mem-1' });
  });

  it('entity referenced by chrono.entityIds → delete blocked', () => {
    const entityId = '550e8400-e29b-41d4-a716-446655440000';
    const data = {
      edges: [],
      facts: [],
      chrono: [{ _id: 'chrono-1', entityIds: [entityId] }],
    };
    const backlinks = findBacklinks(entityId, data);
    assert.equal(backlinks.length, 1);
    assert.deepEqual(backlinks[0], { type: 'chrono', _id: 'chrono-1' });
  });

  it('entity referenced by multiple types → all listed', () => {
    const entityId = '550e8400-e29b-41d4-a716-446655440000';
    const data = {
      edges: [
        { _id: 'edge-1', from: entityId, to: 'x', label: 'a' },
        { _id: 'edge-2', from: 'y', to: entityId, label: 'b' },
      ],
      facts: [{ _id: 'mem-1', entityIds: [entityId] }],
      chrono: [{ _id: 'chrono-1', entityIds: [entityId] }],
    };
    const backlinks = findBacklinks(entityId, data);
    assert.equal(backlinks.length, 4);
    const types = backlinks.map(b => b.type);
    assert.ok(types.includes('edge'));
    assert.ok(types.includes('fact'));
    assert.ok(types.includes('chrono'));
  });
});

// ── 409 Conflict response shape ─────────────────────────────────────────────

describe('409 Conflict response payload', () => {
  it('is asserted against the real guard, not a hand-built object', () => {
    /*
     * This case used to build the 409 body itself and then assert on its own literal, including the exact
     * message. It is the shape `_AUDIT-ANGLES.md` calls "a mock that would pass even if the real code is
     * broken": nothing it touched came from the server, so it could not fail when the message was wrong.
     * And the message WAS wrong for months, claiming "inbound references" about a check that reads BOTH ends
     * of every edge, while this test was green the whole time.
     *
     * `a-delete-refusal-names-the-end-it-checked-db.test.js` asserts the real body against a real database.
     * What is left here is a pointer, checked so it cannot rot into naming a file that does not exist.
     */
    assert.ok(existsSync('testing/standalone/a-delete-refusal-names-the-end-it-checked-db.test.js'),
      'the suite that replaced this case is gone — restore a real assertion here rather than leaving none');
  });

  it('payload is empty array when no backlinks (should not produce 409)', () => {
    const backlinks = [];
    // This should NOT produce a 409 — just verifying shape
    assert.equal(backlinks.length, 0);
  });
});

// ── entityIds / memoryIds UUID validation ───────────────────────────────────

describe('entityIds and memoryIds must be UUIDs', () => {
  function validateIds(ids) {
    const invalid = ids.filter(id => !UUID_V4_RE.test(id));
    return invalid;
  }

  it('all valid UUIDs → no errors', () => {
    const ids = [
      '550e8400-e29b-41d4-a716-446655440000',
      'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    ];
    assert.deepEqual(validateIds(ids), []);
  });

  it('name mixed with UUID → name rejected', () => {
    const ids = [
      '550e8400-e29b-41d4-a716-446655440000',
      'my-entity-name',
    ];
    const invalid = validateIds(ids);
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0], 'my-entity-name');
  });

  it('all names → all rejected', () => {
    const ids = ['Alice', 'Bob', 'Traefik'];
    const invalid = validateIds(ids);
    assert.equal(invalid.length, 3);
  });

  it('empty array → no errors', () => {
    assert.deepEqual(validateIds([]), []);
  });
});

// ── Per-space strictLinkage setting ─────────────────────────────────────────

describe('strictLinkage is a per-space opt-in setting', () => {
  /**
   * Simulate the enforcement gating pattern used in the API.
   * When strictLinkage is false/undefined, validation is skipped.
   */
  // MIRROR of the production rule, kept because these cases enumerate edge shapes cheaply.
  // The rule itself (including the default) is asserted against the REAL `isStrictLinkage` in
  // entity-refs.test.js — without that, this local copy would agree with itself forever, which is
  // exactly how the default flipping from off to on went unnoticed here.
  function validateEdgeRef(meta, from, to) {
    const errors = [];
    if (meta?.strictLinkage !== false) {
      if (!UUID_V4_RE.test(from)) errors.push({ field: 'from', reason: 'not a UUID v4' });
      if (!UUID_V4_RE.test(to)) errors.push({ field: 'to', reason: 'not a UUID v4' });
    }
    return errors;
  }

  function shouldBlockDelete(meta, backlinks) {
    if (meta?.strictLinkage === false) return false;
    return backlinks.length > 0;
  }

  it('strictLinkage=true → name-based from/to rejected', () => {
    const meta = { strictLinkage: true };
    const errors = validateEdgeRef(meta, 'kubernetes', 'docker');
    assert.equal(errors.length, 2);
  });

  it('strictLinkage=false → name-based from/to allowed', () => {
    const meta = { strictLinkage: false };
    const errors = validateEdgeRef(meta, 'kubernetes', 'docker');
    assert.equal(errors.length, 0);
  });

  it('strictLinkage=undefined → name-based from/to REJECTED (strict is the default)', () => {
    const meta = {};
    const errors = validateEdgeRef(meta, 'kubernetes', 'docker');
    assert.equal(errors.length, 2, 'a space that says nothing about linkage now gets the safe behaviour');
  });

  it('no meta → name-based from/to REJECTED (strict is the default)', () => {
    const errors = validateEdgeRef(undefined, 'kubernetes', 'docker');
    assert.equal(errors.length, 2);
  });

  it('strictLinkage=true → delete blocked when backlinks exist', () => {
    const meta = { strictLinkage: true };
    const backlinks = [{ type: 'edge', _id: 'e1' }];
    assert.ok(shouldBlockDelete(meta, backlinks));
  });

  it('strictLinkage=false → delete allowed even with backlinks', () => {
    const meta = { strictLinkage: false };
    const backlinks = [{ type: 'edge', _id: 'e1' }];
    assert.ok(!shouldBlockDelete(meta, backlinks));
  });

  it('strictLinkage=true + no backlinks → delete allowed', () => {
    const meta = { strictLinkage: true };
    assert.ok(!shouldBlockDelete(meta, []));
  });
});
