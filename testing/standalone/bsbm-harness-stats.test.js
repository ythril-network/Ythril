/**
 * The median and the 95th percentile of a run's timings.
 *
 * The harness reports these two numbers per query, and the owner decides on a triple cache from them, so a
 * median that is quietly the wrong element (unsorted input, the lower of two middles, the mean) moves every
 * table row. Each case below states the one rule it guards.
 *
 * Run: node --test testing/standalone/bsbm-harness-stats.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, percentile, summarize } from '../../benchmarks/rdf/stats.mjs';

test('the median of an odd count is the middle value of the sorted values, whatever the input order', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([9, 7, 1, 8, 2]), 7);
});

test('the median of an even count is the mean of the two middle values', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([10, 20]), 15);
});

test('the median is not the mean: one slow outlier does not move it', () => {
  assert.equal(median([1, 1, 1, 1, 1000]), 1);
});

test('p95 is the nearest rank: the 19th of 20 sorted values', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => 20 - i); // 20..1, unsorted on purpose
  assert.equal(percentile(twenty, 95), 19);
  assert.equal(percentile(twenty, 100), 20);
  assert.equal(percentile(twenty, 50), 10);
});

test('a percentile of one value is that value', () => {
  assert.equal(percentile([7], 95), 7);
  assert.equal(median([7]), 7);
});

test('summarize reports n, median, p95, min and max, and leaves its input alone', () => {
  const input = [3, 1, 2, 5, 4];
  const copy = [...input];
  assert.deepEqual(summarize(input), { n: 5, median: 3, p95: 5, min: 1, max: 5 });
  assert.deepEqual(input, copy, 'the caller\'s array must not be sorted in place');
});

test('an empty or non-finite sample is refused, never answered with 0 or NaN', () => {
  assert.throws(() => median([]), /empty/i);
  assert.throws(() => percentile([], 95), /empty/i);
  assert.throws(() => summarize([1, Number.NaN]), /finite/i);
  assert.throws(() => percentile([1, 2], 101), /between/i);
});
