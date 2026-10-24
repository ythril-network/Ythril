/**
 * `{{ count | plural:'base' }}` and `{{ count | plural:'base':{ shown: n } }}` - a counted sentence in the page's language (Q-574).
 *
 * IMPURE on purpose, and for the same reason as `InstantPipe`: the app is zoneless and its pages are OnPush, a pure pipe runs again only
 * when its arguments change, and a language switch changes none of them (the count, the base, the params). A pure pipe would keep the old
 * language on screen until something else happened to re-render the view. Reading the language and the revision signals inside
 * `transform` is what marks the view dirty when either moves.
 *
 * The cost of being impure is a run on every change-detection pass, so an unchanged pass costs one comparison: the last answer is kept
 * per pipe instance, keyed on the count, the base, the params (shallowly, a template's `{ shown: n }` is a new object only when `n`
 * changed, but the comparison does not rely on that), the language and the revision. Only a change asks `PluralText` again.
 *
 * Text, never HTML: do not bind it to `[innerHTML]`; the gate in `the-active-language-has-one-reader.spec.ts` refuses it.
 */
import { Pipe, PipeTransform, inject } from '@angular/core';
import { ActiveLanguage } from './active-language';
import { PluralText } from './plural-text.service';

type Params = Record<string, unknown> | undefined;

interface Memo { count: number; base: string; params: Params; language: string; revision: number; text: string }

const sameParams = (a: Params, b: Params): boolean => {
  if (a === b) return true;
  const x = a ?? {};
  const y = b ?? {};
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => Object.is(x[k], y[k]));
};

@Pipe({ name: 'plural', standalone: true, pure: false })
export class PluralPipe implements PipeTransform {
  private readonly active = inject(ActiveLanguage);
  private readonly plural = inject(PluralText);
  private memo: Memo | null = null;

  transform(count: number, base: string, params?: Record<string, unknown>): string {
    const language = this.active.language();
    const revision = this.active.revision();
    const m = this.memo;
    if (m && Object.is(m.count, count) && m.base === base && m.language === language && m.revision === revision && sameParams(m.params, params)) return m.text;
    const text = this.plural.text(base, count, params);
    this.memo = { count, base, params: params && { ...params }, language, revision, text };
    return text;
  }
}
