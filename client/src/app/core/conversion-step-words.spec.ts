/**
 * The words of a conversion step and of a refused one (bundle-285, plan sections 5 D8, 8 and 12 "security").
 *
 * A step names things that are PEER-AUTHORED: a vote carries them, and any member of a network may have written
 * `<img src=x onerror=...>` as a type name. So a sentence is built from a translation key out of a closed set and the names go in as
 * parameters, never concatenated into a key and never into markup. These tests hold: a sentence per op, with the names as given; the
 * names reach the translator as parameters, whatever they look like; and a refusal code that is not on the list gets the generic sentence
 * with the code as a parameter, never a key built from it.
 *
 * ## Seen red
 *
 * Red on main 2ac9a2b1: `core/conversion-step-words.ts` does not exist.
 */
import { describe, it, expect } from 'vitest';
import { stepSentence, stepRefusalWords, CONVERSION_STEP_KEYS, STEP_REFUSAL_CODES } from './conversion-step-words';
import type { ConversionStep } from './conversion.types';

/** The English of plan section 8, interpolated in ONE pass as the translation service does: a parameter's value is never read for `{{ }}` again. */
const ENGLISH: Record<string, string> = {
  'conversion.step.renameType': 'Rename the type {{from}} to {{to}}',
  'conversion.step.renameProperty': 'Rename the property {{from}} to {{to}}',
  'conversion.step.mapEnum': 'In {{property}}, change {{pairs}}',
  'conversion.step.mapPair': '{{from}} to {{to}}',
  'conversion.step.splitType': 'Split {{type}} by a condition: {{cases}}; all others become {{otherwise}}',
  'conversion.step.splitTypeOpen': 'Split {{type}} by a condition: {{cases}}',
  'conversion.step.splitCase': 'records where {{when}} become {{to}}',
};

interface Call { key: string; params: Record<string, unknown> }

function translator(calls: Call[] = []) {
  return {
    calls,
    translate(key: string, params: Record<string, unknown> = {}): string {
      calls.push({ key, params });
      const text = ENGLISH[key];
      if (text === undefined) return key;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(params[name] ?? ''));
    },
  };
}

const sentence = (step: ConversionStep): string => stepSentence(translator(), step);

describe('a sentence per op', () => {
  it('rename the type', () => {
    expect(sentence({ op: 'renameType', kind: 'entity', from: 'client', to: 'customer' })).toBe('Rename the type client to customer');
  });

  it('rename a property', () => {
    expect(sentence({ op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' })).toBe('Rename the property company to employer');
  });

  it('map a value: the property and each old value with its new one, as drawn', () => {
    expect(sentence({ op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { active: 'on', gone: 'off' } }))
      .toBe('In status, change active to on, gone to off');
  });

  it('split by a condition: each case in order, then the type the others become', () => {
    expect(sentence({
      op: 'splitType', kind: 'entity', from: 'contact', otherwise: 'person',
      cases: [{ when: 'properties.kind == "org"', to: 'organization' }, { when: 'properties.kind == "bot"', to: 'service' }],
    })).toBe('Split contact by a condition: records where properties.kind == "org" become organization; records where properties.kind == "bot" become service; all others become person');
  });

  it('a split with no `otherwise` does not say where the others go: it does not make one up', () => {
    const text = sentence({ op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'a', to: 'b' }] });
    expect(text).toBe('Split contact by a condition: records where a become b');
    expect(text).not.toMatch(/others/);
  });
});

describe('names a peer wrote are parameters, never markup and never part of a key', () => {
  const hostile = ['<img src=x onerror=alert(1)>', '{{to}}', '$&', '</script><b>x</b>', 'conversion.step.renameType', '__proto__', 'constructor'];

  it('every key asked for is on the closed list, whatever the names say', () => {
    for (const name of hostile) {
      const t = translator();
      stepSentence(t,{ op: 'renameType', kind: 'entity', from: name, to: `${name}2` });
      stepSentence(t,{ op: 'renameProperty', kind: 'entity', type: name, from: name, to: `${name}2` });
      stepSentence(t,{ op: 'mapEnum', kind: 'entity', type: 'p', property: name, values: { [name]: 'x' } });
      stepSentence(t,{ op: 'splitType', kind: 'entity', from: name, cases: [{ when: name, to: name }], otherwise: name });
      for (const call of t.calls) expect(CONVERSION_STEP_KEYS, `a key built from "${name}"`).toContain(call.key);
    }
  });

  it('the name reaches the translator whole, as a parameter, and comes out as text exactly as written', () => {
    const t = translator();
    const out = stepSentence(t,{ op: 'renameType', kind: 'entity', from: '<img src=x onerror=alert(1)>', to: '{{from}}' });
    expect(out).toBe('Rename the type <img src=x onerror=alert(1)> to {{from}}');
    expect(t.calls[0]!.params).toEqual({ from: '<img src=x onerror=alert(1)>', to: '{{from}}' });
  });

  it('a name that looks like a replacement pattern is not one', () => {
    expect(sentence({ op: 'renameProperty', kind: 'entity', type: 't', from: '$&', to: "$'" })).toBe("Rename the property $& to $'");
  });

  it('a value map\'s pairs reach the sentence as text too, with no markup added around them', () => {
    const out = sentence({ op: 'mapEnum', kind: 'entity', type: 'p', property: '<b>p</b>', values: { '<i>a</i>': '<u>b</u>' } });
    expect(out).toBe('In <b>p</b>, change <i>a</i> to <u>b</u>');
    expect(out).not.toMatch(/<(span|strong|em|code)/);
  });

  it('the closed list of keys is the six the plan names and the one it needs for a split without `otherwise`', () => {
    expect([...CONVERSION_STEP_KEYS].sort()).toEqual(Object.keys(ENGLISH).sort());
  });
});

describe('why a step was refused', () => {
  it('a code on the list has its own sentence, keyed by the code', () => {
    expect(stepRefusalWords('steps_not_signed')).toEqual({ key: 'conversion.stepRefusal.steps_not_signed', params: {} });
    expect(stepRefusalWords('enum_not_declared_after')).toEqual({ key: 'conversion.stepRefusal.enum_not_declared_after', params: {} });
    expect(stepRefusalWords('replaced')).toEqual({ key: 'conversion.stepRefusal.replaced', params: {} });
  });

  it('every code on the list is worded, and no key is made of a code that is not', () => {
    expect(STEP_REFUSAL_CODES.length).toBeGreaterThan(20);
    for (const code of STEP_REFUSAL_CODES) expect(stepRefusalWords(code).key).toBe(`conversion.stepRefusal.${code}`);
  });

  it('a code the client does not know is the generic sentence with the code as a parameter, never a key built from it', () => {
    for (const code of ['something_new', '<b>x</b>', 'constructor', '__proto__', 'toString', '', 'unknown']) {
      expect(stepRefusalWords(code), `code ${JSON.stringify(code)}`).toEqual({ key: 'conversion.stepRefusal.unknown', params: { code } });
    }
  });
});
