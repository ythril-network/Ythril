/**
 * How a change reads in the history dialog's "What changed" table (Q-744, verify fix F3): the rule of `type-change-words.ts`, alone.
 *
 * ## Seen red
 *
 * Red on 15ac8af8: `./type-change-words` does not exist (the dialog printed `propertySchemas.size` and `{"type":"number"}`).
 */
import { describe, it, expect } from 'vitest';
import { changePlaceWords, changeValueWords, type Say } from './type-change-words';

const WORDS: Record<string, string> = {
  'spaces.schema.history.wholeDefinition': 'The whole definition',
  'spaces.schema.history.facet.required': 'required',
  'spaces.schema.history.facet.pattern': 'pattern {{value}}',
  'spaces.schema.history.facet.not': 'not {{facet}}',
  'spaces.schema.history.facet.enum': 'one of ({{value}})',
  'spaces.schema.history.facet.minimum': 'at least {{value}}',
  'spaces.schema.history.facet.mergeFn': 'merged by {{value}}',
  'spaces.schema.history.place.property.minimum': 'smallest value',
  'spaces.schema.history.place.property.required': 'required',
  'spaces.schema.history.place.property.description': 'description',
  'spaces.schema.history.place.retention.days': 'Retention: delete after (days)',
  'spaces.schema.history.place.namingPattern': 'Naming pattern',
  'propertiesEditor.notDeclared': 'not declared',
  'common.yes': 'Yes',
  'common.no': 'No',
};
const say: Say = (key, params = {}) => (WORDS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_m, p: string) => params[p] ?? '');

describe('changePlaceWords', () => {
  it('a place under propertySchemas is the property, and "name: key" when a deeper key follows', () => {
    expect(changePlaceWords('propertySchemas.size', say)).toBe('size');
    expect(changePlaceWords('propertySchemas.email.required', say)).toBe('email: required');
    expect(changePlaceWords('propertySchemas.email.description', say)).toBe('email: description');
    expect(changePlaceWords('propertySchemas.email.items.type', say)).toBe('email: items.type');
  });

  it('any other place shows as it is, the empty place as "The whole definition"', () => {
    expect(changePlaceWords('futureField', say)).toBe('futureField');
    expect(changePlaceWords('propertySchemas.', say)).toBe('propertySchemas.');
    expect(changePlaceWords('', say)).toBe('The whole definition');
  });
});

describe('changeValueWords', () => {
  const at = 'propertySchemas.email.required';

  it('an absent side is "not declared"; true and false are yes and no, from the app\'s own words', () => {
    expect(changeValueWords(undefined, at, say)).toBe('not declared');
    expect(changeValueWords(true, at, say)).toBe('yes');
    expect(changeValueWords(false, at, say)).toBe('no');
  });

  it('a string or number as it is, an array of plain values joined with ", "', () => {
    expect(changeValueWords('Work address', at, say)).toBe('Work address');
    expect(changeValueWords(30, at, say)).toBe('30');
    expect(changeValueWords(['a', 2, true], at, say)).toBe('a, 2, yes');
  });

  it('a property definition (an object at exactly a property) is its type, then its other plain facets', () => {
    const place = 'propertySchemas.orcid';
    expect(changeValueWords({ type: 'number' }, place, say)).toBe('number');
    expect(changeValueWords({ type: 'string', pattern: '0000-0000-0000-000X' }, place, say)).toBe('string, pattern 0000-0000-0000-000X');
    expect(changeValueWords({ type: 'string', required: true }, place, say)).toBe('string, required');
    expect(changeValueWords({ type: 'string', unique: true, minLength: 3, required: false }, place, say)).toBe('string, unique, minLength 3, not required');
    expect(changeValueWords({ type: 'string', enum: ['a', 'b'] }, place, say)).toBe('string, one of (a, b)');
    expect(changeValueWords({ type: 'number', minimum: 3, mergeFn: 'avg' }, place, say)).toBe('number, at least 3, merged by avg');
  });

  it('a type-level place and a property facet in a place are worded (C7); an unknown one prints as written', () => {
    expect(changePlaceWords('namingPattern', say)).toBe('Naming pattern');
    expect(changePlaceWords('retention.days', say)).toBe('Retention: delete after (days)');
    expect(changePlaceWords('propertySchemas.size.minimum', say)).toBe('size: smallest value');
    expect(changePlaceWords('propertySchemas.size.format', say)).toBe('size: format');
  });

  it('anything else is compact JSON: an object at another place, a definition with a facet that is no plain value, an empty array', () => {
    expect(changeValueWords({ type: 'number' }, 'propertySchemas.size.items', say)).toBe('{"type":"number"}');
    expect(changeValueWords({ type: 'number' }, '', say)).toBe('{"type":"number"}');
    expect(changeValueWords({ type: 'object', properties: { a: { type: 'string' } } }, 'propertySchemas.x', say)).toBe('{"type":"object","properties":{"a":{"type":"string"}}}');
    expect(changeValueWords({ pattern: 'x' }, 'propertySchemas.x', say)).toBe('{"pattern":"x"}');
    expect(changeValueWords([], at, say)).toBe('[]');
    expect(changeValueWords([{ a: 1 }], at, say)).toBe('[{"a":1}]');
    expect(changeValueWords(null, at, say)).toBe('null');
  });
});
