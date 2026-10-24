import { TranslocoTestingModule, TranslocoTestingOptions, type Translation } from '@jsverse/transloco';

/**
 * Transloco module for component specs.
 *
 * Any component whose template uses the `transloco` pipe needs a TranslocoService in its test
 * injector. This provides one with an empty `en` translation and the missing-key handler set to
 * echo the key back — so a spec can assert on stable key strings without maintaining a copy of
 * the real translation files. Pass `translation` to override a specific key when a test needs
 * the rendered text — see `SpecTranslocoOptions` below, which is what makes that option real.
 */
/**
 * What this helper accepts: `TranslocoTestingOptions` plus the `translation` shorthand it has always read.
 *
 * The parameter used to be `TranslocoTestingOptions` alone, which does not declare `translation` — so the
 * docblock above promised an option the type refused, and every caller using it was a type error. The
 * implementation was right and the signature was wrong.
 */
export type SpecTranslocoOptions = TranslocoTestingOptions & {
  /**
   * Per-language dictionaries, e.g. `{ en: { 'some.key': 'Rendered text' } }` or the same as a tree, `{ en: { some: { key: 'Rendered text' } } }`.
   * Transloco reads both; the type said only the flat form, so a spec that handed it a tree (the edit-path refusal spec of bundle-81) did not compile.
   */
  translation?: Record<string, Translation>;
};

export function getTranslocoModule(options: SpecTranslocoOptions = {}) {
  const { translation, ...rest } = options;
  return TranslocoTestingModule.forRoot({
    langs: { en: translation?.['en'] ?? {} },
    translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
    preloadLangs: true,
    ...rest,
  });
}
