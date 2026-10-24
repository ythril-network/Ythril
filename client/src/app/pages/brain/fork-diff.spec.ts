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

describe('compareForkVersions', () => {
  const parent = { _id: 'p', fact: 'one', type: 'note', tags: ['a'], properties: { city: 'Berlin', floor: 2 } };

  it('splits the fields into what differs and what is the same, properties one by one, and leaves empty fields out of "same"', () => {
    const fork = { _id: 'f', fact: 'two', type: 'note', tags: ['a', 'b'], properties: { city: 'Berlin', floor: 3 } };
    const c = compareForkVersions(fork, parent);
    expect(c.fact?.a).toBe('two');
    expect(c.others.map(f => f.key)).toEqual(['tags', 'properties.floor']);
    expect(c.same).toEqual(['type', 'properties.city']);
  });

  it('a fork that differs in the fact alone has no other field', () => {
    expect(compareForkVersions({ ...parent, _id: 'f', fact: 'two' }, parent).others).toEqual([]);
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
