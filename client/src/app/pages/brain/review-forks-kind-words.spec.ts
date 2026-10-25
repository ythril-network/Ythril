/**
 * The words of the kind switch exist in en, de and pl (Q-624, design rev 4 section 11: "Words: under `brain.review.forks.kind.*`, `.orphaned`,
 * `.stale`, with confirm bodies per kind, in en, de and pl", and section 9a: "under `brain.review.forks.resolvedElsewhere.*` in en, de and pl").
 *
 * `testing/i18n-b81-key-coverage.spec.ts` holds the section as a whole (floor and parity); this names the keys the kind-switch layout needs, the
 * keys of the green-lit mockup (`variant-b`, `words2.js`), so a section that keeps its floor by other keys still fails here when the switch,
 * the empty kind, the orphan or the resolved-elsewhere line has no words. Fixture keys, written out on purpose: the expected values of a
 * derivation are allowed to be literal.
 *
 * ## The rules
 *
 * - every key is present and non-empty in en, de and pl;
 * - de and pl hold what en holds under `brain.review.forks.kind.`, `.kindCount.`, `.empty.kind.` and `.resolvedElsewhere.`, and the placeholders match;
 * - `resolvedElsewhere` has the four lines section 9a words (kept the original, kept this version, waiting, reported by a peer).
 *
 * ## Seen red
 *
 * Red on b857da8f: none of these keys exists in any locale.
 */
import { describe, it, expect } from 'vitest';
import { dictionary, LOCALES } from '../../testing/i18n-dictionary';

const P = 'brain.review.forks.';
const KEYS = [
  'kindSwitch', 'kind.fact', 'kind.entity', 'kind.chrono', 'kind.edge', 'kindCount.one', 'kindCount.other',
  'empty.kind.title', 'empty.kind.body', 'empty.elsewhere', 'empty.show',
  'orphaned', 'orphanedBody', 'letDeletionStand', 'stale',
].map(k => P + k);

/** Prefixes whose keys en defines and de and pl must define identically, with a floor so an empty prefix is not parity. */
const PREFIXES = [
  { prefix: `${P}kind.`, floor: 4 },
  { prefix: `${P}kindCount.`, floor: 2 },
  { prefix: `${P}empty.kind.`, floor: 2 },
  { prefix: `${P}resolvedElsewhere.`, floor: 4 },
] as const;

const placeholders = (s: string) => [...s.matchAll(/\{\{?\s*(\w+)\s*\}?\}/g)].map(m => m[1]!).sort();

describe('the words of the kind switch exist in en, de and pl', () => {
  it('every key the layout reads is present and non-empty in every locale', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const words = dictionary(locale);
      for (const key of KEYS) if (!words[key] || !String(words[key]).trim()) missing.push(`${locale}: ${key}`);
    }
    expect(missing).toEqual([]);
  });

  for (const { prefix, floor } of PREFIXES) {
    it(`${prefix}* has at least ${floor} keys in en, and de and pl hold the same keys with the same placeholders`, () => {
      const under = (locale: string) => Object.keys(dictionary(locale)).filter(k => k.startsWith(prefix)).sort();
      const en = under('en');
      expect(en.length, `en has ${en.length} keys under ${prefix}`).toBeGreaterThanOrEqual(floor);
      for (const locale of ['de', 'pl']) {
        const words = dictionary(locale);
        const have = new Set(under(locale));
        expect(en.filter(k => !have.has(k)), `${locale} lacks keys en has under ${prefix}`).toEqual([]);
        const off = en.filter(k => have.has(k) && placeholders(dictionary('en')[k]!).join() !== placeholders(words[k]!).join());
        expect(off, `${locale}: placeholders differ from en`).toEqual([]);
      }
    });
  }

  it('the four kinds are named as the mockup names them in English', () => {
    const en = dictionary('en');
    expect([en[`${P}kind.fact`], en[`${P}kind.entity`], en[`${P}kind.chrono`], en[`${P}kind.edge`]])
      .toEqual(['Facts', 'Entities', 'Timeline', 'Relationships']);
  });
});
