/**
 * RelativeTime — the pure formatter is the load-bearing bit (deterministic under a fixed `now`).
 */
import { describe, it, expect } from 'vitest';
// The pure formatter moved to `core/date-format.ts` with every other date formatting (Q-146).
import { formatRelativeTime, toEpochMs } from '../core/date-format';

const NOW = Date.parse('2026-07-19T12:00:00Z');

describe('toEpochMs', () => {
  it('parses ISO strings, epoch numbers, and Dates', () => {
    expect(toEpochMs('2026-07-19T12:00:00Z')).toBe(NOW);
    expect(toEpochMs(NOW)).toBe(NOW);
    expect(toEpochMs(new Date(NOW))).toBe(NOW);
  });
  it('returns null for null/undefined/garbage', () => {
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs('not a date')).toBeNull();
  });
});

describe('formatRelativeTime (en, fixed now)', () => {
  const rel = (v: string | number | Date) => formatRelativeTime(v, NOW, 'en');

  it('formats recent past with the largest sensible unit', () => {
    expect(rel(NOW - 30 * 1000)).toMatch(/30 seconds ago/);
    expect(rel(NOW - 5 * 60 * 1000)).toMatch(/5 minutes ago/);
    expect(rel(NOW - 2 * 3600 * 1000)).toMatch(/2 hours ago/);
    expect(rel(NOW - 3 * 86400 * 1000)).toMatch(/3 days ago/);
  });

  it('formats the future direction', () => {
    expect(rel(NOW + 2 * 3600 * 1000)).toMatch(/in 2 hours/);
    // numeric:'auto' → "next week" for +1 week (nicer than "in 1 week").
    expect(rel(NOW + 10 * 86400 * 1000)).toMatch(/next week|in \d+ weeks/);
  });

  it('uses months/years for large gaps', () => {
    expect(rel(NOW - 60 * 86400 * 1000)).toMatch(/months? ago/);
    // numeric:'auto' → "last year" for -1 year.
    expect(rel(NOW - 400 * 86400 * 1000)).toMatch(/last year|years? ago/);
  });

  it('returns empty string for unparseable input', () => {
    expect(rel('nope')).toBe('');
  });

  it('is locale-aware (de differs from en)', () => {
    const en = formatRelativeTime(NOW - 2 * 3600 * 1000, NOW, 'en');
    const de = formatRelativeTime(NOW - 2 * 3600 * 1000, NOW, 'de');
    expect(en).not.toBe(de);      // "2 hours ago" vs "vor 2 Stunden"
    expect(de).toMatch(/Stunden/);
  });
});
