/**
 * The private marks that set a name or a number apart inside a translated sentence (bundle-285 slice S11, Q-747): one module, so the vote
 * row, the run block and the Save dialog share one protocol. These tests hold: a name or number that carries a marker character of its own
 * cannot make a piece it did not own; a sentence with names and numbers is cut into text, name and strong pieces in order; and a marker the
 * translation left unpaired gives text, never a throw.
 *
 * ## Seen red
 *
 * Red on the branch before the module: `core/sentence-marks.ts` does not exist.
 */
import { describe, it, expect } from 'vitest';
import { markName, markStrong, piecesOf, stripMarks, strongFirst } from './sentence-marks';

const names = (sentence: string): string[] => piecesOf(sentence).filter(p => p.name).map(p => p.text);
const strongs = (sentence: string): string[] => piecesOf(sentence).filter(p => p.strong).map(p => p.text);
const joined = (sentence: string): string => piecesOf(sentence).map(p => p.text).join('');

describe('a name or a number cannot forge a mark', () => {
  it('keeps a name that holds the closing mark as one name piece, with the mark taken out', () => {
    const sentence = `Rename ${markName('a\u0002 b')} to ${markName('c')}`;
    expect(names(sentence)).toEqual(['a b', 'c']);
    expect(joined(sentence)).toBe('Rename a b to c');
  });

  it('keeps a name that holds the opening mark from starting a name of its own', () => {
    const sentence = `Rename ${markName('\u0001x')} to y`;
    expect(names(sentence)).toEqual(['x']);
    expect(joined(sentence)).toBe('Rename x to y');
  });

  it('keeps a name that holds the strong marks from making a strong piece', () => {
    const sentence = `In ${markName('p\u0003 q \u0004r')} done`;
    expect(strongs(sentence)).toEqual([]);
    expect(names(sentence)).toEqual(['p q r']);
  });

  it('keeps a number that holds the name marks from making a name', () => {
    const sentence = `${markStrong('1\u0001 2\u0002')} records`;
    expect(names(sentence)).toEqual([]);
    expect(strongs(sentence)).toEqual(['1 2']);
  });

  it('wraps a name in no more than its own pair of marks', () => {
    const marked = markName('a\u0001\u0002\u0003\u0004b');
    expect(marked.length).toBe('ab'.length + 2);
    expect(stripMarks(marked)).toBe('ab');
  });
});

describe('a sentence is cut at its marks', () => {
  it('cuts text, name and strong pieces in the order they stand', () => {
    const sentence = `Of ${markStrong('1,200')} records of ${markName('person')}, ${markStrong('3')} cannot become ${markName('human')}.`;
    expect(piecesOf(sentence)).toEqual([
      { text: 'Of ', name: false },
      { text: '1,200', name: false, strong: true },
      { text: ' records of ', name: false },
      { text: 'person', name: true },
      { text: ', ', name: false },
      { text: '3', name: false, strong: true },
      { text: ' cannot become ', name: false },
      { text: 'human', name: true },
      { text: '.', name: false },
    ]);
  });

  it('answers one text piece for a sentence with no marks, and none for an empty one', () => {
    expect(piecesOf('Nothing to convert.')).toEqual([{ text: 'Nothing to convert.', name: false }]);
    expect(piecesOf('')).toEqual([]);
  });

  it('puts a strong number inside a name as part of the name, never as a piece of its own', () => {
    expect(piecesOf(`${'\u0001'}a${'\u0003'}1${'\u0004'}b${'\u0002'}`)).toEqual([{ text: 'a1b', name: true }]);
  });
});

describe('an unbalanced mark gives text, never a throw', () => {
  it.each([
    ['an opening mark never closed', 'a \u0001b', 'a b'],
    ['a closing mark never opened', 'a\u0002 b', 'a b'],
    ['a strong opening never closed', 'a \u0003b', 'a b'],
    ['a strong closing never opened', 'a\u0004 b', 'a b'],
    ['marks in the wrong order', 'a \u0002b\u0001 c', 'a b c'],
    ['only marks', '\u0001\u0002\u0003\u0004', ''],
  ])('%s', (_label, sentence, text) => {
    expect(() => piecesOf(sentence)).not.toThrow();
    expect(joined(sentence)).toBe(text);
    expect(joined(sentence)).not.toMatch(/[\u0001-\u0004]/);
  });
});

describe('strongFirst', () => {
  it('marks the first occurrence of the number that is not inside a name', () => {
    const sentence = `${markName('12')} has 12 records, 12 in all`;
    const pieces = piecesOf(strongFirst(sentence, '12'));
    expect(pieces.filter(p => p.strong).map(p => p.text)).toEqual(['12']);
    expect(pieces.filter(p => p.name).map(p => p.text)).toEqual(['12']);
    expect(pieces.map(p => p.text).join('')).toBe('12 has 12 records, 12 in all');
    expect(pieces[1]).toEqual({ text: ' has ', name: false });
    expect(pieces[2]).toEqual({ text: '12', name: false, strong: true });
  });

  it('leaves the sentence as it is when the number is not there or is empty', () => {
    expect(strongFirst('three records', '3')).toBe('three records');
    expect(strongFirst('three records', '')).toBe('three records');
  });
});

describe('stripMarks', () => {
  it('takes out all four marks and nothing else', () => {
    expect(stripMarks('\u0001a\u0002 \u0003b\u0004 c')).toBe('a b c');
  });
});
