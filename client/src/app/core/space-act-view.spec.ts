/**
 * bundle-157 (Q-564, F1): a set that ended by an abandon reads as ENDED, in the warn colour and in words, whatever its kind.
 *
 * The server reports an abandoned member as `<kind>_abandoned` (`spaces/act-set-report.ts`): `restore_abandoned` and, since migrates
 * can be abandoned, `migrate_abandoned`. `actStateVariant` coloured only the literal `restore_abandoned` as warn, `actRowView` named the
 * two literals again for "ended", and no language file had a word for `migrate_abandoned`, so an abandoned migrate read as its raw key
 * in the pending colour. The rule is ONE: a state `<kind>_abandoned` is an ended act, warn, with no tries and no next try - for a kind
 * this client has never heard of too, since the kinds are the server's strings.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { actRowView, actStateKey, actStateVariant } from './space-act-view';

const LANGS = ['en', 'de', 'pl'] as const;
const dict = (lang: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../public/assets/i18n/${lang}.json`), 'utf8'));

/** The kinds whose sets can be abandoned today, and one this client does not know (the rule must not be a list of these). */
const KINDS = ['restore', 'migrate', 'somedaykind'];

describe('an abandoned act reads as ended, by one rule over <kind>_abandoned (Q-564 F1)', () => {
  for (const kind of KINDS) {
    const state = `${kind}_abandoned`;

    it(`${state} is coloured warn`, () => {
      expect(actStateVariant(state)).toBe('warn');
    });

    it(`${state} reads as ended: its own word, warn, no tries and no next try`, () => {
      const row = actRowView({ state, attempts: 2 });
      expect(row).toEqual({ stateKey: actStateKey(state), variant: 'warn', showsAttempts: false, showsNextTry: false });
    });

    it(`${state} reads as ended even once the process stopped (it is not Stopped: it ended)`, () => {
      expect(actRowView({ state, attempts: 1, stopped: true }).stateKey).toBe(actStateKey(state));
    });
  }

  it('control: a state that merely contains the word is not taken for an abandoned act', () => {
    expect(actStateVariant('abandonedish')).not.toBe('warn');
    expect(actRowView({ state: 'running', attempts: 1 }).variant).toBe('pending');
  });

  for (const lang of LANGS) {
    it(`${lang} has words for every abandonable kind's abandoned state`, () => {
      const d = dict(lang);
      for (const kind of ['restore', 'migrate']) {
        const key = actStateKey(`${kind}_abandoned`);
        expect(typeof d[key], `${lang} has no ${key}`).toBe('string');
        expect(d[key]!.trim().length, `${lang} has an empty ${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('the English word for an abandoned migrate says the old database stays in use', () => {
    expect(dict('en')[actStateKey('migrate_abandoned')]).toMatch(/old database/i);
  });
});
