/**
 * The words and the icon bundle-268 (Q-744, a type's history) adds exist, and the words of the type-row pills it removes are gone
 * (design r4 §7.1, §7.2, §7.8, test C6).
 *
 * `i18n-key-coverage.spec.ts` derives its keys from what the SOURCE uses, so it cannot see a key the components have not been written
 * to use yet, and it never sees a key that is left behind when its last user goes. This spec is the derivation from the other end:
 * the keys of design r4's word table, named below, checked in en, de and pl; the four pill keys checked absent; and the one new icon
 * checked registered in `ph-icon.component.ts`, where `icon-registry-coverage.test.js` only checks the icons a template names.
 *
 * ## The rules
 *
 * - every key of r4 §7.8 exists, non-empty, in `en`, `de` and `pl`;
 * - de and pl interpolate exactly the parameters en does, and neither is the English sentence copied across;
 * - no value under the new keys carries a digit: r4 §7.8 says none is counted, so a digit in a value is a count that came back;
 * - `spaces.schema.badge.library`, `.pattern`, `.ttl` and `rules.countTitle` are gone from every locale (r4 §7.1: the pills' only users);
 * - `clock-counter-clockwise` is a key of the icon registry, with path data (r4 §7.2).
 *
 * ## Seen red
 *
 * Red on 327b105e: none of the new keys exists, the four pill keys are present, and the icon is not registered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dictionary, LOCALES } from './i18n-dictionary';
import { stripComments } from './strip-comments';

/** Design r4 §7.8, one key per row cell; the `a / b` rows are spelled out. */
export const B268_KEYS = [
  'spaces.schema.history.button', 'spaces.schema.history.title', 'spaces.schema.history.helpAria',
  'spaces.schema.history.help.keeps', 'spaces.schema.history.help.origin', 'spaces.schema.history.help.cannotTell',
  'spaces.schema.history.help.mark', 'spaces.schema.history.help.undeclared',
  'spaces.schema.history.notInSchema', 'spaces.schema.history.oneDefinition',
  'spaces.schema.history.currentSince', 'spaces.schema.history.current',
  'spaces.schema.history.span', 'spaces.schema.history.spanFrom',
  'spaces.schema.history.origin.edited', 'spaces.schema.history.origin.layer', 'spaces.schema.history.origin.fetched',
  'spaces.schema.history.whatChanged', 'spaces.schema.history.thisDefinition', 'spaces.schema.history.currentColumn',
  'spaces.schema.history.unread', 'spaces.schema.history.openRecords', 'spaces.schema.history.openRecordsAria',
  'spaces.schema.history.openOlder', 'spaces.schema.history.cut', 'spaces.schema.history.loading',
  'spaces.schema.history.failed', 'spaces.schema.history.readAgain',
  'spaces.schema.history.listAria', 'spaces.schema.history.closeAria',
  'spaces.schema.history.wholeDefinition', 'spaces.schema.history.facet.required',
  'spaces.schema.history.facet.pattern', 'spaces.schema.history.facet.not',
  'common.reason.noAnswer', 'common.reason.busy', 'common.reason.indexBuilding',
  'spaces.schema.list.olderMark', 'spaces.schema.list.olderMarkSr', 'spaces.schema.list.notDefinedHere',
  'spaces.schema.other.layer', 'spaces.schema.other.none', 'spaces.schema.other.helpAria',
  'spaces.schema.other.help.layer', 'spaces.schema.other.help.none', 'spaces.schema.other.help.history',
  'brain.drawer.typeDefinition.label', 'brain.drawer.typeDefinition.current', 'brain.drawer.typeDefinition.older',
  'brain.drawer.typeDefinition.compare', 'brain.drawer.typeDefinition.none', 'brain.drawer.typeDefinition.cannotTell',
  'brain.drawer.typeDefinition.checking', 'brain.drawer.typeDefinition.failed', 'brain.drawer.typeDefinition.checkAgain',
  'brain.drawer.typeDefinition.helpAria', 'brain.drawer.typeDefinition.help.current', 'brain.drawer.typeDefinition.help.older',
  'brain.drawer.typeDefinition.help.none', 'brain.drawer.typeDefinition.help.cannotTell',
  'brain.filter.typeDefinitionOlder', 'brain.filter.typeDefinitionSpan', 'brain.filter.historyOf',
  'brain.filter.cannotFilterByDefinition', 'brain.filter.typeChip', 'brain.filter.relationChip',
  'spaces.schema.history.unsupported',
  'brain.filter.removeTypeAria', 'brain.filter.removeRelationAria', 'brain.filter.removeDefinitionAria',
  'brain.list.typeDefinitionColumn',
] as const;

