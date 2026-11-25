/**
 * Query-parameter substitution: a BSBM template has `%Name%` placeholders, the test driver supplies a value
 * for each, and the harness sends the filled query to both engines.
 *
 * A placeholder left in a query makes both engines answer a parse error, and the run still "completes";
 * a value that is itself read as a placeholder changes the query. Each case guards one of those.
 *
 * Run: node --test testing/standalone/bsbm-harness-params.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeholders, substitute, extractParams } from '../../benchmarks/rdf/params.mjs';

const TEMPLATE = [
  'SELECT ?product WHERE {',
  '  ?product a %ProductType% .',
  '  ?product bsbm:productFeature %ProductFeature1% .',
  '  ?product bsbm:productFeature %ProductFeature2% .',
  '  FILTER (?v > %x%) .',
  '  FILTER (%ProductType% != ?product)',
  '}',
].join('\n');

test('placeholders lists each name once, in order of first appearance', () => {
  assert.deepEqual(placeholders(TEMPLATE), ['ProductType', 'ProductFeature1', 'ProductFeature2', 'x']);
});

test('substitute fills every occurrence of a placeholder', () => {
  const out = substitute(TEMPLATE, {
    ProductType: '<http://example.org/T1>',
    ProductFeature1: '<http://example.org/F1>',
    ProductFeature2: '<http://example.org/F2>',
    x: '42',
  });
  assert.equal(out.includes('%'), false);
  assert.equal(out.split('<http://example.org/T1>').length - 1, 2);
  assert.match(out, /FILTER \(\?v > 42\)/);
});

test('a placeholder with no value is refused, never left in the query', () => {
  assert.throws(() => substitute(TEMPLATE, { ProductType: '<a>', ProductFeature1: '<b>', ProductFeature2: '<c>' }), /x/);
});

test('a value no placeholder uses is refused: it names a parameter the template does not have', () => {
  assert.throws(
    () => substitute('SELECT * WHERE { %A% ?p ?o }', { A: '<a>', B: '<b>' }),
    /B/,
  );
});

test('a value that looks like a placeholder is inserted as text and not substituted again', () => {
  const out = substitute('ASK { %A% ?p %B% }', { A: '"%B%"', B: '<b>' });
  assert.equal(out, 'ASK { "%B%" ?p <b> }');
});

test('extractParams reads back the values the driver put into a template, whatever the whitespace', () => {
  const driverQuery = [
    'SELECT ?product WHERE {',
    '    ?product a <http://example.org/T7> .',
    '\t?product bsbm:productFeature <http://example.org/F1> .',
    '    ?product bsbm:productFeature <http://example.org/F2> .',
    '  FILTER (?v > 1234) .',
    '  FILTER (<http://example.org/T7> != ?product)',
    '}',
  ].join('\n');
  assert.deepEqual(extractParams(TEMPLATE, driverQuery), {
    ProductType: '<http://example.org/T7>',
    ProductFeature1: '<http://example.org/F1>',
    ProductFeature2: '<http://example.org/F2>',
    x: '1234',
  });
});

test('extractParams refuses a query that is not an instance of the template, and one whose repeated value differs', () => {
  assert.throws(() => extractParams(TEMPLATE, 'SELECT * WHERE { ?s ?p ?o }'), /does not match/i);
  const differing = substitute(TEMPLATE, {
    ProductType: '<http://example.org/T1>',
    ProductFeature1: '<b>',
    ProductFeature2: '<c>',
    x: '1',
  }).replace('FILTER (<http://example.org/T1> !=', 'FILTER (<http://example.org/T2> !=');
  assert.throws(() => extractParams(TEMPLATE, differing), /does not match/i);
});
