/**
 * Whether each query of a Ythril run is comparable with Oxigraph's (Q-759), one query at a time: comparable when the
 * row counts match on every run, else not, with one reason from a fixed list derived from the data the import does
 * not keep and from the query's shape.
 *
 * Run: node --test testing/standalone/bsbm-harness-comparability.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, judgeComparability } from '../../benchmarks/rdf/comparability.mjs';

const BSBM = 'http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/vocabulary/';
const DC = 'http://purl.org/dc/elements/1.1/';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

const ok = (rows, per) => ({ median: 3, p95: 4, n: 20, errors: 0, rows, ...(per ? { rowsPerRun: per } : {}) });
const failed = (code) => ({ n: 0, errors: 23, error: { code, status: 500, message: 'x' } });

const T = {
  Q1: { text: `PREFIX rdfs: <${RDFS}>\nSELECT ?p WHERE { ?p rdfs:label ?l }`, form: 'SELECT' },
  Q2: { text: `PREFIX dc: <${DC}>\nSELECT ?p WHERE { ?p dc:publisher ?v }`, form: 'SELECT' },
  Q9: { text: 'DESCRIBE ?x WHERE { %ReviewXYZ% <http://purl.org/stuff/rev#reviewer> ?x }', form: 'DESCRIBE' },
  Q11: { text: 'SELECT ?p ?v WHERE { %OfferXYZ% ?p ?v }', form: 'SELECT' },
  Q12: { text: `PREFIX bsbm: <${BSBM}>\nCONSTRUCT { ?o bsbm:price ?x } WHERE { ?o bsbm:price ?x }`, form: 'CONSTRUCT' },
};
const NOT_TAKEN = { [`${DC}publisher`]: { statements: 100, held: 0 }, [`${BSBM}price`]: { statements: 50, held: 0 } };

const judge = (ox, yt, over = {}) => judgeComparability({ oxigraph: ox, ythril: yt, templates: T, notTaken: NOT_TAKEN, ...over });

test('a query whose row counts match on every run is comparable, with no reason', () => {
  const r = judge({ Q1: ok(5, [5, 6]) }, { Q1: ok(5, [5, 6]) });
  assert.deepEqual(r.queries.Q1, { comparable: true });
  assert.equal(r.valid, true);
  assert.deepEqual(r.differing, []);
});

test('a query differing on a predicate the import does not keep is data-not-held, naming the predicates', () => {
  const r = judge({ Q2: ok(15) }, { Q2: ok(0) });
  assert.deepEqual(r.queries.Q2, { comparable: false, reason: 'data-not-held', predicates: [`${DC}publisher`] });
});

test('a whole-record query that answers more than Oxigraph on every differing run is system-statements', () => {
  const r = judge({ Q9: ok(7, [7, 8]), Q11: ok(11, [11, 11]) }, { Q9: ok(11, [11, 12]), Q11: ok(14, [14, 11]) });
  assert.deepEqual(r.queries.Q9, { comparable: false, reason: 'system-statements' });
  assert.deepEqual(r.queries.Q11, { comparable: false, reason: 'system-statements' });
});

test('a whole-record query that answers fewer rows than Oxigraph on a run is rows-differ: added statements do not explain it', () => {
  const r = judge({ Q11: ok(11, [11, 11]) }, { Q11: ok(14, [14, 9]) });
  assert.equal(r.queries.Q11.reason, 'rows-differ');
});

test('any other mismatch is rows-differ, with the counts and the first differing run', () => {
  const r = judge({ Q1: ok(5, [5, 6, 7]) }, { Q1: ok(5, [5, 6, 8]) });
  assert.deepEqual(r.queries.Q1, { comparable: false, reason: 'rows-differ', differing: { query: 'Q1', oxigraph: 7, ythril: 8, run: 2 } });
});

test('a query that errored has no count: rows-differ, even when it names a predicate the import does not keep', () => {
  const r = judge({ Q1: ok(0), Q2: ok(3) }, { Q1: failed('timeout'), Q2: failed('timeout') });
  assert.equal(r.queries.Q1.reason, 'rows-differ');
  assert.equal(r.queries.Q2.reason, 'rows-differ');
});

test('a mismatch on a query that names a not-held predicate and reads a whole record is data-not-held: the named data comes first', () => {
  const t = { ...T, Q12: { text: `PREFIX dc: <${DC}>\nSELECT ?v WHERE { %X% dc:publisher ?v . %X% ?p ?o }`, form: 'SELECT' } };
  const r = judge({ Q12: ok(9) }, { Q12: ok(4) }, { templates: t });
  assert.equal(r.queries.Q12.reason, 'data-not-held');
});

test('a not-held predicate explains fewer rows only: Ythril answering more is rows-differ', () => {
  const r = judge({ Q2: ok(3) }, { Q2: ok(8) });
  assert.equal(r.queries.Q2.reason, 'rows-differ');
});

test('a predicate the import holds in full is no reason: the same mismatch is rows-differ', () => {
  const r = judge({ Q2: ok(15) }, { Q2: ok(0) }, { notTaken: {} });
  assert.equal(r.queries.Q2.reason, 'rows-differ');
});

test('valid is: every query comparable or named data-not-held or system-statements; rows-differ makes it false and is listed', () => {
  const ox = { Q1: ok(5), Q2: ok(15), Q9: ok(7) };
  const named = judge(ox, { Q1: ok(5), Q2: ok(0), Q9: ok(11) });
  assert.equal(named.valid, true);
  assert.deepEqual(named.differing, []);
  const finding = judge(ox, { Q1: ok(6), Q2: ok(0), Q9: ok(11) });
  assert.equal(finding.valid, false);
  assert.deepEqual(finding.differing, [{ query: 'Q1', oxigraph: 5, ythril: 6 }]);
});

test('a query with no template cannot be given a derived reason: it is refused, not guessed', () => {
  assert.throws(() => judge({ Q99: ok(1) }, { Q99: ok(2) }), /Q99/);
});

test('the reasons are the three of the fixed list', () => {
  assert.deepEqual([...REASONS], ['data-not-held', 'system-statements', 'rows-differ']);
});
