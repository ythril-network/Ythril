/**
 * Tabs that sit side by side have different names in every locale (Q-549).
 *
 * Polish read "Przegląd" for both `brain.tab.overview` and `brain.tab.review` - two neighbouring tabs of the Brain page with one label.
 * Each string is a real word and each is a fair translation of its own English ("Overview", "Review"), so a check of a value
 * against its source cannot see it; only the SET of siblings shows the clash, and a reader of that language is the only one who
 * would have reported it.
 *
 * Derived from the key shapes, never listed: a group is every key sharing a prefix before `.tab.` or `.tabs.` (a key ending in
 * Title, Hint or Section is a sentence about the tab, not its name), and every `nav.*` key is one group (the sidebar's sibling
 * entries). Within a group no two keys share a value in any locale. Floor on the groups found, so a renamed key family cannot pass
 * by finding none.
 */
import { describe, it, expect } from 'vitest';
import { dictionary, LOCALES } from './i18n-dictionary';

/** The sibling groups of one dictionary: group name -> its keys. */
function siblingGroups(dict: Record<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const add = (g: string, key: string): void => { groups.set(g, [...(groups.get(g) ?? []), key]); };
  for (const key of Object.keys(dict)) {
    const tab = /^(.*\.tabs?)\.[^.]+$/.exec(key);
    if (tab && !/(Title|Hint|Section)$/.test(key)) add(tab[1]!, key);
    if (key.startsWith('nav.')) add('nav.*', key);
  }
  return groups;
}

describe('sibling tabs have distinct names (Q-549)', () => {
  it('finds the sibling groups (a floor, so a renamed key family cannot pass by finding none)', () => {
    expect(siblingGroups(dictionary('en')).size).toBeGreaterThanOrEqual(4);
  });

  for (const loc of LOCALES) {
    it(`${loc}: within one group of sibling keys, no two keys share a value`, () => {
      const d = dictionary(loc);
      const clashes: string[] = [];
      for (const [group, keys] of siblingGroups(d)) {
        const byValue = new Map<string, string[]>();
        for (const k of keys) {
          const v = d[k];
          if (typeof v !== 'string') continue;
          byValue.set(v, [...(byValue.get(v) ?? []), k]);
        }
        for (const [value, same] of byValue) if (same.length > 1) clashes.push(`${group}: ${JSON.stringify(value)} is the value of ${same.join(', ')}`);
      }
      expect(clashes, `${loc}: sibling labels that read alike:\n  ${clashes.join('\n  ')}`).toEqual([]);
    });
  }
});
