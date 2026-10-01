/**
 * Why the graph cannot load right now, in words (`Q-155`).
 *
 * Owner, 2026-09-29: *"maybe index or embedding were not ready - then its enough to show in the graph ui why its not
 * possible at the moment"*. The tab spun with nothing on it while an upgraded instance rebuilt its search indexes.
 */
import { describe, it, expect } from 'vitest';
import { readinessReasons } from './graph-readiness';

describe('readinessReasons', () => {
  it('names indexes being built', () => {
    expect(readinessReasons('building', undefined)).toEqual([{ key: 'graph.waiting.indexBuilding' }]);
  });

  it('names indexes that failed', () => {
    expect(readinessReasons('failed', undefined)).toEqual([{ key: 'graph.waiting.indexFailed' }]);
  });

  it('counts records still waiting to be embedded, pending and in progress together', () => {
    expect(readinessReasons('ready', { pending: 40, processing: 2, failed: 0 }))
      .toEqual([{ key: 'graph.waiting.embedding', params: { count: 42 } }]);
  });

  it('gives both when both are true, indexes first', () => {
    expect(readinessReasons('building', { pending: 1, processing: 0, failed: 0 }).map(r => r.key))
      .toEqual(['graph.waiting.indexBuilding', 'graph.waiting.embedding']);
  });

  it('says nothing it does not know: a ready space with an empty queue has no reason', () => {
    expect(readinessReasons('ready', { pending: 0, processing: 0, failed: 0 })).toEqual([]);
    expect(readinessReasons(undefined, undefined)).toEqual([]);
  });
});
