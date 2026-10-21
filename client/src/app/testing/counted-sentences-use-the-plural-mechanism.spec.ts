/**
 * A sentence that counts something goes through the plural mechanism, or it says "1 rows" (Q-549).
 *
 * `pluralText` (`core/plural-text.ts`) picks the form the reader's language uses for the number (`<base>.one|few|many|other`). A
 * value that puts a number beside a noun by hand - "Restoring {{done}} of {{total}} spaces", "Re-queue {{count}} failed embedding
 * job(s)", "across {{count}} checks" - is right for the one count its author tried: it says "1 checks" and "1 conflict(s)" for
 * one, and in Polish it has one form where the language has four. Every such sentence read as correct to its author and to every
 * test, because the harness echoes keys and only a reader of that language sees the number and noun disagree.
 *
 * Derived, never listed: every en value is scanned for a count-like parameter (`COUNT_PARAMS`) sitting directly beside a word -
 * `{{x}} <word>` or `<word> {{x}}` - on a key that is not itself a plural form (`.one`, `.few`, `.many`, `.other`; those ARE the
 * mechanism). `({{x}})` and `: {{x}}` have no word beside the number and are not counted sentences. Words that are not nouns (`of`,
 * `in`, `more`, `left`, ...) do not make a sentence counted by themselves: `NOT_A_NOUN`. A sentence that must stay literal is an entry
 * of `ALLOWED` with the reason written out, and the test refuses an entry without one or for a key that no longer matches.
 *
 * Not claimed: a number the code passes under another name (`{{name}}` given a number) is not found here; time units (`{{days}} d`)
 * are quantities and not counted nouns, and are left out of `COUNT_PARAMS` on purpose.
 */
import { describe, it, expect } from 'vitest';
import { dictionary } from './i18n-dictionary';

/** The parameter names that carry a count of things. */
const COUNT_PARAMS = /^(?:n|count|total|done|rows|affected|shown|remaining|skipped|enqueued|checked|applied|pending|created|updated|resolved|failed|returned|matches|nodes|edges|hops|cols|totalRows|totalCols)$/;

/**
 * Words that sit beside a number without being what is counted: connectives, a status word that follows a count ("3 failed",
 * "2 selected", "4 below"), and the units of a quantity (a duration is measured, not counted).
 */
const NOT_A_NOUN = new Set([
  'of', 'in', 'to', 'from', 'and', 'or', 'more', 'left', 'so', 'still', 'are', 'is', 'were', 'was', 'will', 'out', 'at', 'by', 'with', 'for', 'the', 'a', 'an',
  'failed', 'resolved', 'created', 'updated', 'selected', 'skipped', 'below',
  'days', 'hours', 'minutes', 'seconds',
  // A label that names a kind of schema type ("enum 3"), not a sentence.
  'enum',
]);

/** A key allowed to keep a literal number-beside-noun, with the reason. None today. */
const ALLOWED: Readonly<Record<string, string>> = {};

const PLURAL_FORM = /\.(?:one|few|many|other)$/;

/** The nouns a value counts by hand: the words directly before or after a count-like parameter. */
function countedBy(value: string): string[] {
  const found: string[] = [];
  for (const m of value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (!COUNT_PARAMS.test(m[1]!)) continue;
    const before = /([A-Za-z]{2,})\s+$/.exec(value.slice(0, m.index!))?.[1];
    const after = /^\s+([A-Za-z]{2,})/.exec(value.slice(m.index! + m[0].length))?.[1];
    for (const w of [before, after]) if (w && !NOT_A_NOUN.has(w.toLowerCase())) found.push(`${w} beside {{${m[1]}}}`);
  }
  return found;
}

describe('a counted sentence uses the plural mechanism (Q-549)', () => {
  const en = dictionary('en');

  it('scans the en values that carry a count-like parameter (a floor, so a changed spelling cannot pass by finding none)', () => {
    const withCount = Object.values(en).filter(v => typeof v === 'string' && [...v.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].some(m => COUNT_PARAMS.test(m[1]!)));
    expect(withCount.length).toBeGreaterThan(50);
  });

  it('every ALLOWED entry names a key that still has a hand-counted sentence, and says why', () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(reason.trim().length, `${key}: an allowance needs its reason written`).toBeGreaterThan(10);
      expect(countedBy(en[key] ?? ''), `${key} no longer has a counted sentence - remove its allowance`).not.toEqual([]);
    }
  });

  it('no en value counts a noun by hand: each goes through pluralText with <base>.one and <base>.other', () => {
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(en)) {
      if (typeof value !== 'string' || PLURAL_FORM.test(key) || key in ALLOWED) continue;
      const by = countedBy(value);
      if (by.length) offenders.push(`${key} = ${JSON.stringify(value)}  [${by.join('; ')}]`);
    }
    expect(offenders, `${offenders.length} sentences put a count beside a noun without the plural mechanism:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
