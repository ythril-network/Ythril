/**
 * The validity of a Ythril run (Q-759): a run is valid only when every query answers the row count Oxigraph
 * answered at the same size and parameters; each differing query is named. A query that errored, or that a record
 * does not hold, has no count and differs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeValidity } from './validity.mjs';

const ok = (rows) => ({ median: 3, p95: 4, n: 20, errors: 0, rows });
const failed = (code) => ({ n: 0, errors: 23, error: { code, status: 500, message: 'x' } });

test('equal row counts on every query is valid, with nothing named', () => {
  const ox = { Q1: ok(10), Q2: ok(0), Q9: ok(7) };
  const yt = { Q1: ok(10), Q2: ok(0), Q9: ok(7) };
  assert.deepEqual(judgeValidity(ox, yt), { valid: true, differing: [] });
});

test('each query whose count differs is named with both counts, and the run is invalid', () => {
  const ox = { Q1: ok(10), Q2: ok(5), Q5: ok(1), Q9: ok(7) };
  const yt = { Q1: ok(0), Q2: ok(5), Q5: ok(2), Q9: ok(7) };
  assert.deepEqual(judgeValidity(ox, yt), {
    valid: false,
    differing: [{ query: 'Q1', oxigraph: 10, ythril: 0 }, { query: 'Q5', oxigraph: 1, ythril: 2 }],
  });
});

test('a graph answer counts like any other: a differing Q9 or Q12 makes the run invalid', () => {
  const r = judgeValidity({ Q9: ok(12), Q12: ok(40) }, { Q9: ok(12), Q12: ok(41) });
  assert.equal(r.valid, false);
  assert.deepEqual(r.differing.map((d) => d.query), ['Q12']);
});

test('a query Ythril errored on, or has no record of, differs from Oxigraph\'s rows, even when they are zero', () => {
  const r = judgeValidity({ Q1: ok(0), Q2: ok(3), Q3: ok(1) }, { Q1: failed(404), Q2: ok(null) });
  assert.equal(r.valid, false);
  assert.deepEqual(r.differing, [
    { query: 'Q1', oxigraph: 0, ythril: null }, { query: 'Q2', oxigraph: 3, ythril: null }, { query: 'Q3', oxigraph: 1, ythril: null },
  ]);
});

test('a query Oxigraph has no count for cannot be matched: the run is invalid', () => {
  const r = judgeValidity({ Q1: failed('timeout') }, { Q1: ok(4) });
  assert.equal(r.valid, false);
  assert.deepEqual(r.differing, [{ query: 'Q1', oxigraph: null, ythril: 4 }]);
});

test('when both records hold the count of every run, every run is compared, not only the first', () => {
  const run = (rows, per) => ({ ...ok(rows), rowsPerRun: per });
  assert.deepEqual(judgeValidity({ Q1: run(5, [5, 6, 7]) }, { Q1: run(5, [5, 6, 7]) }), { valid: true, differing: [] });
  assert.deepEqual(judgeValidity({ Q1: run(5, [5, 6, 7]), Q2: run(1, [1, 1]) }, { Q1: run(5, [5, 6, 8]), Q2: run(1, [1, 1]) }), {
    valid: false, differing: [{ query: 'Q1', oxigraph: 7, ythril: 8, run: 2 }],
  });
  const missing = judgeValidity({ Q1: run(5, [5, 6, 7]) }, { Q1: run(5, [5, null, 7]) });
  assert.deepEqual(missing.differing, [{ query: 'Q1', oxigraph: 6, ythril: null, run: 1 }], 'a run with no count is a difference');
});

test('the queries are named in number order, and there must be queries to compare', () => {
  const r = judgeValidity({ Q10: ok(1), Q2: ok(1), Q11: ok(1) }, { Q10: ok(2), Q2: ok(2), Q11: ok(2) });
  assert.deepEqual(r.differing.map((d) => d.query), ['Q2', 'Q10', 'Q11']);
  assert.throws(() => judgeValidity({}, {}), /no queries/);
});
