/**
 * A SPARQL CSV or TSV answer writes every term the way its format says (bundle-271, Q-757, review m4; design r2 R2.2).
 *
 * ## The rules
 *
 * 1. **CSV** (SPARQL 1.1 CSV, RFC 4180): a term is its plain value; a field holding a comma, a quote or a line break (CR or LF) is quoted
 *    with its quotes doubled; a language tag and a datatype are not written; a blank node is `_:label`.
 * 2. **TSV** (SPARQL 1.1 TSV): a term is in Turtle syntax; a tab, a line break, a quote and a backslash in a literal are escaped, so one
 *    row stays one line; a character an IRI cannot hold (`>`, a space, a quote) is a `\uXXXX` escape, so no IRI ends early; a language tag is
 *    `@lang`, a datatype `^^<iri>`; a blank node is `_:label`.
 *
 * Written from the format, not from the writer's own output: each expected text is spelled out.
 *
 * ## Seen red
 *
 * Mutations of the writer: `csvField` without the comma in its quoting test (rule 1: a comma splits a field); `iriRef` without `>` in its
 * escaped set (rule 2: an IRI holding `>` ends early).
 *
 * Run: npm run build:server, then node --test testing/standalone/a-sparql-csv-and-tsv-answer-escapes-every-term.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
let answer;

/** A SELECT answer in `type`: the rendered text. */
function render(type, vars, rows) {
  const { renderSparql } = needModule(answer, ['renderSparql'], 'the SPARQL answer');
  const out = renderSparql({ resultType: type, graphFormat: null }, { form: 'select', vars, rows });
  assert.equal(typeof out.body, 'string', `refused: ${JSON.stringify(out)}`);
  return out.body;
}
const uri = (value) => ({ type: 'uri', value });
const lit = (value, extra = {}) => ({ type: 'literal', value, ...extra });

describe('a SPARQL CSV and TSV answer escapes every term', () => {
  before(async () => { answer = await loadDistModule('../../server/dist/rdf/sparql-answer.js', import.meta.url); });

  it('CSV quotes a field holding a comma, a quote, a CR or an LF, and writes plain values for the rest', () => {
    const csv = render('text/csv', ['a', 'b'], [
      { a: lit('x,y'), b: lit('say "hi"') },
      { a: lit('line1\r\nline2'), b: lit('lone\nlf') },
      { a: lit('lone\rcr'), b: lit('tab\there') },
      { a: lit('hello', { 'xml:lang': 'en' }), b: lit('42', { datatype: XSD_INTEGER }) },
      { a: uri('http://example.org/a>b'), b: { type: 'bnode', value: 'b0' } },
      { a: uri('http://example.org/p,q') },
    ]);
    assert.equal(csv, [
      'a,b',
      '"x,y","say ""hi"""',
      '"line1\r\nline2","lone\nlf"',
      '"lone\rcr",tab\there',
      'hello,42',
      'http://example.org/a>b,_:b0',
      '"http://example.org/p,q",',
    ].join('\r\n') + '\r\n');
  });

  it('TSV writes Turtle syntax, one line per row, escaping a tab, a break, a quote, a backslash and what an IRI cannot hold', () => {
    const tsv = render('text/tab-separated-values', ['a', 'b'], [
      { a: lit('x\ty'), b: lit('say "hi"') },
      { a: lit('l1\nl2'), b: lit('l1\rl2') },
      { a: lit('back\\slash'), b: lit('é') },
      { a: lit('hello', { 'xml:lang': 'en-GB' }), b: lit('42', { datatype: XSD_INTEGER }) },
      { a: uri('http://example.org/a>b'), b: { type: 'bnode', value: 'b0' } },
      { a: uri('http://example.org/sp ace"q'), b: lit('1', { datatype: 'http://example.org/dt>x' }) },
      { b: lit('only b') },
    ]);
    assert.equal(tsv, [
      '?a\t?b',
      '"x\\ty"\t"say \\"hi\\""',
      '"l1\\nl2"\t"l1\\rl2"',
      '"back\\\\slash"\t"é"',
      '"hello"@en-GB\t"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
      '<http://example.org/a\\u003Eb>\t_:b0',
      '<http://example.org/sp\\u0020ace\\u0022q>\t"1"^^<http://example.org/dt\\u003Ex>',
      '\t"only b"',
    ].join('\n') + '\n');
    assert.equal(tsv.split('\n').length, 9, 'a row of the answer is not one line');
  });
});