/** The parameters r4 §7.8 gives a key, where it gives any. A value that drops one cannot say what the table says. */
const PARAMS: Record<string, string[]> = {
  'spaces.schema.history.title': ['type'],
  'spaces.schema.history.oneDefinition': ['since'],
  'spaces.schema.history.currentSince': ['since'],
  'spaces.schema.history.span': ['since', 'until'],
  'spaces.schema.history.spanFrom': ['since'],
  'spaces.schema.history.origin.layer': ['name'],
  'spaces.schema.history.unread': ['place'],
  'spaces.schema.history.openRecordsAria': ['span'],
  'spaces.schema.history.failed': ['reason'],
  'spaces.schema.history.listAria': ['type'],
  'spaces.schema.history.facet.pattern': ['value'],
  'spaces.schema.history.facet.not': ['facet'],
  'spaces.schema.other.layer': ['name'],
  'brain.drawer.typeDefinition.older': ['since'],
  'brain.drawer.typeDefinition.failed': ['reason'],
  'brain.filter.typeDefinitionSpan': ['span'],
  'brain.filter.historyOf': ['type'],
  'brain.filter.typeChip': ['name'],
  'brain.filter.relationChip': ['name'],
};

/** The pills' words (r4 §7.1, P54). Each had one user, the removed `sch-type-badges` block. */
const REMOVED_KEYS = ['spaces.schema.badge.library', 'spaces.schema.badge.pattern', 'spaces.schema.badge.ttl', 'rules.countTitle'];

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]!).sort();

describe('the words of bundle-268 exist in en, de and pl (C6)', () => {
  it('every key of the word table is present and non-empty in every locale', () => {
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const words = dictionary(locale);
      for (const key of B268_KEYS) if (!words[key] || !String(words[key]).trim()) missing.push(`${locale}: ${key}`);
    }
    expect(missing).toEqual([]);
  });

  it('each key carries the parameters the table gives it, de and pl the same as en, and neither is the English copied across', () => {
    const en = dictionary('en');
    const problems: string[] = [];
    for (const key of B268_KEYS) {
      if (en[key] === undefined) { problems.push(`en: ${key} is missing`); continue; }
      const want = (PARAMS[key] ?? []).slice().sort();
      if (placeholders(String(en[key])).join() !== want.join()) problems.push(`en: ${key} has {{${placeholders(String(en[key]))}}}, the table says {{${want}}}`);
      for (const locale of ['de', 'pl']) {
        const t = dictionary(locale)[key];
        if (t === undefined) { problems.push(`${locale}: ${key} is missing`); continue; }
        if (placeholders(String(t)).join() !== placeholders(String(en[key])).join()) problems.push(`${locale}: ${key} placeholders differ from en`);
        if (String(t) === String(en[key]) && /[a-z]{4,}/i.test(String(en[key]).replace(/\{\{[^}]*\}\}/g, ''))) problems.push(`${locale}: ${key} is the English sentence`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no value under the new keys holds a digit: none of them is counted', () => {
    const counted: string[] = [];
    for (const locale of LOCALES) {
      const words = dictionary(locale);
      for (const key of B268_KEYS) {
        const v = words[key];
        if (v !== undefined && /\d/.test(String(v).replace(/\{\{[^}]*\}\}/g, ''))) counted.push(`${locale}: ${key} = ${v}`);
      }
    }
    // A floor, so a table that matched nothing cannot pass by finding no digit.
    expect(Object.keys(dictionary('en')).filter(k => (B268_KEYS as readonly string[]).includes(k)).length).toBe(B268_KEYS.length);
    expect(counted).toEqual([]);
  });
});

describe('the type-row pills leave no words behind (C6, r4 §7.1)', () => {
  it('the library, pattern and retention badge keys and the rules count title are gone from every locale', () => {
    const left: string[] = [];
    for (const locale of LOCALES) {
      const words = dictionary(locale);
      for (const key of REMOVED_KEYS) for (const k of Object.keys(words)) if (k === key || k.startsWith(`${key}.`)) left.push(`${locale}: ${k}`);
    }
    expect(left).toEqual([]);
  });
});

describe('the history icon is registered (C6, r4 §7.2)', () => {
  it('clock-counter-clockwise is a key of the icon registry and carries path data', () => {
    const src = stripComments(readFileSync(resolve(__dirname, '../shared/ph-icon.component.ts'), 'utf8'));
    const body = src.slice(src.indexOf('const ICONS'));
    const names = new Set([...body.matchAll(/^\s*'([a-z0-9-]+)':/gm)].map(m => m[1]));
    // A floor: a registry this regex no longer reads would otherwise report every icon missing for the wrong reason.
    expect(names.has('trash'), 'the registry scan read nothing').toBe(true);
    expect(names.has('clock-counter-clockwise'), 'clock-counter-clockwise is not registered').toBe(true);
    const entry = body.match(/^\s*'clock-counter-clockwise':\s*'([^']*)'/m)?.[1] ?? '';
    expect(entry).toMatch(/<path d="M[^"]+"/);
  });
});
