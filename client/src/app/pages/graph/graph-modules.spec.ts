/**
 * Direct tests for the pure modules extracted from `graph.component.ts`.
 *
 * These are NOT a re-run of `graph.component.characterization.spec.ts`, which drives the same logic
 * through the component and is what proves the split preserved behaviour. What these add is the part
 * that was impractical to reach from outside: the traversal cache's full decision table, including the
 * combinations a user cannot produce by clicking (a cache that is truncated AND shallower, a request
 * against an empty cache), plus the boundaries — the exact depth cut, an empty result, a root with no
 * edges. No TestBed, so they run in milliseconds.
 *
 * That is the point of extracting them: this file could not have been written against the original.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDetailRows, filterAndSortDetails, nextSort, memoryText, chronoText,
} from './graph-details';
import {
  emptyCache, decideFetch, applyResult, filterToDepth, type TraversalCache,
} from './graph-traversal-cache';
import { buildElements, typeColor, DEFAULT_GRAPH_THEME } from './graph-cytoscape';
import type { TraverseNode, TraverseEdge, Entity } from '../../core/api.types';

const node = (id: string, depth: number): TraverseNode => ({ _id: id, name: id.toUpperCase(), type: 'thing', depth });
const edge = (id: string, from: string, to: string): TraverseEdge => ({ _id: id, from, to, label: 'rel' });

function cacheOf(nodes: TraverseNode[], edges: TraverseEdge[], over: Partial<TraversalCache> = {}): TraversalCache {
  return { startId: 'root', direction: 'both', maxDepth: 2, nodes, edges, truncated: false, ...over };
}

describe('graph-traversal-cache — the decision table', () => {
  const req = { startId: 'root', maxDepth: 2, direction: 'both' as const };

  it('has nothing to serve from an empty cache', () => {
    expect(decideFetch(emptyCache(), req)).toBe('replace');
  });

  it('serves the same depth from cache, not just a shallower one', () => {
    // The boundary is `<=`, not `<`. Off by one here means every re-render of an unchanged view
    // re-fetches — correct on screen, invisible in testing, and obvious only in request logs.
    expect(decideFetch(cacheOf([], []), { ...req, maxDepth: 2 })).toBe('from-cache');
    expect(decideFetch(cacheOf([], []), { ...req, maxDepth: 1 })).toBe('from-cache');
    expect(decideFetch(cacheOf([], []), { ...req, maxDepth: 3 })).toBe('incremental');
  });

  it('replaces rather than merges whenever the cache is truncated — at ANY depth', () => {
    // Reachable by clicking only in one direction, but the rule is unconditional: a truncated result
    // is not a prefix of a deeper one, so merging would keep nodes the server has since dropped.
    const t = cacheOf([], [], { truncated: true });
    expect(decideFetch(t, { ...req, maxDepth: 3 })).toBe('replace');
    expect(decideFetch(t, { ...req, maxDepth: 2 })).toBe('from-cache');  // still a subset — safe
  });

  it('treats direction as identity, not as a filter', () => {
    const c = cacheOf([], []);
    expect(decideFetch(c, { ...req, direction: 'inbound' })).toBe('replace');
    expect(decideFetch(c, { ...req, direction: 'outbound', maxDepth: 1 })).toBe('replace');
  });

  it('treats a different root as a different cache', () => {
    expect(decideFetch(cacheOf([], []), { ...req, startId: 'other', maxDepth: 1 })).toBe('replace');
  });

  it('merges without duplicating what it already holds', () => {
    const before = cacheOf([node('a', 1)], [edge('e1', 'root', 'a')]);
    const after = applyResult(before, 'incremental', { ...req, maxDepth: 3 }, {
      nodes: [node('a', 1), node('b', 3)],           // 'a' repeated by the deeper traversal
      edges: [edge('e1', 'root', 'a'), edge('e2', 'a', 'b')],
      truncated: false,
    });
    expect(after.nodes.map(n => n._id)).toEqual(['a', 'b']);
    expect(after.edges.map(e => e._id)).toEqual(['e1', 'e2']);
    expect(after.maxDepth).toBe(3);
  });

  it('does not mutate the cache it was given', () => {
    // The component holds this in a field read during rendering; growing it in place would make
    // "what is cached" depend on when it was observed.
    const before = cacheOf([node('a', 1)], []);
    applyResult(before, 'incremental', { ...req, maxDepth: 3 }, { nodes: [node('b', 3)], edges: [], truncated: false });
    expect(before.nodes.map(n => n._id)).toEqual(['a']);
  });

  it('a replace drops what the previous root had', () => {
    const before = cacheOf([node('stale', 1)], [edge('old', 'root', 'stale')]);
    const after = applyResult(before, 'replace', { ...req, startId: 'other' }, {
      nodes: [node('fresh', 1)], edges: [], truncated: true,
    });
    expect(after.nodes.map(n => n._id)).toEqual(['fresh']);
    expect(after.edges).toEqual([]);
    expect([after.startId, after.truncated]).toEqual(['other', true]);
  });

  it('cuts at the depth boundary inclusively', () => {
    const c = cacheOf([node('a', 1), node('b', 2), node('c', 3)], []);
    expect(filterToDepth(c, 'root', 2).nodes.map(n => n._id)).toEqual(['a', 'b']);
    expect(filterToDepth(c, 'root', 0).nodes).toEqual([]);
  });

  it('keeps an edge only when both endpoints survive, counting the root as present', () => {
    const c = cacheOf(
      [node('a', 1), node('deep', 3)],
      [edge('fromRoot', 'root', 'a'), edge('toRoot', 'a', 'root'), edge('dangling', 'a', 'deep')],
    );
    // The root is never in the node list — it is the thing being traversed FROM — so without forcing
    // it into the visible set, every edge touching it would be dropped as dangling.
    expect(filterToDepth(c, 'root', 2).edges.map(e => e._id)).toEqual(['fromRoot', 'toRoot']);
  });
});

describe('graph-cytoscape — the element model', () => {
  const root = { _id: 'root', name: 'Ada', type: 'person' } as Entity;

  it('emits nothing at all for an empty graph with no root', () => {
    expect(buildElements(null, [], [], 'root')).toEqual([]);
  });

  it('emits a lone root when the traversal found nothing', () => {
    const els = buildElements(root, [], [], 'root');
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ group: 'nodes', classes: 'root', data: { depth: 0 } });
  });

  it('never emits a duplicate id when the traversal echoes the root back', () => {
    // cytoscape rejects a repeated id outright, so this guard is the difference between a graph and
    // an exception.
    const els = buildElements(root, [node('root', 0), node('a', 1)], [], 'root');
    expect(els.filter(e => e.data.id === 'root')).toHaveLength(1);
  });

  it('skips the root by id, not by identity — a renamed root node is still the root', () => {
    const els = buildElements(root, [{ ...node('root', 0), name: 'Different' }], [], 'root');
    expect(els.map(e => e.data['label'])).toEqual(['Ada']);
  });

  it('renames from/to to source/target', () => {
    const els = buildElements(root, [node('a', 1)], [edge('e1', 'root', 'a')], 'root');
    expect(els.at(-1)).toEqual({ group: 'edges', data: { id: 'e1', source: 'root', target: 'a', label: 'rel' } });
  });

  it('substitutes a "default" type rather than emitting undefined', () => {
    const els = buildElements({ ...root, type: '' } as Entity, [{ ...node('a', 1), type: '' }], [], 'root');
    expect(els.map(e => e.data['type'])).toEqual(['default', 'default']);
  });
});

describe('graph-cytoscape — type colours', () => {
  it('returns one fixed colour before the theme has been read', () => {
    // An empty palette means "not read yet", which is why DEFAULT_GRAPH_THEME does not pre-fill it.
    expect(DEFAULT_GRAPH_THEME.typeColors).toEqual([]);
    expect(typeColor(DEFAULT_GRAPH_THEME, 'person')).toBe(typeColor(DEFAULT_GRAPH_THEME, 'place'));
  });

  it('is stable per type, so a type keeps its colour with nothing persisted', () => {
    const theme = { ...DEFAULT_GRAPH_THEME, typeColors: ['#a', '#b', '#c'] };
    expect(typeColor(theme, 'person')).toBe(typeColor(theme, 'person'));
    expect(theme.typeColors).toContain(typeColor(theme, 'a-type-never-seen-before'));
  });
});

describe('graph-details — derivation boundaries', () => {
  it('falls back only when the primary field is empty, not merely absent', () => {
    expect(memoryText({ _id: 'm', fact: '', description: 'fallback', createdAt: '' })).toBe('fallback');
    expect(memoryText({ _id: 'm', description: 'fallback', createdAt: '' })).toBe('fallback');
    expect(memoryText({ _id: 'm', fact: 'primary', description: 'fallback', createdAt: '' })).toBe('primary');
    expect(memoryText({ _id: 'm', createdAt: '' })).toBe('');
    expect(chronoText({ _id: 'c', title: '', description: 'fallback', tags: [], createdAt: '' })).toBe('fallback');
  });

  it('puts facts before chrono — the tie-break that keeps the table stable', () => {
    const rows = buildDetailRows(
      [{ _id: 'm1', fact: 'x', createdAt: 'same' }],
      [{ _id: 'c1', title: 'y', tags: [], createdAt: 'same' }],
    );
    expect(rows.map(r => r.id)).toEqual(['m1', 'c1']);
  });

  it('never returns the array it was given, so a signal cannot change without a write', () => {
    const rows = buildDetailRows([{ _id: 'm1', fact: 'x', createdAt: 'a' }], []);
    const sorted = filterAndSortDetails(rows, { type: 'all', text: '', field: 'createdAt', asc: false });
    expect(sorted).not.toBe(rows);
  });

  it('an empty text filter matches everything rather than nothing', () => {
    const rows = buildDetailRows([{ _id: 'm1', fact: '', createdAt: 'a' }], []);
    expect(filterAndSortDetails(rows, { type: 'all', text: '', field: 'createdAt', asc: false })).toHaveLength(1);
  });

  /*
   * Moved down from `graph.component.characterization.spec.ts` in G-7, not deleted.
   *
   * Both cases reached through the component to exercise this pure function, and the component lost its sort
   * controls when the detail table became `graph-linked-records` — which filters but does not sort. Reaching
   * through a component for a function's behaviour is what let the assertions go on passing after the only
   * way a user could trigger them had gone.
   */
  it('composes kind + text + sort rather than letting one win', () => {
    const rows = buildDetailRows(
      [{ _id: 'm1', fact: 'apple', createdAt: '2026-01-02' },
       { _id: 'm2', fact: 'banana', createdAt: '2026-01-01' }],
      [{ _id: 'c1', title: 'apricot', tags: [], createdAt: '2026-01-03' }],
    );
    const out = filterAndSortDetails(rows, { type: 'fact', text: 'a', field: 'description', asc: true });
    expect(out.map(r => r.id)).toEqual(['m1', 'm2']);
  });

  it('sorts description case-insensitively', () => {
    const rows = buildDetailRows(
      [{ _id: 'a', fact: 'beta', createdAt: '2026-01-01' },
       { _id: 'b', fact: 'Alpha', createdAt: '2026-01-02' }],
      [],
    );
    const out = filterAndSortDetails(rows, { type: 'all', text: '', field: 'description', asc: true });
    expect(out.map(r => r.id)).toEqual(['b', 'a']);
  });

  it('starts a new column ascending from either previous direction', () => {
    expect(nextSort({ field: 'createdAt', asc: false }, 'description')).toEqual({ field: 'description', asc: true });
    expect(nextSort({ field: 'createdAt', asc: true }, 'description')).toEqual({ field: 'description', asc: true });
    expect(nextSort({ field: 'createdAt', asc: true }, 'createdAt')).toEqual({ field: 'createdAt', asc: false });
  });
});
