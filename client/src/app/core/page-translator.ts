/**
 * `translate` for a sentence a `computed()` builds: it is recomputed when the page's words arrive or change, and says the sentence in the
 * language the page shows (Q-185).
 *
 * `TranslocoService.translate()` is a plain method, no dependency of the `computed()` around it. A computed that translates evaluates once
 * during the first render, BEFORE the language file has resolved, gets the raw key back (`brain.overview.retentionNone`) and keeps it; a later
 * switch to German left the English sentence in place. Every spec rendered such a computed fine, because a spec loads its dictionary before
 * the first render. The one reader of "which language, and are its words here" is `ActiveLanguage`: this reads its `revision()` (a dependency,
 * not a value: it moves on every flip and every load) and translates with its `language()`, which keeps the old language until the new words
 * are here, so a switch in flight shows the old sentence and never a key.
 *
 * Call it once, as a field initializer (it injects), and use the result inside `computed()`s:
 *
 *     private readonly say = pageTranslator();
 *     summary = computed(() => [{ label: this.say('tokens.summary.active'), value: n }]);
 *
 * What it prevents: a `computed()` sentence that shows a key, or the old language, because nothing it read moved when the words did. The gate
 * `testing/a-computed-text-follows-the-language.spec.ts` refuses a `computed()` that calls `translate` on its own without reading the words.
 */
import { inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { ActiveLanguage } from './active-language';

/** A sentence for a key, in the language the page shows. */
export type PageTranslator = (key: string, params?: Record<string, unknown>) => string;

export function pageTranslator(): PageTranslator {
  const transloco = inject(TranslocoService);
  const active = inject(ActiveLanguage);
  return (key, params) => {
    active.revision(); // a dependency, not a value: the words arriving is a change
    return transloco.translate(key, params, active.language() || undefined);
  };
}
