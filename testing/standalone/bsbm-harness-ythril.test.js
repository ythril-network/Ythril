/**
 * What the result record says when the RDF import door does not take the file. A refusal that is polled to its end
 * answers `200` with a report whose status is `refused`; the record must still carry the door's own refusal code
 * and the reasons with their counts, not the word "refused" and a clipped JSON string.
 *
 * Run: node --test testing/standalone/bsbm-harness-ythril.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRefusal } from '../../benchmarks/rdf/ythril.mjs';

test('a polled refusal is recorded as rdf_import_refused with every reason code and its count', () => {
  const report = { status: 'refused', reasonCount: 90503, reasonsByCode: { plan_refused: 30503, schema_violation: 60000 } };
  const r = describeRefusal({ status: 200, json: { report }, text: '{"huge":"json"}' });
  assert.equal(r.code, 'rdf_import_refused');
  assert.match(r.message, /plan_refused 30503/);
  assert.match(r.message, /schema_violation 60000/);
  assert.doesNotMatch(r.message, /huge/);
});

test('a 409 refusal keeps the code the door sent', () => {
  const r = describeRefusal({ status: 409, json: { code: 'rdf_import_refused', error: 'refused', report: { reasonsByCode: { 'no-kind': 3 } } }, text: '' });
  assert.equal(r.code, 'rdf_import_refused');
  assert.match(r.message, /no-kind 3/);
});

test('another refusal (a bound, a bad parameter) keeps its own code and message', () => {
  const r = describeRefusal({ status: 413, json: { code: 'rdf_bound_exceeded', error: 'too many subjects' }, text: '' });
  assert.deepEqual(r, { code: 'rdf_bound_exceeded', message: 'too many subjects' });
});

test('an act ended as an input failure is recorded with the code its report keeps under failure', () => {
  const report = { status: 'failed', failure: { status: 413, code: 'rdf_memory_exceeded', detail: 'the index passed room' } };
  for (const json of [{ report }, report]) {
    const r = describeRefusal({ status: 200, json, text: '{"huge":"json"}' });
    assert.equal(r.code, 'rdf_memory_exceeded');
  }
});

test('an answer that is not JSON is recorded as unknown, with its text', () => {
  const r = describeRefusal({ status: 502, json: null, text: 'Bad Gateway' });
  assert.deepEqual(r, { code: 'unknown', message: 'Bad Gateway' });
});
