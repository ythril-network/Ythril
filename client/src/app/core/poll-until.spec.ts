/**
 * `pollUntil` — ask again on a delay until an answer says stop, through errors and hidden tabs.
 *
 * Pinned because the hand-written copies each dropped a different guard: one ended its chain on a single failed
 * request (the reindex poll, which left both Reindex buttons held until a reload), others had no stop at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subject, of, throwError } from 'rxjs';
import { pollUntil } from './poll-until';

describe('pollUntil', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });

  it('first asks after the delay, not at once', () => {
    const request = vi.fn(() => of(1));
    pollUntil({ delayMs: () => 5_000, request, onAnswer: () => true });
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_999);
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('asks again while onAnswer says continue, and stops when it says stop', () => {
    const answers = [true, true, false];
    const request = vi.fn(() => of('x'));
    const onAnswer = vi.fn(() => answers.shift() ?? false);
    pollUntil({ delayMs: () => 1_000, request, onAnswer });
    vi.advanceTimersByTime(10_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(onAnswer).toHaveBeenCalledTimes(3);
  });

  it('a failed request schedules the next one instead of ending the chain', () => {
    let fail = true;
    const request = vi.fn(() => (fail ? throwError(() => new Error('reset')) : of('ok')));
    const onAnswer = vi.fn(() => false);
    pollUntil({ delayMs: () => 1_000, request, onAnswer });
    vi.advanceTimersByTime(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
    fail = false;
    vi.advanceTimersByTime(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab skips the request and keeps the schedule', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const request = vi.fn(() => of(1));
    pollUntil({ delayMs: () => 1_000, request, onAnswer: () => true });
    vi.advanceTimersByTime(5_000);
    expect(request).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    vi.advanceTimersByTime(1_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels the next tick and ignores an answer still in flight', () => {
    const inFlight = new Subject<number>();
    const request = vi.fn(() => inFlight);
    const onAnswer = vi.fn(() => true);
    const poll = pollUntil({ delayMs: () => 1_000, request, onAnswer });
    vi.advanceTimersByTime(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    poll.stop();
    inFlight.next(1);
    expect(onAnswer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(poll.active).toBe(false);
  });

  it('the delay is read for every tick, so a caller can change its cadence', () => {
    let delay = 1_000;
    const request = vi.fn(() => of(1));
    pollUntil({ delayMs: () => delay, request, onAnswer: () => { delay = 3_000; return true; } });
    vi.advanceTimersByTime(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_999);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
