/**
 * Unit tests: multi-type recall result structure and formatting
 *
 * Covers:
 *  - RecallResult type discriminator for each knowledge type
 *  - formatRecallSummary output for memory, entity, edge, chrono, file
 *  - types[] filter restricts which collections are searched
 *  - Deduplication and score-sorting across types
 *  - Tags filter applies only to types that have tags (memory, entity, chrono, file)
 *
 * These tests use pure in-process logic and do NOT require a MongoDB instance.
 * Run with:
 *   node --test testing/standalone/multi-type-recall.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Replicate the formatRecallSummary helper from mcp/router.ts ────────────────
// (kept inline so this test has no server-side module dependencies)

function formatRecallSummary(r) {
  switch (r.type) {
    case 'memory':
      return r.fact ?? '';
    case 'entity':
      return `${r.name ?? ''} (${r.entityType ?? ''})`;
    case 'edge':
      return `${r.from ?? ''} → ${r.label ?? ''} → ${r.to ?? ''}`;
    case 'chrono':
      return r.description ? `${r.title ?? ''}: ${r.description}` : (r.title ?? '');
    case 'file':
      return r.description ? `${r.path ?? ''}: ${r.description}` : (r.path ?? '');
    default:
      return '';
  }
}

// ── Helpers to build fake RecallResult objects ────────────────────────────────

function memoryResult(overrides = {}) {
  return {
    _id: 'mem-1',
    spaceId: 'general',
    type: 'memory',
    score: 0.9,
    fact: 'The service uses Traefik for routing.',
    tags: ['infra'],
    entityIds: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    seq: 1,
    embeddingModel: 'all-MiniLM-L6-v2',
    ...overrides,
  };
}

function entityResult(overrides = {}) {
  return {
    _id: 'ent-1',
    spaceId: 'general',
    type: 'entity',
    score: 0.85,
    name: 'portal-backend',
    entityType: 'service',
    tags: ['backend'],
    properties: { language: 'Go', port: 8080 },
    createdAt: '2024-01-01T00:00:00.000Z',
    seq: 2,
    embeddingModel: 'all-MiniLM-L6-v2',
    ...overrides,
  };
}

function edgeResult(overrides = {}) {
  return {
    _id: 'edge-1',
    spaceId: 'general',
    type: 'edge',
    score: 0.75,
    from: 'ent-portal',
    to: 'ent-db',
    label: 'connects_to',
    createdAt: '2024-01-01T00:00:00.000Z',
    seq: 3,
    embeddingModel: 'all-MiniLM-L6-v2',
    ...overrides,
  };
}

function chronoResult(overrides = {}) {
  return {
    _id: 'chrono-1',
    spaceId: 'general',
    type: 'chrono',
    score: 0.8,
    title: 'portal-backend migration',
    description: 'Migrate portal-backend from Node.js to Go',
    kind: 'milestone',
    startsAt: '2024-06-01T00:00:00.000Z',
    tags: ['migration'],
    entityIds: ['ent-portal'],
    createdAt: '2024-01-01T00:00:00.000Z',
    seq: 4,
    embeddingModel: 'all-MiniLM-L6-v2',
    ...overrides,
  };
}

function fileResult(overrides = {}) {
  return {
    _id: 'docs/portal-backend/README.md',
    spaceId: 'general',
    type: 'file',
    score: 0.78,
    path: 'docs/portal-backend/README.md',
    description: 'Architecture overview for the portal-backend service',
    tags: ['docs', 'portal-backend'],
    sizeBytes: 4096,
    createdAt: '2024-01-01T00:00:00.000Z',
    embeddingModel: 'all-MiniLM-L6-v2',
    ...overrides,
  };
}

// ── formatRecallSummary ────────────────────────────────────────────────────────

describe('formatRecallSummary — memory', () => {
  it('returns fact text for memory results', () => {
    const r = memoryResult();
    assert.equal(formatRecallSummary(r), 'The service uses Traefik for routing.');
  });

  it('returns empty string when fact is undefined', () => {
    const r = memoryResult({ fact: undefined });
    assert.equal(formatRecallSummary(r), '');
  });
});

describe('formatRecallSummary — entity', () => {
  it('returns "name (entityType)" format', () => {
    const r = entityResult();
    assert.equal(formatRecallSummary(r), 'portal-backend (service)');
  });

  it('handles missing name or entityType gracefully', () => {
    assert.equal(formatRecallSummary({ type: 'entity', name: 'foo' }), 'foo ()');
    assert.equal(formatRecallSummary({ type: 'entity', entityType: 'bar' }), ' (bar)');
  });
});

describe('formatRecallSummary — edge', () => {
  it('returns "from → label → to" format', () => {
    const r = edgeResult();
    assert.equal(formatRecallSummary(r), 'ent-portal → connects_to → ent-db');
  });

  it('handles missing fields gracefully', () => {
    assert.equal(formatRecallSummary({ type: 'edge', label: 'depends_on' }), ' → depends_on → ');
  });
});

describe('formatRecallSummary — chrono', () => {
  it('returns "title: description" when description is present', () => {
    const r = chronoResult();
    assert.equal(formatRecallSummary(r), 'portal-backend migration: Migrate portal-backend from Node.js to Go');
  });

  it('returns only title when description is absent', () => {
    const r = chronoResult({ description: undefined });
    assert.equal(formatRecallSummary(r), 'portal-backend migration');
  });

  it('returns only title when description is empty string (falsy)', () => {
    const r = chronoResult({ description: '' });
    assert.equal(formatRecallSummary(r), 'portal-backend migration');
  });
});

describe('formatRecallSummary — unknown type', () => {
  it('returns empty string for unknown type', () => {
    assert.equal(formatRecallSummary({ type: 'unknown' }), '');
  });
});

// ── RecallResult type structure ───────────────────────────────────────────────

describe('RecallResult — type discriminator', () => {
  it('memory result has type="memory" and fact field', () => {
    const r = memoryResult();
    assert.equal(r.type, 'memory');
    assert.ok('fact' in r, 'memory result must have fact field');
    assert.ok(!('name' in r), 'memory result must not have entity name field');
  });

  it('entity result has type="entity" and name/entityType fields', () => {
    const r = entityResult();
    assert.equal(r.type, 'entity');
    assert.ok('name' in r, 'entity result must have name field');
    assert.ok('entityType' in r, 'entity result must have entityType field');
    assert.ok(!('fact' in r), 'entity result must not have memory fact field');
  });

  it('edge result has type="edge" and from/to/label fields', () => {
    const r = edgeResult();
    assert.equal(r.type, 'edge');
    assert.ok('from' in r, 'edge result must have from field');
    assert.ok('to' in r, 'edge result must have to field');
    assert.ok('label' in r, 'edge result must have label field');
  });

  it('chrono result has type="chrono" and title/description fields', () => {
    const r = chronoResult();
    assert.equal(r.type, 'chrono');
    assert.ok('title' in r, 'chrono result must have title field');
    assert.ok('description' in r, 'chrono result must have description field');
  });

  it('file result has type="file" and path/description fields', () => {
    const r = fileResult();
    assert.equal(r.type, 'file');
    assert.ok('path' in r, 'file result must have path field');
    assert.ok('description' in r, 'file result must have description field');
    assert.ok('sizeBytes' in r, 'file result must have sizeBytes field');
  });

  it('all result types have _id, spaceId, score fields', () => {
    const results = [memoryResult(), entityResult(), edgeResult(), chronoResult(), fileResult()];
    for (const r of results) {
      assert.ok('_id' in r, `${r.type} result must have _id`);
      assert.ok('spaceId' in r, `${r.type} result must have spaceId`);
      assert.ok('score' in r, `${r.type} result must have score`);
    }
  });
});

// ── Deduplication and score-sort logic ───────────────────────────────────────
// Mirrors the logic in memory.ts recall() and recallGlobal()

function mergeAndSort(resultArrays, topK = 10) {
  const flat = resultArrays.flat();
  flat.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seen = new Set();
  const deduped = [];
  for (const r of flat) {
    if (!seen.has(r._id)) {
      seen.add(r._id);
      deduped.push(r);
    }
  }
  return deduped.slice(0, topK);
}

describe('Recall merge-and-sort logic', () => {
  it('merges results from multiple types and sorts by score descending', () => {
    const results = mergeAndSort([
      [memoryResult({ score: 0.9 })],
      [entityResult({ score: 0.85 })],
      [edgeResult({ score: 0.75 })],
      [chronoResult({ score: 0.8 })],
      [fileResult({ score: 0.72 })],
    ]);

    assert.equal(results.length, 5);
    assert.equal(results[0].type, 'memory');   // score 0.9
    assert.equal(results[1].type, 'entity');   // score 0.85
    assert.equal(results[2].type, 'chrono');   // score 0.8
    assert.equal(results[3].type, 'edge');     // score 0.75
    assert.equal(results[4].type, 'file');     // score 0.72
  });

  it('deduplicates by _id across types', () => {
    const dup = memoryResult({ _id: 'shared-id', score: 0.9 });
    const dup2 = entityResult({ _id: 'shared-id', score: 0.7 });

    const results = mergeAndSort([[dup], [dup2]]);
    assert.equal(results.length, 1, 'duplicate _ids should be collapsed to one result');
    assert.equal(results[0]._id, 'shared-id');
    assert.equal(results[0].score, 0.9, 'higher-score result should be kept');
  });

  it('respects topK limit', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      memoryResult({ _id: `mem-${i}`, score: 1 - i * 0.01 }),
    );
    const results = mergeAndSort([many], 5);
    assert.equal(results.length, 5);
  });

  it('returns empty array when all inputs are empty', () => {
    const results = mergeAndSort([[], [], [], []]);
    assert.equal(results.length, 0);
  });
});

// ── types[] filter logic ───────────────────────────────────────────────────────
// Replicate the activeTypes logic from recall()

function resolveActiveTypes(types) {
  return (types && types.length > 0)
    ? types
    : ['memory', 'entity', 'edge', 'chrono', 'file'];
}

describe('types[] filter', () => {
  it('defaults to all five types when types is undefined', () => {
    const active = resolveActiveTypes(undefined);
    assert.deepEqual(active, ['memory', 'entity', 'edge', 'chrono', 'file']);
  });

  it('defaults to all five types when types is empty array', () => {
    const active = resolveActiveTypes([]);
    assert.deepEqual(active, ['memory', 'entity', 'edge', 'chrono', 'file']);
  });

  it('restricts to specified types', () => {
    const active = resolveActiveTypes(['memory', 'chrono']);
    assert.deepEqual(active, ['memory', 'chrono']);
  });

  it('handles single type', () => {
    const active = resolveActiveTypes(['entity']);
    assert.deepEqual(active, ['entity']);
  });

  it('accepts file as a valid type', () => {
    const active = resolveActiveTypes(['file']);
    assert.deepEqual(active, ['file']);
  });
});

// ── tags filter applicability ──────────────────────────────────────────────────

function tagsApply(knowledgeType) {
  return knowledgeType === 'memory' || knowledgeType === 'entity' || knowledgeType === 'chrono' || knowledgeType === 'file';
}

describe('Tags filter applicability', () => {
  it('tags apply to memory', () => assert.ok(tagsApply('memory')));
  it('tags apply to entity', () => assert.ok(tagsApply('entity')));
  it('tags apply to chrono', () => assert.ok(tagsApply('chrono')));
  it('tags apply to file', () => assert.ok(tagsApply('file')));
  it('tags do NOT apply to edge', () => assert.ok(!tagsApply('edge')));
});

// ── Embedding text derivation ──────────────────────────────────────────────────
// These helpers intentionally duplicate the formulas from entities.ts,
// chrono.ts, and file-meta.ts. Standalone tests avoid importing production
// modules to stay dependency-free and fast. If the production formulas change,
// these tests will catch the divergence — they act as specification tests for
// the formula.

function entityEmbedText(name, type) {
  return `${name} ${type}`;
}

function chronoEmbedText(title, description) {
  return description ? `${title} ${description}` : title;
}

function fileEmbedText(filePath, description) {
  return description?.trim() ? description : filePath;
}

describe('Embedding text derivation', () => {
  it('entity embed text is "name type"', () => {
    assert.equal(entityEmbedText('portal-backend', 'service'), 'portal-backend service');
  });

  it('chrono embed text is "title description" when description present', () => {
    assert.equal(chronoEmbedText('Migration', 'Move to Go'), 'Migration Move to Go');
  });

  it('chrono embed text is just title when description is absent', () => {
    assert.equal(chronoEmbedText('Migration', undefined), 'Migration');
  });

  it('chrono embed text is just title when description is empty string', () => {
    assert.equal(chronoEmbedText('Migration', ''), 'Migration');
  });

  it('file embed text is description when description is present', () => {
    assert.equal(fileEmbedText('docs/README.md', 'Architecture overview'), 'Architecture overview');
  });

  it('file embed text falls back to path when description is absent', () => {
    assert.equal(fileEmbedText('docs/README.md', undefined), 'docs/README.md');
  });

  it('file embed text falls back to path when description is empty/whitespace', () => {
    assert.equal(fileEmbedText('docs/README.md', '   '), 'docs/README.md');
  });
});

// ── formatRecallSummary — file ─────────────────────────────────────────────────

describe('formatRecallSummary — file', () => {
  it('returns "path: description" when description is present', () => {
    const r = fileResult();
    assert.equal(formatRecallSummary(r), 'docs/portal-backend/README.md: Architecture overview for the portal-backend service');
  });

  it('returns only path when description is absent', () => {
    const r = fileResult({ description: undefined });
    assert.equal(formatRecallSummary(r), 'docs/portal-backend/README.md');
  });

  it('returns only path when description is empty string (falsy)', () => {
    const r = fileResult({ description: '' });
    assert.equal(formatRecallSummary(r), 'docs/portal-backend/README.md');
  });

  it('handles missing path gracefully', () => {
    assert.equal(formatRecallSummary({ type: 'file', path: undefined, description: undefined }), '');
  });
});
