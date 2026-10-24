/**
 * A sentence about a COUNT, in the plural form the reader's language uses.
 *
 * `Intl.PluralRules` decides the category (English and German have `one` and `other`; Polish has `one`, `few`, `many` and
 * `other`), the translation file carries one key per category (`<base>.one`, `<base>.few`, ...), and the number in the sentence
 * is formatted by `Intl.NumberFormat` for the same language. Written for the "N more rows were left out" sentence of a refusal
 * and then wanted by the retype confirmation ("Remove 3 properties"), which is why it is a module.
 *
 * What a hand copy drops, and this does not: a category a locale file has no key for falls back to `<base>.other` instead of
 * showing a raw key, and a platform that does not know the language falls back to `other` instead of throwing in the middle of
 * rendering an error message. The count is always passed as `{{count}}`, and every other finite number in `params` likewise,
 * already formatted for the language.
 *
 * Nothing to say is said out loud, in development, once per base: a count that is not a finite number answers `''` (there is no form for
 * `NaN`, and "NaN things" is a wrong sentence rather than a missing one), and so does a base none of whose forms exists. A caller that
 * renders a sentence shows the count alone then (`PluralText`); the console line is what makes a typo in a base or a `NaN` from a missing
 * field findable, instead of a blank badge nobody reports. The `Intl` objects of a language are built once (`intl-cache.ts`).
 *
 * A component or service does not call this: it asks the `PluralText` service (or the `plural` pipe), which reads the language whose
 * words are loaded. This takes a language as a parameter for the helpers that are not Angular classes and have no signal to read.
 */
import { cachedIntl } from './intl-cache';
import { warnOnceInDev } from './dev-missing-translation.handler';
import { translatedOrEmpty, type KeyTranslator } from './translated-text';

export type PluralTranslator = KeyTranslator;

const tag = (language: string): string => language || 'en';

/** The plural rules of a language, or null for one the platform rejects (every count is then `other`). Built once per language. */
function rulesOf(language: string): Intl.PluralRules | null {
  return cachedIntl<Intl.PluralRules | null>(`PluralRules|${tag(language)}`, () => new Intl.PluralRules(tag(language)), () => null);
}

function numbersOf(language: string): Intl.NumberFormat | null {
  return cachedIntl<Intl.NumberFormat | null>(`NumberFormat|${tag(language)}`, () => new Intl.NumberFormat(tag(language)), () => null);
}

/** A number as the language writes it ('1.234' in German, '1,234' in English); the plain number for a language the platform rejects. */
export function formatCount(language: string, n: number): string {
  const numbers = numbersOf(language);
  return numbers ? numbers.format(n) : String(n);
}

export function pluralText(
  transloco: PluralTranslator,
  language: string,
  base: string,
  count: number,
  params: Record<string, unknown> = {},
): string {
  if (!Number.isFinite(count)) {
    warnOnceInDev(`plural-count:${base}`, `[i18n] Plural base "${base}" was asked for a count that is not a finite number (${String(count)}); no sentence`);
    return '';
  }
  const category = rulesOf(language)?.select(count) ?? 'other';
  const format = (n: number): string => formatCount(language, n);
  // Every number in the sentence, not only the count: "262144 of 1,048,576" puts two notations in one line.
  const all: Record<string, unknown> = { count: format(count) };
  for (const [name, value] of Object.entries(params)) if (name !== 'count') all[name] = typeof value === 'number' && Number.isFinite(value) ? format(value) : value;
  for (const key of [`${base}.${category}`, `${base}.other`]) {
    const text = translatedOrEmpty(transloco, key, all);
    if (text) return text;
  }
  warnOnceInDev(`plural-form:${base}`, `[i18n] Plural base "${base}" has no form (${base}.${category}, nor ${base}.other) in language "${tag(language)}"`);
  return '';
}
