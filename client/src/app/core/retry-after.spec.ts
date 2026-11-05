/**
 * `retryAfterSecondsOf` — the seconds a refused request's `Retry-After` names, or null (bundle-233).
 *
 * Two pages read the header by hand before this (the file listing's owed-answer wait, the second-factor lock's sentence); each keeps its own
 * default and bound over this one reading.
 */
import { HttpHeaders } from '@angular/common/http';
import { describe, it, expect } from 'vitest';
import { retryAfterSecondsOf } from './retry-after';

const answer = (retryAfter?: string) => ({ headers: new HttpHeaders(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }) });

describe('retryAfterSecondsOf', () => {
  it('reads a count of seconds', () => {
    expect(retryAfterSecondsOf(answer('300'))).toBe(300);
    expect(retryAfterSecondsOf(answer('0'))).toBe(0);
    expect(retryAfterSecondsOf(answer('1.5'))).toBe(1.5);
  });

  it('is null when the answer names none', () => {
    expect(retryAfterSecondsOf(answer())).toBeNull();
    expect(retryAfterSecondsOf({})).toBeNull();
    expect(retryAfterSecondsOf(null)).toBeNull();
    expect(retryAfterSecondsOf(undefined)).toBeNull();
    expect(retryAfterSecondsOf('not an answer')).toBeNull();
  });

  it('is null when the header is not a count of seconds', () => {
    expect(retryAfterSecondsOf(answer('-5'))).toBeNull();
    expect(retryAfterSecondsOf(answer('soon'))).toBeNull();
    expect(retryAfterSecondsOf(answer('Infinity'))).toBeNull();
  });
});
