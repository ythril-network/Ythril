/**
 * Phase 3 of the conversation extractor — resolve time (`F-31`, DECOMPOSITION.md §3). Code, except the two
 * judgements the document names (3.4 *the exchange places it today*, 3.9 *it genuinely took more than a
 * day*), which arrive here as inputs rather than being decided here.
 *
 * Why this is code: the prompt spends a section on *"last Tuesday"* and another on *"more than a day"*,
 * every rule in them is calendar arithmetic, and *"a confidently wrong date on a timeline has nothing
 * anywhere to contradict it."* A model gets these wrong quietly; a function gets them wrong once, in a test.
 *
 * Three steps, each separately testable:
 *  - `findTemporalExpressions` (3.1, 3.2) — find and classify, no dates yet;
 *  - `resolveExpression` (3.3, 3.5–3.7) — anchor one expression to its session date;
 *  - `chronoDatesFor` (3.10, 3.11) — whether a resolution may put anything on a timeline, and what.
 *
 * Dates are `YYYY-MM-DD` strings and all arithmetic is in UTC, so the machine's zone can never move a day.
 */
import {
  WEEKDAYS, MONTHS, NUMBER_WORDS, APPROXIMATE, INDEFINITE_AMOUNTS, UNITS, PAST_MARKERS, FUTURE_MARKERS,
  RELATIVE_DAYS, WEEKDAY_QUALIFIERS, WEEKENDS, PERIODS, VAGUE,
} from './time-lexicon.js';

type Unit = 'day' | 'week' | 'month' | 'year';

/** What an expression IS, before any date is attached (3.2). */
export type TemporalExpression =
  | { kind: 'absolute-day'; year?: number; month: number; day: number }
  | { kind: 'absolute-month'; year: number; month: number }
  | { kind: 'absolute-year'; year: number }
  | { kind: 'relative-day'; offsetDays: number }
  | { kind: 'weekday'; weekday: number; direction: 'past' | 'future' | 'this' | 'unknown' }
  | { kind: 'weekend'; which: 'last' | 'this' | 'next' | 'unknown' }
  | { kind: 'offset'; amount?: number; unit: Unit; direction: 'past' | 'future'; approximate: boolean }
  | { kind: 'duration'; amount?: number; unit: Unit; approximate: boolean }
  | { kind: 'period'; unit: 'week' | 'month' | 'year'; which: 'past' | 'this' | 'future' }
  | { kind: 'vague' };

export interface FoundExpression {
  /** The matched text, as it appears. */
  text: string;
  start: number;
  end: number;
  expr: TemporalExpression;
}

/** A resolved expression. `value` is in the format its precision names: `YYYY-MM-DD`, `YYYY-MM` or `YYYY`. */
export interface Resolution {
  precision: 'day' | 'month' | 'year' | 'none';
  value?: string;
  /** Set only on a genuine two-ended range the conversation handed over — a weekend, today. */
  endsAt?: string;
  /** The expression was approximate: no day may be derived from it (3.6). */
  approximate: boolean;
  /** The session date an approximate or undated expression is stated AS OF. Always set. */
  asOf: string;
  /**
   * For a calendar period with no day (`last week`), the days it spans — context for a claim's sentence
   * (*"in the week before 7 August"*), never a chrono range: the event took a day, the week is the doubt.
   */
  window?: { from: string; to: string };
}

// ── calendar arithmetic ───────────────────────────────────────────────────

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
export const weekdayOf = (s: string): number => day(s).getUTCDay();
const pad = (n: number) => String(n).padStart(2, '0');

