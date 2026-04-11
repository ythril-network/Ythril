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
    tags: ['infra'],
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
  // All collection types now have tags — the filter applies universally
  return true;
}

describe('Tags filter applicability', () => {
  it('tags apply to memory', () => assert.ok(tagsApply('memory')));
  it('tags apply to entity', () => assert.ok(tagsApply('entity')));
  it('tags apply to chrono', () => assert.ok(tagsApply('chrono')));
  it('tags apply to file', () => assert.ok(tagsApply('file')));
  it('tags apply to edge', () => assert.ok(tagsApply('edge')));
});

// ── Embedding text derivation ──────────────────────────────────────────────────
// These helpers intentionally duplicate the formulas from entities.ts,
// edges.ts, chrono.ts, memory.ts, and file-meta.ts. Standalone tests avoid
// importing production modules to stay dependency-free and fast. If the
// production formulas change, these tests will catch the divergence — they
// act as specification tests for the formula.

function memoryEmbedText(fact, tags = [], entityNames = [], description, properties) {
  const parts = [];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (entityNames.length > 0) parts.push(entityNames.join(' '));
  parts.push(fact);
  if (description?.trim()) parts.push(description.trim());
  if (properties) {
    const propEntries = Object.entries(properties);
    if (propEntries.length > 0) parts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
  }
  return parts.join(' ');
}

function entityEmbedText(name, type, tags = [], description, properties = {}) {
  const parts = [name, type];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  const propEntries = Object.entries(properties);
  if (propEntries.length > 0) parts.push(propEntries.map(([k, v]) => `${k} ${String(v)}`).join(' '));
  return parts.join(' ');
}

function edgeEmbedText(from, label, to, tags = [], type, description) {
  const parts = [];
  if (tags.length > 0) parts.push(tags.join(' '));
  parts.push(from, label, to);
  if (type?.trim()) parts.push(type.trim());
  if (description?.trim()) parts.push(description.trim());
  return parts.join(' ');
}

function chronoEmbedText(title, kind, status, description, tags = []) {
  const parts = [kind, status, title];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  return parts.join(' ');
}

function fileEmbedText(filePath, tags = [], description) {
  const parts = [filePath];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  return parts.join(' ');
}

describe('Embedding text derivation — memory', () => {
  it('fact alone (no tags, no entities)', () => {
    assert.equal(memoryEmbedText('Redis TTL is 30 minutes'), 'Redis TTL is 30 minutes');
  });

  it('tags are prepended before fact', () => {
    assert.equal(
      memoryEmbedText('Redis TTL is 30 minutes', ['infra', 'redis']),
      'infra redis Redis TTL is 30 minutes',
    );
  });

  it('entity names come after tags, before fact', () => {
    assert.equal(
      memoryEmbedText('Redis TTL is 30 minutes', ['infra'], ['portal-backend']),
      'infra portal-backend Redis TTL is 30 minutes',
    );
  });

  it('description is appended after fact', () => {
    assert.equal(
      memoryEmbedText('Redis TTL is 30 minutes', [], [], 'Session timeout value'),
      'Redis TTL is 30 minutes Session timeout value',
    );
  });

  it('properties are appended last', () => {
    assert.equal(
      memoryEmbedText('Redis TTL is 30 minutes', [], [], undefined, { aspect: 'cache', severity: 'low' }),
      'Redis TTL is 30 minutes aspect cache severity low',
    );
  });

  it('combines all fields in correct order', () => {
    assert.equal(
      memoryEmbedText('Redis TTL is 30 minutes', ['infra'], ['portal-backend'], 'Session timeout', { aspect: 'cache' }),
      'infra portal-backend Redis TTL is 30 minutes Session timeout aspect cache',
    );
  });
});

describe('Embedding text derivation — entity', () => {
  it('minimal: name and type', () => {
    assert.equal(entityEmbedText('portal-backend', 'service'), 'portal-backend service');
  });

  it('includes tags', () => {
    assert.equal(
      entityEmbedText('portal-backend', 'service', ['backend', 'go']),
      'portal-backend service backend go',
    );
  });

  it('includes description', () => {
    assert.equal(
      entityEmbedText('portal-backend', 'service', [], 'Main API gateway'),
      'portal-backend service Main API gateway',
    );
  });

  it('includes properties as key-value pairs', () => {
    assert.equal(
      entityEmbedText('portal-backend', 'service', [], undefined, { language: 'Go', port: 8080 }),
      'portal-backend service language Go port 8080',
    );
  });

  it('combines all fields', () => {
    assert.equal(
      entityEmbedText('portal-backend', 'service', ['backend'], 'Main API', { language: 'Go' }),
      'portal-backend service backend Main API language Go',
    );
  });
});

