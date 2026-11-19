/**
 * `isPlainObject`: the client's one answer to "is this a value whose keys can be read as a map" (bundle-285 S13, lens finding 3).
 *
 * The same question, with the same answer, as the schema package's `isPlainObject` that the server asks: not `null`, not an array, an object. A class
 * instance counts (an `HttpErrorResponse` is read for its `status` and `error`), and so does an object made without a prototype; a function, a
 * primitive and `undefined` do not.
 *
 * ## Seen red
 *
 * Red at 877a5d3c5: `core/plain-object.ts` does not exist ("Failed to resolve import "./plain-object"").
 */
import { describe, expect, it } from 'vitest';
import { isPlainObject } from './plain-object';

class Box { constructor(readonly status = 409) {} }

describe('isPlainObject', () => {
  it.each([
    ['an object literal', { a: 1 }],
    ['an empty object', {}],
    ['an object without a prototype', Object.create(null) as object],
    ['a class instance (an error response is read for its keys)', new Box()],
  ])('is true for %s', (_name, value) => {
    expect(isPlainObject(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [1, 2]],
    ['an empty array', []],
    ['a string', 'x'],
    ['a number', 0],
    ['a boolean', false],
    ['a function', () => ({})],
  ])('is false for %s', (_name, value) => {
    expect(isPlainObject(value)).toBe(false);
  });

  it('narrows to a map of unknown values', () => {
    const v: unknown = { op: 'renameProperty' };
    if (!isPlainObject(v)) throw new Error('expected a plain object');
    expect(v['op']).toBe('renameProperty');
  });
});
