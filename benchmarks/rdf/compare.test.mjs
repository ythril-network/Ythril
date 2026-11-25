/**
 * The side-by-side table of an Oxigraph record and a Ythril record of the same size and variant, with every query
 * more than 10 times slower than Oxigraph marked. Cases build two records and read the rendered text and rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRecords, renderComparison } from './compare.mjs';

const SHA = 'c'.repeat(64);
const q = (median, p95 = median * 2) => ({ median, p95, n: 20, errors: 0, rows: 5 });

function record(engine, queries, over = {}) {
  return {
    outcome: 'ok', engine, size: 1000, ythrilCommit: '2bfffd806', oxigraphDigest: 'sha256:aa',
    dataset: { variant: 'ythril-loadable-1', triples: 370911, sha256: SHA },
    loadMs: engine === 'oxigraph' ? 900 : 20000, valid: true, queries, ...over,
  };
}

const rowOf = (cmp, name) => cmp.rows.find((r) => r.query === name);

test('the ratio is Ythril over Oxigraph on the median', () => {
  const cmp = compareRecords(record('oxigraph', { Q1: q(2) }), record('ythril', { Q1: q(25) }));
  assert.equal(rowOf(cmp, 'Q1').ratioMedian, 12.5);
});

test('a query is marked only when it is MORE than 10 times slower: ten times exactly is not', () => {
  const cmp = compareRecords(
    record('oxigraph', { Q1: q(2), Q2: q(2), Q3: q(2) }),
    record('ythril', { Q1: q(20), Q2: q(20.02), Q3: q(19.98) }),
  );
  assert.equal(rowOf(cmp, 'Q1').slower, false);
  assert.equal(rowOf(cmp, 'Q2').slower, true);
  assert.equal(rowOf(cmp, 'Q3').slower, false);
  assert.deepEqual(cmp.slower, ['Q2']);
});

test('the mark follows the median, not the p95 and not the other direction', () => {
  const cmp = compareRecords(
    record('oxigraph', { Q1: q(2, 4), Q2: q(2, 4), Q3: q(20) }),
    record('ythril', { Q1: q(10, 400), Q2: q(30, 8), Q3: q(2) }),
  );
  assert.equal(rowOf(cmp, 'Q1').slower, false, 'median ratio 5, p95 ratio 100');
  assert.equal(rowOf(cmp, 'Q1').ratioP95, 100);
  assert.equal(rowOf(cmp, 'Q2').slower, true, 'median ratio 15, p95 ratio 2');
  assert.equal(rowOf(cmp, 'Q3').slower, false, 'Ythril faster');
});

test('a query Ythril answered with an error is its own row, not a fast one and not a slow one', () => {
  const cmp = compareRecords(
    record('oxigraph', { Q1: q(2), Q2: q(2) }),
    record('ythril', { Q1: { n: 0, errors: 23, error: { code: 404, status: 404, message: 'Not Found' } }, Q2: q(3) }),
  );
  const r = rowOf(cmp, 'Q1');
  assert.equal(r.slower, false);
  assert.equal(r.ratioMedian, null);
  assert.match(r.note, /404/);
  assert.deepEqual(cmp.noAnswer, ['Q1']);
  assert.match(renderComparison(record('oxigraph', { Q1: q(2) }), record('ythril', { Q1: { n: 0, errors: 23, error: { code: 404, status: 404, message: 'Not Found' } } })), /error 404/);
});

test('a query only one record holds is a row saying so', () => {
  const cmp = compareRecords(record('oxigraph', { Q1: q(2), Q2: q(2) }), record('ythril', { Q1: q(3) }));
  assert.match(rowOf(cmp, 'Q2').note, /not in the ythril record/i);
  assert.deepEqual(cmp.noAnswer, ['Q2']);
});

test('records that are not of one size, one variant and one pair of engines are refused', () => {
  const ox = record('oxigraph', { Q1: q(2) });
  const yt = record('ythril', { Q1: q(2) });
  assert.throws(() => compareRecords(ox, { ...yt, size: 5000 }), /size/);
  assert.throws(() => compareRecords(ox, { ...yt, dataset: { ...yt.dataset, sha256: 'd'.repeat(64) } }), /sha256|variant/);
  assert.throws(() => compareRecords(ox, { ...yt, dataset: { ...yt.dataset, variant: 'ythril-loadable-2' } }), /variant/);
  assert.throws(() => compareRecords(yt, ox), /first record must be the oxigraph run/);
  assert.throws(() => compareRecords(yt, yt), /first record must be the oxigraph run/);
  assert.throws(() => compareRecords(ox, ox), /second record must be the ythril run/);
  assert.throws(() => compareRecords({ ...ox, dataset: undefined }, yt), /dataset|variant/);
});

test('the table lists queries in number order and shows both engines side by side, with the marked ones named', () => {
  const names = ['Q1', 'Q2', 'Q9', 'Q10', 'Q11'];
  const ox = record('oxigraph', Object.fromEntries(names.map((n) => [n, q(2, 3)])));
  const yt = record('ythril', Object.fromEntries(names.map((n) => [n, q(n === 'Q10' ? 40 : 4, 9)])));
  const text = renderComparison(ox, yt);
  const order = [...text.matchAll(/^\| (Q\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(order, ['Q1', 'Q2', 'Q9', 'Q10', 'Q11']);
  const line = text.split('\n').find((l) => l.startsWith('| Q10 '));
  assert.match(line, /2\.00/);
  assert.match(line, /40\.00/);
  assert.match(line, /20\.0x/);
  assert.match(line, />10x slower/);
  assert.doesNotMatch(text.split('\n').find((l) => l.startsWith('| Q1 ')), /slower/);
  assert.match(text, /more than 10x slower than Oxigraph: Q10 \(1 of 5\)/);
});

test('with none marked the summary says none, and the factor can be changed', () => {
  const ox = record('oxigraph', { Q1: q(2) });
  const yt = record('ythril', { Q1: q(6) });
  assert.match(renderComparison(ox, yt), /more than 10x slower than Oxigraph: none \(0 of 1\)/);
  const strict = renderComparison(ox, yt, { factor: 2 });
  assert.match(strict, /more than 2x slower than Oxigraph: Q1 \(1 of 1\)/);
});

test('the header carries the size, the variant with its sha256 and both load times, or the load refusal', () => {
  const ox = record('oxigraph', { Q1: q(2) });
  const ok = renderComparison(ox, record('ythril', { Q1: q(3) }));
  assert.match(ok, /1000 products/);
  assert.match(ok, new RegExp(`ythril-loadable-1.*${SHA}`));
  assert.match(ok, /Oxigraph loaded in 900 ms/);
  assert.match(ok, /Ythril loaded in 20000 ms/);
  const refused = renderComparison(ox, record('ythril', { Q1: q(3) }, { loadMs: null, loadRefusal: { status: 200, code: 'rdf_import_refused', message: 'reasons: plan_refused 5' } }));
  assert.match(refused, /Ythril load refused: rdf_import_refused/);
});

const invalidYthril = (queries = { Q1: q(3), Q5: q(3) }) => record('ythril', queries, {
  valid: false, invalidQueries: [{ query: 'Q1', oxigraph: 10, ythril: 0 }, { query: 'Q5', oxigraph: 1, ythril: null }],
});

test('a record that is not valid is refused, naming the differing queries, unless the caller asks to see it', () => {
  const ox = record('oxigraph', { Q1: q(2), Q5: q(2) });
  assert.throws(() => compareRecords(ox, invalidYthril()), (err) => /invalid/i.test(err.message) && /Q1/.test(err.message) && /Q5/.test(err.message));
  assert.throws(() => renderComparison(ox, invalidYthril()), /invalid/i);
  assert.doesNotThrow(() => compareRecords(ox, invalidYthril(), { showInvalid: true }));
});

test('an invalid record shown on request carries the INVALID header, with the queries and both counts', () => {
  const ox = record('oxigraph', { Q1: q(2), Q5: q(2) });
  const text = renderComparison(ox, invalidYthril(), { showInvalid: true });
  assert.match(text.split('\n')[0], /^INVALID/);
  assert.match(text, /Q1 \(Oxigraph 10 rows, Ythril 0\)/);
  assert.match(text, /Q5 \(Oxigraph 1 rows?, Ythril no answer\)/);
  assert.doesNotMatch(renderComparison(ox, record('ythril', { Q1: q(3), Q5: q(3) })), /INVALID/);
});

test('a record that was never judged is refused as well: it cannot be told from a valid one', () => {
  const ox = record('oxigraph', { Q1: q(2) });
  const { valid: _v, ...unjudged } = record('ythril', { Q1: q(3) });
  assert.throws(() => compareRecords(ox, unjudged), /not been judged|valid/i);
  assert.throws(() => compareRecords({ ...ox, valid: undefined }, record('ythril', { Q1: q(3) })), /valid/i);
});

test('the table shows the rows each engine answered, beside the times', () => {
  const ox = record('oxigraph', { Q1: { ...q(2), rows: 10 } });
  const yt = record('ythril', { Q1: { ...q(3), rows: 10 } });
  const line = renderComparison(ox, yt).split('\n').find((l) => l.startsWith('| Q1 '));
  assert.match(line, /\| 10 \| 10 \|/);
  assert.match(renderComparison(ox, yt), /Oxigraph rows \| Ythril rows/);
});
