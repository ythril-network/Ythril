/**
 * ONE refusal formatter (bundle-23, Q-93 / F-46, R6-14) - `describeRefusal` in core/refusal-text.ts.
 *
 * ## Why this is a spec of a function and not of a screen
 *
 * Three formatters said a refusal three ways (`fmtApiError`, `refusalText`, `httpErrorReason`) and ~65 sites read
 * `err.error.error` raw. Q-93 adds seven things a refusal can now say - an introduced key, a pre-existing key, the
 * keys the type does declare, a truncated list, a rule that could not be evaluated, a record too large to check, and
 * a 412 on a schema save. Each reaches the operator through ONE function or it reaches them in the server's English.
 *
 * ## What it holds
 *
 * - Every sentence is built from a translation key that exists in en, de AND pl (a table-driven check over the keys
 *   the formatter ASKED FOR - derived by recording the translate calls, never a list of keys written here, which is
 *   the second copy that rots).
 * - A count says its plural the way the language does: `Intl.PluralRules` decides, so Polish gets its three forms
 *   (one / few / many) and not English's two. The test compares the plural CATEGORY the platform computes with the
 *   sentence that came out, for counts that land in every Polish category.
 * - A number is formatted by the reader's locale (`Intl.NumberFormat`), not `String(n)`; a list of keys by
 *   `Intl.ListFormat` (`core/list-format.ts`).
 * - A code or outcome the client has no words for still says something true (the server's reason), never a blank and
 *   never the raw code (`Q-133`, the rule `refusalText` already keeps).
 *
 * The wire shapes are fixed in E:/ythril-scratch/b23/client-contract.md (SchemaViolationError.toStructured()).
 * These specs are RED on the base because `describeRefusal` does not exist: a TypeError at the first call, which is
 * the correct red for a function that is the whole subject.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as refusal from './refusal-text';
import { formatList } from './list-format';

const I18N = resolve(__dirname, '../../../public/assets/i18n');
const LANGS = ['en', 'de', 'pl'] as const;
type Lang = (typeof LANGS)[number];
const dict: Record<Lang, Record<string, string>> = {
  en: JSON.parse(readFileSync(resolve(I18N, 'en.json'), 'utf8')),
  de: JSON.parse(readFileSync(resolve(I18N, 'de.json'), 'utf8')),
  pl: JSON.parse(readFileSync(resolve(I18N, 'pl.json'), 'utf8')),
};

/** A real translate: the shipped file, `{{ name }}` / `{{name}}` interpolated, the KEY itself when missing (as Transloco does). Records what was asked. */
function translocoFor(lang: Lang) {
  const asked: string[] = [];
  return {
    asked,
    translate: (key: string, params?: Record<string, unknown>): string => {
      asked.push(key);
      const raw = dict[lang][key];
      if (raw === undefined) return key;
      return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => String(params?.[name] ?? ''));
    },
  };
}

type Row = { field: string; value?: unknown; reason: string; declared?: string[]; outcome?: 'violated' | 'could_not_evaluate' | 'too_large' };
const undeclared = (key: string, declared = ['name', 'age', 'email']): Row =>
  ({ field: `properties.${key}`, value: 'x', reason: `property '${key}' is not declared on this type`, declared });
const ruleRow = (outcome: Row['outcome'], reason = 'Age must be positive'): Row =>
  ({ field: 'rules.age-positive', reason, outcome });
const refused = (body: Record<string, unknown>, status = 422) =>
  ({ status, error: { error: 'schema_violation', message: 'server sentence in English', introduced: [], preExisting: [], violations: [], ...body } });

/** The function under test, reached through the module namespace so its absence is a failed expectation naming it. */
function describe_(lang: Lang, err: unknown, fallbackKey = 'data.migrate.requestFailed') {
  const fn = (refusal as Record<string, unknown>)['describeRefusal'];
  expect(typeof fn, 'core/refusal-text.ts must export describeRefusal(transloco, language, err, fallbackKey?)').toBe('function');
  const t = translocoFor(lang);
  const view = (fn as (...a: unknown[]) => { text: string; rows: { field: string; text: string; kind: string; outcome: string }[]; reload: boolean })(t, lang, err, fallbackKey);
  return { view, asked: t.asked };
}

