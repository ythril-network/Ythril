/**
 * `watchConvertRun`: read a conversion's progress until it ends (bundle-285 slice S6, Q-747; plan section 3.1 item 7, handover item 3).
 *
 * Two places show a run as it goes (the dialog a converting Save leaves open, and the note on the type), so the loop is written once, with
 * the guards a hand-written copy forgets:
 *
 * - **A bounded interval.** One read at once, then one every `CONVERT_POLL_MS`; never faster.
 * - **It ends.** On an answer that is not a run in progress (finished, failed, none), on `stop()` (a closed dialog, a destroyed page), and
 *   after `CONVERT_POLL_FAILURES_MAX` reads in a row that failed: a server that never answers is not read for ever.
 * - **A failed read says so, and is tried again.** The caller is told how many failed in a row; one good answer clears the count.
 * - **An answer after `stop()` is dropped**, so a closed dialog is never written to.
 *
 * ## Seen red
 *
 * Red at 64037445f: `pages/settings/convert-status-watch.ts` does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject, of } from 'rxjs';
import type { ConversionResult, ConvertStatusAnswer } from '../../core/conversion.types';
import { doneStatus, okStatus } from '../../testing/popup-convert-fixtures';
import { runningStatus } from '../../testing/review-unconverted-fixtures';
import { CONVERT_POLL_FAILURES_MAX, CONVERT_POLL_MS, watchConvertRun } from './convert-status-watch';

const refusedRead: ConversionResult<ConvertStatusAnswer> = { ok: false, refusal: { kind: 'other', status: 503, error: 'down' } };

function harness(answers: ConversionResult<ConvertStatusAnswer>[]) {
  let read = 0;
  const status = vi.fn(() => of(answers[Math.min(read++, answers.length - 1)]!));
  const seen: ConvertStatusAnswer[] = [];
  const failures: [number, boolean][] = [];
  const finished = vi.fn();
  const watch = watchConvertRun({ status }, 'customers', {
    onStatus: s => seen.push(s), onFailure: (n, gaveUp) => failures.push([n, gaveUp]), onFinished: finished,
  });
  return { status, seen, failures, finished, watch };
}

describe('watchConvertRun', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads at once, then once every CONVERT_POLL_MS while the run is in progress, and hands each answer on', () => {
    const h = harness([okStatus(runningStatus({ left: 30 })), okStatus(runningStatus({ left: 20 })), okStatus(runningStatus({ left: 10 }))]);
    vi.advanceTimersByTime(0);
    expect(h.status).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CONVERT_POLL_MS - 1);
    expect(h.status).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(h.status).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CONVERT_POLL_MS);
    expect(h.status).toHaveBeenCalledTimes(3);
    expect(h.seen.map(s => (s as { left: number }).left)).toEqual([30, 20, 10]);
    expect(h.finished).not.toHaveBeenCalled();
    h.watch.stop();
  });

  it('keeps its interval bounded: three seconds', () => {
    expect(CONVERT_POLL_MS).toBe(3000);
    expect(CONVERT_POLL_FAILURES_MAX).toBeGreaterThan(0);
    expect(CONVERT_POLL_FAILURES_MAX).toBeLessThanOrEqual(60);
  });

  it.each([
    ['a finished run', okStatus(doneStatus())],
    ['a failed run', okStatus(doneStatus({ state: 'failed', error: 'x' }))],
    ['a space that never had a run', okStatus({ state: 'none' })],
  ])('stops after %s and says it is finished', (_name, last) => {
    const h = harness([okStatus(runningStatus()), last]);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(CONVERT_POLL_MS);
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(h.finished).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CONVERT_POLL_MS * 20);
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(h.watch.active).toBe(false);
  });

  it('a failed read is said (how many in a row) and tried again; a good answer clears the count', () => {
    const h = harness([refusedRead, refusedRead, okStatus(runningStatus()), refusedRead]);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(CONVERT_POLL_MS * 3);
    expect(h.failures).toEqual([[1, false], [2, false], [1, false]]);
    expect(h.seen).toHaveLength(1);
    h.watch.stop();
  });

  it('gives up after CONVERT_POLL_FAILURES_MAX failed reads in a row, says so once, and asks no more', () => {
    const h = harness([refusedRead]);
    vi.advanceTimersByTime(CONVERT_POLL_MS * (CONVERT_POLL_FAILURES_MAX + 10));
    expect(h.status).toHaveBeenCalledTimes(CONVERT_POLL_FAILURES_MAX);
    expect(h.failures.at(-1)).toEqual([CONVERT_POLL_FAILURES_MAX, true]);
    expect(h.failures.filter(([, gaveUp]) => gaveUp)).toHaveLength(1);
    expect(h.watch.active).toBe(false);
    expect(h.finished).not.toHaveBeenCalled();
  });

  it('stop() ends it, and an answer still in flight is dropped', () => {
    const inFlight = new Subject<ConversionResult<ConvertStatusAnswer>>();
    const status = vi.fn(() => inFlight);
    const seen: ConvertStatusAnswer[] = [];
    const watch = watchConvertRun({ status }, 'customers', { onStatus: s => seen.push(s), onFailure: () => {} });
    vi.advanceTimersByTime(0);
    expect(status).toHaveBeenCalledTimes(1);
    watch.stop();
    inFlight.next(okStatus(runningStatus()));
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(CONVERT_POLL_MS * 10);
    expect(status).toHaveBeenCalledTimes(1);
  });
});
