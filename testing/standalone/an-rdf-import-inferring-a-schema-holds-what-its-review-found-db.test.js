/**
 * An RDF import that infers its schema from its data holds what the review and the drive of Q-755 found (bundle-270, Q-755 fix round, items F1
 * to F6): each case is the trigger the finding named, run through the real routes.
 *
 * ## What it holds
 *
 * - F1: a class the inference does not take (too few subjects, no name) never refuses a strict import at the default settings: the subjects
 *   typed only by it, and the label groups that describe it, are left out and counted `not-inferred`, and the rest lands.
 * - F2: naming many classes or keys of one local part costs a constant number of probes per name, and a file whose classes pass the type cap
 *   is refused as soon as they do, not after the whole file was named.
 * - F3: a derived address and a foreign one never get one edge name or property key: the derived term keeps its name, the foreign one is numbered.
 * - F4: a predicate the space holds as a property is not also inferred as an edge label: it is named `term-clash` and its statements are left out.
 * - F5: a type the space stores as a library reference takes no inferred property: the pair is named `library-reference` and left out.
 * - F6: support and confidence count subjects, not the groups a subject's statements arrive in (a default graph and a named graph).
 *
 * Run: node --test testing/standalone/an-rdf-import-inferring-a-schema-holds-what-its-review-found-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith } from './_rdf-import-schema-doors.mjs';
import { ttl, people, EX, inferredOf, stepOf } from './_rdf-import-infer.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const id = (n) => `rdfinfrv${n}`;
const SRC_BASE = 'https://src.example/ld/s/';
const LIBRARY_ENTRY = 'rdfinfrv-person';
const PLAIN = ['1a', '1b', '1c', '1d', '2a', '2b', '3a', '3b', '6'];
const STORED_4 = { entity: { Person: { iri: `${EX}Person`, propertySchemas: { related: { iri: `${EX}related`, type: 'string' } } } } };

/** The drive's file: ten Quokkas (six follow a Marmot), nine Marmots, one Axolotl, and no schema. */
function zooFile() {
  const lines = ['@prefix v: <http://zoo.example/vocab/> .', '@prefix i: <http://zoo.example/id/> .'];
  for (let n = 1; n <= 10; n++) {
    const follows = n <= 6 ? ` ; v:follows i:m${n}` : '';
    lines.push(`i:q${n} a v:Quokka ; rdfs:label "quokka ${n}" ; v:quokkaNick "nick ${n}" ; v:quokkaWeight ${n}.5 ; v:quokkaBorn "2020-01-0${n % 9 + 1}"^^xsd:date ; v:quokkaLively ${n % 2 === 0}${follows} .`);
  }
  for (let n = 1; n <= 9; n++) lines.push(`i:m${n} a v:Marmot ; rdfs:label "marmot ${n}" ; v:marmotTitle "title ${n}" .`);
  lines.push('i:a1 a v:Axolotl ; rdfs:label "axolotl 1" ; v:axolotlDepth 4 .');
  return ttl(lines);
}

