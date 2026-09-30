/**
 * How an instant reads to this viewer (`Q-146`, `Q-100`) — the pure half.
 *
 * Every assertion pins the zone to UTC. A local rendering asserted without a zone passes in one office and fails in
 * the next (and on CI, which runs in UTC), so the zone is a parameter here rather than whatever the machine has.
 * Where the LOCALE decides the shape, the assertion is a pattern and a month name, not an exact string: the exact
 * bytes `Intl` produces move between ICU versions (a narrow no-break space before `AM`, for one).
 */
import { describe, it, expect } from 'vitest';
import {
  formatInstant, instantParts, formatRelativeTime, resolveAutoLocale, toEpochMs, parsePreference,
  DEFAULT_DATE_PREFERENCE, type DateFormatOptions,
} from './date-format';

const T = '2026-09-29T07:59:03.000Z';
const opts = (o: Partial<DateFormatOptions>): DateFormatOptions => ({ style: 'auto', zone: 'utc', locale: 'en-US', ...o });

describe('named formats, whatever the language', () => {
  it('ISO 8601 is year-month-day and a 24-hour clock', () => {
    expect(formatInstant(T, 'datetimeSeconds', opts({ style: 'iso', locale: 'de' }))).toBe('2026-09-29 07:59:03 UTC');
    expect(formatInstant(T, 'date', opts({ style: 'iso', locale: 'pl' }))).toBe('2026-09-29');
    expect(formatInstant(T, 'datetime', opts({ style: 'iso' }))).toBe('2026-09-29 07:59 UTC');
  });

  it('day.month.year is dotted with a 24-hour clock', () => {
    expect(formatInstant('2026-09-29T19:05:00.000Z', 'datetimeSeconds', opts({ style: 'dmy24', locale: 'en-US' })))
      .toBe('29.09.2026 19:05:00 UTC');
    expect(formatInstant(T, 'date', opts({ style: 'dmy24' }))).toBe('29.09.2026');
  });

  it('local time converts the zone, and crosses the date line when it must', () => {
    const p = instantParts('2026-08-10T23:30:00.000Z', { style: 'dmy24', zone: 'local', locale: 'de', timeZone: 'Europe/Berlin' })!;
    expect(p.date).toBe('11.08.2026');
    expect(p.time).toBe('01:30:00');
  });

  it('says UTC when it renders UTC, and nothing when it renders local', () => {
    expect(formatInstant(T, 'datetime', opts({ style: 'iso', zone: 'utc' }))).toMatch(/ UTC$/);
    expect(formatInstant(T, 'datetime', { style: 'iso', zone: 'local', locale: 'en', timeZone: 'UTC' })).not.toMatch(/UTC/);
  });
});

describe('Automatic follows the locale (Q-100)', () => {
  it('German and Polish read day first; US English reads month first', () => {
    expect(formatInstant(T, 'date', opts({ locale: 'de' }))).toMatch(/^29\.09\.2026$/);
    expect(formatInstant(T, 'date', opts({ locale: 'pl' }))).toMatch(/^29\.09\.2026$/);
    expect(formatInstant(T, 'date', opts({ locale: 'en-US' }))).toMatch(/^09\/29\/2026$/);
  });

  it('the month name is the language\'s own in the long form', () => {
    expect(formatInstant(T, 'dateLong', opts({ locale: 'de' }))).toMatch(/Sept/);
    expect(formatInstant(T, 'dateLong', opts({ locale: 'pl' }))).toMatch(/wrz/);
    expect(formatInstant(T, 'dateLong', opts({ locale: 'en-US' }))).toMatch(/Sep/);
  });
});

describe('the Automatic locale (D-7: browser locale when its language is the UI language)', () => {
  it('keeps the browser\'s region when the languages agree', () => {
    expect(resolveAutoLocale('en', ['en-GB', 'de-DE'])).toBe('en-GB');
    expect(resolveAutoLocale('de', ['de-AT'])).toBe('de-AT');
  });

  it('takes the UI language when the browser speaks another', () => {
    // The Q-100 report: UI in Deutsch, browser en-US, and every date in US order.
    expect(resolveAutoLocale('de', ['en-US'])).toBe('de');
    expect(resolveAutoLocale('pl', [])).toBe('pl');
  });
});

describe('the ISO value that the hover shows', () => {
  it('is the original instant in UTC, never a localised string', () => {
    expect(instantParts(T, { style: 'dmy24', zone: 'local', locale: 'de', timeZone: 'Europe/Berlin' })!.iso).toBe(T);
  });
});

describe('absent and unparseable input', () => {
  it('formats to empty and parts to null, never "Invalid Date"', () => {
    for (const v of [null, undefined, '', 'not a date', Number.NaN]) {
      expect(formatInstant(v as never, 'datetime', opts({}))).toBe('');
      expect(instantParts(v as never, opts({}))).toBe(null);
    }
  });

  it('epoch-ms is the sort key, so nobody sorts the rendered text', () => {
    expect(toEpochMs('2025-01-02T00:00:00Z')!).toBeLessThan(toEpochMs('2026-02-01T00:00:00Z')!);
    expect(toEpochMs('nonsense')).toBe(null);
  });
});

describe('relative time', () => {
  it('is in the given locale', () => {
    const now = Date.parse(T);
    expect(formatRelativeTime(now - 2 * 3600_000, now, 'de')).toMatch(/Stunden/);
    expect(formatRelativeTime(now - 2 * 3600_000, now, 'en')).toMatch(/2 hours ago/);
  });
});

describe('the stored preference', () => {
  it('reads a valid one and falls back to the default for anything else', () => {
    expect(parsePreference('{"style":"iso","zone":"utc"}')).toEqual({ style: 'iso', zone: 'utc' });
    for (const bad of [null, '', 'not json', '{"style":"weird","zone":"utc"}', '{"style":"iso","zone":"mars"}', '[]']) {
      expect(parsePreference(bad)).toEqual(DEFAULT_DATE_PREFERENCE);
    }
  });
});
