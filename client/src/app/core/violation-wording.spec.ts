/**
 * What a schema violation says to this user (bundle-285, Q-943): `violationWording` turns a violation row into a sentence in the reader's
 * language from its `code` and `params`, and answers the server's own `reason` whenever it cannot (a code it does not know, a row without one,
 * params that do not fit the code's shape, a sentence a locale lacks). Every screen that shows a violation asks it, so the fallback is here.
 *
 * Fed the shipped dictionaries, not stand-ins: a word missing from a locale is a red row here, never a raw key on the page.
 */
import { describe, expect, it } from 'vitest';
import { dictionary, LOCALES, type Locale } from '../testing/i18n-dictionary';
import { VIOLATION_LIST_SHOWN, VIOLATION_PARAMS, VIOLATION_TEXT_MAX, violationWording } from './violation-wording';

/** A real translate over the shipped file: `{{name}}` interpolated, the key itself when missing (as Transloco does). */
function translatorFor(locale: Locale) {
  const dict = dictionary(locale);
  return {
    translate: (key: string, params: Record<string, unknown> = {}): string => {
      const raw = dict[key];
      if (raw === undefined) return key;
      return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => String(params[name] ?? ''));
    },
    getActiveLang: () => locale,
  };
}

const en = translatorFor('en');
const de = translatorFor('de');
const pl = translatorFor('pl');

/** One row per code, as the server raises it: the code, its params, and the English `reason` it wrote. */
const SAMPLES: Record<string, { params: Record<string, unknown>; reason: string }> = {
  type_not_allowed: { params: { allowlist: 'entityTypes', allowedValues: ['person', 'company'] }, reason: 'not in entityTypes allowlist: person, company' },
  ref_unresolved: { params: { entry: 'contact' }, reason: "schema library entry 'contact' not found — update or remove this $ref" },
  naming_pattern: { params: { type: 'person', pattern: '^[A-Z]' }, reason: "does not match naming pattern for type 'person': ^[A-Z]" },
  naming_pattern_not_evaluated: { params: { type: 'person', pattern: '(a+)+' }, reason: "naming pattern for type 'person' not evaluated, so nothing was checked: (a+)+" },
  endpoint_type: { params: { label: 'works-at', end: 'to', allowedValues: ['company'] }, reason: "'works-at' declares its to endpoint as one of: company" },
  functional: { params: { label: 'born-in', count: 2 }, reason: "'born-in' is declared functional: one subject may have at most one. 2 other edge(s) with this label already start here" },
  required: { params: { missingProperty: 'text' }, reason: "required property 'text' is missing or empty" },
  additional_properties: { params: { additionalProperty: 'nickname' }, reason: "property 'nickname' is not declared on this type" },
  type: { params: { type: 'number', got: 'string' }, reason: "expected type 'number', got 'string'" },
  enum: { params: { allowedValues: ['open', 'closed'] }, reason: 'must be one of: open, closed' },
  minimum: { params: { comparison: '>=', limit: 1000 }, reason: 'must be >= 1000' },
  maximum: { params: { comparison: '<=', limit: 5 }, reason: 'must be <= 5' },
  pattern: { params: { pattern: '^\\S+@\\S+$' }, reason: 'does not match pattern: ^\\S+@\\S+$' },
  pattern_not_evaluated: { params: { pattern: '(a+)+' }, reason: 'pattern not evaluated, so nothing was checked: (a+)+' },
  rule: { params: { rule: 'adult', message: 'Age must be 18 or more', hash: 'a1b2c3' }, reason: 'Age must be 18 or more (rule a1b2c3)' },
  rule_not_evaluated: { params: { rule: 'adult', message: 'Age must be 18 or more', hash: 'a1b2c3', cause: 'type_mismatch' }, reason: 'Age must be 18 or more — could not be evaluated on this record (a value of a type the rule does not compare) (rule a1b2c3)' },
  rule_too_large: { params: { rule: 'adult', message: 'Age must be 18 or more', hash: 'a1b2c3', path: 'notes', bound: 'characters', limit: 4096 }, reason: 'Age must be 18 or more — too large to check: self.notes is longer than 4096 characters (rule a1b2c3)' },
  link_target_removed: { params: { entityId: 'e-1' }, reason: "link_target_removed: the entity 'e-1' was deleted while this record was written, so the link to it was not kept; the record itself is written." },
  reference_not_found: { params: { refField: 'to', refKind: 'entity', space: 'customers', ids: ['e-1', 'e-2'] }, reason: "`to` references 2 entity IDs that do not exist in space 'customers': \"e-1\", \"e-2\". Create the record first, then link it — the write was refused rather than stored with a dead link." },
  conversion_error: { params: { errorKind: 'TypeError' }, reason: 'TypeError' },
};