/** The sentence with every number and its grouping stripped, so two counts of the same plural form compare equal. */
const shape = (s: string): string => s.replace(/\d[\d\s.,\u00a0\u202f]*/g, '#');

describe('describeRefusal - what each kind of refusal says', () => {
  for (const lang of LANGS) {
    describe(lang, () => {
      it('an introduced undeclared key is a row of its own: the key, and the keys the type DOES declare, as a list in this language', () => {
        const { view } = describe_(lang, refused({ introduced: [undeclared('legacyFlag')] }));
        expect(view.rows).toHaveLength(1);
        expect(view.rows[0]).toMatchObject({ field: 'properties.legacyFlag', kind: 'introduced', outcome: 'undeclared' });
        expect(view.rows[0]!.text).toContain('legacyFlag');
        expect(view.rows[0]!.text, 'the declared keys are part of the answer, listed by Intl.ListFormat').toContain(formatList(['name', 'age', 'email'], lang));
      });

      it('a pre-existing row is marked so, and is not an introduced one', () => {
        const { view } = describe_(lang, refused({ introduced: [undeclared('fresh')], preExisting: [undeclared('old')] }));
        expect(view.rows.map(r => [r.field, r.kind])).toEqual([
          ['properties.fresh', 'introduced'],
          ['properties.old', 'preExisting'],
        ]);
        expect(shape(view.rows[0]!.text), 'introduced and pre-existing are told apart in words, not only in a field').not.toBe(shape(view.rows[1]!.text).replace('old', 'fresh'));
      });

      it('the three rule outcomes are three different sentences, none of them the raw code or the raw rules.<name> field', () => {
        const texts = (['violated', 'could_not_evaluate', 'too_large'] as const).map(o =>
          describe_(lang, refused({ introduced: [ruleRow(o)] })).view.rows[0]!);
        expect(new Set(texts.map(r => r.text)).size, 'violated / could not evaluate / too large must read differently').toBe(3);
        expect(texts.map(r => r.outcome)).toEqual(['violated', 'could_not_evaluate', 'too_large']);
        for (const r of texts) {
          expect(r.text).not.toMatch(/could_not_evaluate|too_large/);
          expect(r.text, 'the editor shows the rule MESSAGE, not the name of the rule row').not.toContain('rules.age-positive');
        }
        expect(texts[0]!.text, 'a violated rule says its own message').toContain('Age must be positive');
      });

      it('a number is formatted for the reader, not String(n)', () => {
        const { view } = describe_(lang, refused({ introduced: [undeclared('k')], truncated: 1234 }));
        expect(view.text).toContain(new Intl.NumberFormat(lang).format(1234));
      });

      it('an outcome this client has no words for says the server\'s reason - never blank, never the raw code', () => {
        const row = { field: 'rules.r', reason: 'The server explains.', outcome: 'some_future_outcome' } as unknown as Row;
        const { view } = describe_(lang, refused({ introduced: [row] }));
        expect(view.rows[0]!.text).toContain('The server explains.');
        expect(view.rows[0]!.text).not.toContain('some_future_outcome');
      });

      it('a 412 on a schema save says someone changed the schema and offers a reload; no other answer does', () => {
        const { view } = describe_(lang, { status: 412, error: { error: 'Precondition Failed' } });
        expect(view.reload).toBe(true);
        expect(view.text.length).toBeGreaterThan(0);
        expect(view.text, 'translated, not the server\'s English').not.toBe('Precondition Failed');
        expect(describe_(lang, refused({ introduced: [undeclared('k')] })).view.reload).toBe(false);
        expect(describe_(lang, { status: 409, error: { error: 'conflict' } }).view.reload).toBe(false);
      });

      it('a server fault carries its request id, a refusal the caller caused does not (the rule refusalText already keeps)', () => {
        const headers = { get: (n: string) => (n === 'X-Request-Id' ? 'req-9' : null) };
        expect(describe_(lang, { status: 500, headers, error: { error: 'boom' } }).view.text).toContain('req-9');
        expect(describe_(lang, { ...refused({ introduced: [undeclared('k')] }), headers }).view.text).not.toContain('req-9');
      });

      it('an answer with nothing in it says the fallback key\'s sentence', () => {
        const { view } = describe_(lang, { error: null }, 'data.migrate.requestFailed');
        expect(view.text).toBe(dict[lang]['data.migrate.requestFailed']);
      });
    });
  }
});

