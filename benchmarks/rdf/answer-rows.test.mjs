/**
 * The row count of an answer (Q-759): rows of a result set, and for a graph answer (Q9 DESCRIBE, Q12 CONSTRUCT)
 * the statements in it, counted by parsing the text on both engines, so Turtle and N-Triples are comparable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countRows } from './answer-rows.mjs';

const TURTLE = `@prefix ex: <http://ex.test/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:a ex:p ex:b, ex:c ;
     ex:q "text"@en, 5 ;
     a ex:Thing .
ex:b ex:p [ ex:q "blank" ] .
`;

test('a Turtle answer is counted by its statements: lists, prefixes and blank nodes included', () => {
  // ex:a: p b, p c, q "text", q 5, type = 5; ex:b: p _:x = 1; _:x: q "blank" = 1.
  assert.equal(countRows(TURTLE, 'text/turtle'), 7);
});

test('an N-Triples answer is counted by its statements, comments and blank lines left out', () => {
  const nt = '# a comment\n<http://ex.test/a> <http://ex.test/p> "x" .\n\n<http://ex.test/a> <http://ex.test/p> "y" .\n';
  assert.equal(countRows(nt, 'application/n-triples'), 2);
});

test('the same graph in Turtle and in N-Triples has one count', () => {
  const nt = [
    '<http://ex.test/a> <http://ex.test/p> <http://ex.test/b> .', '<http://ex.test/a> <http://ex.test/p> <http://ex.test/c> .',
    '<http://ex.test/a> <http://ex.test/q> "text"@en .', '<http://ex.test/a> <http://ex.test/q> "5"^^<http://www.w3.org/2001/XMLSchema#integer> .',
    '<http://ex.test/a> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://ex.test/Thing> .',
  ].join('\n');
  assert.equal(countRows(nt, 'application/n-triples'), countRows(TURTLE.split('ex:b ex:p [')[0], 'text/turtle'));
});

test('a statement stated twice is one statement', () => {
  const nt = '<http://ex.test/a> <http://ex.test/p> "x" .\n<http://ex.test/a> <http://ex.test/p> "x" .\n';
  assert.equal(countRows(nt, 'application/n-triples'), 1);
  assert.equal(countRows('@prefix ex: <http://ex.test/> . ex:a ex:p "x" . ex:a ex:p "x" .', 'text/turtle'), 1);
});

test('an empty graph is zero statements, not no count', () => {
  assert.equal(countRows('', 'application/n-triples'), 0);
  assert.equal(countRows('@prefix ex: <http://ex.test/> .\n', 'text/turtle'), 0);
});

test('a graph answer that does not parse is an error, never a count', () => {
  assert.throws(() => countRows('this is not turtle at all', 'text/turtle'), /unparsable|parse|Unexpected/i);
  assert.throws(() => countRows('<http://ex.test/a> <http://ex.test/p> "x"\n', 'application/n-triples'), /unparsable|parse|Unexpected/i);
});

test('a result set is its bindings, an ASK is one, and text that is no JSON is an error', () => {
  assert.equal(countRows(JSON.stringify({ head: { vars: ['a'] }, results: { bindings: [{}, {}, {}] } }), 'application/sparql-results+json'), 3);
  assert.equal(countRows(JSON.stringify({ head: {}, results: { bindings: [] } }), 'application/sparql-results+json'), 0);
  assert.equal(countRows(JSON.stringify({ head: {}, boolean: false }), 'application/sparql-results+json'), 1);
  assert.throws(() => countRows('<html>', 'application/sparql-results+json'), /unparsable|JSON/i);
});
