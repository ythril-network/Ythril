/**
 * The predicates the import does not keep (Q-759), found by counting what the variant states per predicate and what
 * the Ythril instance answers per predicate, never by a list typed for the benchmark.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPredicates, countQuery, notTakenOf } from './not-taken.mjs';

const P = (n) => `http://example.org/${n}`;
const line = (s, p, o) => `<http://example.org/s${s}> <${P(p)}> ${o} .`;

test('the variant is counted per predicate, one statement per line', () => {
  const counts = countPredicates([
    line(1, 'a', '"x"'), line(2, 'a', '"y"'), line(1, 'b', '<http://example.org/s2>'),
    line(1, 'c', '"7"^^<http://example.org/usd>'), '', '# a comment',
  ]);
  assert.deepEqual(counts, { [P('a')]: 2, [P('b')]: 1, [P('c')]: 1 });
});

test('a literal holding a space or an escaped quote is no second predicate', () => {
  const counts = countPredicates([line(1, 'a', '"a <http://example.org/z> b"'), line(1, 'a', '"say \\"hi\\" ."')]);
  assert.deepEqual(counts, { [P('a')]: 2 });
});

test('a line that is no statement is refused, never skipped', () => {
  assert.throws(() => countPredicates(['<http://example.org/s> nonsense']), /statement/);
  assert.throws(() => countPredicates(['<http://example.org/s> <http://example.org/p>']), /statement/, 'no object');
});

test('a predicate the instance holds fewer statements of than the variant states is not taken, with both counts', () => {
  const taken = notTakenOf({ [P('a')]: 10, [P('b')]: 20, [P('c')]: 5 }, { [P('a')]: 10, [P('b')]: 0, [P('c')]: 3 });
  assert.deepEqual(taken, { [P('b')]: { statements: 20, held: 0 }, [P('c')]: { statements: 5, held: 3 } });
});

test('more statements than the variant states (the system ones) is no loss', () => {
  assert.deepEqual(notTakenOf({ [P('a')]: 10 }, { [P('a')]: 14 }), {});
});

test('a predicate the instance gave no count for is refused: absent is not zero held', () => {
  assert.throws(() => notTakenOf({ [P('a')]: 10 }, {}), /a/);
});

test('the count query asks for one predicate by its full IRI', () => {
  assert.equal(countQuery(P('a')), `SELECT (COUNT(*) AS ?n) WHERE { ?s <${P('a')}> ?o }`);
  assert.throws(() => countQuery('x> . } DELETE'), /IRI/);
});
