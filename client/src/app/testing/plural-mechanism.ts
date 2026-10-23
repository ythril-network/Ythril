/**
 * What the source gates need to know about the plural mechanism, written once.
 *
 * The mechanism is three modules: the function (`core/plural-text.ts`), the service that reads the page's language and calls it
 * (`core/plural-text.service.ts`, class `PluralText`), and the pipe over the service (`core/plural.pipe.ts`). Two gates ask about it from
 * different sides - `the-active-language-has-one-reader.spec.ts` (who may call the function, where a sentence may be bound) and
 * `i18n-key-coverage.spec.ts` (which bases the calls name, and whether every locale has their forms) - and both need the same two
 * facts: which files ARE the mechanism, and under what name a source holds the service. Two copies of "which files" is how one gate
 * starts scanning the mechanism's own parameter-passing calls as callers.
 */

/** The modules that ARE the plural mechanism, relative to `client/`: their calls take a base as a parameter by construction. */
export const CORE_PLURAL_MODULES: readonly string[] = [
  'src/app/core/plural-text.ts',
  'src/app/core/plural-text.service.ts',
  'src/app/core/plural.pipe.ts',
];

/** The names under which a (comment-stripped) source holds the PluralText service: an `inject(PluralText)` field or a typed parameter. */
export function pluralServiceNames(src: string): string[] {
  const names = [...src.matchAll(/\b(\w+)\s*=\s*inject\(\s*PluralText\s*\)/g)].map(m => m[1]!);
  for (const m of src.matchAll(/\b(\w+)\s*:\s*PluralText\b/g)) names.push(m[1]!);
  return [...new Set(names)];
}
