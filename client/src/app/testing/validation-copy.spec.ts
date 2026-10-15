/**
 * The words the Schema tab uses for what validation does (bundle-23, Q-93 / F-46, R6-14 "Copy" and "i18n").
 *
 * ## What was wrong, and why a spec reads it
 *
 * - **The Warn label promised a log.** `spaces.settings.validation.warn` said "Warn - log violations only" in all
 *   three languages; the server RETURNS the violations on the write's answer (`warnings`), it logs none of them for
 *   the caller. A label that describes a behaviour the product does not have is the stale-sentence defect CLAUDE.md
 *   describes, in the one place an operator picks the mode.
 * - **Two key families said the same three modes** (`spaces.create.validation.*` in the create dialog,
 *   `spaces.settings.validation.*` in the Schema tab), so the two drifted. There is ONE family now; the spec derives
 *   the key each `<option value="warn|strict|off">` uses from the templates and requires one key per mode.
 * - **Strict said "reject violations"** and nothing of what it now refuses: a property the type does not declare, and
 *   a rule that is not satisfied.
 * - **`spaces.schema.validation.{strict,warn,off}` are dead** (no template reads them). ONLY those three go; their
 *   neighbours (`label`, `sectionTitle`, `appliesHint`, `hint`) are live - the vet's first reading ("the family is
 *   dead") would have deleted four live keys and raw keys would have shown on the Schema tab.
 * - **`.sch-msg.warn` and `.sch-msg.error` had no CSS** (the class in use is `err`/`warn`; only `err`, `ok`, `info`
 *   were styled) and there is no forced-colors rule, so a message distinguished by colour alone vanished in
 *   high-contrast mode.
 * - **Badges and the property summary were English literals** in a three-language app (`Library`, `pat`, `ttl`,
 *   `enum 3`, `min:`, `max:`, `default:`, `any`).
 *
 * Every set below is DERIVED (templates scanned, keys read from the shipped files) and carries a floor.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackedAppSources, CLIENT_ROOT } from './tracked-sources';
import { stripComments } from './strip-comments';
import { propertyLiterals, readClientSource } from './server-source';

const I18N = resolve(CLIENT_ROOT, 'public/assets/i18n');
const LANGS = ['en', 'de', 'pl'] as const;
const dict = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(resolve(I18N, `${l}.json`), 'utf8')) as Record<string, string>])) as Record<(typeof LANGS)[number], Record<string, string>>;
const read = (rel: string): string => stripComments(readFileSync(resolve(CLIENT_ROOT, rel), 'utf8'));
const sources = (): { file: string; text: string }[] => trackedAppSources().map(file => ({ file, text: read(file) }));

/**
 * mode -> the set of translation keys its option uses, over every select that offers ALL THREE validation modes.
 * (A bare value="off" also labels media levels and embedding switches; only a select with off + warn + strict is the
 * validation-mode picker.)
 */
