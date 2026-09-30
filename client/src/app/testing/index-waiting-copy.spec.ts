/**
 * The wording a space that is waiting for the search service needs, in all three locales (`Q-113`).
 *
 * `i18n-key-coverage.spec.ts` only checks keys the source already references, and the test harness echoes raw
 * keys, so a key that is missing everywhere, or present in English only, renders as a raw dotted string for a
 * German or Polish operator while every component spec stays green. This names the keys the feature needs.
 *
 * It also pins the retired advice: `failed` used to be what a late search service was marked, so its title told
 * the operator to restart the instance or recreate the space. Now `failed` is a real build failure or a timeout,
 * and that advice would send an operator to destroy a healthy space.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const I18N = resolve(__dirname, '../../../public/assets/i18n');
const load = (loc: string): Record<string, string> => JSON.parse(readFileSync(join(I18N, `${loc}.json`), 'utf8'));

const KEYS = [
  'spaces.indexWaiting',
  'spaces.indexWaitingTitle',
  'spaces.summary.waiting',
  'spaces.summary.waitingHint',
  'brain.overview.idx.waiting',
  'graph.waiting.indexWaiting',
] as const;

describe('index-waiting copy', () => {
  for (const loc of ['en', 'de', 'pl']) {
    it(`${loc}: every key exists and is a non-empty sentence`, () => {
      const t = load(loc);
      for (const k of KEYS) {
        expect(typeof t[k], `${loc}.json lacks ${k}`).toBe('string');
        expect(t[k].trim().length, `${loc}.json has an empty ${k}`).toBeGreaterThan(0);
      }
    });
  }

  it('de and pl are translated, not copies of the English', () => {
    const en = load('en');
    for (const loc of ['de', 'pl']) {
      const t = load(loc);
      for (const k of KEYS) expect(t[k], `${loc}: ${k} is the English text`).not.toBe(en[k]);
    }
  });

  it('a Space is never the typed character, in any of the new values', () => {
    for (const [loc, bad] of [['de', /Leerzeichen/i], ['pl', /spacj/i]] as const) {
      const t = load(loc);
      for (const k of KEYS) expect(t[k], `${loc}: ${k}`).not.toMatch(bad);
    }
  });

  it('the visible badge text says the wait is for the search service, and the detail is the longer sentence', () => {
    const en = load('en');
    expect(en['spaces.indexWaiting']).toMatch(/search service/i);
    expect(en['spaces.indexWaitingTitle'].length).toBeGreaterThan(en['spaces.indexWaiting'].length);
  });

  it('indexFailedTitle no longer tells the operator to restart or recreate, in any locale', () => {
    const offers: Record<string, RegExp> = {
      en: /restart|recreate/i,
      de: /neu starten|neustart|neu erstellen/i,
      pl: /uruchom ponownie|utw[oó]rz .* ponownie/i,
    };
    for (const loc of ['en', 'de', 'pl']) {
      expect(load(loc)['spaces.indexFailedTitle'], `${loc}: spaces.indexFailedTitle`).not.toMatch(offers[loc]);
    }
  });
});
