/**
 * Every facet a property definition can carry and every place a type has, as the schema package declares them, has words in the
 * history dialog's "What changed" table, in en, de and pl (Q-744, pre-ship review C7).
 *
 * ## Why
 *
 * `type-change-words.ts` words the names it knows and prints any other raw, so a newer server's facet is shown and never dropped.
 * That is right for a name that does not exist yet and wrong for one that does: `minimum 3` and `namingPattern` reached a person
 * who never saw the schema's JSON. The names are READ from `schema/src/vocabulary.ts` (`PropertySchema`, `TypeSchema`), so a name
 * the schema gains turns this red until it has a sample here, a key in each language and a line in `type-change-words.ts`.
 *
 * ## Seen red
 *
 * Red on 4f9f11f0: `minimum 3`, `enum (a, b)` and `namingPattern` print as the wire spells them, and no `place` or `facet.minimum` key exists.
 */
import { describe, it, expect } from 'vitest';
import { changePlaceWords, changeValueWords, type Say } from './type-change-words';
import { dictionary, LOCALES } from '../testing/i18n-dictionary';
import { interfaceBody, interfaceKeys, readRepoSource } from '../testing/server-source';

const VOCABULARY = 'schema/src/vocabulary.ts';
const FACET = 'spaces.schema.history.facet';
const PLACE = 'spaces.schema.history.place';

/** Keys of the `{ ... }` that follows `name?:` inside an interface body (the nested level `interfaceKeys` blanks). */
function nestedKeys(src: string, iface: string, name: string): string[] {
  const m = new RegExp(`\\b${name}\\??:\\s*\\{([^{}]*)\\}`).exec(interfaceBody(src, iface));
  if (!m) throw new Error(`no nested object ${name} in ${iface}: the schema moved, and this check would report clean about nothing`);
  return [...m[1]!.matchAll(/(?:^|[;,\n])\s*([A-Za-z_]\w*)\??\s*:/g)].map(x => x[1]!);
}

const src = readRepoSource(VOCABULARY);
const FACETS = interfaceKeys(src, 'PropertySchema');
const ALL_TYPE_KEYS = interfaceKeys(src, 'TypeSchema');
/**
 * `_unresolvedRef` is `@internal`, never stored. `propertySchemas` and `rules` are maps walked entry by entry, so a change is never at the
 * map itself: its places are `propertySchemas.<name>[.<facet>]` and `rules.<name>[.rule|.message]`, checked below.
 */
const TYPE_KEYS = ALL_TYPE_KEYS.filter(k => k !== '_unresolvedRef' && k !== 'propertySchemas' && k !== 'rules');
const NESTED = { retention: nestedKeys(src, 'TypeSchema', 'retention'), endpoints: nestedKeys(src, 'TypeSchema', 'endpoints') };
const TYPE_PLACES = [...TYPE_KEYS, ...NESTED.retention.map(k => `retention.${k}`), ...NESTED.endpoints.map(k => `endpoints.${k}`)];

/** A value of the right shape for each facet; a facet the schema gains has none here, which the first test names. */
const SAMPLES: Record<string, unknown> = {
  description: 'x', type: 'string', enum: ['a', 'b'], minimum: 3, maximum: 9, pattern: 'p', mergeFn: 'avg', required: true, default: 1,
};

/** Echoes the key and its parameters, so what was asked is what is compared. */
const tag: Say = (key, params = {}) => `<${key}${Object.entries(params).map(([k, v]) => ` ${k}=${v}`).join('')}>`;

describe('the schema package is found', () => {
  it('reads the facets and the places it declares', () => {
    expect(FACETS, 'PropertySchema keys').toEqual(expect.arrayContaining(['type', 'enum', 'minimum', 'maximum', 'pattern', 'required']));
    expect(ALL_TYPE_KEYS, 'TypeSchema keys').toEqual(expect.arrayContaining(['description', 'namingPattern', 'retention', 'endpoints', 'rules', 'propertySchemas']));
    expect(TYPE_KEYS, 'the places of a type above its properties and rules').toEqual(expect.arrayContaining(['namingPattern', 'functional']));
    expect(NESTED.retention).toEqual(expect.arrayContaining(['days', 'contentDays']));
    expect(NESTED.endpoints).toEqual(expect.arrayContaining(['from', 'to']));
  });
});

describe('a property facet has words', () => {
  it('has a sample, so the check below can say it', () => {
    expect(FACETS.filter(f => !(f in SAMPLES)), 'a facet of PropertySchema with no sample in this spec').toEqual([]);
  });

  it.each(FACETS.filter(f => f !== 'type'))('%s is worded as a value, not printed as the wire spells it', facet => {
    const text = changeValueWords({ type: 'string', [facet]: SAMPLES[facet] }, 'propertySchemas.p', tag);
    expect(text).toContain(`<${FACET}.${facet}`);
  });

  it.each(FACETS)('%s has words as the place of a change under a property', facet => {
    expect(changePlaceWords(`propertySchemas.p.${facet}`, tag)).toBe(`p: <${PLACE}.property.${facet}>`);
  });

  it('a facet the client does not know prints as written, and a property place of an unknown facet too', () => {
    expect(changeValueWords({ type: 'string', unique: true, format: 'email' }, 'propertySchemas.p', tag)).toBe('string, unique, format email');
    expect(changePlaceWords('propertySchemas.p.format', tag)).toBe('p: format');
  });
});

describe('a type-level place has words', () => {
  it.each(TYPE_PLACES)('%s is worded, not printed as the wire spells it', place => {
    expect(changePlaceWords(place, tag)).toBe(`<${PLACE}.${place}>`);
  });

  it('a rule is named, by its expression or its message', () => {
    expect(changePlaceWords('rules.adult', tag)).toBe(`<${PLACE}.rules name=adult>`);
    expect(changePlaceWords('rules.adult.rule', tag)).toBe(`<${PLACE}.rules.rule name=adult>`);
    expect(changePlaceWords('rules.adult.message', tag)).toBe(`<${PLACE}.rules.message name=adult>`);
  });

  it('a place this client does not know prints as written', () => {
    expect(changePlaceWords('futureField', tag)).toBe('futureField');
    expect(changePlaceWords('retention.futureDays', tag)).toBe('retention.futureDays');
  });
});

describe('the words exist in every language', () => {
  const keys = [
    ...FACETS.filter(f => f !== 'type').map(f => `${FACET}.${f}`),
    ...FACETS.map(f => `${PLACE}.property.${f}`),
    ...TYPE_PLACES.map(p => `${PLACE}.${p}`),
    `${PLACE}.rules`, `${PLACE}.rules.rule`, `${PLACE}.rules.message`, 'spaces.schema.history.unsupported',
  ];
  const VALUE_KEYS = new Set(FACETS.filter(f => f !== 'type' && f !== 'required').map(f => `${FACET}.${f}`));

  it.each(LOCALES)('%s has each key, with the parameter the sentence needs', locale => {
    const dict = dictionary(locale);
    for (const key of keys) {
      const value = dict[key];
      expect(value, `${locale}: ${key}`).toBeTruthy();
      if (VALUE_KEYS.has(key)) expect(value, `${locale}: ${key} takes {{value}}`).toContain('{{value}}');
      if (key.startsWith(`${PLACE}.rules.`) || key === `${PLACE}.rules`) expect(value, `${locale}: ${key} takes {{name}}`).toContain('{{name}}');
    }
  });
});