function addMonths(s: string, n: number): string {
  const d = day(s);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** Most recent `weekday` strictly before `s`. The day of speaking never counts (3.3). */
function previous(s: string, weekday: number): string {
  const back = ((weekdayOf(s) - weekday + 7) % 7) || 7;
  return addDays(s, -back);
}

/** Nearest `weekday` strictly after `s`. */
function following(s: string, weekday: number): string {
  const fwd = ((weekday - weekdayOf(s) + 7) % 7) || 7;
  return addDays(s, fwd);
}

// ── 3.1 / 3.2 — find and classify ─────────────────────────────────────────

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (ws: readonly string[]) => [...ws].sort((a, b) => b.length - a.length).map(esc).join('|');

const WD = alt(WEEKDAYS);
const MO = alt(MONTHS);
const NUM = `\\d+|${alt(Object.keys(NUMBER_WORDS))}`;
const APX = alt(APPROXIMATE);
const UNIT = alt(Object.keys(UNITS));
const PASTM = alt(PAST_MARKERS);
const FUTM = alt(FUTURE_MARKERS);
const ORD = '(?:st|nd|rd|th)?';

const amountOf = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  return /^\d+$/.test(t) ? Number(t) : NUMBER_WORDS[t];
};
const isIndefinite = (raw: string | undefined) => !!raw && (INDEFINITE_AMOUNTS as readonly string[]).includes(raw.toLowerCase());
const monthNumber = (name: string) => MONTHS.indexOf(name.toLowerCase() as typeof MONTHS[number]) + 1;

type Matcher = { re: RegExp; build: (m: RegExpExecArray) => TemporalExpression | null };

const MATCHERS: Matcher[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/gi, build: m => ({ kind: 'absolute-day', year: +m[1]!, month: +m[2]!, day: +m[3]! }) },
  { re: new RegExp(`\\b(\\d{1,2})${ORD}(?: of)? (${MO})(?:,? (\\d{4}))?\\b`, 'gi'),
    build: m => ({ kind: 'absolute-day', month: monthNumber(m[2]!), day: +m[1]!, ...(m[3] ? { year: +m[3] } : {}) }) },
  { re: new RegExp(`\\b(${MO}) (\\d{1,2})${ORD}(?:,? (\\d{4}))?\\b`, 'gi'),
    build: m => ({ kind: 'absolute-day', month: monthNumber(m[1]!), day: +m[2]!, ...(m[3] ? { year: +m[3] } : {}) }) },
  { re: new RegExp(`\\b(${MO}),? (\\d{4})\\b`, 'gi'), build: m => ({ kind: 'absolute-month', year: +m[2]!, month: monthNumber(m[1]!) }) },
  { re: /\b(?:in|since|during|of|back in) ((?:19|20)\d{2})\b/gi, build: m => ({ kind: 'absolute-year', year: +m[1]! }) },
  { re: new RegExp(`\\b(${alt(RELATIVE_DAYS.map(([p]) => p))})\\b`, 'gi'),
    build: m => ({ kind: 'relative-day', offsetDays: RELATIVE_DAYS.find(([p]) => p === m[1]!.toLowerCase())![1] }) },
  { re: new RegExp(`\\b(${alt(Object.keys(WEEKENDS))})\\b`, 'gi'), build: m => ({ kind: 'weekend', which: WEEKENDS[m[1]!.toLowerCase()]! }) },
  { re: new RegExp(`\\b(?:(${alt(Object.keys(WEEKDAY_QUALIFIERS))}) )?(${WD})\\b`, 'gi'),
    build: m => ({ kind: 'weekday', weekday: WEEKDAYS.indexOf(m[2]!.toLowerCase() as typeof WEEKDAYS[number]),
      direction: m[1] ? WEEKDAY_QUALIFIERS[m[1].toLowerCase()]! : 'unknown' }) },
  // `in three days` / `in a few weeks` — future offsets by preposition.
  { re: new RegExp(`\\bin (?:(${APX}) )?(${NUM})? ?(${UNIT})\\b`, 'gi'),
    build: m => {
      const approximate = !!m[1] || isIndefinite(m[2]) || isIndefinite(m[1]);
      return { kind: 'offset', unit: UNITS[m[3]!.toLowerCase()]!, direction: 'future', approximate,
        ...(amountOf(m[2]) !== undefined ? { amount: amountOf(m[2]) } : {}) };
    } },
  // `three weeks ago`, `about a month back`, `a few days later`.
  { re: new RegExp(`\\b(?:(${APX}) )?(${NUM}) (${UNIT}) (${PASTM}|${FUTM})\\b`, 'gi'),
    build: m => {
      const amount = amountOf(m[2]);
      const approximate = !!m[1] || isIndefinite(m[2]);
      const future = (FUTURE_MARKERS as readonly string[]).includes(m[4]!.toLowerCase());
      return { kind: 'offset', unit: UNITS[m[3]!.toLowerCase()]!, direction: future ? 'future' : 'past', approximate,
        ...(amount !== undefined ? { amount } : {}) };
    } },
  { re: new RegExp(`\\b(${alt(INDEFINITE_AMOUNTS)}) (${UNIT}) (${PASTM}|${FUTM})\\b`, 'gi'),
    build: m => ({ kind: 'offset', unit: UNITS[m[2]!.toLowerCase()]!, approximate: true,
      direction: (FUTURE_MARKERS as readonly string[]).includes(m[3]!.toLowerCase()) ? 'future' : 'past' }) },
  // `for about three weeks` — a length, not a point.
  { re: new RegExp(`\\bfor (?:(${APX}) )?(${NUM}) (${UNIT})\\b`, 'gi'),
    build: m => ({ kind: 'duration', unit: UNITS[m[3]!.toLowerCase()]!, approximate: !!m[1] || isIndefinite(m[2]),
      ...(amountOf(m[2]) !== undefined ? { amount: amountOf(m[2]) } : {}) }) },
  { re: new RegExp(`\\b(?:the )?(${alt(Object.keys(PERIODS))}) (week|month|year)\\b`, 'gi'),
    build: m => ({ kind: 'period', unit: m[2]!.toLowerCase() as 'week' | 'month' | 'year', which: PERIODS[m[1]!.toLowerCase()]! }) },
  { re: new RegExp(`\\b(?:sometime )?(${alt(VAGUE)})\\b`, 'gi'), build: () => ({ kind: 'vague' }) },
];

