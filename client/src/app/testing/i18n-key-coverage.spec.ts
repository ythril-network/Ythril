/**
 * Every translation key referenced in the source must exist in en.json — and en/de/pl must agree.
 *
 * This exists because a missing key fails INVISIBLY. Transloco renders the key itself, so the UI shows
 * `mediaProcessing.face.enable` where a sentence should be; the component still builds, the unit tests
 * still pass (the test harness deliberately echoes raw keys), and nothing goes red. The only detector is
 * a human looking at that exact screen.
 *
 * It was written while migrating the old `models.*` namespace to `mediaProcessing.*` — 182 keys across
 * three locales and every template that referenced them. A single missed reference would have shipped a
 * raw key into the UI with every existing test still green. On its very first run it also found two keys
 * that had been missing on main all along (`schemaLib.field.schema` / `schemaLib.field.schemaHint`), which
 * is the whole argument for having it.
 *
 * Scope note: it matches STATIC keys — string literals handed to the transloco pipe or service. Keys built
 * at runtime (`'x.' + kind`) can't be checked this way and are deliberately not attempted; the point is to
 * catch typos and half-finished renames, which are always static.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from './strip-comments';
import { callArguments } from './call-arguments';

const SRC = resolve(__dirname, '..');
const I18N = resolve(__dirname, '../../../public/assets/i18n');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const load = (loc: string): Record<string, string> =>
  JSON.parse(readFileSync(join(I18N, `${loc}.json`), 'utf8'));

/**
 * Static translation keys used in the source. Matches the two shapes the app actually uses:
 *   {{ 'some.key' | transloco }}   and   transloco.translate('some.key')
 * A key is `word.word(.word)*` — requiring a dot avoids sweeping up every unrelated string literal.
 */
function usedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const KEY = /'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'\s*(?:\|\s*transloco|\))/g;
  const TRANSLATE = /translate\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g;
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const re of [KEY, TRANSLATE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const key = m[1];
        // Only treat it as a translation key when en.json actually has that NAMESPACE — otherwise the
        // pattern also matches import paths, css classes and the like. A wholly-unknown namespace is not
        // evidence of a missing translation, but a known namespace with an unknown leaf is.
        if (!found.has(key)) found.set(key, []);
        found.get(key)!.push(file.slice(SRC.length + 1));
      }
    }
  }
  return found;
}

/**
 * The bases `pluralText(transloco, lang, '<base>', count)` is called with (Q-549, Q-472).
 *
 * `pluralText` looks up `<base>.<category>` and falls back to `<base>.other`, and `translatedOrEmpty` answers '' for a key it
 * cannot find - so a base that is misspelled, or whose `.one` / `.other` was never written, renders an EMPTY sentence with no raw
 * key, no error and every test green. The static-key scan above cannot see it: the call never spells a full key.
 *
 * Derived from the source: every `pluralText(` call's third argument. A literal is a base. An identifier is resolved to the literals
 * its function (a method or an arrow with that parameter) is called with in the same file; one that resolves to none is a failure to
 * say so rather than a site silently skipped (`UNCHECKED_BASES` names a site with the reason, none today).
 */
const UNCHECKED_BASES: Readonly<Record<string, string>> = {};

/** Every plural base the client calls `pluralText` with, with where; unresolved identifiers are returned under `unresolved`. */
function pluralBases(): { bases: Map<string, string[]>; unresolved: string[] } {
  const bases = new Map<string, string[]>();
  const unresolved: string[] = [];
  const add = (base: string, where: string): void => { bases.set(base, [...(bases.get(base) ?? []), where]); };
  for (const file of walk(SRC)) {
    if (file.endsWith('plural-text.ts')) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\bpluralText\(/g)) {
      const where = `${file.slice(SRC.length + 1)}:${src.slice(0, m.index!).split('\n').length}`;
      const base = callArguments(src, m.index! + m[0].length - 1)[2] ?? '';
      const literal = /^'([^']+)'$/.exec(base);
      if (literal) { add(literal[1]!, where); continue; }
      if (!/^[A-Za-z_]\w*$/.test(base)) { unresolved.push(`${where}: base \`${base}\` is neither a literal nor a parameter`); continue; }
      const head = src.slice(0, m.index!);
      const decl = [...head.matchAll(new RegExp(`(?:\\b(\\w+)\\s*=\\s*(?:async\\s*)?|\\b(\\w+))\\([^()]*\\b${base}\\s*:`, 'g'))].pop();
      const fn = decl?.[1] ?? decl?.[2];
      const callers = fn ? [...src.matchAll(new RegExp(`\\b${fn}\\(\\s*'([^']+)'`, 'g'))].map(c => c[1]!) : [];
      if (!callers.length) { unresolved.push(`${where}: base \`${base}\` resolves to no literal handed to ${fn ?? 'its function'} in this file`); continue; }
      for (const c of callers) add(c, `${where} via ${fn}`);
    }
  }
  return { bases, unresolved };
}

