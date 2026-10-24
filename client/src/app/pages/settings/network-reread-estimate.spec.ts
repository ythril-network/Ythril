/**
 * `rereadCycles` beyond the dialog spec's mockup case: an empty space still takes its cycle (decision 47).
 *
 * A member reads ONE space per cycle and visits every owed space once, so a space with no records is a cycle, not nothing: an estimate that
 * counted it as zero would promise a re-read of ten empty spaces in no time at all.
 */
import { describe, it, expect } from 'vitest';
import { RECORDS_PER_CYCLE, rereadCycles } from './network-reread-estimate';

describe('rereadCycles', () => {
  it('an empty space is one cycle, and no spaces are none', () => {
    expect(rereadCycles([0])).toBe(1);
    expect(rereadCycles([0, 0, 0])).toBe(3);
    expect(rereadCycles([])).toBe(0);
  });

  it('a record over the cycle size costs a whole further cycle, and a count that cannot be negative is read as empty', () => {
    expect(rereadCycles([RECORDS_PER_CYCLE + 1])).toBe(2);
    expect(rereadCycles([-5])).toBe(1);
  });
});