const row = (code: string, over: Partial<{ params: unknown; reason: string }> = {}) =>
  ({ field: 'properties.age', reason: over.reason ?? SAMPLES[code]!.reason, code, params: 'params' in over ? over.params : SAMPLES[code]!.params });

describe('violationWording: every code is worded in every language', () => {
  it('the samples cover every code the client has words for (a code added to the table without a sample fails here)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(VIOLATION_PARAMS).sort());
  });

  for (const locale of LOCALES) {
    const t = translatorFor(locale);
    it.each(Object.keys(SAMPLES))(`${locale}: %s is a sentence of this language, not the server's English, a raw key or a code name`, code => {
      const w = violationWording(t, locale, row(code));
      expect(w.key, `${locale} ${code}`).not.toBeNull();
      expect(w.text).not.toBe('');
      expect(w.text).not.toContain('{{');
      expect(w.text).not.toMatch(/\bviolation\.[a-z]/);
      expect(w.text).not.toContain(code.includes('_') ? code : `'${code}'`);
      expect(w.text).not.toMatch(/\b(?:entityTypes|edgeLabels|memoryTypes|chronoTypes|engine_unavailable|type_mismatch|evaluation_error|not_boolean)\b/);
      expect(w.serverText).toBe(SAMPLES[code]!.reason);
      if (code !== 'rule' && code !== 'conversion_error') expect(w.text).not.toBe(SAMPLES[code]!.reason);
    });
  }
});

describe('violationWording: the sentences, as the drawing words them', () => {
  it('a declared type and the type found are named in the language, never as English type names', () => {
    expect(violationWording(en, 'en', row('type')).text).toBe('must be a number, not text');
    expect(violationWording(de, 'de', row('type')).text).toBe('muss eine Zahl sein (ist ein Text)');
    expect(violationWording(pl, 'pl', row('type')).text).toBe('musi być liczbą (jest tekstem)');
    expect(violationWording(en, 'en', row('type', { params: { type: 'date', got: 'object' } })).text).toBe('must be a date, not a list or an object');
  });

  it('a missing required property reads as drawn', () => {
    expect(violationWording(en, 'en', row('required')).text).toBe('required, missing');
    expect(violationWording(de, 'de', row('required')).text).toBe('erforderlich, fehlt');
    expect(violationWording(pl, 'pl', row('required')).text).toBe('wymagane, brak');
  });

  it('a limit is a number formatted for the reader', () => {
    expect(violationWording(en, 'en', row('minimum')).text).toBe('must be at least 1,000');
    expect(violationWording(de, 'de', row('minimum')).text).toBe('muss mindestens 1.000 sein');
    expect(violationWording(en, 'en', row('maximum')).text).toBe('must be at most 5');
  });

  it('a list is joined the way the language joins one', () => {
    const values = { allowedValues: ['open', 'closed', 'pending'] };
    expect(violationWording(en, 'en', row('enum', { params: values })).text).toBe('not an allowed value (allowed: open, closed, and pending)');
    expect(violationWording(de, 'de', row('enum', { params: values })).text).toBe('kein zulässiger Wert (zulässig: open, closed und pending)');
    expect(violationWording(pl, 'pl', row('enum', { params: values })).text).toBe('niedozwolona wartość (dozwolone: open, closed i pending)');
  });

  it(`a long list names the first ${VIOLATION_LIST_SHOWN} and counts the rest, the server's cut marker included`, () => {
    const names = Array.from({ length: 50 }, (_, i) => `v${i + 1}`);
    const cut = { allowedValues: [...names, '…(+12 more)'] };
    const rest = 50 - VIOLATION_LIST_SHOWN + 12;
    const shown = names.slice(0, VIOLATION_LIST_SHOWN).join(', ');
    expect(violationWording(en, 'en', row('enum', { params: cut })).text).toBe(`not an allowed value (allowed: ${shown}, and ${rest} more)`);
    expect(violationWording(de, 'de', row('enum', { params: cut })).text).toContain(`${rest} weitere`);
    expect(violationWording(pl, 'pl', row('enum', { params: cut })).text).toContain(`jeszcze ${rest}`);
    expect(violationWording(en, 'en', row('enum', { params: cut })).text).not.toContain('…(+');
  });

  it('a count of references counts what the server cut too, in the plural the language uses', () => {
    const ids = { refField: 'to', refKind: 'entity', space: 'customers', ids: ['e-1', '…(+3 more)'] };
    expect(violationWording(en, 'en', row('reference_not_found', { params: ids })).text).toBe("names 4 records that are not in space 'customers': e-1 and 3 more");
    const one = { ...ids, ids: ['e-1'] };
    expect(violationWording(en, 'en', row('reference_not_found', { params: one })).text).toBe("names 1 record that is not in space 'customers': e-1");
  });

  it('a counted sentence takes the form the language needs for the number', () => {
    const at = (t: typeof en, lang: string, count: number) => violationWording(t, lang, row('functional', { params: { label: 'born-in', count } })).text;
    expect(at(en, 'en', 1)).not.toBe(at(en, 'en', 2).replace('2', '1'));
    expect(at(pl, 'pl', 2).replace('2', '#')).not.toBe(at(pl, 'pl', 5).replace('5', '#'));
    expect(at(pl, 'pl', 5)).toContain('5');
  });

  it('the cause of a rule that could not judge the record and the cap a value is over are words, never their codes', () => {
    expect(violationWording(en, 'en', row('rule_not_evaluated')).text).toBe('Age must be 18 or more (could not be checked on this record: a value has a type the rule cannot compare)');
    expect(violationWording(en, 'en', row('rule_too_large')).text).toBe('Age must be 18 or more (too large to check: self.notes is longer than 4,096 characters)');
    expect(violationWording(en, 'en', row('rule_too_large', { params: { ...SAMPLES['rule_too_large']!.params, bound: 'depth' } })).text).toBe('Age must be 18 or more (too large to check: self.notes is nested too deeply)');
  });

  it('a value from a schema or a record is bounded where it is shown', () => {
    const long = 'x'.repeat(VIOLATION_TEXT_MAX * 4);
    const w = violationWording(en, 'en', row('pattern', { params: { pattern: long } }));
    expect(w.key).not.toBeNull();
    expect(w.text.length).toBeLessThanOrEqual('does not match the pattern '.length + VIOLATION_TEXT_MAX + 1);
    expect(w.text.endsWith('…')).toBe(true);
  });

  it('markup in a value is kept as characters: the module answers text, which every place binds as text', () => {
    const w = violationWording(en, 'en', row('required', { params: { missingProperty: '<b>x</b>' } }));
    expect(w.text).toBe('required, missing');
    const p = violationWording(en, 'en', row('pattern', { params: { pattern: '<img src=x>' } }));
    expect(p.text).toBe('does not match the pattern <img src=x>');
  });
});

