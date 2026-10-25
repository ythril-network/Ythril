/**
 * The words of the kind switch exist in en, de and pl (Q-624, design rev 4 section 11: "Words: under `brain.review.forks.kind*`, `.orphaned`,
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
 * - de and pl hold what en holds under `brain.review.forks.kindCount.`, `.empty.kind.` and `.resolvedElsewhere.`, and the placeholders match;
 * - `resolvedElsewhere` has the four lines section 9a words (kept the original, kept this version, waiting, reported by a peer).
 *
 * ## Seen red
 *
 * Red on b857da8f: none of these keys exists in any locale.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { dictionary, LOCALES } from '../../testing/i18n-dictionary';
import { FORK_KIND_TAB } from '../../core/forks.types';

const P = 'brain.review.forks.';
const KEYS = [
  'kindSwitch', 'kindCount.one', 'kindCount.other',
  'empty.kind.title', 'empty.kind.body', 'empty.elsewhere', 'empty.show',
  'orphaned', 'orphanedBody', 'letDeletionStand', 'stale',
].map(k => P + k);

/** Prefixes whose keys en defines and de and pl must define identically, with a floor so an empty prefix is not parity. */
const PREFIXES = [
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

  /** The Brain tab key each kind is named by: the app's one name for it (`brain.tab.*`). A fixture, written out on purpose. */
  const TAB_KEYS = ['brain.tab.facts', 'brain.tab.entities', 'brain.tab.chrono', 'brain.tab.edges'];

  it('the switch has no label keys of its own: a kind is named by its Brain tab, so the name has one source', () => {
    const duplicates: string[] = [];
    for (const locale of LOCALES) {
      for (const key of Object.keys(dictionary(locale))) if (/^brain\.review\.forks\.kind\.[A-Za-z]+$/.test(key)) duplicates.push(`${locale}: ${key}`);
    }
    expect(duplicates, 'a kind label under brain.review.forks.kind.* is a second name for what brain.tab.* names').toEqual([]);
  });

  it('no word of the section repeats a Brain tab name under another key', () => {
    for (const locale of LOCALES) {
      const words = dictionary(locale);
      const tabNames = new Set(TAB_KEYS.map(k => words[k]));
      const repeated = Object.keys(words).filter(k => k.startsWith(P) && tabNames.has(words[k]));
      expect(repeated, `${locale}: these brain.review.forks.* values equal a brain.tab.* name`).toEqual([]);
    }
  });

  it('the switch reads brain.tab.*, which names the kinds in every locale as the Brain tabs do', () => {
    for (const locale of LOCALES) {
      const words = dictionary(locale);
      for (const key of TAB_KEYS) expect(words[key], `${locale}: ${key}`).toBeTruthy();
    }
    expect(TAB_KEYS.map(k => dictionary('en')[k])).toEqual(['Facts', 'Entities', 'Chrono', 'Edges']);
    const source = readFileSync(resolve(__dirname, 'review-forks.component.ts'), 'utf8');
    expect(source).toMatch(/brain\.tab\.\$\{FORK_KIND_TAB\[kind\]\}/);
    expect(source, 'the component still reads a label key of its own').not.toMatch(/brain\.review\.forks\.kind\./);
    expect(Object.values(FORK_KIND_TAB).sort(), "the tabs that name the kinds").toEqual(["chrono", "edges", "entities", "facts"]);
  });

  it('the sentences that name a kind use the app\'s own term for it, not a new one', () => {
    const en = dictionary('en');
    const hints = [`${P}kindHint.chrono`, `${P}kindNoun.chrono`, `${P}kindOne.chrono`, `${P}kindHint.edge`, `${P}kindNoun.edge`, `${P}kindOne.edge`].map(k => en[k]!.toLowerCase());
    expect(hints.join(' ')).not.toMatch(/timeline|relationship/);
    expect([en[`${P}kindNoun.chrono`], en[`${P}kindNoun.edge`]]).toEqual(['chrono entry', 'edge']);
  });
});
