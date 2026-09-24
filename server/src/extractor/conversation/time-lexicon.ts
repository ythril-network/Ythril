/**
 * The words the temporal tagger reads (`F-31`, DECOMPOSITION.md 3.1). Data, not logic: a language is added
 * by adding a lexicon, and nothing in `time.ts` names a word.
 *
 * English only today. The rules these feed are language-independent (nearest occurrence in the direction the
 * sentence points; a weekend is two days; an approximation stays approximate), so a second language is a
 * second table here, not a second resolver.
 */

// The calendar words and spelled-out numbers are shared English (`text/english.ts`): the evidence checks read
// them too, and a second copy would be the one that falls behind.
export { WEEKDAYS, MONTHS, NUMBER_WORDS } from '../../text/english.js';

/**
 * Words that make an amount approximate. *"Keep an approximation approximate"*: an offset carrying one of
 * these resolves to no day at all, only to "about N units as of <session date>".
 */
export const APPROXIMATE = [
  'about', 'around', 'roughly', 'nearly', 'almost', 'over', 'more than', 'less than', 'under', 'approximately',
  'a few', 'a couple of', 'a couple', 'several', 'some', 'a number of', 'a good',
] as const;

/** An amount with no number at all — approximate by nature. */
export const INDEFINITE_AMOUNTS = ['a few', 'a couple of', 'a couple', 'several', 'some', 'a number of'] as const;

export const UNITS: Readonly<Record<string, 'day' | 'week' | 'month' | 'year'>> = {
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year',
};

/** Words after an amount that point it back in time… */
export const PAST_MARKERS = ['ago', 'back', 'before', 'earlier'] as const;
/** …and forward. `in three days` is handled by its preposition, not here. */
export const FUTURE_MARKERS = ['from now', 'later', 'time'] as const;

/** Relative days: the phrase and its offset from the session date. Longest first — the tagger relies on it. */
export const RELATIVE_DAYS: readonly (readonly [string, number])[] = [
  ['the day before yesterday', -2], ['the day after tomorrow', 2],
  ['yesterday', -1], ['last night', -1], ['today', 0], ['tonight', 0], ['this morning', 0],
  ['this afternoon', 0], ['this evening', 0], ['tomorrow', 1],
];

/** A weekday's qualifier and the direction it points. `on`/bare leave direction to the sentence. */
export const WEEKDAY_QUALIFIERS: Readonly<Record<string, 'past' | 'future' | 'this' | 'unknown'>> = {
  'last': 'past', 'this past': 'past', 'past': 'past',
  'next': 'future', 'this coming': 'future', 'coming': 'future', 'see you': 'future', 'until': 'future',
  'this': 'this',
  'on': 'unknown',
};

/** Weekend phrases. `over the weekend` and `the weekend` name no particular one. */
export const WEEKENDS: Readonly<Record<string, 'last' | 'this' | 'next' | 'unknown'>> = {
  'last weekend': 'last', 'this past weekend': 'last', 'past weekend': 'last',
  'this weekend': 'this', 'this coming weekend': 'next', 'next weekend': 'next',
  'over the weekend': 'unknown', 'the weekend': 'unknown',
};

/** Calendar periods relative to the session: never a day, sometimes a month or a year. */
export const PERIODS: Readonly<Record<string, 'past' | 'this' | 'future'>> = {
  last: 'past', past: 'past', previous: 'past', this: 'this', next: 'future', coming: 'future',
};

/** Phrases that name a time and give no day, month or year. They resolve to nothing, on purpose. */
export const VAGUE = [
  'in the spring', 'in the summer', 'in the autumn', 'in the fall', 'in the winter',
  'this spring', 'this summer', 'this autumn', 'this fall', 'this winter',
  'next spring', 'next summer', 'next autumn', 'next fall', 'next winter',
  'last spring', 'last summer', 'last autumn', 'last fall', 'last winter',
  'recently', 'lately', 'the other day', 'a while ago', 'a while back', 'some time ago', 'sometime',
  'soon', 'back then', 'at some point', 'one day',
] as const;
