/**
 * Every value a vote round or a decision can take has a translated label, in every language.
 *
 * The page used to print the wire value: `meta_change: notes`. Labels are looked up by a key built at runtime
 * (`'networks.roundType.' + type`), which `i18n-key-coverage.spec.ts` deliberately cannot check — it matches static
 * keys only. So a round type the server learns next year, or an outcome it records, renders as a raw key in the UI
 * with every other spec green, because the test harness echoes keys. This derives both value sets from the server's
 * source and asks each language for each key.
 *
 * `ended` is the one outcome that is not a server value: a round that concluded before outcomes were recorded is
 * listed with the reason unknown, and the client names that state itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLIENT_ROOT } from './tracked-sources';
import { aliasLiterals, propertyLiterals, readRepoSource } from './server-source';

const I18N = resolve(CLIENT_ROOT, 'public/assets/i18n');
const LOCALES = ['en', 'de', 'pl'] as const;
const load = (loc: string): Record<string, string> => JSON.parse(readFileSync(join(I18N, `${loc}.json`), 'utf8'));

describe('vote round labels', () => {
  const types = readRepoSource('server/src/config/types-networks.ts');
  const roundTypes = aliasLiterals(types, 'VoteRoundType');
  const outcomes = propertyLiterals(types, 'VoteRound', 'outcome');

  it('derives the round types and the outcomes from the server (a floor)', () => {
    expect(roundTypes.length, `round types: ${roundTypes.join(', ')}`).toBeGreaterThanOrEqual(6);
    expect(roundTypes).toContain('meta_change');
    expect(outcomes.length, 'the server\'s VoteRound declares no outcome values yet').toBeGreaterThanOrEqual(3);
  });

  for (const locale of LOCALES) {
    const dict = (): Record<string, string> => load(locale);

    it(`${locale}: every round type has a label under networks.roundType.*`, () => {
      const missing = roundTypes.filter(t => !(dict()[`networks.roundType.${t}`] ?? '').trim());
      expect(missing, `${locale}.json has no networks.roundType.<type> for:`).toEqual([]);
    });

    it(`${locale}: every outcome, and the legacy "ended", has a label under networks.decisions.outcome.*`, () => {
      const wanted = [...new Set([...outcomes, 'ended'])];
      const missing = wanted.filter(o => !(dict()[`networks.decisions.outcome.${o}`] ?? '').trim());
      expect(missing, `${locale}.json has no networks.decisions.outcome.<outcome> for:`).toEqual([]);
    });
  }

  it('a label is not the wire value itself (a copy-paste of the key is not a translation)', () => {
    const en = load('en');
    const same = roundTypes.filter(t => (en[`networks.roundType.${t}`] ?? '').trim() === t);
    expect(same).toEqual([]);
  });
});