describe('violationWording: the server\'s sentence is the answer whenever the client cannot word the row', () => {
  const fallback = (r: unknown) => violationWording(en, 'en', r as Parameters<typeof violationWording>[2]);

  it('a row stored before codes existed (field and reason only) says its reason', () => {
    expect(fallback({ field: 'properties.age', reason: 'must be a number' })).toEqual({ text: 'must be a number', key: null, serverText: 'must be a number' });
  });

  it('a code the client does not know says the reason', () => {
    expect(fallback({ field: 'x', reason: 'something new', code: 'brand_new_code', params: {} }).text).toBe('something new');
    expect(fallback({ field: 'x', reason: 'own key', code: 'toString', params: {} }).text).toBe('own key');
  });

  it('params that do not fit the code\'s shape say the reason', () => {
    expect(fallback(row('type', { params: { type: 'integer', got: 'string' } })).key).toBeNull();
    expect(fallback(row('type', { params: { type: 'number' } })).key).toBeNull();
    expect(fallback(row('minimum', { params: { comparison: '>=', limit: '5' } })).key).toBeNull();
    expect(fallback(row('enum', { params: { allowedValues: [1, 2] } })).key).toBeNull();
    expect(fallback(row('endpoint_type', { params: { label: 'l', end: 'middle', allowedValues: [] } })).key).toBeNull();
    expect(fallback(row('required', { params: null })).key).toBeNull();
    expect(fallback(row('required', { params: ['text'] })).key).toBeNull();
    expect(fallback(row('type', { params: { type: 'number', got: 'string' }, reason: 'r' })).key).not.toBeNull();
  });

  it('a sentence the locale lacks says the reason, never the raw key', () => {
    const empty = { translate: (key: string) => key };
    expect(violationWording(empty, 'en', row('type'))).toEqual({ text: SAMPLES['type']!.reason, key: null, serverText: SAMPLES['type']!.reason });
    const noTypeNames = { translate: (key: string, p?: Record<string, unknown>) => (key.startsWith('violation.valueType.') ? key : en.translate(key, p)) };
    expect(violationWording(noTypeNames, 'en', row('type')).key).toBeNull();
  });

  it('a row with neither a code nor a reason says nothing rather than something false', () => {
    expect(fallback({ field: 'x' })).toEqual({ text: '', key: null, serverText: '' });
  });
});
