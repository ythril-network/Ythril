/**
 * How an instant reads to this viewer — the ONE place the client turns a timestamp into text (`Q-146`, `Q-100`).
 *
 * Owner, 2026-09-29: *"iso date utc saved, local format displayed … we need a date-formatting setting so iso
 * timestamps can be displayed that way everywhere on ythril ui."* Before this, twenty places formatted their own
 * dates in five spellings, and the two shared components each had their own `Intl` call — one pinned to `de-DE`
 * for every language, the other ignoring a language switch. A setting only reaches the dates that ask it, so this
 * module is the only file allowed to format one; `testing/one-date-formatter.spec.ts` fails on any other.
 *
 * ## RENDERING ONLY
 *
 * Owner, 2026-08-10: *"dont change the 'we save utc' stance. just for rendering local"*. Storage, the wire format,
 * the API, sync and the audit log stay ISO 8601 UTC. Everything here takes the UTC value and converts at render
 * time; `iso` is always the original instant in UTC, and the views put it on `<time datetime>` and the hover.
 *
 * ## The formats
 *
 * - `auto` — the viewer's locale decides order and clock (`resolveAutoLocale`, decision D-7).
 * - `iso` — `2026-09-29 07:59:03`, year first, 24-hour. Sorts as text, reads the same in every language.
 * - `dmy24` — `29.09.2026 07:59:03`, the app's long-standing table convention.
 *
 * A zone of `utc` renders UTC and says so (` UTC` after the time); `local` renders the browser's zone and says
 * nothing, because that is what a reader assumes a time on their screen means.
 *
 * `Intl` formatters are cached per (locale, zone, shape): a table re-renders on every change-detection pass through
 * the impure pipe, and constructing a `DateTimeFormat` is the expensive half of formatting.
 */

export type InstantValue = string | number | Date | null | undefined;

export type DateStyle = 'auto' | 'iso' | 'dmy24';
export type DateZone = 'local' | 'utc';

export interface DatePreference {
  style: DateStyle;
  zone: DateZone;
}

/** What the viewer sees before choosing: their locale, their zone. */
export const DEFAULT_DATE_PREFERENCE: Readonly<DatePreference> = Object.freeze({ style: 'auto', zone: 'local' });

export const DATE_STYLES: readonly DateStyle[] = ['auto', 'iso', 'dmy24'];
export const DATE_ZONES: readonly DateZone[] = ['local', 'utc'];

/** The preference plus the locale `auto` resolves to. `timeZone` overrides `local` — for tests, never for callers. */
export interface DateFormatOptions extends DatePreference {
  locale: string;
  timeZone?: string;
}

/**
 * - `date` — the calendar date alone.
 * - `dateLong` — the date with the month named, for prose ("expires 29 Sept 2026").
 * - `time` — the clock with seconds.
 * - `datetime` — date and clock to the minute.
 * - `datetimeSeconds` — date and clock to the second, for audit-grade places.
 */
export type InstantVariant = 'date' | 'dateLong' | 'time' | 'datetime' | 'datetimeSeconds';

/** Epoch-ms from an ISO string / epoch-ms / Date, or null when unparseable — the sort key, never the rendered text. */
export function toEpochMs(value: InstantValue): number | null {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * The locale `auto` uses: the browser's own locale when it speaks the UI language, else the UI language (D-7).
 *
 * The owner asked for "the browser's locale by default"; `Q-100` asked that the language the user PICKED decide.
 * They agree whenever the browser and the UI speak the same language, and this keeps the browser's region then
 * (`en-GB` stays day-first). They disagree only when the UI is switched away from the browser's language — the
 * `Q-100` report, a German UI in an `en-US` browser rendering US dates — and there the UI language wins.
 * Reversing D-7 is this one line: return `browserLanguages[0] ?? uiLanguage`.
 */
export function resolveAutoLocale(uiLanguage: string, browserLanguages: readonly string[]): string {
  const ui = uiLanguage.toLowerCase();
  return browserLanguages.find(l => l.toLowerCase().split('-')[0] === ui) ?? uiLanguage;
}

/** A stored preference, or the default for anything that is not exactly one. */
export function parsePreference(raw: string | null): DatePreference {
  if (!raw) return { ...DEFAULT_DATE_PREFERENCE };
  try {
    const v = JSON.parse(raw) as Partial<DatePreference> | null;
    if (v && typeof v === 'object' && !Array.isArray(v)
      && DATE_STYLES.includes(v.style as DateStyle) && DATE_ZONES.includes(v.zone as DateZone)) {
      return { style: v.style as DateStyle, zone: v.zone as DateZone };
    }
  } catch { /* not JSON: the default */ }
  return { ...DEFAULT_DATE_PREFERENCE };
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, timeZone: string | undefined, shape: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone ?? ''}|${JSON.stringify(shape)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...shape, ...(timeZone ? { timeZone } : {}) });
    } catch {
      // An unknown locale from a browser setting: English order rather than a thrown render.
      f = new Intl.DateTimeFormat('en', { ...shape, ...(timeZone ? { timeZone } : {}) });
    }
    cache.set(key, f);
  }
  return f;
}

const DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
const DATE_LONG: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
const CLOCK_S: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
const CLOCK_M: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/** The zone `Intl` is given: UTC, a test's override, or the browser's (undefined). */
function zoneOf(o: DateFormatOptions): string | undefined {
  return o.zone === 'utc' ? 'UTC' : o.timeZone;
}

/** Year, month, day, hour, minute, second as two-digit strings in the zone — for the named formats. */
function fields(d: Date, tz: string | undefined): Record<'y' | 'mo' | 'd' | 'h' | 'mi' | 's', string> {
  const parts = formatter('en-US', tz, { ...DATE, ...CLOCK_S, hourCycle: 'h23' }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)?.value ?? '';
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/**
 * The date and the clock as SEPARATE strings, plus the original instant — for the two-line table cell.
 * Null for an absent or unparseable value, so a view shows a dash instead of "Invalid Date".
 */
export function instantParts(value: InstantValue, o: DateFormatOptions): { date: string; time: string; iso: string } | null {
  const t = toEpochMs(value);
  if (t === null) return null;
  const d = new Date(t);
  const tz = zoneOf(o);
  let date: string;
  let time: string;
  if (o.style === 'auto') {
    date = formatter(o.locale, tz, DATE).format(d);
    time = formatter(o.locale, tz, CLOCK_S).format(d);
  } else {
    const f = fields(d, tz);
    date = o.style === 'iso' ? `${f.y}-${f.mo}-${f.d}` : `${f.d}.${f.mo}.${f.y}`;
    time = `${f.h}:${f.mi}:${f.s}`;
  }
  if (o.zone === 'utc') time += ' UTC';
  return { date, time, iso: d.toISOString() };
}

/** One instant as one line of text in the viewer's format; '' for an absent or unparseable value. */
export function formatInstant(value: InstantValue, variant: InstantVariant, o: DateFormatOptions): string {
  const t = toEpochMs(value);
  if (t === null) return '';
  const d = new Date(t);
  const tz = zoneOf(o);
  const utc = o.zone === 'utc' ? ' UTC' : '';

  if (variant === 'dateLong' && o.style === 'auto') return formatter(o.locale, tz, DATE_LONG).format(d);

  if (o.style === 'auto') {
    switch (variant) {
      case 'date': case 'dateLong': return formatter(o.locale, tz, DATE).format(d);
      case 'time': return formatter(o.locale, tz, CLOCK_S).format(d) + utc;
      case 'datetime': return formatter(o.locale, tz, { ...DATE, ...CLOCK_M }).format(d) + utc;
      case 'datetimeSeconds': return formatter(o.locale, tz, { ...DATE, ...CLOCK_S }).format(d) + utc;
    }
  }
  const f = fields(d, tz);
  const date = o.style === 'iso' ? `${f.y}-${f.mo}-${f.d}` : `${f.d}.${f.mo}.${f.y}`;
  switch (variant) {
    case 'date': case 'dateLong': return date;
    case 'time': return `${f.h}:${f.mi}:${f.s}${utc}`;
    case 'datetime': return `${date} ${f.h}:${f.mi}${utc}`;
    case 'datetimeSeconds': return `${date} ${f.h}:${f.mi}:${f.s}${utc}`;
  }
}

/**
 * A CALENDAR date that has no zone — a spreadsheet cell's date, which the reader decodes as midnight UTC. Shown in
 * the viewer's date format but always read in UTC, or a viewer west of Greenwich sees the day before.
 */
export function formatCalendarDate(value: Date, o: DateFormatOptions): string {
  return formatInstant(value, 'date', { ...o, zone: 'utc' });
}

/** "2 hours ago" / "in 3 days" in the locale, picking the largest sensible unit. Pure: `nowMs` is a parameter. */
export function formatRelativeTime(value: InstantValue, nowMs: number, locale = 'en'): string {
  const t = toEpochMs(value);
  if (t === null) return '';
  const diff = t - nowMs;
  const a = Math.abs(diff);
  let rtf: Intl.RelativeTimeFormat;
  try { rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }); } catch { rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }); }
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H, W = 7 * D, MO = 30 * D, Y = 365 * D;
  if (a < M) return rtf.format(Math.round(diff / S), 'second');
  if (a < H) return rtf.format(Math.round(diff / M), 'minute');
  if (a < D) return rtf.format(Math.round(diff / H), 'hour');
  if (a < W) return rtf.format(Math.round(diff / D), 'day');
  if (a < MO) return rtf.format(Math.round(diff / W), 'week');
  if (a < Y) return rtf.format(Math.round(diff / MO), 'month');
  return rtf.format(Math.round(diff / Y), 'year');
}

/** The browser's own time zone name (`Europe/Berlin`), for the settings page to say what "local" means. */
export function browserTimeZone(): string {
  try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** The original instant in UTC ISO 8601, for `<time datetime>` and the hover; '' when there is none. */
export function isoOf(value: InstantValue): string {
  const t = toEpochMs(value);
  return t === null ? '' : new Date(t).toISOString();
}
