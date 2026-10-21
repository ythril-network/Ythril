/**
 * The shipped translation files, read once the same way by every spec that asks a question of their values.
 *
 * `load` was written by hand in `locale-false-friends.spec.ts` and `i18n-key-coverage.spec.ts`; the specs of bundle-162 are the
 * third site, so it is a module. It throws on a short dictionary: a moved directory would otherwise yield `{}`, and every loop
 * over "each key" would pass over nothing and report clean.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const I18N_DIR = resolve(__dirname, '../../../public/assets/i18n');
export const LOCALES = ['en', 'de', 'pl'] as const;
export type Locale = (typeof LOCALES)[number];

/** One locale's flat key -> value dictionary. */
export function dictionary(locale: string): Record<string, string> {
  const dict = JSON.parse(readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8')) as Record<string, string>;
  if (Object.keys(dict).length < 1000) {
    throw new Error(`${locale}.json holds ${Object.keys(dict).length} keys - fewer than 1000, so the file moved or is not the shipped dictionary, and a check over it would report clean about nothing.`);
  }
  return dict;
}