function optionKeysByMode(): Record<string, Map<string, string[]>> {
  const out: Record<string, Map<string, string[]>> = { off: new Map(), warn: new Map(), strict: new Map() };
  for (const { file, text } of sources()) {
    for (const sel of text.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g)) {
      const opts = [...sel[1]!.matchAll(/<option\s+value="(off|warn|strict)"[^>]*>\s*\{\{\s*'([^']+)'\s*\|\s*transloco/g)];
      if (new Set(opts.map(o => o[1])).size < 3) continue;
      for (const o of opts) {
        const bucket = out[o[1]!]!;
        bucket.set(o[2]!, [...(bucket.get(o[2]!) ?? []), file]);
      }
    }
  }
  return out;
}

describe('validation modes: one key family, and it says what the modes do', () => {
  it('every mode has option sites in at least two templates (floor) and they all use ONE key', () => {
    const byMode = optionKeysByMode();
    for (const [mode, keys] of Object.entries(byMode)) {
      const sites = [...keys.values()].reduce((n, f) => n + f.length, 0);
      expect(sites, `fewer than two <option value="${mode}"> sites found - the scan is blind, not the app consistent`).toBeGreaterThanOrEqual(2);
      expect([...keys.keys()], `the "${mode}" option is labelled by ${keys.size} different keys: ${[...keys.entries()].map(([k, f]) => `${k} (${f.join(', ')})`).join('; ')}`).toHaveLength(1);
    }
  });

  it('only spaces.schema.validation.{strict,warn,off} are removed - the live neighbours stay and are read by a template', () => {
    const all = sources().map(s => s.text).join('\n');
    for (const l of LANGS) {
      for (const dead of ['strict', 'warn', 'off']) {
        expect(`spaces.schema.validation.${dead}` in dict[l], `${l}.json still carries the dead key spaces.schema.validation.${dead}`).toBe(false);
      }
    }
    // The family's remaining keys are DERIVED from en.json, so a key added next year is held to the same rule.
    const live = Object.keys(dict.en).filter(k => k.startsWith('spaces.schema.validation.'));
    expect(live.length, 'the live neighbours (label, sectionTitle, appliesHint, hint) were deleted with the dead three').toBeGreaterThanOrEqual(4);
    for (const k of live) {
      expect(all.includes(`'${k}'`), `${k} is in en.json and no template reads it`).toBe(true);
      for (const l of LANGS) expect(k in dict[l], `${l}.json lacks ${k}`).toBe(true);
    }
  });

  /** EVERY key a mode's option is labelled by (today two families; after the change one) - each is held to the words. */
  const keysOf = (mode: string): string[] => {
    const keys = [...optionKeysByMode()[mode]!.keys()];
    expect(keys.length, 'no <option value="' + mode + '"> found').toBeGreaterThan(0);
    return keys;
  };

  it('Warn says the violations are RETURNED, not logged, in every language', () => {
    for (const k of keysOf('warn')) {
      expect(dict.en[k], k).toMatch(/returned/i);
      expect(dict.en[k], 'the old promise: nothing is logged for the caller').not.toMatch(/\blog/i);
      expect(dict.de[k], k).toMatch(/zur(ü|ue)ckgegeben|zur(ü|ue)ckgeliefert|zur(ü|ue)ckgemeldet|geliefert/i);
      expect(dict.de[k]).not.toMatch(/protokoll/i);
      expect(dict.pl[k], k).toMatch(/zwr[aó]c/i);
      expect(dict.pl[k]).not.toMatch(/rejestruj/i);
    }
  });

  it('Strict names what it refuses now: an undeclared property and an unsatisfied rule, in every language', () => {
    for (const k of keysOf('strict')) {
      expect(dict.en[k], k).toMatch(/undeclared|not declared/i);
      expect(dict.en[k], k).toMatch(/\brules?\b/i);
      expect(dict.de[k], k).toMatch(/nicht deklarierte|undeklarierte|nicht deklariert/i);
      expect(dict.de[k], k).toMatch(/regel/i);
      expect(dict.pl[k], k).toMatch(/niezadeklarowan|nie zadeklarowan|nieznan/i);
      expect(dict.pl[k], k).toMatch(/regu/i);
    }
  });
});

describe('the message variants of the schema editor are styled, and survive forced colours', () => {
  const css = read('src/app/pages/settings/schema-styles.ts');

  it('every .sch-msg variant a template uses has a rule (derived from the templates, floor 3)', () => {
    const used = new Set<string>();
    for (const { text } of sources()) for (const m of text.matchAll(/class="sch-msg\s+([a-z-]+)"/g)) used.add(m[1]!);
    expect(used.size, 'the scan found fewer than three variants - it is not reading the templates').toBeGreaterThanOrEqual(3);
    const unstyled = [...used].filter(v => !new RegExp(`\\.sch-msg\\.${v}\\b`).test(css));
    expect(unstyled, 'sch-msg variants used in a template with no CSS rule in schema-styles.ts').toEqual([]);
  });

  it('warn is one of them (the rule-refusal and no-backfill notices use it)', () => {
    expect(css).toMatch(/\.sch-msg\.warn\b/);
  });

  it('a forced-colors rule covers .sch-msg, so a message told apart by colour alone is not lost', () => {
    const block = /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{([\s\S]*?)\}\s*\}?/.exec(css);
    expect(block, 'schema-styles.ts has no @media (forced-colors: active) rule').not.toBeNull();
    expect(block![0]).toMatch(/\.sch-msg/);
  });
});

describe('the schema components carry no hard-coded English (badges, summaries, option text)', () => {
  /** The components that draw the Schema tab; derived from the files that import schema-styles or are named schema-*. */
  const FILES = (): string[] => trackedAppSources().filter(f => /(schema-type-editor|schema-type-name|space-schema-tab|space-schema-layers|prop-schema-table|schema-rules)\.component\.ts$/.test(f));

  /** The text nodes and literal user-facing attributes of every inline template, with interpolations removed. */
  function literals(file: string): string[] {
    const tpl = /template:\s*`([\s\S]*?)`/.exec(read(file))?.[1] ?? '';
    const noInterp = tpl.replace(/\{\{[\s\S]*?\}\}/g, ' ');
    const out: string[] = [];
    for (const m of noInterp.matchAll(/>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) out.push(m[1]!.trim());
    for (const m of noInterp.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) out.push(m[1]!.trim());
    return out.filter(Boolean);
  }

  it('finds the schema components (floor)', () => {
    expect(FILES().length).toBeGreaterThanOrEqual(4);
  });

  it('no template of them holds an English word the translation files do not own', () => {
    // The property TYPE names are identifiers of the wire format, derived from the PropertySchema.type union - not prose.
    const typeNames = propertyLiterals(readClientSource('src/app/core/api.types.ts'), 'PropertySchema', 'type');
    expect(typeNames.length, 'could not read the PropertySchema.type members').toBeGreaterThanOrEqual(3);
    const offenders = FILES().flatMap(f => literals(f).filter(l => !typeNames.includes(l)).map(l => `${f}: "${l}"`));
    expect(offenders, 'English literals in the Schema tab templates (Library, pat, ttl, enum, min:, max:, default:, any ...)').toEqual([]);
  });
});
