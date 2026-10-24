/**
 * A counted sentence in the language the page is shown in (Q-574): the one thing a component, a service or a template asks instead of
 * `pluralText(transloco, transloco.getActiveLang(), ...)`.
 *
 * What the inline call got wrong, and this does not:
 *
 *  - `getActiveLang()` is the language that was REQUESTED, and a language's words load lazily, so for a moment after a switch it says `de`
 *    while every sentence is `en`'s. This reads `ActiveLanguage.language()`, which flips once the words are here, and translates with that
 *    language EXPLICITLY - so a switch in flight keeps the old sentence on screen instead of going blank.
 *  - It reads `ActiveLanguage.revision()` as well, so a `computed()` or an OnPush template that calls `text()` runs again when the words
 *    arrive, not only when the language flips.
 *  - It never answers `''`. A base with no form, a count that is not a number, or words that never came (`pluralText` says `''`, and says
 *    so in the development console) leave the count alone, formatted for the language: a missing sentence must not take its number with it.
 *
 * Not for markup: a counted sentence is text, and `testing/the-active-language-has-one-reader.spec.ts` refuses one bound as HTML.
 */
import { Injectable, inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { ActiveLanguage } from './active-language';
import { formatCount, pluralText } from './plural-text';

@Injectable({ providedIn: 'root' })
export class PluralText {
  private readonly transloco = inject(TranslocoService);
  private readonly active = inject(ActiveLanguage);

  /** `<base>.one|few|many|other` for `count`, with `{{count}}` and every finite number in `params` formatted for the language. */
  text(base: string, count: number, params: Record<string, unknown> = {}): string {
    this.active.revision(); // a dependency, not a value: the words arriving is a change
    const language = this.active.language() || 'en';
    const words = { translate: (key: string, p?: Record<string, unknown>): string => this.transloco.translate(key, p, language) };
    // Before the language's words exist there is nothing to look up (and a lookup would report every base as missing): the count alone.
    const sentence = this.hasWords(language) ? pluralText(words, language, base, count, params) : '';
    return sentence || formatCount(language, count);
  }

  private hasWords(language: string): boolean {
    try { return this.transloco.getTranslation().has(language); } catch { return false; }
  }
}
