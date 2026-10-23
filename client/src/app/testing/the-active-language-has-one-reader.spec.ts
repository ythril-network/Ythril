/**
 * The page's language has one reader, and a counted sentence is built in one place (Q-574).
 *
 * ## What went wrong
 *
 * "Which language is the page in?" was asked eight ways. `transloco.getActiveLang()` is a plain method: it is not a signal, so a
 * `computed()` or an OnPush template that calls it never learns of a switch; six components and services each wrapped `langChanges$` in a
 * private `toSignal` to get around that, and about thirty-five methods called `pluralText(transloco, transloco.getActiveLang(), ...)`
 * inline, each right for the render it was written in. None of them knew a second fact: a language's words load LAZILY, so for a moment
 * after a switch the active language is `de` and the words are still `en`'s. A sentence read from the new language in that window finds no
 * words and renders nothing - not even its number.
 *
 * The cure is one reader of the language (`core/active-language.ts`, which flips only once the new words are here) and one place that
 * builds a counted sentence from it (`PluralText`, and the `plural` pipe on top of it). This gate holds the code to that shape, derived
 * over every tracked source and never from a list of files:
 *
 *   (a) `pluralText(` is called only by the core plural modules, and by helpers that are not Angular classes (no `@Component`,
 *       `@Injectable`, `@Pipe`, `@Directive` in the file - a plain function handed its language as a parameter has no signal to read);
 *   (b) `langChanges$` is read only in `core/active-language.ts`, plus an entry of `LANG_CHANGES_ALLOWED` with its reason written out and
 *       a check that the entry is still true;
 *   (c) a counted sentence is never bound as HTML: `| plural` or the PluralText service's `.text(` never sits inside `[innerHTML]` or a
 *       `bypassSecurityTrust*` call. The sentence is built from a translation value and a number; a count is not markup, and a value that
 *       later carries a tag would otherwise be rendered through the sanitizer's bypass.
 *
 * Not claimed: `getActiveLang()` has many legitimate readers (a date's locale, a file size's) that are not counted sentences and are not
 * counted here; and a method that returns a sentence which another template binds as HTML is out of reach of a scan - (c) reads the
 * binding and the bypass call, not the data flow between them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';
import { componentTemplates } from './component-templates';
import { callArguments } from './call-arguments';
import { CORE_PLURAL_MODULES, pluralServiceNames } from './plural-mechanism';

/** The one module that reads `langChanges$` to answer which language the page is in. */
const ACTIVE_LANGUAGE = 'src/app/core/active-language.ts';

/** A file allowed to read `langChanges$` outside the module that owns it, with the reason. */
const LANG_CHANGES_ALLOWED: Readonly<Record<string, string>> = {
  'src/app/app.config.ts':
    'the bootstrap initializer keeps <html lang> in step with every switch: it writes a document attribute before any component exists, '
    + 'it renders no sentence, and it has no words to wait for - it is not a second reader of the page\'s language',
};

