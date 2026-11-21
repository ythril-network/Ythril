/**
 * An RDF data import with `schema` set takes as schema only the subjects that declare a type, a property or a shape, and only those of the
 * sources it was asked for (bundle-270, Q-955 fix round: findings F3 and F4).
 *
 * ## The doubt
 *
 * The selector (`isSchemaGroup`, `schemaGroupsOf` in `rdf/schema-from-rdf.ts`) decided "schema" by a namespace prefix: any `rdf:type` in the
 * OWL namespace, any predicate in the SHACL one. `ex:alice a owl:NamedIndividual, ex:Person`, an `owl:Thing` instance and a SHACL validation
 * report (`sh:result`, `sh:focusNode`) are data, yet were skipped as schema and dropped from the import. And `from` was not asked: with
 * `from: [shacl]` the `owl:Class` subjects were still taken out of the data and built nothing.
 *
 * ## What it holds
 *
 * - Each declaring class the mapping reads (an ontology, a class, each property kind, an RDFS class, an RDF property, a node shape, a property
 *   shape) makes its subject schema, and so does a declaring predicate a shape states with no type.
 * - A subject typed `owl:NamedIndividual` or `owl:Thing` beside a data class, and a SHACL validation report, are not schema.
 * - With `from: [shacl]` an `owl:Class` subject is skipped and named not asked, and only the shapes are mapped; with `from: [declared]` the
 *   reverse (Q-755 test 33, design revision 3, which replaces how F4 kept such groups as data).
 * - A blank node a selected group reaches is followed; one only an unselected group reaches is not.
 *
 * Run: node --test testing/standalone/the-rdf-import-takes-as-schema-only-what-declares-one.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readTrackedSources } from './_sources.mjs';

const { isSchemaGroup, schemaGroupsOf, SCHEMA_DECLARING_CLASSES } = await import('../../server/dist/rdf/schema-from-rdf.js');

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#', sh: 'http://www.w3.org/ns/shacl#', ex: 'http://data.example/',
};
const iri = (value) => ({ kind: 'iri', value });
const blank = (id) => ({ kind: 'blank', id });
const q = (subject, predicate, object) => ({ subject, predicate: iri(predicate), object });
const typed = (subject, cls) => q(subject, `${NS.rdf}type`, iri(cls));
const keyOf = (term) => (term.kind === 'iri' ? `i:${term.value}` : `b:${term.id}`);
const blankKey = (id) => `b:${id}`;
/** A sorted file's groups, one per subject, as the selector reads them. */
const groupsOf = (quads) => {
  const by = new Map();
  for (const quad of quads) {
    const k = keyOf(quad.subject);
    if (!by.has(k)) by.set(k, { key: k, subject: quad.subject, quads: [] });
    by.get(k).quads.push(quad);
  }
  return () => (async function* () { yield* by.values(); })();
};
const keysOf = async (quads, from) => [...(await schemaGroupsOf(groupsOf(quads), blankKey, null, from)).keys].sort();

