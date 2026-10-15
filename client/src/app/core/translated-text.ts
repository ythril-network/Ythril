/**
 * A translation key's sentence, or `''` when there is none — never the raw key.
 *
 * The translation service answers a key it does not know with the key itself, so a caller that shows what it got prints
 * `refusal.row.tooLarge.introduced` at a user. Every caller that has a fallback of its own (a server reason, the next plural
 * category, the old tooltip) has to tell "no such key" from a sentence, and three wrote that comparison by hand: the refusal
 * formatter, the plural sentence and the rung picker's tooltip. The comparison is the part a copy gets subtly wrong (an empty
 * string is no sentence either), so it is asked here.
 */
export interface KeyTranslator {
  translate(key: string, params?: Record<string, unknown>): string;
}

/** The sentence `key` names, or `''` when the service has none for it (it answered the key itself, or nothing). */
export function translatedOrEmpty(transloco: KeyTranslator, key: string, params?: Record<string, unknown>): string {
  const text = transloco.translate(key, params);
  return text && text !== key ? text : '';
}