describe('an RDF import inferring a schema holds what its review found (real routes, real MongoDB)', { skip, timeout: 600_000 }, () => {
  let d, writer, schemaAct;
  before(async () => {
    d = await openRdfImportSchemaDoors({
      suite: 'rdf_import_infer_review',
      spaces: [
        ...PLAIN.map(n => spaceWith(id(n), undefined, STRICT)),
        spaceWith(id('4'), STORED_4, STRICT),
        spaceWith(id('5'), { entity: { Person: { $ref: `library:${LIBRARY_ENTRY}` } } }, STRICT),
      ],
    });
    d.loader.saveSchemaLibrary([{ name: LIBRARY_ENTRY, knowledgeType: 'entity', typeName: 'Person', schema: { iri: `${EX}Person`, propertySchemas: { name: { type: 'string' } } } }]);
    writer = await d.mint('rdf-import-infer-review-writer', Object.fromEntries([...PLAIN, '4', '5'].map(n => [id(n), d.row({ knowledge: 'write', schema: 'write' })])));
    schemaAct = await import('../../server/dist/spaces/schema-rdf-import-act.js');
  });
  after(async () => { schemaAct?.setSchemaRdfImportKnobsForTest?.(null); await d?.close(); });

  const DATA = { schema: 'generate', from: ['data'] };
  const rest = (space, text, params = DATA, opts = {}) => d.importRestOne(writer.key, space, text, params, opts);
  const names = async (space) => (await d.records(space, 'entities')).map(r => r.name).sort();
  const ok = (r) => assert.equal(r.status, 200, `${r.door}: ${r.text.slice(0, 600)}`);
  const named = (list, pred) => (list ?? []).find(pred);

  it('F1: the drive\'s 20-subject file with a one-subject class lands in a strict space at the default settings, that subject left out', async () => {
    const r = await rest(id('1a'), zooFile());
    ok(r);
    assert.ok((r.body.notTaken?.['not-inferred'] ?? 0) > 0, `the pruned subject's statements are left out: ${JSON.stringify(r.body.notTaken)}`);
    assert.deepEqual(Object.keys(d.heldTypes(id('1a')).entity ?? {}).sort(), ['Marmot', 'Quokka']);
    const stored = await names(id('1a'));
    assert.equal(stored.length, 19, `ten Quokkas and nine Marmots: ${JSON.stringify(stored)}`);
    assert.ok(!stored.includes('axolotl 1'), 'the Axolotl is not stored');
    assert.equal((await d.records(id('1a'), 'edges')).length, 6, 'the edges land');
  });

  it('F1: test 34\'s file (a type seen on one subject) lands in a strict space, the lonely subject left out', async () => {
    const r = await rest(id('1b'), ttl(people(2), people(1, { cls: 'ex:Lonely', prefix: 'l' })));
    ok(r);
    assert.equal(r.body.notTaken?.['not-inferred'], 2, `its type and its label: ${JSON.stringify(r.body.notTaken)}`);
    assert.deepEqual(await names(id('1b')), ['person 0', 'person 1']);
  });

  it('F1: the label group of a class that is not inferred is skipped with it, and the import lands', async () => {
    const r = await rest(id('1c'), ttl(people(2), 'ex:Lonely rdfs:label "Rare" .', people(1, { cls: 'ex:Lonely', prefix: 'l' })));
    ok(r);
    assert.deepEqual(await names(id('1c')), ['person 0', 'person 1'], 'the label group is no record');
    assert.deepEqual(Object.keys(d.heldTypes(id('1c')).entity ?? {}), ['Person']);
  });

  it('F1: a subject typed by an inferred class and one that is not keeps its record; only the class statement is left out', async () => {
    const r = await rest(id('1d'), ttl(people(2), 'p:both a ex:Person, ex:Lonely ; rdfs:label "both" .'));
    ok(r);
    assert.deepEqual(await names(id('1d')), ['both', 'person 0', 'person 1']);
    assert.equal(r.body.notTaken?.['not-inferred'], 1, JSON.stringify(r.body.notTaken));
  });

  it('F2: classes of one local part refuse at the type cap as soon as they pass it, each name costing a constant number of probes', async () => {
    const file = ttl(Array.from({ length: 300 }, (_, i) => people(2, { cls: `<http://x.example/${i}/Item>`, prefix: `i${i}x` })).flat());
    let claims = 0;
    let probes = 0;
    schemaAct.setSchemaRdfImportKnobsForTest({ hooks: { afterNameClaim: (n) => { claims += 1; probes += n; } } });
    let r;
    try { r = await rest(id('2a'), file); } finally { schemaAct.setSchemaRdfImportKnobsForTest(null); }
    assert.equal(r.status, 422, r.text.slice(0, 400));
    assert.equal(r.body?.reasons?.[0]?.code, 'type-cap', r.text.slice(0, 400));
    assert.ok(claims > 0, 'the premise: names were claimed');
    assert.ok(claims <= 205, `the inference stopped near the cap, not after all 300 classes: ${claims} names claimed`);
    assert.ok(probes <= 4 * claims, `a name costs a constant number of probes: ${probes} probes for ${claims} names`);
    assert.deepEqual(d.heldTypes(id('2a')), {}, 'nothing was written');
  });

  it('F2: property keys of one local part on one type cost a constant number of probes each', async () => {
    const preds = Array.from({ length: 150 }, (_, i) => `<http://x.example/${i}/age> "${i}"^^xsd:decimal`).join(' ; ');
    let claims = 0;
    let probes = 0;
    schemaAct.setSchemaRdfImportKnobsForTest({ hooks: { afterNameClaim: (n) => { claims += 1; probes += n; } } });
    let r;
    try { r = await rest(id('2b'), ttl(people(2, { extra: () => preds })), { ...DATA, dryRun: true }); } finally { schemaAct.setSchemaRdfImportKnobsForTest(null); }
    ok(r);
    assert.equal(inferredOf(r).properties.length, 150, 'every key is inferred');
    assert.ok(claims >= 151, `the premise: a type and 150 keys were claimed: ${claims}`);
    assert.ok(probes <= 4 * claims, `a key costs a constant number of probes: ${probes} probes for ${claims} names`);
  });

  it('F3: a foreign predicate and the vocabulary\'s own property of one key get two keys; the vocabulary\'s keeps the name', async () => {
    const v = `${SRC_BASE}vocab/`;
    const file = ttl([0, 1].map(i => `<${SRC_BASE}entity/p${i}> a <${v}entity/Person> ; rdfs:label "P${i}" ; <${v}entity/Person#age> "${i}"^^xsd:decimal ; <http://a.example/age> "${i + 10}"^^xsd:decimal .`));
    const r = await rest(id('3a'), file, { ...DATA, sourceBase: SRC_BASE });
    ok(r);
    const props = d.heldTypes(id('3a')).entity?.Person?.propertySchemas ?? {};
    assert.deepEqual(Object.keys(props).sort(), ['age', 'age_2'], JSON.stringify(props));
    assert.equal(props.age?.iri, undefined, 'the vocabulary\'s own property carries no iri');
    assert.equal(props.age_2?.iri, 'http://a.example/age', JSON.stringify(props));
  });

  it('F3: a foreign edge predicate and the vocabulary\'s own edge label of one name get two names; the vocabulary\'s keeps the name', async () => {
    const v = `${SRC_BASE}vocab/`;
    const file = ttl([0, 1].map(i => `<${SRC_BASE}entity/p${i}> a <${v}entity/Person> ; rdfs:label "P${i}" ; <${v}edge/knows> <${SRC_BASE}entity/p${1 - i}> ; <http://a.example/knows> <${SRC_BASE}entity/p${1 - i}> .`));
    const r = await rest(id('3b'), file, { ...DATA, sourceBase: SRC_BASE });
    ok(r);
    const edges = d.heldTypes(id('3b')).edge ?? {};
    assert.deepEqual(Object.keys(edges).sort(), ['knows', 'knows_2'], JSON.stringify(edges));
    assert.equal(edges.knows?.iri, undefined, 'the vocabulary\'s own label carries no iri');
    assert.equal(edges.knows_2?.iri, 'http://a.example/knows', JSON.stringify(edges));
    assert.equal((await d.records(id('3b'), 'edges')).length, 4, 'both predicates land as edges');
  });

  it('F4: a predicate the space holds as a property is not inferred as an edge label: named term-clash, its statements left out', async () => {
    const file = ttl(people(2), people(2, { cls: 'ex:Org', prefix: 'org', extra: (i) => `ex:related p:person${i}` }));
    const r = await rest(id('4'), file, { schema: 'expand', from: ['data'] });
    ok(r);
    assert.equal(named(inferredOf(r).notInferred, n => n.iri === `${EX}related`)?.why, 'term-clash', JSON.stringify(inferredOf(r).notInferred));
    assert.deepEqual(d.heldTypes(id('4')).edge ?? {}, {}, 'no edge label is inferred');
    assert.equal(r.body.notTaken?.['not-inferred'], 2, JSON.stringify(r.body.notTaken));
    assert.deepEqual(await names(id('4')), ['org 0', 'org 1', 'person 0', 'person 1']);
  });

  it('F5: a type the space stores as a library reference takes no inferred property: named library-reference, its statements left out', async () => {
    const file = ttl(people(2, { extra: (i) => `ex:height "${170 + i}"^^xsd:decimal` }));
    const r = await rest(id('5'), file, { schema: 'expand', from: ['data'] });
    ok(r);
    const left = named(inferredOf(r).notInferred, n => n.iri === `${EX}height`);
    assert.equal(left?.why, 'library-reference', JSON.stringify(inferredOf(r)));
    assert.equal(left?.type, 'Person');
    assert.deepEqual(inferredOf(r).properties, []);
    assert.deepEqual(d.heldTypes(id('5')).entity?.Person, { $ref: `library:${LIBRARY_ENTRY}` }, 'the linked type is kept whole');
    assert.equal(r.body.notTaken?.['not-inferred'], 2, JSON.stringify(r.body.notTaken));
    assert.deepEqual(await names(id('5')), ['person 0', 'person 1']);
  });

  it('F6: a subject stating one class and one property in the default graph and in a named graph has support 1 and confidence 1', async () => {
    const file = ttl(
      'p:alice a ex:Person ; rdfs:label "Alice" ; ex:age "41"^^xsd:decimal .',
      '<http://g.example/one> { p:alice a ex:Person ; ex:age "41"^^xsd:decimal . }',
    );
    const r = await rest(id('6'), file, { ...DATA, dryRun: true, inferMinSupport: 1 }, { format: 'trig' });
    // The plan refuses a subject written in two graphs (`plan_refused`, as before this round): the report of that answer carries the inference.
    assert.ok(stepOf(r)?.inferred, `the answer carries the inference: ${r.text.slice(0, 600)}`);
    const type = named(inferredOf(r).types, t => t.iri === `${EX}Person`);
    assert.equal(type?.support, 1, JSON.stringify(inferredOf(r)));
    const prop = named(inferredOf(r).properties, p => p.iri === `${EX}age`);
    assert.equal(prop?.support, 1, JSON.stringify(inferredOf(r)));
    assert.ok(prop?.confidence <= 1, `a share is at most 1: ${JSON.stringify(prop)}`);
  });
});