/** A file whose source declares an Angular class that can hold state or be injected. */
const declaresAngularClass = (src: string): boolean => /^\s*@(?:Component|Injectable|Pipe|Directive)\s*\(/m.test(src);

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

interface Source { file: string; src: string }
const sources = (): Source[] => trackedAppSources().map(file => ({ file, src: stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8')) }));

/** Where `pluralText(` is called in a source (its definition `function pluralText(` is not a call). */
function pluralTextCalls(src: string): number[] {
  return [...src.matchAll(/\bpluralText\(/g)].filter(m => !/\bfunction\s+$/.test(src.slice(0, m.index!))).map(m => lineOf(src, m.index!));
}

/** Where `langChanges$` is referenced in a source. */
function langChangesReads(src: string): number[] {
  return [...src.matchAll(/\blangChanges\$/g)].map(m => lineOf(src, m.index!));
}

/** The text of every `[innerHTML]="..."` binding in a template. */
function innerHtmlBindings(template: string): string[] {
  return [...template.matchAll(/\[innerHTML\]\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!);
}

/** A binding expression that builds a counted sentence: the `plural` pipe, or a call of a service's `.text(`. */
const buildsCountedSentenceInTemplate = (expression: string): boolean => /\|\s*plural\b/.test(expression) || /\.text\(/.test(expression);

/** Where a `bypassSecurityTrust*` call is handed a sentence of the PluralText service. */
function bypassOfCountedSentence(src: string): number[] {
  const names = pluralServiceNames(src);
  if (!names.length) return [];
  const callsService = new RegExp(`\\b(?:${names.join('|')})\\.text\\(`);
  return [...src.matchAll(/\bbypassSecurityTrust\w*\(/g)]
    .filter(m => callArguments(src, m.index! + m[0].length - 1).some(a => callsService.test(a)))
    .map(m => lineOf(src, m.index!));
}

describe('the page\'s language has one reader (Q-574)', () => {
  const all = sources();

  it('scans the client\'s sources, and the module that owns the language is among them', () => {
    expect(all.length, 'a floor, so a listing that came back short cannot pass by scanning nothing').toBeGreaterThan(150);
    expect(all.some(s => s.file === 'src/app/core/plural-text.ts' && /\bfunction\s+pluralText\(/.test(s.src)), 'the plural function is not where this gate expects').toBe(true);
    // The module does not exist at the base commit, and that is what this line is red for: a gate over "the one reader" that never saw it
    // would report clean about a rule whose subject is missing.
    expect(all.map(s => s.file), `${ACTIVE_LANGUAGE} must exist and be tracked (git add it): the one reader is the subject of this gate`).toContain(ACTIVE_LANGUAGE);
    expect(all.find(s => s.file === ACTIVE_LANGUAGE)?.src ?? '', 'the one reader must read langChanges$').toMatch(/\blangChanges\$/);
  });

  it('(a) pluralText( is called only by the core plural modules and by helpers that are not Angular classes', () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const { file, src } of all) {
      const calls = pluralTextCalls(src);
      sites += calls.length;
      if (!calls.length || CORE_PLURAL_MODULES.includes(file) || !declaresAngularClass(src)) continue;
      offenders.push(...calls.map(line => `${file}:${line}`));
    }
    expect(sites, 'a floor: pluralText has callers (the core module itself, at least)').toBeGreaterThan(0);
    expect(offenders, `${offenders.length} components and services build a counted sentence themselves - inject PluralText (or use the \`plural\` pipe), which reads the language whose words are loaded:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('(b) langChanges$ is read only by the module that owns the language, plus the allow-listed bootstrap entry', () => {
    const offenders: string[] = [];
    let reads = 0;
    for (const { file, src } of all) {
      const lines = langChangesReads(src);
      reads += lines.length;
      if (!lines.length || file === ACTIVE_LANGUAGE || file in LANG_CHANGES_ALLOWED) continue;
      offenders.push(...lines.map(line => `${file}:${line}`));
    }
    expect(reads, 'a floor: the bootstrap entry reads langChanges$, so a scan that finds none is broken').toBeGreaterThan(0);
    expect(offenders, `${offenders.length} private copies of the page's language - read ActiveLanguage.language() (it flips once the words are here; a private toSignal(langChanges$) flips at the request, before them):\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('every LANG_CHANGES_ALLOWED entry has its reason written and still reads langChanges$', () => {
    for (const [file, reason] of Object.entries(LANG_CHANGES_ALLOWED)) {
      expect(reason.trim().length, `${file}: an allowance needs its reason written`).toBeGreaterThan(30);
      const source = all.find(s => s.file === file);
      expect(source, `${file} is no longer a tracked source - remove its allowance`).toBeTruthy();
      expect(langChangesReads(source!.src).length, `${file} no longer reads langChanges$ - remove its allowance`).toBeGreaterThan(0);
    }
  });
});

describe('a counted sentence is never bound as HTML (Q-574, security lens S2)', () => {
  const templates = componentTemplates();

  it('finds the bindings it holds to the rule (a floor, so a changed spelling cannot pass by finding none)', () => {
    const bindings = templates.flatMap(t => innerHtmlBindings(t.text));
    expect(bindings.length).toBeGreaterThanOrEqual(10);
    const bypasses = sources().reduce((n, s) => n + [...s.src.matchAll(/\bbypassSecurityTrust\w*\(/g)].length, 0);
    expect(bypasses).toBeGreaterThanOrEqual(3);
  });

  it('no [innerHTML] binding builds its value with the plural pipe or the PluralText service', () => {
    const offenders = templates.flatMap(t => innerHtmlBindings(t.text).filter(buildsCountedSentenceInTemplate).map(b => `${t.file}:${t.startLine}  [innerHTML]="${b}"`));
    expect(offenders, `a counted sentence bound as HTML:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('no bypassSecurityTrust call is handed a sentence of the PluralText service', () => {
    const offenders = sources().flatMap(s => bypassOfCountedSentence(s.src).map(line => `${s.file}:${line}`));
    expect(offenders, `a counted sentence passed to a security bypass:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  // The detectors above are the gate. A detector that has never seen a violation is a claim, so each is shown a violation here.
  it('the detectors see what they claim to', () => {
    expect(innerHtmlBindings(`<p [innerHTML]="n | plural:'a.b'"></p><p [innerHTML]="'k' | transloco: { x: 1 }"></p>`)).toEqual([`n | plural:'a.b'`, `'k' | transloco: { x: 1 }`]);
    expect(buildsCountedSentenceInTemplate(`n | plural:'a.b'`)).toBe(true);
    expect(buildsCountedSentenceInTemplate(`plural.text('a.b', n)`)).toBe(true);
    expect(buildsCountedSentenceInTemplate(`'k' | transloco: { x: 1 }`)).toBe(false);

    const service = `class X { private readonly counted = inject(PluralText); h() { return this.sanitizer.bypassSecurityTrustHtml(this.counted.text('a.b', 2)); } }`;
    expect(bypassOfCountedSentence(service)).toEqual([1]);
    expect(bypassOfCountedSentence(`class X { constructor(private plural: PluralText) {} h() { return this.s.bypassSecurityTrustHtml(\`<b>\${this.plural.text('a', 1)}</b>\`); } }`)).toEqual([1]);
    expect(bypassOfCountedSentence(`class X { private readonly counted = inject(PluralText); h(r: Response) { return this.s.bypassSecurityTrustHtml(r.text()); } }`)).toEqual([]);

    expect(pluralTextCalls(`export function pluralText(a) {}\nconst x = pluralText(t, 'en', 'b', 1);`)).toEqual([2]);
    expect(langChangesReads(`a\nthis.t.langChanges$.subscribe()`)).toEqual([2]);
    expect(declaresAngularClass(`@Injectable({ providedIn: 'root' })\nexport class S {}`)).toBe(true);
    expect(declaresAngularClass(`export function helper() {}`)).toBe(false);
  });
});
