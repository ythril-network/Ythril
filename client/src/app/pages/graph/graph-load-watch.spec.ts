/**
 * `GraphLoadWatch` — the in-flight flag, the explain-the-wait clock and its reasons (`Q-155`, split by `Q-162`).
 *
 * The component specs drive this through a real page; these pin the two properties a page cannot easily show:
 * a second `begin()` leaves no orphan clock behind, and `end()` keeps the reasons for the error state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { GraphLoadWatch, WAIT_EXPLAIN_MS } from './graph-load-watch';

function makeWatch(indexStatus: 'building' | 'ready' = 'building') {
  const source = {
    listSpaces: vi.fn(() => of({ spaces: [{ id: 's1', indexStatus }] } as any)),
    getSpaceStats: vi.fn(() => of({ embedQueue: { pending: 3, processing: 1, failed: 0 } } as any)),
  };
  const translator = { translate: vi.fn((key: string, p?: Record<string, unknown>) => `${key}:${p?.['seconds']}`) };
  return { watch: new GraphLoadWatch(source, translator), source, translator };
}

describe('GraphLoadWatch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is loading at once, and says it is waiting only once the load has run long', () => {
    const { watch, source } = makeWatch();
    watch.begin('s1');
    expect([watch.loading(), watch.waiting()]).toEqual([true, false]);
    vi.advanceTimersByTime(WAIT_EXPLAIN_MS - 1);
    expect(source.getSpaceStats).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(watch.waiting()).toBe(true);
    expect(watch.reasons().map(r => r.key)).toEqual(['graph.waiting.indexBuilding', 'graph.waiting.embedding']);
  });

  it('end() stops the clock and keeps the reasons, so an error state can still show them', () => {
    const { watch } = makeWatch();
    watch.begin('s1');
    vi.advanceTimersByTime(WAIT_EXPLAIN_MS);
    watch.end();
    expect([watch.loading(), watch.waiting()]).toEqual([false, false]);
    expect(watch.reasons().length).toBe(2);
  });

  it('a second begin() replaces the first clock rather than leaving it to fire', () => {
    const { watch, source } = makeWatch();
    watch.begin('s1');
    vi.advanceTimersByTime(WAIT_EXPLAIN_MS - 1);
    watch.begin('s1');
    vi.advanceTimersByTime(WAIT_EXPLAIN_MS - 1);
    expect(source.listSpaces).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(source.listSpaces).toHaveBeenCalledTimes(1);
  });

  it('a readiness lookup that fails names nothing instead of failing', () => {
    const { watch, source } = makeWatch();
    source.listSpaces.mockReturnValue(throwError(() => new Error('down')));
    source.getSpaceStats.mockReturnValue(throwError(() => new Error('down')));
    watch.begin('s1');
    vi.advanceTimersByTime(WAIT_EXPLAIN_MS);
    expect(watch.waiting()).toBe(true);
    expect(watch.reasons()).toEqual([]);
  });

  it('words the give-up in seconds', () => {
    const { watch } = makeWatch();
    expect(watch.gaveUpMessage()).toBe('graph.waiting.gaveUp:30');
  });
});
