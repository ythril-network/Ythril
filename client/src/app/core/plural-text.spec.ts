import { describe, expect, it } from 'vitest';
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