describe('the schema option takes as schema only what declares one', () => {
  it('each declaring class and the declaring predicates of a shape make a subject schema', () => {
    const s = iri(`${NS.ex}x`);
    for (const cls of [`${NS.owl}Ontology`, `${NS.owl}Class`, `${NS.owl}ObjectProperty`, `${NS.owl}DatatypeProperty`, `${NS.rdfs}Class`, `${NS.rdf}Property`,
      `${NS.sh}NodeShape`, `${NS.sh}PropertyShape`]) {
      assert.equal(isSchemaGroup([typed(s, cls)]), true, `a subject typed ${cls} is a declaration`);
    }
    for (const p of [`${NS.sh}targetClass`, `${NS.sh}path`, `${NS.rdfs}subClassOf`, `${NS.rdfs}domain`]) {
      assert.equal(isSchemaGroup([q(s, p, iri(`${NS.ex}y`))]), true, `a subject stating ${p} is a declaration`);
    }
  });

  it('an owl:NamedIndividual, an owl:Thing and a SHACL validation report are data, not schema (F3)', () => {
    const alice = iri(`${NS.ex}alice`);
    assert.equal(isSchemaGroup([typed(alice, `${NS.owl}NamedIndividual`), typed(alice, `${NS.ex}Person`)]), false, 'a named individual is a record');
    assert.equal(isSchemaGroup([typed(alice, `${NS.owl}Thing`)]), false, 'an owl:Thing instance is a record');
    const report = iri(`${NS.ex}report`);
    assert.equal(isSchemaGroup([
      typed(report, `${NS.sh}ValidationReport`), q(report, `${NS.sh}conforms`, { kind: 'literal', value: 'false' }), q(report, `${NS.sh}result`, blank('r1')),
    ]), false, 'a validation report is data');
    assert.equal(isSchemaGroup([q(blank('r1'), `${NS.sh}focusNode`, alice), q(blank('r1'), `${NS.sh}resultPath`, iri(`${NS.ex}age`))]), false, 'a validation result is data');
  });

  it('a file that holds a named individual keeps it out of the schema groups (F3)', async () => {
    const person = iri(`${NS.ex}Person`);
    const alice = iri(`${NS.ex}alice`);
    const keys = await keysOf([typed(person, `${NS.owl}Class`), typed(alice, `${NS.owl}NamedIndividual`), typed(alice, `${NS.ex}Person`)]);
    assert.deepEqual(keys, [`i:${NS.ex}Person`]);
  });

  const mixed = () => {
    const klass = iri(`${NS.ex}Person`);
    const shape = iri(`${NS.ex}PersonShape`);
    return [
      typed(klass, `${NS.owl}Class`),
      typed(shape, `${NS.sh}NodeShape`), q(shape, `${NS.sh}targetClass`, klass), q(shape, `${NS.sh}property`, blank('p')),
      q(blank('p'), `${NS.sh}path`, iri(`${NS.ex}age`)),
      typed(iri(`${NS.ex}Place`), `${NS.owl}Class`), q(iri(`${NS.ex}Place`), `${NS.rdfs}subClassOf`, blank('res')),
      typed(blank('res'), `${NS.owl}Restriction`),
    ];
  };

  // Q-755 test 33 (design revision 3): with `schema` set a declaring group is never a record, whichever source `from` asks for. A group of a
  // kind `from` does not ask for is skipped and named apart (`notAsked`), and its statements are not handed to the mapping.
  const notAskedOf = async (quads, from) => [...((await schemaGroupsOf(groupsOf(quads), blankKey, null, from)).notAsked ?? [])].sort();
  const quadsOf = async (quads, from) => (await schemaGroupsOf(groupsOf(quads), blankKey, 10_000, from)).quads;

  it('with from: shacl every declaration is skipped; the owl:Class subjects are named not asked and not mapped (Q-755 test 33)', async () => {
    const keys = await keysOf(mixed(), ['shacl']);
    assert.deepEqual(keys, ['b:p', 'b:res', `i:${NS.ex}Person`, `i:${NS.ex}PersonShape`, `i:${NS.ex}Place`], `every declaration is skipped: ${keys.join(', ')}`);
    assert.deepEqual(await notAskedOf(mixed(), ['shacl']), ['b:res', `i:${NS.ex}Person`, `i:${NS.ex}Place`], 'the classes are named not asked');
    const mapped = await quadsOf(mixed(), ['shacl']);
    assert.ok(mapped.length > 0 && mapped.every(x => keyOf(x.subject) === 'b:p' || keyOf(x.subject) === `i:${NS.ex}PersonShape`), 'only the shapes are mapped');
  });

  it('with from: declared every declaration is skipped; the shapes are named not asked and not mapped (Q-755 test 33)', async () => {
    const keys = await keysOf(mixed(), ['declared']);
    assert.deepEqual(keys, ['b:p', 'b:res', `i:${NS.ex}Person`, `i:${NS.ex}PersonShape`, `i:${NS.ex}Place`], `every declaration is skipped: ${keys.join(', ')}`);
    assert.deepEqual(await notAskedOf(mixed(), ['declared']), ['b:p', `i:${NS.ex}PersonShape`], 'the shapes are named not asked');
  });

  it('with both sources every declaration is schema', async () => {
    const both = await keysOf(mixed(), ['declared', 'shacl']);
    assert.deepEqual(both, ['b:p', 'b:res', `i:${NS.ex}Person`, `i:${NS.ex}PersonShape`, `i:${NS.ex}Place`]);
  });
});

/**
 * The classes the mapping asks a file for: every `withType(...)` argument of a mapping source (a literal list, or a constant naming one), as
 * addresses. Read from the source, never from the selector's own list, so a class the mapping starts to read and the selector does not know fails.
 */
function mappingClassesOf(text) {
  const prefix = { OWL: NS.owl, RDFS: NS.rdfs, RDF: NS.rdf, SH: NS.sh };
  const termsIn = (list) => [...list.matchAll(/\b(OWL|RDFS|RDF|SH)\('(\w+)'\)/g)].map(m => `${prefix[m[1]]}${m[2]}`);
  const out = new Set();
  for (const call of text.matchAll(/withType\(\s*(\[[^\]]*\]|[A-Z_]+)\s*\)/g)) {
    let list = call[1];
    if (!list.startsWith('[')) list = new RegExp(`const ${list}\\b[^=]*=\\s*(\\[[^\\]]*\\])`).exec(text)?.[1] ?? '';
    for (const iriOf of termsIn(list)) out.add(iriOf);
  }
  return out;
}

describe('the selector and the mapping read one set of declaring classes', () => {
  const declaring = new Set(Object.values(SCHEMA_DECLARING_CLASSES).flat());
  const sources = readTrackedSources('server/src/rdf', { floor: 10 }).filter(f => /schema-from-rdf-(owl|shacl)\.ts$/.test(f.file));

  it('every class the mapping asks the file for is one the selector takes as a declaration', () => {
    assert.equal(sources.length, 2, 'the owl and the shacl half of the mapping are read');
    const asked = new Set(sources.flatMap(f => [...mappingClassesOf(f.text)]));
    assert.ok(asked.size >= 6, `the scan found the classes the mapping asks for (${asked.size})`);
    const missing = [...asked].filter(c => !declaring.has(c));
    assert.deepEqual(missing, [], `the mapping reads classes the selector would leave in the data: ${missing.join(', ')}`);
  });

  it('a class added to the mapping and not to the selector is found (the planted case)', () => {
    const planted = `${sources[0].text}\nconst extra = store.withType([OWL('Ontology'), OWL('Planted')]);\n`;
    assert.deepEqual([...mappingClassesOf(planted)].filter(c => !declaring.has(c)), [`${NS.owl}Planted`]);
  });
});
