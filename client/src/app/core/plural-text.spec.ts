import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluralText, type PluralTranslator } from './plural-text';

/** A translator over a flat dictionary that fills `{{name}}` from params, answering an unknown key with the key, as Transloco does. */
function translator(dict: Record<string, string>): PluralTranslator {
  return {
    translate: (key, params = {}) =>
      key in dict ? dict[key].replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(params[name])) : key,
  };
}

describe('pluralText', () => {
  const pl = translator({
    'edges.one': '{{count}} krawędź',
    'edges.few': '{{count}} krawędzie',
    'edges.many': '{{count}} krawędzi',
    'edges.other': '{{count}} krawędzi (other)',
  });

  it('picks the category the language uses for the count', () => {
    expect(pluralText(pl, 'pl', 'edges', 1)).toBe('1 krawędź');
    expect(pluralText(pl, 'pl', 'edges', 3)).toBe('3 krawędzie');
    expect(pluralText(pl, 'pl', 'edges', 5)).toBe('5 krawędzi');
  });

  it('falls back to <base>.other when the language has no key for the category, never to the raw key', () => {
    const en = translator({ 'rows.other': '{{count}} rows' });
    expect(pluralText(en, 'en', 'rows', 1)).toBe('1 rows');
  });

  it('formats every number in the sentence for the language, not only the count', () => {
    const de = translator({ 'cut.other': 'Die ersten {{shown}} von {{count}} Zeichen ({{label}})' });
    expect(pluralText(de, 'de', 'cut', 1048576, { shown: 262144, label: 'Teil 1' })).toBe('Die ersten 262.144 von 1.048.576 Zeichen (Teil 1)');
  });

  it('leaves a parameter that is not a finite number as it is', () => {
    const en = translator({ 'x.other': '{{count}} of {{a}} {{b}}' });
    expect(pluralText(en, 'en', 'x', 2, { a: '1000', b: Number.NaN })).toBe('2 of 1000 NaN');
  });
});

/**
 * What `pluralText` answers when there is nothing to say, and what it costs to ask (Q-574).
 *
 * It answers `''` for a count that is not a finite number and for a base none of whose forms exists, and the caller that renders a
 * sentence (the PluralText service) then shows the count alone. An empty answer with no trace is how a typo in a base, or a NaN from a
 * missing field, becomes a blank badge nobody reports: in development each case says so, once per base, through the console like the
 * missing-translation handler (`dev-missing-translation.handler.ts`) - once, not on every render of every row.
 *
 * Every base below is unique to its test: the warning is once per base for the session, so a base reused across tests would hide it.
 */
describe('pluralText: nothing to say', () => {
  afterEach(() => vi.restoreAllMocks());
  const en = translator({ 'warm.other': '{{count}} things' });

  it('a non-finite count gives \'\' and one dev warning, however often it is asked', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(pluralText(en, 'en', 'warm', n)).toBe('');
    }
    expect(warn, 'one warning for the base, not one per call').toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('warm');
  });

  it('a finite count is answered and says nothing', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(pluralText(en, 'en', 'warm', 3)).toBe('3 things');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a base with no form resolves to \'\' and one dev warning, naming the base', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) expect(pluralText(en, 'en', 'nothing.here', 2)).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('nothing.here');
    // A second base is a second warning: it is once per base, not once for the session.
    expect(pluralText(en, 'en', 'nothing.there', 2)).toBe('');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('pluralText: the Intl objects of a language are built once', () => {
  afterEach(() => vi.restoreAllMocks());
  const en = translator({ 'cache.other': '{{count}} things' });
  const builtFor = (spy: { mock: { calls: unknown[][] } }, language: string): number =>
    spy.mock.calls.filter(c => c[0] === language).length;

  // Languages no other case in this file asks for, so none of them is already in the cache before the spy is installed.
  it('PluralRules and NumberFormat are constructed once per language across many calls and counts', () => {
    const rules = vi.spyOn(Intl, 'PluralRules');
    const numbers = vi.spyOn(Intl, 'NumberFormat');
    for (const n of [0, 1, 2, 3, 5, 12, 22, 1000]) {
      pluralText(en, 'sv', 'cache', n);
      pluralText(en, 'fi', 'cache', n);
    }
    expect(builtFor(rules, 'sv'), 'PluralRules for sv').toBe(1);
    expect(builtFor(rules, 'fi'), 'PluralRules for fi').toBe(1);
    expect(builtFor(numbers, 'sv'), 'NumberFormat for sv').toBe(1);
    expect(builtFor(numbers, 'fi'), 'NumberFormat for fi').toBe(1);
  });

  it('a language the platform rejects is tried once, and its fallback outcome is the cached answer', () => {
    const rules = vi.spyOn(Intl, 'PluralRules');
    const numbers = vi.spyOn(Intl, 'NumberFormat');
    for (let i = 0; i < 4; i++) expect(pluralText(en, 'not a language!', 'cache', i + 2)).toBe(`${i + 2} things`);
    expect(builtFor(rules, 'not a language!'), 'PluralRules for the rejected tag').toBe(1);
    expect(builtFor(numbers, 'not a language!'), 'NumberFormat for the rejected tag').toBe(1);
  });
});