describe('every pluralText base has its forms in every locale (Q-549, Q-472)', () => {
  const { bases, unresolved } = pluralBases();
  const CATEGORY = /^(?:zero|one|two|few|many|other)$/;
  const formsOf = (dict: Record<string, string>, base: string): string[] =>
    Object.keys(dict).filter(k => k.startsWith(`${base}.`) && CATEGORY.test(k.slice(base.length + 1))).map(k => k.slice(base.length + 1));

  it('finds the bases (a floor, so a changed call shape cannot pass by finding none)', () => {
    expect(bases.size).toBeGreaterThanOrEqual(8);
  });

  it('every call hands pluralText a literal base, or a parameter that resolves to literals in the same file', () => {
    const open = unresolved.filter(u => !Object.keys(UNCHECKED_BASES).some(site => u.startsWith(site)));
    expect(open, 'pluralText bases that cannot be checked:\n  ' + open.join('\n  ')).toEqual([]);
  });

  it('en has <base>.one and <base>.other, and de and pl carry every form en has', () => {
    const en = load('en');
    const wrong: string[] = [];
    for (const [base, sites] of bases) {
      const enForms = formsOf(en, base);
      for (const need of ['one', 'other']) {
        if (!enForms.includes(need)) wrong.push(`en: ${base}.${need} is missing (called at ${sites.join(', ')})`);
      }
      for (const loc of ['de', 'pl']) {
        const have = formsOf(load(loc), base);
        for (const form of enForms) if (!have.includes(form)) wrong.push(`${loc}: ${base}.${form} is missing (en has it)`);
      }
    }
    expect(wrong, `plural bases whose forms are missing - the sentence renders empty:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});

describe('i18n key coverage', () => {
  const en = load('en');
  const namespaces = new Set(Object.keys(en).map(k => k.split('.')[0]));

  it('every static key used in the source exists in en.json', () => {
    const missing: string[] = [];
    for (const [key, files] of usedKeys()) {
      const ns = key.split('.')[0];
      if (!namespaces.has(ns)) continue;      // not a translation namespace at all
      if (!(key in en)) missing.push(`${key}  (used in ${[...new Set(files)].join(', ')})`);
    }
    expect(missing, `translation keys referenced in the source but absent from en.json:\n  ${missing.join('\n  ')}`)
      .toEqual([]);
  });

  it('no locale defines the same key twice', () => {
    /*
     * `JSON.parse` keeps the LAST of two identical keys and reports nothing, so a duplicate is invisible in
     * every way that matters: the file parses, the key count looks right, `Object.keys` shows one entry, and
     * both of the checks above pass. What the reader sees is the other definition's text.
     *
     * Found by writing one. U-1 added `brain.query.projection` for the recall form without noticing the
     * Advanced Query panel had defined it 71 lines further down; the new label was simply never used, and
     * the only detector was a screenshot showing the old word.
     *
     * So this reads the FILE rather than the parsed object — a parsed object cannot answer the question,
     * which is the whole reason the duplicate survived.
     */
    for (const loc of ['en', 'de', 'pl']) {
      const src = readFileSync(join(I18N, `${loc}.json`), 'utf8');
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const m of src.matchAll(/^\s*"([^"]+)":/gm)) {
        if (seen.has(m[1])) dupes.push(m[1]);
        seen.add(m[1]);
      }
      expect(dupes, `${loc}.json defines these keys twice — the second wins silently`).toEqual([]);
    }
  });

  it('de and pl carry exactly the same keys as en', () => {
    const enKeys = Object.keys(en).sort();
    for (const loc of ['de', 'pl']) {
      const keys = Object.keys(load(loc)).sort();
      const missing = enKeys.filter(k => !keys.includes(k));
      const extra = keys.filter(k => !enKeys.includes(k));
      expect(missing, `${loc}.json is missing keys present in en.json`).toEqual([]);
      expect(extra, `${loc}.json has keys that no longer exist in en.json`).toEqual([]);
    }
  });

  it('every placeholder is double-braced, in every value of every locale', () => {
    /*
     * Transloco interpolates `{{param}}` and nothing else — this app has no messageformat plugin — so a
     * value written `Entities ({count})` renders those eleven characters literally. Found on the Query tab
     * (`Q-101`, 2026-09-28): the walk's headings read `REACHED BY THE WALK ({COUNT})`, in all three
     * languages, with every spec green, because the test harness echoes keys rather than rendering values.
     *
     * A brace pair holding ONE bare identifier is the placeholder shape. Braces around a comma-separated
     * list are prose — `{ knowledgeType, typeName, schema }` describes a JSON snippet in the schema-import
     * errors — and are left alone. Derived over every value, never a list of known keys.
     */
    const offenders: string[] = [];
    let scanned = 0;
    for (const loc of ['en', 'de', 'pl']) {
      for (const [key, value] of Object.entries(load(loc))) {
        if (typeof value !== 'string') continue;
        scanned++;
        const withoutDouble = value.replace(/\{\{[^}]*\}\}/g, '');
        const single = withoutDouble.match(/\{\s*[A-Za-z_][\w.]*\s*\}/g);
        if (single) offenders.push(`${loc}: ${key} → ${single.join(' ')}`);
      }
    }
    // A floor, so a loader that returned nothing cannot pass this by scanning nothing.
    expect(scanned).toBeGreaterThan(3000);
    expect(offenders, `single-brace placeholders render literally — write {{param}}:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);
  });

  it('de and pl interpolate exactly the parameters en does', () => {
    /*
     * A translation that drops or renames a `{{param}}` renders without the number the English shows, and
     * like a single-brace placeholder it fails silently. Per key, the SET of parameter names must match.
     */
    const params = (v: unknown): string =>
      typeof v === 'string'
        ? [...new Set([...v.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(m => m[1]))].sort().join(',')
        : '';
    const others = { de: load('de'), pl: load('pl') };
    const mismatched: string[] = [];
    let withParams = 0;
    for (const [key, value] of Object.entries(en)) {
      const want = params(value);
      if (want) withParams++;
      for (const loc of ['de', 'pl'] as const) {
        const got = params(others[loc][key]);
        if (got !== want) mismatched.push(`${loc}: ${key} has [${got}], en has [${want}]`);
      }
    }
    expect(withParams).toBeGreaterThan(50);
    expect(mismatched, `a locale's value interpolates different parameters from en:\n  ${mismatched.join('\n  ')}`)
      .toEqual([]);
  });
});