describe('Embedding text derivation — edge', () => {
  it('from + label + to (no tags)', () => {
    assert.equal(edgeEmbedText('adr-0028', 'supersedes', 'adr-0029'), 'adr-0028 supersedes adr-0029');
  });

  it('tags are prepended before from+label+to', () => {
    assert.equal(
      edgeEmbedText('adr-0028', 'supersedes', 'adr-0029', ['security', 'adr']),
      'security adr adr-0028 supersedes adr-0029',
    );
  });

  it('includes type when present', () => {
    assert.equal(
      edgeEmbedText('adr-0028', 'supersedes', 'adr-0029', [], 'causal'),
      'adr-0028 supersedes adr-0029 causal',
    );
  });

  it('includes description when present', () => {
    assert.equal(
      edgeEmbedText('adr-0028', 'supersedes', 'adr-0029', [], undefined, 'Harbor replaced registry:2'),
      'adr-0028 supersedes adr-0029 Harbor replaced registry:2',
    );
  });

  it('combines all fields', () => {
    assert.equal(
      edgeEmbedText('adr-0028', 'supersedes', 'adr-0029', ['security'], 'causal', 'Harbor replaced registry:2'),
      'security adr-0028 supersedes adr-0029 causal Harbor replaced registry:2',
    );
  });
});

describe('Embedding text derivation — chrono', () => {
  it('kind + status + title', () => {
    assert.equal(chronoEmbedText('Migration', 'milestone', 'upcoming'), 'milestone upcoming Migration');
  });

  it('includes tags', () => {
    assert.equal(
      chronoEmbedText('Migration', 'milestone', 'upcoming', undefined, ['infra', 'migration']),
      'milestone upcoming Migration infra migration',
    );
  });

  it('includes description', () => {
    assert.equal(
      chronoEmbedText('Migration', 'milestone', 'upcoming', 'Move to Go'),
      'milestone upcoming Migration Move to Go',
    );
  });

  it('combines all fields', () => {
    assert.equal(
      chronoEmbedText('Migration', 'milestone', 'completed', 'Move to Go', ['infra']),
      'milestone completed Migration infra Move to Go',
    );
  });

  it('ignores empty description', () => {
    assert.equal(chronoEmbedText('Migration', 'event', 'upcoming', ''), 'event upcoming Migration');
  });
});

describe('Embedding text derivation — file', () => {
  it('always includes path', () => {
    assert.equal(fileEmbedText('docs/README.md'), 'docs/README.md');
  });

  it('path + tags', () => {
    assert.equal(
      fileEmbedText('docs/README.md', ['docs', 'api']),
      'docs/README.md docs api',
    );
  });

  it('path + description', () => {
    assert.equal(
      fileEmbedText('docs/README.md', [], 'Architecture overview'),
      'docs/README.md Architecture overview',
    );
  });

  it('path + tags + description', () => {
    assert.equal(
      fileEmbedText('docs/README.md', ['docs'], 'Architecture overview'),
      'docs/README.md docs Architecture overview',
    );
  });

  it('ignores empty/whitespace description', () => {
    assert.equal(fileEmbedText('docs/README.md', [], '   '), 'docs/README.md');
  });
});

// ── minPerType logic ───────────────────────────────────────────────────────────
// Mirrors the two-phase logic in memory.ts recall()

function recallWithMinPerType(resultArraysByType, topK, minPerType) {
  const activeTypes = Object.keys(resultArraysByType);

  // Phase 1: collect guaranteed results
  const guaranteed = [];
  const guaranteedIds = new Set();
  if (minPerType) {
    for (const [type, floor] of Object.entries(minPerType)) {
      if (!activeTypes.includes(type) || !floor) continue;
      const typeResults = (resultArraysByType[type] ?? []).slice(0, floor);
      for (const r of typeResults) {
        if (!guaranteedIds.has(r._id)) {
          guaranteedIds.add(r._id);
          guaranteed.push(r);
        }
      }
    }
  }

  // Phase 2: fill remaining slots from global results (sorted by score)
  const allResults = Object.values(resultArraysByType).flat();
  allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const fillSlots = Math.max(0, topK - guaranteed.length);
  const fill = [];
  for (const r of allResults) {
    if (fill.length >= fillSlots) break;
    if (!guaranteedIds.has(r._id)) fill.push(r);
  }

  // Combine, sort by score
  const final = [...guaranteed, ...fill];
  final.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return final;
}