/**
 * Every temporal expression in `text`, left to right, never overlapping. Where two matchers claim the same
 * words the LONGER wins — `last weekend` over `weekend`, `the day before yesterday` over `yesterday`.
 */
export function findTemporalExpressions(text: string): FoundExpression[] {
  const all: FoundExpression[] = [];
  for (const { re, build } of MATCHERS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const expr = build(m);
      if (expr && !(expr.kind === 'absolute-day' && (expr.day < 1 || expr.day > 31 || expr.month < 1))) {
        all.push({ text: m[0], start: m.index, end: m.index + m[0].length, expr });
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: FoundExpression[] = [];
  let cursor = -1;
  for (const f of all) {
    if (f.start < cursor) continue;
    out.push(f);
    cursor = f.end;
  }
  return out;
}

// ── 3.3 / 3.5–3.7 — resolve against the session date ──────────────────────

export interface ResolveOptions {
  /**
   * 3.4, decided by a Jev-style judgement elsewhere and handed in: the same exchange places a forward weekday
   * TODAY (*"on my way"*, *"see you in an hour"*). Only then does the day of speaking count.
   */
  placesToday?: boolean;
}

/** Anchor one expression to the date of the session it was said in. */
export function resolveExpression(expr: TemporalExpression, sessionDate: string, opts: ResolveOptions = {}): Resolution {
  const none = (extra: Partial<Resolution> = {}): Resolution => ({ precision: 'none', approximate: false, asOf: sessionDate, ...extra });
  const at = (value: string, precision: Resolution['precision'], extra: Partial<Resolution> = {}): Resolution =>
    ({ precision, value, approximate: false, asOf: sessionDate, ...extra });

  switch (expr.kind) {
    case 'absolute-day': {
      // No year given: the session's year. A conversation names a day without a year when it is this year's.
      const y = expr.year ?? Number(sessionDate.slice(0, 4));
      const v = `${y}-${pad(expr.month)}-${pad(expr.day)}`;
      return ymd(day(v)) === v ? at(v, 'day') : none();
    }
    case 'absolute-month': return at(`${expr.year}-${pad(expr.month)}`, 'month');
    case 'absolute-year': return at(String(expr.year), 'year');
    case 'relative-day': return at(addDays(sessionDate, expr.offsetDays), 'day');

    case 'weekday': {
      const today = weekdayOf(sessionDate) === expr.weekday;
      if (expr.direction === 'past') return at(previous(sessionDate, expr.weekday), 'day');
      if (expr.direction === 'future') {
        return at(today && opts.placesToday ? sessionDate : following(sessionDate, expr.weekday), 'day');
      }
      if (expr.direction === 'this') return at(today ? sessionDate : following(sessionDate, expr.weekday), 'day');
      // A bare weekday points wherever the sentence points, and the tense is a judgement, not a pattern.
      // Until that judgement exists, it resolves to nothing rather than to a guess.
      return none();
    }

    case 'weekend': {
      const wd = weekdayOf(sessionDate);
      const inWeekend = wd === 6 || wd === 0;
      if (expr.which === 'last') {
        // The most recent COMPLETED weekend: a weekend containing today is not "last weekend" (3.5).
        const sun = previous(sessionDate, 0);
        return at(addDays(sun, -1), 'day', { endsAt: sun });
      }
      if (expr.which === 'this') {
        // The weekend IN PROGRESS when the session is inside one; otherwise the coming one.
        if (wd === 6) return at(sessionDate, 'day', { endsAt: addDays(sessionDate, 1) });
        if (wd === 0) return at(addDays(sessionDate, -1), 'day', { endsAt: sessionDate });
        const sat = following(sessionDate, 6);
        return at(sat, 'day', { endsAt: addDays(sat, 1) });
      }
      if (expr.which === 'next') {
        // Inside a weekend: the following one. Otherwise the one AFTER the coming Saturday.
        const sat = inWeekend ? following(sessionDate, 6) : addDays(following(sessionDate, 6), 7);
        return at(sat, 'day', { endsAt: addDays(sat, 1) });
      }
      return none();
    }

    case 'offset': {
      if (expr.approximate || expr.amount === undefined) return none({ approximate: true });
      const n = expr.direction === 'past' ? -expr.amount : expr.amount;
      if (expr.unit === 'day') return at(addDays(sessionDate, n), 'day');
      if (expr.unit === 'week') return at(addDays(sessionDate, 7 * n), 'day');
      if (expr.unit === 'month') return at(addMonths(sessionDate, n), 'month');
      return at(String(Number(sessionDate.slice(0, 4)) + n), 'year');
    }

    case 'duration': return none({ approximate: expr.approximate });

    case 'period': {
      if (expr.unit === 'month') {
        const n = expr.which === 'past' ? -1 : expr.which === 'future' ? 1 : 0;
        return at(addMonths(sessionDate, n), 'month');
      }
      if (expr.unit === 'year') {
        const n = expr.which === 'past' ? -1 : expr.which === 'future' ? 1 : 0;
        return at(String(Number(sessionDate.slice(0, 4)) + n), 'year');
      }
      // A week is no day, so it gets no value — but its days are context for the claim's sentence.
      const monday = weekdayOf(sessionDate) === 1 ? sessionDate : previous(sessionDate, 1);
      const shift = expr.which === 'past' ? -7 : expr.which === 'future' ? 7 : 0;
      const from = addDays(monday, shift);
      return none({ window: { from, to: addDays(from, 6) } });
    }

    case 'vague': return none();
  }
}

// ── 3.10 / 3.11 — may it go on the timeline? ──────────────────────────────

/**
 * What a resolution may put on a timeline: a day, a two-ended span, or nothing.
 *
 * A span needs BOTH halves of the rule (3.11): the conversation handed both ends (3.10 — only a range such as
 * a weekend resolves to one, and nothing here looks across sessions for an end), AND the event genuinely
 * took more than a day (3.9 — a judgement about what it IS, handed in). *"`endsAt` is how long the thing
 * LASTED. It is never how unsure you are about when it happened."*
 *
 * A two-ended range whose event took a day (a concert last weekend) gets NOTHING — picking one of the two
 * days would invent a day the conversation never states. The date belongs in the claim's sentence instead.
 */
export function chronoDatesFor(res: Resolution, lastedMoreThanADay: boolean): { date: string; endsAt?: string } | null {
  if (res.precision !== 'day' || !res.value || res.approximate) return null;
  if (res.endsAt) return lastedMoreThanADay ? { date: res.value, endsAt: res.endsAt } : null;
  return { date: res.value };
}
