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
 * The TEMPLATE half (further down, Q-572) asks the same question of the other place a number meets a noun: a component template that
 * writes the count and then the word as two things, `{{ n }} {{ 'key' | transloco }}`.
 *
 * Not claimed: a number the code passes under another name (`{{name}}` given a number) is not found here; time units (`{{days}} d`)
 * are quantities and not counted nouns, and are left out of `COUNT_PARAMS` on purpose.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { dictionary } from './i18n-dictionary';
import { componentTemplates, type ComponentTemplate } from './component-templates';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';

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

/**
 * ## The template half (Q-572)
 *
 * A template that puts a count beside a translated word writes the plural by hand, in one of three shapes (comments are stripped first, so
 * a template's own explanation is not read as its subject):
 *
 *   1. `{{ <expr> }}` then `{{ '<key>' | transloco }}` with only whitespace between - "12 records", the noun a separate key;
 *   2. inside one interpolation, `<expr> + ' ' + ('<key>' | transloco)` - the same thing built by concatenation;
 *   3. a count-like expression (`.length`, a COUNT_PARAMS-named identifier, or a call ending in Count, Total or size) directly followed by a
 *      ternary of two translated keys, `{{ n }} {{ n === 1 ? ('a' | transloco) : ('b' | transloco) }}` - the singular and the plural word
 *      chosen by hand, which is two forms where Polish has three.
 *
 * Each is the number-and-noun defect the dictionary half finds in a VALUE, living in the template instead: the value of `key` is just
 * "records", so the scan above cannot see it, and a reader of a language with more than two forms sees a number and a noun that disagree.
 * The cure is one plural key family and `{{ n | plural:'<base>' }}`. A key-pair ternary with no count before it is not matched: choosing
 * between two words is not counting.
 *
 * `TEMPLATE_ALLOWED` lists a translated key that legitimately sits beside a value, each with its reason; the gate refuses an entry with no
 * reason and an entry whose key no longer sits beside one. Derived over `componentTemplates()`, so a template added tomorrow is held to it.
 */

/** A translated key sitting directly beside a value in a template, with the reason it is allowed to. */
const TEMPLATE_ALLOWED: Readonly<Record<string, string>> = {
  'data.migrate.success':
    'the value is a status sentence (the migration notice, already built by pluralText in the component) and the key is the clause that follows it - there is no noun being counted',
  'tokens.table.perMin':
    'a unit of rate ("/min") written directly after a limit, like the "d" of "3 d": a quantity with a unit, not a count of things (COUNT_PARAMS leaves time units out on purpose)',
};

const TRANSLATED = String.raw`'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'\s*\|\s*transloco`;
const GAP = String.raw`(?:[\s ]|&nbsp;)*`;
const TERNARY = String.raw`[^{}?]*\?\s*\(\s*${TRANSLATED}\s*\)\s*:\s*\(\s*${TRANSLATED}`;

/** A number-like expression: a length or size, a COUNT_PARAMS-named identifier, or a call ending in Count, Total or size. */
function countLike(expr: string): boolean {
  const e = expr.trim().replace(/!$/, '');
  const last = /(?:^|\.)(\w+)$/.exec(e)?.[1];
  return /\.(?:length|size)$/.test(e) || (last !== undefined && COUNT_PARAMS.test(last)) || /\b\w*(?:Count|Total|size)\([^()]*\)$/.test(e);
}

interface HandCountedSite { shape: 1 | 2 | 3; keys: string[]; text: string; index: number }

