/**
 * `LatestWins` — one slot per piece of state an answer writes (`Q-112`).
 *
 * Starting a request cancels the one before it, so a slow answer to an earlier request can never overwrite the
 * answer to a later one — and the cancelled request stops rather than finishing for nobody. The helper was written
 * for the tab search bars (`Q-88`) inside `recall-hits.ts`, where nothing else could find it; it lives in `core/`
 * now, with the three guards a hand-written `switchMap` drops: the error path, a `finally` that runs on cancel too
 * (a loading indicator must not stay on for a request nobody is waiting for), and teardown when the owner is
 * destroyed.
 */
import { DestroyRef } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import { LatestWins } from './latest-wins';

function destroyRef(): DestroyRef & { destroy(): void } {
  const cbs: (() => void)[] = [];
  return { onDestroy: (cb: () => void) => { cbs.push(cb); return () => {}; }, destroy: () => cbs.forEach(c => c()) } as never;
}

describe('LatestWins', () => {
  it('applies only the latest answer, whatever order they arrive in', () => {
    const slot = new LatestWins();
    const a = new Subject<string>(), b = new Subject<string>();
    const applied: string[] = [];
    slot.run(a, v => applied.push(v));
    slot.run(b, v => applied.push(v));
    b.next('B'); a.next('A');
    expect(applied).toEqual(['B']);
    expect(a.observed, 'the superseded request was not cancelled').toBe(false);
  });

  it('routes an error to the error handler, never to the apply', () => {
    const slot = new LatestWins();
    const s = new Subject<string>();
    const apply = vi.fn(), error = vi.fn();
    slot.run(s, { next: apply, error });
    s.error(new Error('boom'));
    expect(apply).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('runs `finally` when the request ends AND when it is superseded or cancelled', () => {
    const slot = new LatestWins();
    const done = vi.fn();
    slot.run(new Subject<string>(), { next: () => {}, finally: done });
    slot.run(new Subject<string>(), { next: () => {}, finally: done });   // supersedes the first
    expect(done).toHaveBeenCalledTimes(1);
    slot.cancel();
    expect(done).toHaveBeenCalledTimes(2);
  });

  it('debounces with `after`, a new call restarting the wait', () => {
    vi.useFakeTimers();
    try {
      const slot = new LatestWins();
      const run = vi.fn();
      slot.after(100, run); vi.advanceTimersByTime(60);
      slot.after(100, run); vi.advanceTimersByTime(60);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60);
      expect(run).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('cancels the pending wait and the request in flight when its owner is destroyed', () => {
    vi.useFakeTimers();
    try {
      const ref = destroyRef();
      const slot = new LatestWins(ref);
      const s = new Subject<string>();
      const apply = vi.fn(), later = vi.fn();
      slot.run(s, apply);
      slot.after(100, later);
      ref.destroy();
      s.next('late'); vi.advanceTimersByTime(200);
      expect(apply).not.toHaveBeenCalled();
      expect(later).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
