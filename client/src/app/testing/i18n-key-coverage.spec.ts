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
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from './strip-comments';
import { callArguments } from './call-arguments';
import { dictionary, I18N_DIR, LOCALES } from './i18n-dictionary';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { componentTemplates } from './component-templates';
import { CORE_PLURAL_MODULES, pluralServiceNames } from './plural-mechanism';

const SRC = resolve(CLIENT_ROOT, 'src/app');

/**
 * The client's tracked, non-spec sources as absolute paths. `git ls-files` (via `trackedAppSources`), never a directory walk: a
 * gitignored or generated file is not the app, and the listing throws on a short result instead of returning one that every loop passes.
 */
const appSources = (): string[] => trackedAppSources().map(f => resolve(CLIENT_ROOT, f));

/**
 * Static translation keys used in the source. Matches the two shapes the app actually uses:
 *   {{ 'some.key' | transloco }}   and   transloco.translate('some.key')
 * A key is `word.word(.word)*` — requiring a dot avoids sweeping up every unrelated string literal.
 */
function usedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const KEY = /'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'\s*(?:\|\s*transloco|\))/g;
  const TRANSLATE = /translate\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g;
  for (const file of appSources()) {
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

/** One use of a plural base: the base, and the line it is written on. */
interface BaseUse { base: string; line: number; via?: string }
interface UnresolvedBase { line: number; why: string }

/**
 * The bases a (comment-stripped) source hands the plural mechanism through a CALL: `pluralText(t, lang, '<base>', n)` (third argument)
 * and `<service>.text('<base>', n)` on a held PluralText service (first argument). A literal is a base; an identifier is resolved to the
 * literals its function (a method or an arrow with that parameter) is called with in the same file; anything else, or an identifier that
 * resolves to none, is returned as unresolved rather than skipped.
 */
export function basesCalledIn(src: string): { found: BaseUse[]; unresolved: UnresolvedBase[] } {
  const found: BaseUse[] = [];
  const unresolved: UnresolvedBase[] = [];
  const calls: { re: RegExp; argument: number }[] = [{ re: /\bpluralText\(/g, argument: 2 }];
  const services = pluralServiceNames(src);
  if (services.length) calls.push({ re: new RegExp(`\\b(?:${services.join('|')})\\.text\\(`, 'g'), argument: 0 });
  for (const { re, argument } of calls) {
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index!).split('\n').length;
      const base = callArguments(src, m.index! + m[0].length - 1)[argument] ?? '';
      const literal = /^'([^']+)'$/.exec(base);
      if (literal) { found.push({ base: literal[1]!, line }); continue; }
      if (!/^[A-Za-z_]\w*$/.test(base)) { unresolved.push({ line, why: `base \`${base}\` is neither a literal nor a parameter` }); continue; }
      const head = src.slice(0, m.index!);
      const decl = [...head.matchAll(new RegExp(`(?:\\b(\\w+)\\s*=\\s*(?:async\\s*)?|\\b(\\w+))\\([^()]*\\b${base}\\s*:`, 'g'))].pop();
      const fn = decl?.[1] ?? decl?.[2];
      const callers = fn ? [...src.matchAll(new RegExp(`\\b${fn}\\(\\s*'([^']+)'`, 'g'))].map(c => c[1]!) : [];
      if (!callers.length) { unresolved.push({ line, why: `base \`${base}\` resolves to no literal handed to ${fn ?? 'its function'} in this file` }); continue; }
      for (const c of callers) found.push({ base: c, line, via: fn });
    }
  }
  return { found, unresolved };
}

/**
 * The bases a template hands the `plural` pipe: `{{ n | plural:'<base>' }}`. Only a literal is a base: a pipe argument is a template
 * expression with no function to resolve it through, so anything else is refused (`{{ n | plural:key }}` cannot be checked here).
 */
export function pipeBasesIn(template: string): { found: BaseUse[]; unresolved: UnresolvedBase[] } {
  const found: BaseUse[] = [];
  const unresolved: UnresolvedBase[] = [];
  for (const m of template.matchAll(/\|\s*plural\b(?:\s*:\s*('[^']*'|[^\s:}|]*))?/g)) {
    const line = template.slice(0, m.index!).split('\n').length;
    const literal = /^'([^']+)'$/.exec(m[1] ?? '');
    if (literal) found.push({ base: literal[1]!, line });
    else unresolved.push({ line, why: `the plural pipe's base \`${m[1] ?? ''}\` is not a string literal` });
  }
  return { found, unresolved };
}

/** Every plural base the client names, with where; bases that cannot be read are returned under `unresolved`. */
function pluralBases(): { bases: Map<string, string[]>; unresolved: string[] } {
  const bases = new Map<string, string[]>();
  const unresolved: string[] = [];
  const add = (base: string, where: string): void => { bases.set(base, [...(bases.get(base) ?? []), where]); };
  const rel = (file: string): string => file.slice(SRC.length + 1).replace(/\\/g, '/');
  for (const file of appSources()) {
    const repoPath = `src/app/${rel(file)}`;
    if (CORE_PLURAL_MODULES.includes(repoPath)) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    const { found, unresolved: open } = basesCalledIn(src);
    for (const u of found) add(u.base, `${rel(file)}:${u.line}${u.via ? ` via ${u.via}` : ''}`);
    unresolved.push(...open.map(u => `${rel(file)}:${u.line}: ${u.why}`));
  }
  for (const t of componentTemplates()) {
    const { found, unresolved: open } = pipeBasesIn(t.text);
    for (const u of found) add(u.base, `${t.file.replace(/^src\/app\//, '')}:${t.startLine + u.line - 1} (pipe)`);
    unresolved.push(...open.map(u => `${t.file.replace(/^src\/app\//, '')}:${t.startLine + u.line - 1}: ${u.why}`));
  }
  return { bases, unresolved };
}

