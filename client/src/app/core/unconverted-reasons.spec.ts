/**
 * The reason classes of Review's Unconverted section (bundle-285, plan sections 3.1 item 9 and 6): the server lists a record for one of ten
 * reasons, and the section groups them into three the user can act on — "Does not fit", "Already exists", "Steps refused".
 *
 * What these tests hold: the table is the plan's; a reason the client does not know is "does not fit" (the one class whose advice, fix the
 * record or dismiss it, is true of any record the run could not convert), never a throw and never a class made of a name that happens to be
 * a property of every object; and the class counts and the type choices are sums of `counts.openBy` groups, never invented numbers.
 * `testing/conversion-contract.spec.ts` holds the table to the server's own list of reasons, so a reason added there fails with its name.
 *
 * ## Seen red
 *
 * Red on main 2ac9a2b1: `core/unconverted-reasons.ts` does not exist.
 */
import { describe, it, expect } from 'vitest';
import {
  UNCONVERTED_REASONS, UNCONVERTED_REASON_CLASS, UNCONVERTED_CLASSES, reasonClassOf, reasonsOfClass, openCountsByClass, soleOpenType, openTypesOf,
} from './unconverted-reasons';
import type { UnconvertedOpenGroup } from './conversion.types';

describe('the classes', () => {
  it('are fit, exists and refused, in the order the switch lists them', () => {
    expect([...UNCONVERTED_CLASSES]).toEqual(['fit', 'exists', 'refused']);
  });

  it('class the ten reasons as the plan does', () => {
    expect(UNCONVERTED_REASON_CLASS).toEqual({
      not_conforming: 'fit', no_case_matched: 'fit', both_set: 'fit', could_not_evaluate: 'fit', version_ceiling: 'fit', fork: 'fit', conversion_failed: 'fit',
      relationship_exists: 'exists', functional_taken: 'exists',
      step_refused: 'refused',
    });
    expect([...UNCONVERTED_REASONS].sort()).toEqual(Object.keys(UNCONVERTED_REASON_CLASS).sort());
  });

  it('reasonClassOf answers a known reason\'s class and "fit" for any reason it does not know', () => {
    expect(reasonClassOf('relationship_exists')).toBe('exists');
    expect(reasonClassOf('step_refused')).toBe('refused');
    expect(reasonClassOf('a_reason_from_a_newer_server')).toBe('fit');
    expect(reasonClassOf('')).toBe('fit');
  });

  it('a name every object has is not a reason', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) expect(reasonClassOf(name), name).toBe('fit');
  });

  it('reasonsOfClass lists each class\'s known reasons in the server\'s order, and together they are all of them', () => {
    expect(reasonsOfClass('fit')).toEqual(['not_conforming', 'no_case_matched', 'both_set', 'could_not_evaluate', 'version_ceiling', 'fork', 'conversion_failed']);
    expect(reasonsOfClass('exists')).toEqual(['relationship_exists', 'functional_taken']);
    expect(reasonsOfClass('refused')).toEqual(['step_refused']);
    expect(UNCONVERTED_CLASSES.flatMap(c => reasonsOfClass(c)).sort()).toEqual([...UNCONVERTED_REASONS].sort());
  });
});

const group = (kind: UnconvertedOpenGroup['kind'], type: string, reason: string, n: number): UnconvertedOpenGroup => ({ kind, type, reason: reason as never, n });
const OPEN: UnconvertedOpenGroup[] = [
  group('entity', 'person', 'not_conforming', 3),
  group('entity', 'person', 'both_set', 1),
  group('entity', 'person', 'step_refused', 14),
  group('edge', 'works_at', 'relationship_exists', 2),
  group('entity', 'organization', 'a_reason_from_a_newer_server', 5),
];

describe('openCountsByClass (the number on each pill of the reason switch)', () => {
  it('sums the open groups of each class, a reason it does not know under "fit"', () => {
    expect(openCountsByClass(OPEN)).toEqual({ fit: 9, exists: 2, refused: 14 });
  });

  it('narrows to a type when one is chosen, and a class with nothing open is zero, not missing', () => {
    expect(openCountsByClass(OPEN, { kind: 'entity', type: 'person' })).toEqual({ fit: 4, exists: 0, refused: 14 });
    expect(openCountsByClass(OPEN, { kind: 'edge', type: 'works_at' })).toEqual({ fit: 0, exists: 2, refused: 0 });
    expect(openCountsByClass([])).toEqual({ fit: 0, exists: 0, refused: 0 });
  });

  it('a type is a kind and a name: the same name under another kind is another type', () => {
    expect(openCountsByClass(OPEN, { kind: 'fact', type: 'person' })).toEqual({ fit: 0, exists: 0, refused: 0 });
  });
});

describe('the record types with something open (the type choice)', () => {
  it('lists each type once, with its open count, kinds in the Brain\'s order and names in the order of their letters', () => {
    expect(openTypesOf(OPEN)).toEqual([
      { kind: 'entity', type: 'organization', open: 5 },
      { kind: 'entity', type: 'person', open: 18 },
      { kind: 'edge', type: 'works_at', open: 2 },
    ]);
  });

  it('leaves out a group with nothing open', () => {
    expect(openTypesOf([group('entity', 'person', 'not_conforming', 0)])).toEqual([]);
  });

  it('soleOpenType is the one type when exactly one has open items, and null for none or for several', () => {
    expect(soleOpenType([group('entity', 'person', 'not_conforming', 3), group('entity', 'person', 'both_set', 1)])).toEqual({ kind: 'entity', type: 'person' });
    expect(soleOpenType(OPEN)).toBeNull();
    expect(soleOpenType([])).toBeNull();
  });
});
