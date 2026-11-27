/**
 * The size under a type cap (Q-759): the import refused a kind with more than 200 types until Q-981 removed that limit; the
 * largest product count whose generated data keeps its type count under a given cap is found by a binary search over the generator's
 * output, not by loading. The search is driven with a counting function; the counter reads N-Triples.
 *
 * Run: node --test testing/standalone/bsbm-harness-typecap.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTypes, largestUnderCap } from '../../benchmarks/rdf/typecap.mjs';

test('the largest size whose type count is under the cap is found, and the count function is asked only O(log) times', () => {
  const calls = [];
  const count = (n) => { calls.push(n); return Math.floor(n / 10); };
  // count(n) < 200 exactly for n < 2000.
  assert.equal(largestUnderCap(count, { lo: 1000, hi: 5000, cap: 200 }).size, 1999);
  assert.ok(calls.length <= 14, `asked ${calls.length} times`);
});

test('the answer carries the type count measured at the chosen size', () => {
  const r = largestUnderCap((n) => Math.floor(n / 10) + 3, { lo: 1000, hi: 5000, cap: 200 });
  assert.deepEqual(r, { size: 1969, types: 199 });
});

test('a count of exactly the cap is not under it', () => {
  assert.equal(largestUnderCap((n) => (n >= 3000 ? 200 : 199), { lo: 1000, hi: 5000, cap: 200 }).size, 2999);
});

test('when even the smallest size is not under the cap, or the largest already is, the search says so rather than guessing', () => {
  assert.throws(() => largestUnderCap(() => 250, { lo: 1000, hi: 5000, cap: 200 }), /smallest/);
  assert.deepEqual(largestUnderCap(() => 50, { lo: 1000, hi: 5000, cap: 200 }), { size: 5000, types: 50 });
});

test('types are the distinct classes of rdf:type statements, however many subjects state each', () => {
  const t = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';
  const nt = [
    `<http://ex.test/a> ${t} <http://ex.test/C1> .`, `<http://ex.test/b> ${t} <http://ex.test/C1> .`, `<http://ex.test/c> ${t} <http://ex.test/C2> .`,
    '<http://ex.test/c> <http://ex.test/p> <http://ex.test/C3> .', '# comment', '',
  ].join('\n');
  assert.equal(countTypes(nt), 2);
});
