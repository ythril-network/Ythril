/**
 * What a query's text says about the data it needs (Q-759): the predicates it names, expanded through its own
 * PREFIX lines, and whether it reads a whole record. The reason a query is not comparable is derived from these,
 * never typed per query.
 *
 * Run: node --test testing/standalone/bsbm-harness-query-shape.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predicatesOf, readsWholeRecord } from '../../benchmarks/rdf/query-shape.mjs';

const BSBM = 'http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/vocabulary/';
const DC = 'http://purl.org/dc/elements/1.1/';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

const Q10 = `PREFIX bsbm: <${BSBM}>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX dc: <${DC}>

SELECT DISTINCT ?offer ?price
WHERE {
	?offer bsbm:product %ProductXYZ% .
    ?offer dc:publisher ?vendor .
	?vendor bsbm:country <http://downlode.org/rdf/iso-3166/countries#US> .
	?offer bsbm:price ?price .
}
ORDER BY xsd:double(str(?price))
LIMIT 10`;

const Q9 = `PREFIX rev: <http://purl.org/stuff/rev#>

DESCRIBE ?x
WHERE { %ReviewXYZ% rev:reviewer ?x }`;

const Q11 = `SELECT ?property ?hasValue ?isValueOf
WHERE {
  { %OfferXYZ% ?property ?hasValue }
  UNION
  { ?isValueOf ?property %OfferXYZ% }
}`;

const Q1 = `PREFIX bsbm: <${BSBM}>
PREFIX rdfs: <${RDFS}>
SELECT DISTINCT ?product ?label
WHERE {
    ?product rdfs:label ?label .
    ?product a %ProductType% .
    ?product bsbm:productFeature %ProductFeature1% .
    FILTER (?value1 > %x%)
}
ORDER BY ?label
LIMIT 10`;

test('a prefixed name is expanded through the query\'s own PREFIX lines, a full IRI is kept', () => {
  const found = predicatesOf(Q10);
  for (const iri of [`${BSBM}product`, `${DC}publisher`, `${BSBM}country`, `${BSBM}price`]) assert.ok(found.includes(iri), iri);
  assert.ok(found.includes('http://downlode.org/rdf/iso-3166/countries#US'));
});

test('the PREFIX declarations themselves, variables and %placeholders% are no predicate', () => {
  const found = predicatesOf(Q1);
  assert.deepEqual(found, [`${BSBM}productFeature`, `${RDFS}label`].sort());
  assert.ok(!found.some((i) => i.endsWith('#') || i.includes('%')));
});

test('a property path\'s predicate is named without its operator', () => {
  const q = `PREFIX rdfs: <${RDFS}>\nSELECT ?c WHERE { %X% rdfs:subClassOf* ?c }`;
  assert.deepEqual(predicatesOf(q), [`${RDFS}subClassOf`]);
});

test('a prefixed name inside a string or a comment is no mention', () => {
  const q = `PREFIX dc: <${DC}>\n# dc:publisher is not asked\nSELECT ?s WHERE { ?s dc:date "dc:publisher" }`;
  assert.deepEqual(predicatesOf(q), [`${DC}date`]);
});

test('a prefix the query does not declare is refused, never guessed', () => {
  assert.throws(() => predicatesOf('SELECT ?s WHERE { ?s nope:thing ?o }'), /nope/);
});

test('a DESCRIBE reads a whole record', () => {
  assert.equal(readsWholeRecord(Q9), true);
});

test('a pattern with a variable predicate on a bound subject, or a bound object, reads a whole record', () => {
  assert.equal(readsWholeRecord(Q11), true);
  assert.equal(readsWholeRecord('SELECT ?p ?o WHERE { <http://x/a> ?p ?o }'), true);
  assert.equal(readsWholeRecord('SELECT ?s ?p WHERE { ?s ?p <http://x/a> }'), true);
});

test('a query that names every predicate reads no whole record, and a SELECT variable list is no pattern', () => {
  assert.equal(readsWholeRecord(Q1), false);
  assert.equal(readsWholeRecord(Q10), false);
  assert.equal(readsWholeRecord('SELECT ?a ?b ?c WHERE { ?a <http://x/p> ?b . ?b <http://x/q> ?c } ORDER BY ?a ?b ?c'), false);
});

test('a pattern starts after { } or a full stop: terms after a keyword are no pattern', () => {
  assert.equal(readsWholeRecord('SELECT ?s WHERE { ?s <http://x/p> ?o } GROUP BY ?s ?o <http://x/a>'), false);
  assert.equal(readsWholeRecord('SELECT ?s WHERE { ?s <http://x/p> ?o . <http://x/a> ?p ?v }'), true, 'after a full stop it is one');
});

test('a comment between the terms of a pattern does not break it', () => {
  assert.equal(readsWholeRecord('SELECT ?p ?o WHERE { <http://x/a> # the record\n ?p ?o }'), true);
});

test('a pattern of three variables is a scan of everything, not a read of one record', () => {
  assert.equal(readsWholeRecord('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5'), false);
});
