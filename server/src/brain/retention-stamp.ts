/**
 * What a retention stamp (`_expireAt`, `_contentExpireAt`) may be: a `Date`, or nothing (bundle-40, Q-268, Q-223).
 *
 * ## What it prevents
 *
 * A stamp stored as anything but a BSON Date never matches the sweep's `{ _expireAt: { $lte: now } }`, so the record it sits on never
 * expires, silently, for as long as it is stored. A backup's stamp arrives as JSON (text, or an EJSON `{"$date": ...}` object, or whatever an
 * older or hand-made body carried), and the import used to store it as it came. This is the ONE question of "what does this value
 * name", asked by the import (`sync/arrivals.ts`, every family) and by the sweep's heal of what an import already stored
 * (`brain/retention-stamp-heal.ts`), so the two cannot disagree about a value.
 *
 * ## The rule
 *
 * - a `Date` that holds an instant stays;
 * - a string passes only when it is `YYYY-MM-DDTHH:MM:SS` with optional fractional seconds and an explicit zone, `Z` or `+hh:mm` / `-hh:mm`,
 *   and every component is real (month 1-12, a day the month has in that year, hour 0-23, minute and second 0-59, an offset of hours 0-23
 *   and minutes 0-59); it becomes the instant it names, whatever zone this process runs in;
 * - everything else (a number, null, an object, a boolean, a zone-less string, a rolled date such as `2020-02-30`, `T24:00`, the basic-form
 *   offset `+hhmm`, a lowercase `z`) is `undefined`, so the field is dropped and the record is stamped as an unstamped one is.
 *
 * It is not `Date.parse`: V8 rolls `2020-02-30` to March 1, reads `T24:00:00` as the next midnight, reads a zone-less string in the host's zone,
 * and takes `+hhmm`. Each of those would give a record a deadline nobody set.
 */

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function daysIn(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** The instant a stored or arriving retention stamp names, or `undefined` when it names none (the field is then dropped). */
export function retentionStampOf(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : new Date(value.getTime());
  if (typeof value !== 'string') return undefined;
  const m = STAMP.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  let offsetMs = 0;
  if (m[8] !== undefined) {
    const offHour = Number(m[9]);
    const offMinute = Number(m[10]);
    if (offHour > 23 || offMinute > 59) return undefined;
    offsetMs = (m[8] === '-' ? -1 : 1) * (offHour * 60 + offMinute) * 60_000;
  }
  // To the millisecond, as `Date#toJSON` writes: the digits past the third are cut, never rounded.
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0').slice(0, 3));
  // `Date.UTC` reads a year 0-99 as 1900-1999: the component is set explicitly so a four-digit year means itself.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, ms);
  const instant = at.getTime() - offsetMs;
  return Number.isNaN(instant) ? undefined : new Date(instant);
}