/** The hand-counted sites of one template's text. */
function handCountedSites(text: string): HandCountedSite[] {
  const found: HandCountedSite[] = [];
  // Shape 1: {{ expr }} {{ 'key' | transloco }}
  for (const m of text.matchAll(new RegExp(String.raw`\{\{([^{}]*?)\}\}${GAP}\{\{\s*${TRANSLATED}\s*\}\}`, 'g'))) {
    found.push({ shape: 1, keys: [m[2]!], text: m[0], index: m.index! });
  }
  // Shape 2: expr + ' ' + ('key' | transloco)
  for (const m of text.matchAll(new RegExp(String.raw`\+\s*' '\s*\+\s*\(\s*${TRANSLATED}`, 'g'))) {
    found.push({ shape: 2, keys: [m[1]!], text: m[0], index: m.index! });
  }
  // Shape 3: a count-like value directly followed by a ternary of two translated keys, in two interpolations or in one.
  for (const m of text.matchAll(new RegExp(String.raw`\{\{([^{}]*?)\}\}${GAP}\{\{${TERNARY}`, 'g'))) {
    if (countLike(m[1]!)) found.push({ shape: 3, keys: [m[2]!, m[3]!], text: m[0], index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(String.raw`([\w.!()]+)\s*\+\s*' '\s*\+\s*\(${TERNARY}`, 'g'))) {
    if (countLike(m[1]!)) found.push({ shape: 3, keys: [m[2]!, m[3]!], text: m[0], index: m.index! });
  }
  return found;
}

const lineIn = (t: ComponentTemplate, index: number): number => t.startLine + t.text.slice(0, index).split('\n').length - 1;

describe('a counted sentence in a template uses the plural mechanism (Q-572)', () => {
  const templates = componentTemplates();
  const sites = templates.flatMap(t => handCountedSites(t.text).map(s => ({ ...s, where: `${t.file}:${lineIn(t, s.index)}` })));

  it('scans the component templates (a floor, so a changed spelling of `template:` cannot pass by finding none)', () => {
    expect(templates.length).toBeGreaterThanOrEqual(100);
  });

  it('every TEMPLATE_ALLOWED entry says why, and still sits beside a value in some template', () => {
    for (const [key, reason] of Object.entries(TEMPLATE_ALLOWED)) {
      expect(reason.trim().length, `${key}: an allowance needs its reason written`).toBeGreaterThan(30);
      expect(sites.some(s => s.keys.includes(key)), `${key} no longer sits beside a value in any template - remove its allowance`).toBe(true);
    }
  });

  it('no template writes a count and its noun as two translations: each goes through the plural pipe', () => {
    const offenders = sites
      .filter(s => !s.keys.some(k => k in TEMPLATE_ALLOWED))
      .map(s => `${s.where}  [shape ${s.shape}: ${s.keys.join(' / ')}]  ${s.text.replace(/\s+/g, ' ').trim().slice(0, 150)}`);
    expect(offenders, `${offenders.length} template sites put a count beside a word without the plural mechanism:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  // A detector that has never seen a violation is a claim: each shape is shown one, and the things it must leave alone.
  it('the detector sees each shape, and leaves a bare choice between two words alone', () => {
    const keysOf = (text: string): string[][] => handCountedSites(text).map(s => s.keys);
    expect(keysOf(`<b>{{ rows().length }} {{ 'a.rows' | transloco }}</b>`)).toEqual([['a.rows']]);
    expect(keysOf(`{{ x ? rows.length + ' ' + ('a.sel' | transloco) : ('a.all' | transloco) }}`)).toEqual([['a.sel']]);
    expect(keysOf(`{{ net.members.length }} {{ net.members.length === 1 ? ('a.one' | transloco) : ('a.many' | transloco) }}`)).toEqual([['a.one', 'a.many']]);
    expect(keysOf(`{{ openVotesCount() + ' ' + (n === 1 ? ('a.one' | transloco) : ('a.many' | transloco)) }}`)).toEqual([['a.one', 'a.many']]);
    expect(keysOf(`{{ done ? ('a.yes' | transloco) : ('a.no' | transloco) }}`)).toEqual([]);
    expect(keysOf(`{{ label }} {{ cond ? ('a.yes' | transloco) : ('a.no' | transloco) }}`)).toEqual([]);
    expect(keysOf(`{{ 'a.title' | transloco }}: {{ name }}`)).toEqual([]);
    expect(countLike('rec.errors!.length')).toBe(true);
    expect(countLike('spaceTotal(sv.stats)')).toBe(true);
    expect(countLike('failedCount()')).toBe(true);
    expect(countLike('label')).toBe(false);
  });
});

/**
 * The code half: a count and a translated word joined in a template string, `${n} ${this.transloco.translate('...kind', ...)}`.
 *
 * Found by bundle-164's second reader after the template half was green: the delete-cascade confirmation built "1 Chronoeinträge" and
 * "5 wpisy chronologiczne" this way, because the word was one key with no plural forms and the count was glued on in code. Neither half
 * above could see it - the value had no `{{count}}` and the line was not in a template. The cure is the same: the plural service, whose
 * forms carry the count. Derived over every tracked source, comments stripped, so a site written tomorrow is held to it.
 */
const CODE_HAND_COUNT = /\$\{\s*([^{}`]+?)\s*\}\s+\$\{[^{}`]*?\btranslate\(/g;

function codeHandCounts(src: string): { expr: string; index: number }[] {
  return [...src.matchAll(new RegExp(CODE_HAND_COUNT.source, 'g'))].map(m => ({ expr: m[1]!, index: m.index! }));
}

describe('a counted sentence built in code uses the plural mechanism (Q-572)', () => {
  const sources = trackedAppSources().filter(f => !f.endsWith('.spec.ts'));
  const sites = sources.flatMap(file => {
    const src = stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
    return codeHandCounts(src).map(s => `${file}:${src.slice(0, s.index).split('\n').length}  \${${s.expr}} \${...translate(`);
  });

  it('scans the tracked sources (a floor, so an empty listing cannot pass)', () => {
    expect(sources.length).toBeGreaterThan(200);
  });

  it('no source writes a count beside a translated word in a template string: it asks the plural service', () => {
    expect(sites, `${sites.length} places glue a count to a translated word:\n  ${sites.join('\n  ')}`).toEqual([]);
  });

  it('the detector sees the shape, and leaves a label-then-value alone', () => {
    expect(codeHandCounts("`  • ${n} ${this.transloco.translate(`brain.cascade.kind.${type}`, { count: n })}`")).toHaveLength(1);
    expect(codeHandCounts("`${this.transloco.translate('a.title')}: ${n}`")).toHaveLength(0);
    expect(codeHandCounts("`${n} ${this.plural.text('a.base', n)}`")).toHaveLength(0);
  });
});
