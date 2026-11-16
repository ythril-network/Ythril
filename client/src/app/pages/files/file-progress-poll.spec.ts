/**
 * The Files page's progress poll (`file-progress-poll.ts`), reached without the page.
 *
 * It exists only while a row on screen is still being processed, never stacks a second timer, ends itself when the rows are done, and
 * `stop()` ends it for a folder nobody is looking at. Moved out of `file-manager.component.ts` (Q-861) with its behaviour unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FileEntry } from '../../core/api.types';
import { entriesInFlight, FileProgressPoll, PROGRESS_POLL_MS } from './file-progress-poll';

const row = (over: Partial<FileEntry> = {}): FileEntry => ({ name: 'a.pdf', isDirectory: false, ...over } as FileEntry);

describe('entriesInFlight', () => {
  it('is true for a row with progress, a pending row and a processing row, and false for every finished state', () => {
    expect(entriesInFlight([row({ progress: { step: 'ocr', steps: ['ocr'] } })])).toBe(true);
    expect(entriesInFlight([row({ embeddingStatus: 'pending' })])).toBe(true);
    expect(entriesInFlight([row({ embeddingStatus: 'processing' })])).toBe(true);
    for (const status of ['complete', 'partial', 'failed', 'skipped', 'disabled'] as const) {
      expect(entriesInFlight([row({ embeddingStatus: status })])).toBe(false);
    }
    expect(entriesInFlight([row()])).toBe(false);
    expect(entriesInFlight([])).toBe(false);
  });

  it('finds one in-flight row among finished ones', () => {
    expect(entriesInFlight([row({ embeddingStatus: 'complete' }), row({ embeddingStatus: 'processing' })])).toBe(true);
  });
});

describe('FileProgressPoll', () => {
  let entries: FileEntry[];
  let refresh: ReturnType<typeof vi.fn>;
  let poll: FileProgressPoll;
  beforeEach(() => {
    vi.useFakeTimers();
    entries = [row({ embeddingStatus: 'processing' })];
    refresh = vi.fn();
    poll = new FileProgressPoll(() => entries, refresh);
  });
  afterEach(() => {
    poll.stop();
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('polls every PROGRESS_POLL_MS while a row is in flight, and not before the first interval', () => {
    poll.sync();
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PROGRESS_POLL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PROGRESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('an idle folder polls nothing', () => {
    entries = [row({ embeddingStatus: 'complete' })];
    poll.sync();
    vi.advanceTimersByTime(PROGRESS_POLL_MS * 5);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never stacks a second timer when synced again while running', () => {
    poll.sync();
    poll.sync();
    poll.sync();
    vi.advanceTimersByTime(PROGRESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ends itself once the answer shows nothing in flight', () => {
    poll.sync();
    refresh.mockImplementation(() => { entries = [row({ embeddingStatus: 'complete' })]; });
    vi.advanceTimersByTime(PROGRESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PROGRESS_POLL_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a sync that finds nothing in flight stops a running poll', () => {
    poll.sync();
    entries = [];
    poll.sync();
    vi.advanceTimersByTime(PROGRESS_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stop() ends it, and a later sync with a row in flight starts a fresh one', () => {
    poll.sync();
    poll.stop();
    vi.advanceTimersByTime(PROGRESS_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
    poll.sync();
    vi.advanceTimersByTime(PROGRESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the tab is hidden and resumes when it is looked at', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    poll.sync();
    vi.advanceTimersByTime(PROGRESS_POLL_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    vi.advanceTimersByTime(PROGRESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
