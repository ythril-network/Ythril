/**
 * Which kind of SPARQL query a BSBM template is decides what the harness asks the engine to send back: a
 * SELECT answers result rows, DESCRIBE (Q9) and CONSTRUCT (Q12) answer a graph. Asking a graph query for
 * `application/sparql-results+json` makes an engine answer 406 for two of the eleven queries, and the
 * table then shows two errors that are the harness's, not the engine's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryForm, acceptFor, EXPLORE_NUMBERS } from './queries.mjs';

test('the form is the first keyword after the prologue, whatever the prefixes and comments say', () => {
  assert.equal(queryForm('PREFIX a: <http://a/>\nSELECT ?x WHERE { ?x ?p ?o }'), 'SELECT');
  assert.equal(queryForm('PREFIX rev: <http://purl.org/stuff/rev#>\n\nDESCRIBE ?x\nWHERE { <a> rev:reviewer ?x }'), 'DESCRIBE');
  assert.equal(queryForm('# SELECT in a comment\nPREFIX a: <http://a/>\nCONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }'), 'CONSTRUCT');
  assert.equal(queryForm('select distinct ?x where { ?x ?p ?o }'), 'SELECT');
  assert.equal(queryForm('SELECT ?property WHERE { <a> ?property ?v }'), 'SELECT');
});

test('a text with no query form is refused', () => {
  assert.throws(() => queryForm('PREFIX a: <http://a/>'), /form/i);
});

test('rows are asked for as SPARQL JSON and graphs as N-Triples', () => {
  assert.equal(acceptFor('SELECT'), 'application/sparql-results+json');
  assert.equal(acceptFor('ASK'), 'application/sparql-results+json');
  assert.equal(acceptFor('DESCRIBE'), 'application/n-triples');
  assert.equal(acceptFor('CONSTRUCT'), 'application/n-triples');
  assert.throws(() => acceptFor('UPDATE'), /form/i);
});

test('Ythril is asked for Turtle where Oxigraph is asked for N-Triples: its endpoint answers a graph as Turtle, N-Quads or JSON-LD', () => {
  for (const form of ['DESCRIBE', 'CONSTRUCT']) {
    assert.equal(acceptFor(form, 'ythril'), 'text/turtle');
    assert.equal(acceptFor(form, 'oxigraph'), 'application/n-triples');
    assert.equal(acceptFor(form), 'application/n-triples', 'the default engine is Oxigraph');
  }
  for (const form of ['SELECT', 'ASK']) assert.equal(acceptFor(form, 'ythril'), 'application/sparql-results+json');
  assert.throws(() => acceptFor('CONSTRUCT', 'virtuoso'), /engine/i);
});

test('the Explore mix is eleven queries: Q6 was removed from BSBM', () => {
  assert.deepEqual(EXPLORE_NUMBERS, [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]);
});