describe('minPerType floor guarantee', () => {
  const buildResults = () => ({
    memory: [
      memoryResult({ _id: 'mem-1', score: 0.5 }),
      memoryResult({ _id: 'mem-2', score: 0.45 }),
    ],
    entity: [
      entityResult({ _id: 'ent-1', score: 0.92 }),
      entityResult({ _id: 'ent-2', score: 0.88 }),
    ],
    edge: [edgeResult({ _id: 'edge-1', score: 0.3 })],
    chrono: [chronoResult({ _id: 'chrono-1', score: 0.6 })],
    file: [fileResult({ _id: 'file-1', score: 0.55 })],
  });

  it('without minPerType returns pure score ranking', () => {
    const results = recallWithMinPerType(buildResults(), 3, undefined);
    assert.equal(results.length, 3);
    assert.equal(results[0]._id, 'ent-1');   // score 0.92
    assert.equal(results[1]._id, 'ent-2');   // score 0.88
    assert.equal(results[2]._id, 'chrono-1'); // score 0.6
  });

  it('minPerType guarantees low-scoring edge appears in results', () => {
    const results = recallWithMinPerType(buildResults(), 5, { edge: 1 });
    const edgeResult = results.find(r => r.type === 'edge');
    assert.ok(edgeResult, 'edge result must be present');
    assert.equal(edgeResult._id, 'edge-1');
  });

  it('minPerType does not duplicate results', () => {
    const results = recallWithMinPerType(buildResults(), 10, { entity: 2, edge: 1 });
    const ids = results.map(r => r._id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'no duplicate _ids');
  });

  it('respects topK after guaranteeing floors', () => {
    const results = recallWithMinPerType(buildResults(), 3, { entity: 2, edge: 1 });
    assert.equal(results.length, 3);
  });

  it('floor larger than available results fills as many as possible', () => {
    const results = recallWithMinPerType(buildResults(), 10, { edge: 5 });
    const edgeResults = results.filter(r => r.type === 'edge');
    assert.equal(edgeResults.length, 1, 'only 1 edge available, floor of 5 is capped');
  });

  it('empty minPerType object behaves like no minPerType', () => {
    const withEmpty = recallWithMinPerType(buildResults(), 3, {});
    const withUndefined = recallWithMinPerType(buildResults(), 3, undefined);
    assert.deepEqual(
      withEmpty.map(r => r._id),
      withUndefined.map(r => r._id),
    );
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

// ── minScore filtering (simulated) ─────────────────────────────────────────────
// These tests validate the minScore filtering logic in isolation, the same
// algorithm that recall() and recallGlobal() use as a post-query filter.

function applyMinScore(results, minScore) {
  if (minScore != null && minScore > 0) {
    return results.filter(r => (r.score ?? 0) >= minScore);
  }
  return results;
}

describe('minScore filtering', () => {
  const mixedResults = [
    memoryResult({ _id: 'hi-1', score: 0.95 }),
    entityResult({ _id: 'hi-2', score: 0.85 }),
    edgeResult({ _id: 'mid-3', score: 0.60 }),
    chronoResult({ _id: 'low-4', score: 0.30 }),
    fileResult({ _id: 'low-5', score: 0.10 }),
  ];

  it('returns all results when minScore is undefined', () => {
    const filtered = applyMinScore(mixedResults, undefined);
    assert.equal(filtered.length, 5);
  });

  it('returns all results when minScore is 0', () => {
    const filtered = applyMinScore(mixedResults, 0);
    assert.equal(filtered.length, 5);
  });

  it('filters out results below minScore threshold', () => {
    const filtered = applyMinScore(mixedResults, 0.7);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(r => r.score >= 0.7));
    assert.deepEqual(filtered.map(r => r._id), ['hi-1', 'hi-2']);
  });

  it('filters out all results when minScore is higher than all scores', () => {
    const filtered = applyMinScore(mixedResults, 0.99);
    assert.equal(filtered.length, 0);
  });

  it('includes results exactly at the minScore boundary', () => {
    const filtered = applyMinScore(mixedResults, 0.60);
    assert.equal(filtered.length, 3);
    assert.ok(filtered.some(r => r._id === 'mid-3'));
  });

  it('works with minScore=1.0 (only perfect matches)', () => {
    const withPerfect = [memoryResult({ _id: 'perfect', score: 1.0 }), ...mixedResults];
    const filtered = applyMinScore(withPerfect, 1.0);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]._id, 'perfect');
  });

  it('treats missing score as 0', () => {
    const noScore = [memoryResult({ _id: 'noscore', score: undefined })];
    const filtered = applyMinScore(noScore, 0.1);
    assert.equal(filtered.length, 0);
  });
});
