/**
 * The PluralText service: a counted sentence in the page's language, by the form that language uses for the count (Q-574).
 *
 * Written before the module exists (`core/plural-text.service.ts`, class `PluralText`, `text(base, count, params?)`), so each case is red
 * at the base commit because its import cannot be resolved. It is what a template or a method calls instead of
 * `pluralText(transloco, transloco.getActiveLang(), ...)`: it reads the page's language from `ActiveLanguage` (the language whose words
 * are loaded, not the one just requested) and never returns an empty string.
 *
 *  - the form per locale: en and de `one` / `other`; pl `one` / `few` / `many` (0 and 5 and 12 are `many`, 2 and 22 are `few`);
 *  - when no form of the base resolves (a typo, a key missing from one language, or the language's words never came) the answer is the
 *    count alone, formatted for the language - a missing sentence must not take the number with it;
 *  - the language it answers in is the one whose words are loaded, so a switch in flight keeps the old sentence rather than going blank.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { PluralText } from './plural-text.service';
import { dictionary } from '../testing/i18n-dictionary';
import { LanguageLoads, settle, startInEnglish, switchTo } from '../testing/language-loads';

const EN = { 'k.one': '{{count}} thing', 'k.other': '{{count}} things', 'p.other': '{{count}} of {{total}} parts' };
const DE = { 'k.one': '{{count}} Ding', 'k.other': '{{count}} Dinge', 'p.other': '{{count}} von {{total}} Teilen' };
const PL = {
  'k.one': '{{count}} rzecz', 'k.few': '{{count}} rzeczy', 'k.many': '{{count}} rzeczy-many', 'k.other': '{{count}} rzeczy-other',
  'p.other': '{{count}} z {{total}} części',
};

async function service(loads: LanguageLoads, language: 'en' | 'de' | 'pl' = 'en') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: loads.providers() });
  const transloco = await startInEnglish();
  if (language !== 'en') {
    switchTo(transloco, language);
    await settle();
  }
  return { text: TestBed.inject(PluralText), transloco };
}

const all = (): LanguageLoads => new LanguageLoads().now('en', EN).now('de', DE).now('pl', PL);

describe('PluralText: the form each locale uses for the count', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('en: one and other', async () => {
    const { text } = await service(all());
    expect(text.text('k', 1)).toBe('1 thing');
    expect(text.text('k', 0)).toBe('0 things');
    expect(text.text('k', 2)).toBe('2 things');
  });

  it('de: one and other', async () => {
    const { text } = await service(all(), 'de');
    expect(text.text('k', 1)).toBe('1 Ding');
    expect(text.text('k', 2)).toBe('2 Dinge');
  });

  it('pl: one, few and many by the language\'s own rule (0 many, 1 one, 2 few, 5 many, 12 many, 22 few)', async () => {
    const { text } = await service(all(), 'pl');
    expect(text.text('k', 1)).toBe('1 rzecz');
    expect(text.text('k', 2)).toBe('2 rzeczy');
    expect(text.text('k', 22)).toBe('22 rzeczy');
    expect(text.text('k', 0)).toBe('0 rzeczy-many');
    expect(text.text('k', 5)).toBe('5 rzeczy-many');
    expect(text.text('k', 12)).toBe('12 rzeczy-many');
    expect(text.text('k', 1.5), 'a fraction is `other` in Polish').toMatch(/rzeczy-other$/);
  });

  it('formats the count and every number in params for the language', async () => {
    const { text } = await service(all(), 'de');
    expect(text.text('p', 1048576, { total: 2097152 })).toBe('1.048.576 von 2.097.152 Teilen');
  });

  it('works over the shipped dictionaries: the sentence is the dictionary\'s own form for the category', async () => {
    const loads = new LanguageLoads().now('en', dictionary('en')).now('de', dictionary('de')).now('pl', dictionary('pl'));
    for (const language of ['en', 'de', 'pl'] as const) {
      const { text } = await service(loads, language);
      const dict = dictionary(language);
      const nf = new Intl.NumberFormat(language);
      for (const n of [0, 1, 2, 3, 5, 12, 22]) {
        const category = new Intl.PluralRules(language).select(n);
        const want = (dict[`webhooks.failures.${category}`] ?? dict['webhooks.failures.other']!).replace(/\{\{\s*count\s*\}\}/g, nf.format(n));
        expect(text.text('webhooks.failures', n), `${language} ${n}`).toBe(want);
      }
    }
  });
});

describe('PluralText: a sentence that cannot be found still shows its number', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a base with no form in the language answers the count alone, formatted for the language', async () => {
    const { text } = await service(all(), 'de');
    expect(text.text('no.such.base', 1234567)).toBe(new Intl.NumberFormat('de').format(1234567));
  });

  it('a base with no form in pl formats for pl', async () => {
    const { text } = await service(all(), 'pl');
    expect(text.text('no.such.base', 1234567)).toBe(new Intl.NumberFormat('pl').format(1234567));
  });

  it('a non-finite count still answers something, never the empty string', async () => {
    const { text } = await service(all());
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const answer = text.text('k', n);
      expect(answer, `count ${n}`).not.toBe('');
      expect(answer).not.toMatch(/undefined|\{\{/);
    }
  });

  it('when the words of the page\'s language never came, the count is still shown', async () => {
    const loads = new LanguageLoads().now('en', EN).never('de');
    const { text } = await service(loads, 'de');
    // The switch is in flight, so the page is still in en and its sentence is en's; either way the number is there.
    expect(text.text('k', 3)).toMatch(/3/);
    expect(text.text('k', 3)).not.toBe('');
  });
});

describe('PluralText: it answers in the language whose words are loaded', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a switch in flight keeps the old sentence, and the new one appears when the words arrive', async () => {
    const loads = new LanguageLoads().now('en', EN);
    const de = loads.late('de');
    const { text, transloco } = await service(loads);
    switchTo(transloco, 'de');
    await settle();
    expect(text.text('k', 2), 'transloco already says de, the words are not here: the page is still en').toBe('2 things');

    de.resolve(DE);
    await settle();
    expect(text.text('k', 2)).toBe('2 Dinge');
  });

  it('after a failed load it answers in the fallback', async () => {
    const loads = new LanguageLoads().now('en', EN).failing('de');
    const { text } = await service(loads, 'de');
    expect(text.text('k', 2)).toBe('2 things');
  });
});