describe('every plural base has its forms in every locale (Q-549, Q-472, Q-574)', () => {
  const { bases, unresolved } = pluralBases();
  const CATEGORY = /^(?:zero|one|two|few|many|other)$/;
  const formsOf = (dict: Record<string, string>, base: string): string[] =>
    Object.keys(dict).filter(k => k.startsWith(`${base}.`) && CATEGORY.test(k.slice(base.length + 1))).map(k => k.slice(base.length + 1));

  it('finds the bases (a floor over every form - pluralText calls, service .text calls, the plural pipe - so a changed call shape cannot pass by finding none)', () => {
    expect(bases.size).toBeGreaterThanOrEqual(8);
  });

  // The derivation is the gate. The service and the pipe have no caller at the base commit, so a derivation that never read one would pass
  // everything: each form is shown a source, and the refusal of a base it cannot read is shown one too.
  it('the derivation reads every form the mechanism is called in, and refuses a base it cannot read', () => {
    const service = `class A { private readonly plural = inject(PluralText); a() { return this.plural.text('svc.literal', 2); } b() { return this.show('svc.viaParam', 1); } show(base: string, n: number) { return this.plural.text(base, n); } c() { return this.plural.text(this.key, 3); } }`;
    expect(basesCalledIn(service).found.map(u => u.base).sort()).toEqual(['svc.literal', 'svc.viaParam']);
    expect(basesCalledIn(service).unresolved.map(u => u.why)).toEqual([expect.stringContaining('this.key')]);
    expect(basesCalledIn(`const t = pluralText(tr, lang, 'fn.literal', 2);`).found.map(u => u.base)).toEqual(['fn.literal']);
    expect(basesCalledIn(`class B { x() { return other.text('not.a.service', 2); } }`).found).toEqual([]);

    const pipe = pipeBasesIn(`<b>{{ n | plural:'pipe.literal' }}</b><i>{{ m | plural:'pipe.withParams':{ shown: 3 } }}</i><u>{{ k | plural:key }}</u><s>{{ j | plural }}</s>`);
    expect(pipe.found.map(u => u.base)).toEqual(['pipe.literal', 'pipe.withParams']);
    expect(pipe.unresolved).toHaveLength(2);
    expect(pipeBasesIn(`{{ 'a.b' | transloco }} {{ x | pluralize }}`).found).toEqual([]);
  });

  it('every call and pipe use hands the mechanism a literal base, or (a call) a parameter that resolves to literals in the same file', () => {
    const open = unresolved.filter(u => !Object.keys(UNCHECKED_BASES).some(site => u.startsWith(site)));
    expect(open, 'pluralText bases that cannot be checked:\n  ' + open.join('\n  ')).toEqual([]);
  });

  // The forms a language needs are the categories its own plural rules use (Polish: one, few, many, other), not the ones English
  // happens to carry: a Polish base with only one/other falls back to `other` for 2-4 and renders the wrong case, and nothing fails.
  it('every language carries a form for every plural category its own rules use', () => {
    const wrong: string[] = [];
    for (const loc of LOCALES) {
      const needed = new Intl.PluralRules(loc).resolvedOptions().pluralCategories;
      const dict = dictionary(loc);
      for (const [base, sites] of bases) {
        const have = formsOf(dict, base);
        for (const need of needed) if (!have.includes(need)) wrong.push(`${loc}: ${base}.${need} is missing (called at ${sites.join(', ')})`);
      }
    }
    expect(wrong, `plural bases whose forms are missing - the sentence renders empty:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});

describe('i18n key coverage', () => {
  const en = dictionary('en');
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
      const src = readFileSync(join(I18N_DIR, `${loc}.json`), 'utf8');
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
      const keys = Object.keys(dictionary(loc)).sort();
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
      for (const [key, value] of Object.entries(dictionary(loc))) {
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

  it('no value writes a placeholder with spaces inside the braces, in any locale', () => {
    /*
     * The placeholder convention here is `{{name}}`, and the plural mechanism fills it by name. About thirty-five values per file wrote
     * `{{ name }}` instead: both spellings interpolate in Transloco's own transpiler, so nothing ever failed, and that is the reason for the
     * gate - two spellings of one thing are read by two kinds of code (a regex that fills params, a spec that compares parameter sets, a
     * translator pasting between files), and the next reader that is written for one spelling misses the other without a sound.
     * Derived over every value of every locale, never a list of keys.
     */
    const offenders: string[] = [];
    let scanned = 0;
    for (const loc of LOCALES) {
      for (const [key, value] of Object.entries(dictionary(loc))) {
        if (typeof value !== 'string') continue;
        scanned++;
        const spaced = value.match(/\{\{\s+[^{}]*\}\}|\{\{[^{}]*\s+\}\}/g);
        if (spaced) offenders.push(`${loc}: ${key} → ${spaced.join(' ')}`);
      }
    }
    expect(scanned, 'a floor, so a loader that returned nothing cannot pass this by scanning nothing').toBeGreaterThan(3000);
    expect(offenders, `${offenders.length} values carry a spaced placeholder - write {{name}}:\n  ${offenders.slice(0, 60).join('\n  ')}`).toEqual([]);
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
    const others = { de: dictionary('de'), pl: dictionary('pl') };
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
