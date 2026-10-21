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
 */
import { translatedOrEmpty, type KeyTranslator } from './translated-text';

export type PluralTranslator = KeyTranslator;

export function pluralText(
  transloco: PluralTranslator,
  language: string,
  base: string,
  count: number,
  params: Record<string, unknown> = {},
): string {
  let category = 'other';
  try { category = new Intl.PluralRules(language || 'en').select(count); } catch { /* an unknown language: `other` */ }
  let format = (n: number): string => String(n);
  try { const nf = new Intl.NumberFormat(language || 'en'); format = n => nf.format(n); } catch { /* an unknown language: the plain number */ }
  // Every number in the sentence, not only the count: "262144 of 1,048,576" puts two notations in one line.
  const all: Record<string, unknown> = { count: format(count) };
  for (const [name, value] of Object.entries(params)) if (name !== 'count') all[name] = typeof value === 'number' && Number.isFinite(value) ? format(value) : value;
  for (const key of [`${base}.${category}`, `${base}.other`]) {
    const text = translatedOrEmpty(transloco, key, all);
    if (text) return text;
  }
  return '';
}