describe('describeRefusal - counts say their plural the way the language does', () => {
  // 0,1,2,5,22,25,100 land in every Polish category (one, few, many) and both English / German ones.
  const COUNTS = [0, 1, 2, 5, 22, 25, 100];
  for (const lang of LANGS) {
    it(`${lang}: the truncated-rows sentence changes exactly when Intl.PluralRules changes category`, () => {
      const rules = new Intl.PluralRules(lang);
      const said = COUNTS.map(n => ({
        n,
        category: rules.select(n),
        sentence: shape(describe_(lang, refused({ introduced: [undeclared('k')], truncated: n })).view.text),
      }));
      for (const a of said) for (const b of said) {
        expect(a.sentence === b.sentence, `${lang}: ${a.n} (${a.category}) vs ${b.n} (${b.category})`).toBe(a.category === b.category);
      }
      // Polish has three forms across these counts; the point of the table is that the PLATFORM decides.
      if (lang === 'pl') expect(new Set(said.map(s => s.category)).size).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('describeRefusal - every runtime key it builds exists', () => {
  /*
   * The i18n-key-coverage spec matches STATIC keys only and says so: a key built at runtime ('x.' + kind) escapes it.
   * This formatter is exactly that case - it builds keys from a code, an outcome and a plural category - so the table
   * below drives every case through a recording translate and holds each key it asked for to the three shipped files.
   */
  const CASES: [string, unknown][] = [
    ['introduced undeclared', refused({ introduced: [undeclared('a')] })],
    ['pre-existing undeclared', refused({ preExisting: [undeclared('a')] })],
    ['truncated 1', refused({ introduced: [undeclared('a')], truncated: 1 })],
    ['truncated 3', refused({ introduced: [undeclared('a')], truncated: 3 })],
    ['truncated 12', refused({ introduced: [undeclared('a')], truncated: 12 })],
    ['rule violated', refused({ introduced: [ruleRow('violated')] })],
    ['rule could not evaluate', refused({ introduced: [ruleRow('could_not_evaluate')] })],
    ['rule too large', refused({ introduced: [ruleRow('too_large')] })],
    ['space rule', refused({ introduced: [{ field: 'meta.rules.r', reason: 'No.', outcome: 'violated' }] })],
    ['412', { status: 412, error: { error: 'Precondition Failed' } }],
  ];

  it('the table covers enough kinds to mean something (floor)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(8);
  });

  for (const lang of LANGS) {
    it(`${lang}: every key the formatter asked for is a key of en.json, de.json and pl.json`, () => {
      const asked = new Set<string>();
      for (const [, err] of CASES) for (const k of describe_(lang, err).asked) asked.add(k);
      // The fallback key is the CALLER's; every other key is the formatter's own.
      asked.delete('data.migrate.requestFailed');
      expect(asked.size, 'the formatter asked for no translation key at all - it said everything in server English').toBeGreaterThanOrEqual(6);
      const missing = [...asked].flatMap(k => LANGS.filter(l => !(k in dict[l])).map(l => `${l}: ${k}`));
      expect(missing, 'keys the formatter builds that a shipped locale does not have').toEqual([]);
    });

    it(`${lang}: a plural family is complete for the categories ${lang} uses`, () => {
      const need = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
      const asked = new Set<string>();
      for (const n of [0, 1, 2, 5, 22, 25]) {
        for (const k of describe_(lang, refused({ introduced: [undeclared('a')], truncated: n })).asked) asked.add(k);
      }
      const bases = new Set([...asked].filter(k => /\.(zero|one|two|few|many|other)$/.test(k)).map(k => k.replace(/\.[a-z]+$/, '')));
      expect(bases.size, 'no plural-suffixed key was asked for: the count is not pluralised through Intl.PluralRules').toBeGreaterThanOrEqual(1);
      const missing = [...bases].flatMap(b => need.filter(c => !(`${b}.${c}` in dict[lang])).map(c => `${b}.${c}`));
      expect(missing).toEqual([]);
    });
  }
});
