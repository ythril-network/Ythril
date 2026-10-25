/**
 * What `fork-diff` marks between a fork and its parent (bundle-81, decision 43): the words only one version has, the fields that differ, and the
 * guard that keeps a very long text from freezing the page.
 */
import { describe, it, expect } from 'vitest';
import { compareForkVersions, fieldSegments, MAX_DIFF_CELLS, wordDiff } from './fork-diff';

const words = { empty: '(empty)', none: '(none)' };
const kinds = (a: string, b: string) => wordDiff(a, b).map(s => `${s.kind}:${s.text.trim()}`).filter(s => !s.endsWith(':'));

describe('wordDiff: a is this version (the fork), b the other (the parent)', () => {
  it('marks only the words that differ, removed ones first where they meet', () => {
    expect(kinds('closes at 17:30 on weekdays', 'closes at 18:00 on weekdays')).toEqual(['same:closes at', 'del:18:00', 'ins:17:30', 'same:on weekdays']);
  });

  it('two equal texts have no mark, and an empty side is one whole mark', () => {
    expect(wordDiff('same text', 'same text').every(s => s.kind === 'same')).toBe(true);
    expect(kinds('added', '')).toEqual(['ins:added']);
    expect(kinds('', 'removed')).toEqual(['del:removed']);
  });

  it('does not compare word by word beyond the cell limit: one removed run and one added run', () => {
    const side = (word: string) => Array.from({ length: Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10 }, (_, i) => `${word}${i}`).join(' ');
    const out = wordDiff(side('a'), side('b'));
    expect(out.map(s => s.kind)).toEqual(['del', 'ins']);
  });
});

/** The fact's fields as the list answer's `kinds.fact` states them (BODY_FIELDS_OF, the main field among them) and its main field. */
const FACT_FIELDS = ['fact', 'type', 'description', 'tags', 'linkEntities'];

describe('compareForkVersions', () => {
  const parent = { _id: 'p', fact: 'one', type: 'note', tags: ['a'], properties: { city: 'Berlin', floor: 2 } };

  it('splits the fields into what differs and what is the same, properties one by one, and leaves empty fields out of "same"', () => {
    const fork = { _id: 'f', fact: 'two', type: 'note', tags: ['a', 'b'], properties: { city: 'Berlin', floor: 3 } };
    const c = compareForkVersions(fork, parent, FACT_FIELDS, 'fact');
    expect(c.main?.a).toBe('two');
    expect(c.others.map(f => f.key)).toEqual(['tags', 'properties.floor']);
    expect(c.same).toEqual(['type', 'properties.city']);
  });

  it('a fork that differs in the fact alone has no other field', () => {
    expect(compareForkVersions({ ...parent, _id: 'f', fact: 'two' }, parent, FACT_FIELDS, 'fact').others).toEqual([]);
  });
});

/** What the comparison calls the main field's difference: the list's `mainField` is generic now, so the name of the result's key is not fixed. */
const mainOf = (c: any): { a: unknown; b: unknown } | undefined => c.main ?? c.fact;

describe('compareForkVersions compares the fields the page names, per kind (Q-624)', () => {
  const ENTITY = ['name', 'type', 'description', 'tags'];
  const CHRONO = ['title', 'type', 'start', 'end', 'description', 'tags'];
  const EDGE = ['description', 'weight'];

  it('an entity differs on its name, the main field, and no `fact` is looked for', () => {
    const c = compareForkVersions({ _id: 'f', name: 'Hamburg Logistik GmbH', type: 'org', tags: ['a'] } as never,
      { _id: 'p', name: 'Hamburg Logistics GmbH', type: 'org', tags: ['a'] } as never, ENTITY, 'name');
    expect(mainOf(c)?.a).toBe('Hamburg Logistik GmbH');
    expect(mainOf(c)?.b).toBe('Hamburg Logistics GmbH');
    expect(c.others).toEqual([]);
    expect(c.same).toEqual(['type', 'tags']);
  });

  it('the main field is not repeated among the other fields, whether or not the answer lists it among `fields`', () => {
    for (const fields of [ENTITY, ENTITY.filter(f => f !== 'name')]) {
      const c = compareForkVersions({ _id: 'f', name: 'one', type: 'a' } as never, { _id: 'p', name: 'two', type: 'b' } as never, fields, 'name');
      expect(mainOf(c)?.a).toBe('one');
      expect(c.others.map(f => f.key)).toEqual(['type']);
    }
  });

  it('a timeline entry differs on its title and dates; fields the kind does not list are not compared', () => {
    const c = compareForkVersions({ _id: 'f', title: 'Review B', start: '2026-11-19', end: '2026-11-19', tags: ['x'] } as never,
      { _id: 'p', title: 'Review A', start: '2026-11-12', end: '2026-11-19', tags: ['x'], fact: 'not a chrono field' } as never, CHRONO, 'title');
    expect(mainOf(c)?.a).toBe('Review B');
    expect(c.others.map(f => f.key)).toEqual(['start']);
  });

  it('a relationship differs on its description and weight, and a `tags` it does not list is not compared', () => {
    const c = compareForkVersions({ _id: 'f', description: 'Twice weekly', weight: 0.9, tags: ['x'] } as never,
      { _id: 'p', description: 'Weekly', weight: 1, tags: ['y'] } as never, EDGE, 'description');
    expect(mainOf(c)?.a).toBe('Twice weekly');
    expect(c.others.map(f => f.key)).toEqual(['weight']);
  });

  it('properties are compared key by key for every kind', () => {
    const c = compareForkVersions({ _id: 'f', name: 'x', properties: { tier: 'preferred', country: 'DE' } } as never,
      { _id: 'p', name: 'x', properties: { tier: 'standard', country: 'DE' } } as never, ENTITY, 'name');
    expect(c.others.map(f => f.key)).toEqual(['properties.tier']);
    expect(c.same).toContain('properties.country');
  });

  it('a fact still differs on its `fact`: the fact path is one case of the rule, not the rule', () => {
    const c = compareForkVersions({ _id: 'f', fact: 'two' } as never, { _id: 'p', fact: 'one' } as never, FACT_FIELDS, 'fact');
    expect(mainOf(c)?.a).toBe('two');
  });
});

describe('fieldSegments', () => {
  it('lists the tags only one side has, the other side’s first, with a plain space between marks', () => {
    const marks = fieldSegments({ key: 'tags', a: ['x', 'new'], b: ['x', 'old'] }, words);
    expect(marks).toEqual([{ kind: 'del', text: 'old' }, { kind: 'same', text: ' ' }, { kind: 'ins', text: 'new' }]);
  });

  it('shows another field as the parent’s value then the fork’s, and an absent value in words', () => {
    expect(fieldSegments({ key: 'type', a: 'policy', b: undefined }, words)).toEqual([{ kind: 'del', text: '(empty)' }, { kind: 'ins', text: 'policy' }]);
    expect(fieldSegments({ key: 'linkEntities', a: [], b: [] }, words)).toEqual([]);
  });
});
