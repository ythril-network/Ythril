/**
 * Shared English word lists — the calendar and the spelled-out numbers.
 *
 * Read by the conversation extractor's time tagger (`extractor/conversation/time-lexicon.ts` re-exports them)
 * and by the evidence checks (`evidence/evidence-check.ts`). One copy, because two copies of a month list is
 * how one of them ends up without "sept".
 */

/** Index is `Date.getUTCDay()`: 0 = Sunday. */
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Index + 1 is the month number. */
export const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

/** Spelled-out amounts. `a`/`an` are one; `a couple` is two AND approximate (see APPROXIMATE). */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
