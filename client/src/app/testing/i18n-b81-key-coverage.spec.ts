/**
 * The words bundle-81 adds exist in all three locales (design rev 8 §8.2 and §9 "Client", decisions 15, 19, 43): every key under
 * `brain.review.forks.*` and `networks.reread.*`, and `networks.refusal.record_version_at_ceiling`, in en, de and pl.
 *
 * The plan says `i18n-key-coverage.spec.ts` covers them; that file derives its keys from what the SOURCE uses, and the components
 * are not written yet, so a source-derived check finds nothing to cover. This spec is the derivation from the other end: the keys
 * the two green-lit mockups use (named below, the mockups' own `data-key`s and `T(...)` keys), plus a floor on each prefix, with
 * the English file as the reference for the other two locales.
 *
 * ## The rules
 *
 * - every mockup key exists in `en`, `de` and `pl`, non-empty;
 * - each prefix has at least its floor of keys in `en` (a prefix with fewer is not the green-lit section);
 * - whatever `en` holds under a prefix, `de` and `pl` hold too (no key in one locale and not another), and no translation is the
 *   English sentence copied across unless it is a placeholder-only value;
 * - a plural key (`.one` / `.other`) has both forms, and `{{...}}` placeholders match between en and each locale;
 * - `networks.refusal.record_version_at_ceiling` carries `{{id}}` in all three.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: none of the keys exists in any locale. Mutation for the covered part: delete one de key and the rule that names
 * the locale and key fails. Restore by hand.
 */
import { describe, it, expect } from 'vitest';
import { dictionary, LOCALES } from './i18n-dictionary';

const PREFIXES = [
  { prefix: 'brain.review.forks.', floor: 40 },
  { prefix: 'networks.reread.', floor: 15 },
] as const;

/** The keys the mockups use (`b81-mock-forks/shared/*.js`, `b81-mock-reread/layout-b.html`), plain keys; plurals are `.one`/`.other`. */
const MOCKUP_KEYS = [
  'brain.review.forks.legend.onlyThis', 'brain.review.forks.legend.onlyOther', 'brain.review.forks.showBoth',
  'brain.review.forks.thisVersion', 'brain.review.forks.otherVersion', 'brain.review.forks.keepThis', 'brain.review.forks.keepOther',
  'brain.review.forks.forkOf', 'brain.review.forks.writtenOn', 'brain.review.forks.unchanged', 'brain.review.forks.pointedAt',
  'brain.review.forks.pointedAtNone', 'brain.review.forks.atCap', 'brain.review.forks.atCapBody',
  'brain.review.forks.confirm.keepThis.title', 'brain.review.forks.confirm.keepThis.body',
  'brain.review.forks.confirm.keepOther.title', 'brain.review.forks.confirm.keepOther.body',
  'brain.review.forks.confirm.deletes', 'brain.review.forks.confirm.deletesNone',
  'brain.review.forks.empty.title', 'brain.review.forks.empty.body', 'brain.review.forks.loadError',
  'brain.review.forks.edges.one', 'brain.review.forks.edges.other', 'brain.review.forks.links.one', 'brain.review.forks.links.other',
  'networks.reread.title', 'networks.reread.scope.legend', 'networks.reread.estimate', 'networks.reread.cost',
  'networks.reread.alreadyOwed', 'networks.reread.typeNameToConfirm', 'networks.reread.confirm', 'networks.reread.mfa',
  'networks.reread.button', 'networks.reread.section', 'networks.reread.none', 'networks.reread.underway',
  'networks.reread.noSpaces', 'networks.reread.header', 'networks.reread.more',
  'networks.reread.member.catchingUp', 'networks.reread.member.owed',
  'networks.refusal.record_version_at_ceiling',
];

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]!).sort();

describe('the words of bundle-81 exist in en, de and pl', () => {
  it('the mockups\' keys are present and non-empty in every locale', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const words = dictionary(locale);
      for (const key of MOCKUP_KEYS) if (!words[key] || !String(words[key]).trim()) missing.push(`${locale}: ${key}`);
    }
    expect(missing).toEqual([]);
  });

  for (const { prefix, floor } of PREFIXES) {
    it(`${prefix}* has at least ${floor} keys in en, and de and pl hold exactly the same keys`, () => {
      const under = (locale: string) => Object.keys(dictionary(locale)).filter(k => k.startsWith(prefix)).sort();
      const en = under('en');
      expect(en.length, `en has ${en.length} keys under ${prefix}`).toBeGreaterThanOrEqual(floor);
      for (const locale of ['de', 'pl']) {
        const have = new Set(under(locale));
        expect(en.filter(k => !have.has(k)), `${locale} lacks keys en has under ${prefix}`).toEqual([]);
        const extra = [...have].filter(k => !en.includes(k));
        expect(extra, `${locale} has keys en lacks under ${prefix}`).toEqual([]);
      }
    });

    it(`${prefix}*: placeholders match en in de and pl, plurals have both forms, and nothing is the English sentence copied across`, () => {
      const en = dictionary('en');
      const keys = Object.keys(en).filter(k => k.startsWith(prefix));
      expect(keys.length).toBeGreaterThanOrEqual(floor);
      const problems: string[] = [];
      for (const key of keys) {
        if (/\.one$/.test(key) && !(key.replace(/\.one$/, '.other') in en)) problems.push(`en: ${key} has no .other form`);
        for (const locale of ['de', 'pl']) {
          const t = dictionary(locale)[key];
          if (t === undefined) continue; // reported by the key-set rule above
          if (placeholders(String(t)).join() !== placeholders(String(en[key])).join()) problems.push(`${locale}: ${key} placeholders ${placeholders(String(t))} differ from en ${placeholders(String(en[key]))}`);
          if (String(t) === String(en[key]) && /[a-z]{4,}/i.test(String(en[key]).replace(/\{\{[^}]*\}\}/g, ''))) problems.push(`${locale}: ${key} is the English sentence`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('networks.refusal.record_version_at_ceiling carries {{id}} in all three locales, and de and pl are not the English', () => {
    const en = dictionary('en')['networks.refusal.record_version_at_ceiling'];
    expect(en, 'en.json has no networks.refusal.record_version_at_ceiling').toBeTruthy();
    for (const locale of LOCALES) {
      const t = dictionary(locale)['networks.refusal.record_version_at_ceiling'];
      expect(t, `${locale}.json has no networks.refusal.record_version_at_ceiling`).toBeTruthy();
      expect(t).toContain('{{id}}');
      if (locale !== 'en') expect(t).not.toBe(en);
    }
  });
});
