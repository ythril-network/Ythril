/**
 * An RDF data import with `from: data` infers a schema from the file's own statements, prunes it by support and confidence, and lets declared
 * and stored terms win (bundle-270, Q-755, tests 1 to 7, 12 to 18, 21, 23, 25 to 27, 30, 33 to 37 of its plan): `POST
 * /api/brain/spaces/:spaceId/import/rdf?schema=&from=data` and MCP `import_rdf { schema, from: [data] }`.
 *
 * ## What it holds
 *
 * - 1: a schema-less Turtle file with `schema: generate, from: [data]` into an empty strict space lands whole, on both doors.
 * - 2, 27, 36: a property takes its column's majority datatype (ties: string, date, number, boolean; `other` never wins), a mixed column is named
 *   with its counts, and `inferMinConfidence` leaves a column whose majority is too thin out as mixed.
 * - 3: a predicate with several literals on one subject is not inferred, its statements are left out (`not-inferred`), the rest lands.
 * - 4, 23, 25, 26: names: the smallest valid plain label, else the local part; clashes numbered and listed under `renamed`; an endpoint member
 *   of a name with a colon is written `entity:<name>`; a declared term is taken, never numbered.
 * - 5, 21: declared and stored terms keep their definitions; each change names its source.
 * - 6, 7: no inferred property is required; `functional` only with `inferFunctional`; endpoints name the observed types, an end stored in the
 *   space leaves its side open.
 * - 12, 14, 16, 17: what has no safe inference (a predicate used as a class, reserved and product predicates, literal-and-node predicates,
 *   an edge to an address the file does not describe, an export's own classes) is named, left out, and the strict import lands.
 * - 13: in a strict space a mixed column's minority is refused, nothing is written, and the dry run named the column beforehand.
 * - 15: a Ythril export read under its source builds its vocabulary's type once (no `_2`).
 * - 18, 30, 33: declaring groups are never records with `schema` set; a kind `from` does not ask for is counted apart.
 * - 34, 35, 37: support and confidence prune, and every inferred term carries both.
 *
 * Run: node --test testing/standalone/an-rdf-import-infers-its-schema-from-its-data-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportSchemaDoors, spaceWith, baseOf } from './_rdf-import-schema-doors.mjs';
import { ttl, people, EX, PEOPLE, TICKET_FILE, TICKET_TYPES, stepOf, inferredOf } from './_rdf-import-infer.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const WARN = { validationMode: 'warn' };
const id = (n) => `rdfinf${n}`;
const SRC_BASE = 'https://src.example/ld/s/';

/** Every space this file imports into: strict unless named here, one per case. */
const WARN_IDS = ['2', '34', '35', '36', '25b', '37'];
const STRICT_IDS = ['1r', '1m', '3', '4', '5', '6a', '6b', '7', '12', '13', '14', '15', '16', '17', '18', '21', '23', '25', '26', '27', '30', '33'];

describe('an RDF import infers its schema from its data (real routes, real MongoDB)', { skip, timeout: 600_000 }, () => {
  let d, writer;
  const STORED_21 = { entity: { Person: { iri: `${EX}Person`, propertySchemas: { age: { iri: `${EX}age`, type: 'string' } } } } };
  before(async () => {
    d = await openRdfImportSchemaDoors({
      suite: 'rdf_import_infer',
      spaces: [
        ...STRICT_IDS.filter(n => n !== '21').map(n => spaceWith(id(n), undefined, STRICT)),
        spaceWith(id('21'), STORED_21, STRICT),
        ...WARN_IDS.map(n => spaceWith(id(n), undefined, WARN)),
        spaceWith('rdfinfsrc', { entity: { Person: { propertySchemas: { age: { type: 'number' } } } } }, WARN),
      ],
    });
    const all = [...STRICT_IDS, ...WARN_IDS].map(id).concat('rdfinfsrc');
    writer = await d.mint('rdf-import-infer-writer', Object.fromEntries(all.map(s => [s, d.row({ knowledge: 'write', schema: 'write' })])));
  });
  after(async () => { await d?.close(); });

  const DATA = { schema: 'generate', from: ['data'] };
  const rest = (space, text, params = DATA) => d.importRestOne(writer.key, space, text, params);
  const names = async (space, col = 'entities') => (await d.records(space, col)).map(r => r.name).sort();
  const ok = (r) => assert.equal(r.status, 200, `${r.door}: ${r.text.slice(0, 600)}`);
  const named = (list, pred) => (list ?? []).find(pred);

  it('1: a schema-less file with schema: generate, from: [data] into an empty strict space lands whole, on both doors', async () => {
    const { rest: r, mcp: m } = await d.importBoth(writer.key, [id('1r'), id('1m')], TICKET_FILE, DATA);
    ok(r);
    assert.equal(m.isError, false, `MCP: ${m.text.slice(0, 600)}`);
    for (const space of [id('1r'), id('1m')]) {
      assert.deepEqual(d.heldTypes(space), TICKET_TYPES, `${space}: the inferred schema is stored`);
      assert.deepEqual(await names(space), ['Alice', 'Bob'], space);
      assert.equal((await d.records(space, 'edges')).length, 2, `${space}: both edges land`);
    }
  });

  it('2: a property takes its column\'s majority datatype, and a mixed column is named with its counts', async () => {
    const file = ttl(people(3, { extra: (i) => (i < 2 ? `ex:code "${i}"^^xsd:decimal` : 'ex:code "x"') }));
    const r = await rest(id('2'), file, { ...DATA, dryRun: true });
    ok(r);
    const prop = named(inferredOf(r).properties, p => p.iri === `${EX}code`);
    assert.equal(prop?.datatype, 'number', `the majority is number: ${JSON.stringify(inferredOf(r))}`);
    const mixed = named(inferredOf(r).mixed, m => m.predicate === `${EX}code`);
    assert.deepEqual(mixed?.counts, { string: 1, number: 2, boolean: 0, date: 0, other: 0 }, JSON.stringify(inferredOf(r).mixed));
    assert.equal(mixed?.majority, 'number');
  });

  it('3: a predicate with several literals on one subject is not inferred, its statements are left out, and the rest lands', async () => {
    const file = ttl(people(3, { extra: (i) => (i === 0 ? 'ex:nick "a", "b" ; ex:age "3"^^xsd:decimal' : `ex:nick "c${i}" ; ex:age "${i}"^^xsd:decimal`) }));
    const r = await rest(id('3'), file);
    ok(r);
    const props = d.heldTypes(id('3')).entity?.Person?.propertySchemas ?? {};
    assert.deepEqual(Object.keys(props), ['age'], `nick is not inferred: ${JSON.stringify(props)}`);
    assert.ok(named(inferredOf(r).multiValued, m => m.predicate === `${EX}nick`), `nick is named multi-valued: ${JSON.stringify(inferredOf(r))}`);
    assert.equal(r.body.notTaken?.['not-inferred'], 4, `every nick statement is left out: ${JSON.stringify(r.body.notTaken)}`);
    assert.equal((await names(id('3'))).length, 3);
  });

  it('4: a type is named by its label, else its local name; two clashing names are numbered and listed under renamed', async () => {
    const file = ttl(
      'ex:P1 rdfs:label "Human" .',
      people(2, { cls: 'ex:P1', prefix: 'h' }), people(2, { cls: 'ex:Thing2', prefix: 't' }),
      people(2, { cls: '<http://a.example/Item>', prefix: 'ia' }), people(2, { cls: '<http://b.example/Item>', prefix: 'ib' }),
    );
    const r = await rest(id('4'), file);
    ok(r);
    const entity = d.heldTypes(id('4')).entity ?? {};
    assert.deepEqual(Object.keys(entity).sort(), ['Human', 'Item', 'Item_2', 'Thing2'], JSON.stringify(entity));
    assert.equal(entity.Item.iri, 'http://a.example/Item', 'the first address in code-unit order keeps the name');
    assert.equal(entity.Item_2.iri, 'http://b.example/Item');
    assert.ok(named(inferredOf(r).renamed, x => x.iri === 'http://b.example/Item' && x.name === 'Item_2'), JSON.stringify(inferredOf(r).renamed));
    assert.equal((await names(id('4'))).length, 8, 'the label-only group of the class is no record');
  });

  it('5: with from: [declared, data] a declared property keeps its definition, an undeclared one is filled, each change names its source', async () => {
    const file = ttl(
      'ex:Person a owl:Class .', 'ex:age a owl:DatatypeProperty ; rdfs:domain ex:Person ; rdfs:range xsd:string .',
      people(2, { extra: (i) => `ex:age "${40 + i}"^^xsd:decimal ; ex:height "${170 + i}"^^xsd:decimal` }),
    );
    const r = await rest(id('5'), file, { schema: 'generate', from: ['declared', 'data'] });
    ok(r);
    const props = d.heldTypes(id('5')).entity?.Person?.propertySchemas ?? {};
    assert.equal(props.age?.type, 'string', `the declared type stands: ${JSON.stringify(props)}`);
    assert.equal(props.height?.type, 'number', `the undeclared property is inferred: ${JSON.stringify(props)}`);
    const changes = stepOf(r)?.changes ?? [];
    const src = (pred) => named(changes, pred)?.source;
    assert.equal(src(c => c.change === 'add-type' && c.type === 'Person'), 'declared', JSON.stringify(changes));
    assert.equal(src(c => c.change === 'add-property' && c.prop === 'age'), 'declared', JSON.stringify(changes));
    assert.equal(src(c => c.change === 'add-property' && c.prop === 'height'), 'data', JSON.stringify(changes));
  });

  it('6: no inferred property is required; an edge label is functional only with inferFunctional', async () => {
    const without = await rest(id('6a'), TICKET_FILE);
    ok(without);
    const withF = await rest(id('6b'), TICKET_FILE, { ...DATA, inferFunctional: true });
    ok(withF);
    assert.equal(d.heldTypes(id('6a')).edge?.knows?.functional, undefined, 'no functional without inferFunctional');
    assert.equal(d.heldTypes(id('6b')).edge?.knows?.functional, true, 'functional with inferFunctional and one object per subject');
    for (const space of [id('6a'), id('6b')]) {
      for (const [type, def] of Object.entries(d.heldTypes(space).entity ?? {})) {
        for (const [prop, p] of Object.entries(def.propertySchemas ?? {})) assert.notEqual(p.required, true, `${space}: ${type}.${prop} is required`);
      }
    }
  });

  it('7: endpoints name the observed entity types; a side with an end stored in the space is left open', async () => {
    await d.seed(id('7'), 'entity', [{ _id: 'stored1', name: 'Stored', type: null, properties: {} }]);
    const file = ttl(
      people(2, { extra: (i) => `ex:worksAt p:org${i} ; ex:likes <${baseOf(id('7'))}entity/stored1>` }),
      people(2, { cls: 'ex:Org', prefix: 'org' }),
    );
    const r = await rest(id('7'), file, { schema: 'generate', from: ['data'], inferMinSupport: 1 });
    ok(r);
    const edge = d.heldTypes(id('7')).edge ?? {};
    assert.deepEqual(edge.worksAt?.endpoints, { from: ['Person'], to: ['Org'] }, JSON.stringify(edge));
    assert.deepEqual(edge.likes?.endpoints, { from: ['Person'] }, `the stored end leaves the to side open: ${JSON.stringify(edge)}`);
    assert.ok(named(inferredOf(r).openEndpoints, o => o.type === 'likes' && o.side === 'to'), JSON.stringify(inferredOf(r).openEndpoints));
  });

  it('12: a predicate used as a class and as a predicate is named and not inferred as a property', async () => {
    const file = ttl(people(2, { cls: 'ex:Tag', prefix: 'tag' }), people(2, { extra: () => 'ex:Tag "x"' }));
    const r = await rest(id('12'), file);
    ok(r);
    assert.ok(named(inferredOf(r).notInferred, n => n.iri === `${EX}Tag` && n.why === 'used-as-class'), JSON.stringify(inferredOf(r).notInferred));
    assert.equal(d.heldTypes(id('12')).entity?.Person?.propertySchemas, undefined, 'no property is inferred from it');
    assert.equal(r.body.notTaken?.['not-inferred'], 2);
  });

  it('13: in a strict space a mixed column\'s minority is refused, nothing is written, and the dry run named the column', async () => {
    const file = ttl(people(3, { extra: (i) => (i < 2 ? `ex:code "${i}"^^xsd:decimal` : 'ex:code "x"') }));
    const dry = await rest(id('13'), file, { ...DATA, dryRun: true });
    assert.equal(dry.status, 409, dry.text.slice(0, 400));
    assert.ok(named(inferredOf(dry).mixed, m => m.predicate === `${EX}code`), `the dry run names the mixed column: ${dry.text.slice(0, 600)}`);
    const real = await rest(id('13'), file);
    assert.equal(real.status, 409, real.text.slice(0, 400));
    assert.ok(real.body.report.reasonsByCode['datatype-refused'] >= 1, JSON.stringify(real.body.report.reasonsByCode));
    assert.deepEqual(d.heldTypes(id('13')), {}, 'no schema is written');
    assert.deepEqual(await d.records(id('13'), 'entities'), []);
  });

  it('14: a file using reserved or product predicates infers none of them, names them, and lands', async () => {
    const file = ttl(people(2, { extra: (i) => `schema:startDate "2020-01-0${i + 1}" ; ythril:weight "${i}"^^xsd:decimal ; ex:age "${i}"^^xsd:decimal` }));
    const r = await rest(id('14'), file);
    ok(r);
    assert.deepEqual(Object.keys(d.heldTypes(id('14')).entity?.Person?.propertySchemas ?? {}), ['age']);
    for (const iri of ['http://schema.org/startDate', 'https://w3id.org/ythril/ns#weight']) {
      assert.ok(named(inferredOf(r).notInferred, n => n.iri === iri), `${iri} is named: ${JSON.stringify(inferredOf(r).notInferred)}`);
    }
  });

  it('15: a Ythril export read under its source with from: [declared, data] builds Person once, no Person_2', async () => {
    const v = `${SRC_BASE}vocab/`;
    const file = ttl(
      `<${v}entity/Person> a owl:Class .`,
      [0, 1].map(i => `<${SRC_BASE}entity/p${i}> a <${v}entity/Person> ; rdfs:label "P${i}" ; <${v}entity/Person#age> "${i}"^^xsd:decimal .`),
    );
    const r = await rest(id('15'), file, { schema: 'generate', from: ['declared', 'data'], sourceBase: SRC_BASE });
    ok(r);
    const entity = d.heldTypes(id('15')).entity ?? {};
    assert.deepEqual(Object.keys(entity), ['Person'], JSON.stringify(entity));
    assert.equal(entity.Person.propertySchemas?.age?.type, 'number', JSON.stringify(entity));
    assert.equal(entity.Person.iri, undefined, 'a vocabulary term carries no iri');
  });

  it('16: a literal-and-node predicate, a class-and-predicate term and an edge to an undescribed address are left out, and the strict import lands', async () => {
    const file = ttl(
      people(2, { extra: (i) => `ex:about ${i === 0 ? '"text"' : 'p:person0'} ; ex:link <http://nowhere.example/x${i}> ; ex:Kind "k"` }),
      people(2, { cls: 'ex:Kind', prefix: 'kind' }),
    );
    const r = await rest(id('16'), file);
    ok(r);
    const why = (iri) => named(inferredOf(r).notInferred, n => n.iri === iri)?.why;
    assert.equal(why(`${EX}about`), 'literal-and-node', JSON.stringify(inferredOf(r).notInferred));
    assert.equal(why(`${EX}link`), 'end-not-described');
    assert.equal(why(`${EX}Kind`), 'used-as-class');
    assert.deepEqual(d.heldTypes(id('16')).edge ?? {}, {}, 'no edge label is inferred');
  });

  it('17: re-importing a Ythril export with from: [data] infers none of the export\'s own classes', async () => {
    await d.seed('rdfinfsrc', 'entity', [0, 1].map(i => ({ _id: `e${i}`, name: `E${i}`, type: 'Person', properties: { age: i } })));
    const exported = await d.exportRest(writer.key, 'rdfinfsrc', { format: 'turtle' });
    assert.equal(exported.status, 200, exported.text?.slice(0, 200));
    const r = await rest(id('17'), exported.text, { schema: 'generate', from: ['data'], sourceBase: baseOf('rdfinfsrc') });
    ok(r);
    const types = Object.values(d.heldTypes(id('17'))).flatMap(m => Object.values(m ?? {}));
    const own = types.filter(t => typeof t.iri === 'string' && /ythril|prov#|w3\.org\/2006\/time|schema\.org/.test(t.iri));
    assert.deepEqual(own, [], `an export's own class is inferred: ${JSON.stringify(d.heldTypes(id('17')))}`);
    assert.deepEqual(Object.keys(d.heldTypes(id('17')).entity ?? {}), ['Person'], JSON.stringify(d.heldTypes(id('17'))));
  });

  it('18: with from: [data] only, owl:Class groups are not records', async () => {
    const r = await rest(id('18'), ttl('ex:Person a owl:Class .', people(2)));
    ok(r);
    assert.equal((await names(id('18'))).length, 2, 'the class is no record');
    assert.equal(r.body.notTaken?.['schema-not-asked'], 1, JSON.stringify(r.body.notTaken));
  });

  it('21: a stored property with the same address keeps its datatype; an inferred key clashing inside a type is numbered', async () => {
    const file = ttl(people(2, { extra: (i) => `ex:age "${i}"^^xsd:decimal ; <http://other.example/age> "${i}"^^xsd:decimal` }));
    const r = await rest(id('21'), file, { schema: 'expand', from: ['data'] });
    ok(r);
    const props = d.heldTypes(id('21')).entity?.Person?.propertySchemas ?? {};
    assert.equal(props.age?.type, 'string', `the stored datatype stands: ${JSON.stringify(props)}`);
    assert.deepEqual(props.age_2, { iri: 'http://other.example/age', type: 'number' }, JSON.stringify(props));
  });

  it('23: a label foaf:Person or UNTYPED gives a valid numbered or prefixed name and a valid endpoint', async () => {
    const file = ttl(
      'ex:A rdfs:label "foaf:Person" .', 'ex:B rdfs:label "UNTYPED" .',
      people(2, { cls: 'ex:A', prefix: 'a', extra: (i) => `ex:rel p:b${i}` }), people(2, { cls: 'ex:B', prefix: 'b' }),
    );
    const r = await rest(id('23'), file);
    ok(r);
    const held = d.heldTypes(id('23'));
    assert.deepEqual(Object.keys(held.entity ?? {}).sort(), ['UNTYPED_2', 'foaf:Person'], JSON.stringify(held));
    assert.deepEqual(held.edge?.rel?.endpoints, { from: ['entity:foaf:Person'], to: ['UNTYPED_2'] }, JSON.stringify(held.edge));
  });

  it('25: an invalid, an over-long and a __proto__ label fall back to the local part, or the term is named not inferred; the import lands', async () => {
    const long = 'L'.repeat(201);
    const file = ttl(
      'ex:C1 rdfs:label "" .', `ex:C2 rdfs:label "${long}" .`, 'ex:C3 rdfs:label "__proto__" .',
      people(2, { cls: 'ex:C1', prefix: 'c1' }), people(2, { cls: 'ex:C2', prefix: 'c2' }), people(2, { cls: 'ex:C3', prefix: 'c3' }),
    );
    const r = await rest(id('25'), file);
    ok(r);
    assert.deepEqual(Object.keys(d.heldTypes(id('25')).entity ?? {}).sort(), ['C1', 'C2', 'C3']);
    const noName = await rest(id('25b'), ttl('<http://x.example/c/> rdfs:label "__proto__" .', people(2, { cls: '<http://x.example/c/>' })), { ...DATA, dryRun: true });
    ok(noName);
    assert.ok(named(inferredOf(noName).notInferred, n => n.iri === 'http://x.example/c/' && n.why === 'no-name'), JSON.stringify(inferredOf(noName)));
  });

  it('26: an inferred address equal to a declared class takes the declared term, never a number', async () => {
    const file = ttl('ex:Person a owl:Class ; rdfs:label "Human" .', people(2, { extra: (i) => `ex:age "${i}"^^xsd:decimal` }));
    const r = await rest(id('26'), file, { schema: 'generate', from: ['declared', 'data'] });
    ok(r);
    const entity = d.heldTypes(id('26')).entity ?? {};
    assert.deepEqual(Object.keys(entity), ['Human'], JSON.stringify(entity));
    assert.equal(entity.Human.propertySchemas?.age?.type, 'number');
  });

  it('27: equal string and number counts give string; an other-only column is left out and named', async () => {
    const file = ttl(people(2, { extra: (i) => `ex:code ${i === 0 ? '"1"^^xsd:decimal' : '"x"'} ; ex:home "http://h.example/${i}"^^xsd:anyURI` }));
    const r = await rest(id('27'), file);
    ok(r);
    const props = d.heldTypes(id('27')).entity?.Person?.propertySchemas ?? {};
    assert.equal(props.code?.type, 'string', JSON.stringify(props));
    assert.equal(props.home, undefined);
    assert.ok(named(inferredOf(r).notInferred, n => n.iri === `${EX}home` && n.why === 'other-only'), JSON.stringify(inferredOf(r).notInferred));
  });

  it('30: from: [data] with an sh:NodeShape subject: not a record', async () => {
    const r = await rest(id('30'), ttl('ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person .', people(2)));
    ok(r);
    assert.equal((await names(id('30'))).length, 2);
  });

  it('33: with from: [shacl], owl:Class groups are named not asked, neither built nor imported', async () => {
    const file = ttl(
      'ex:Place a owl:Class .', 'ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person .',
      people(2), 'p:here a ex:Place ; rdfs:label "Here" .',
    );
    // A dry run: its report names the schema step it would write (the refused import's own report carries none, as nothing was written).
    const r = await d.importRestOne(writer.key, id('33'), file, { schema: 'generate', from: ['shacl'], dryRun: true });
    assert.equal(r.status, 409, `the Place subject has no type the space knows: ${r.text.slice(0, 400)}`);
    assert.equal(r.body.report.notTaken?.['schema-not-asked'], 1, JSON.stringify(r.body.report.notTaken));
    const added = r.body.report.schema?.typesAdded ?? [];
    assert.ok(added.includes('entity:Person') && !added.includes('entity:Place'), `the shape is built, the class is not: ${JSON.stringify(added)}`);
    assert.deepEqual(d.heldTypes(id('33')), {});
  });

  it('34: a type seen on one subject is not inferred at the default support 2 and is named with support 1; with inferMinSupport=1 it is', async () => {
    const file = ttl(people(2), people(1, { cls: 'ex:Lonely', prefix: 'l' }));
    const at2 = await rest(id('34'), file, { ...DATA, dryRun: true });
    ok(at2);
    assert.equal(named(inferredOf(at2).notInferred, n => n.iri === `${EX}Lonely`)?.support, 1, JSON.stringify(inferredOf(at2)));
    assert.equal(named(inferredOf(at2).types, t => t.iri === `${EX}Lonely`), undefined);
    const at1 = await rest(id('34'), file, { ...DATA, dryRun: true, inferMinSupport: 1 });
    ok(at1);
    assert.ok(named(inferredOf(at1).types, t => t.iri === `${EX}Lonely`), JSON.stringify(inferredOf(at1)));
  });

  it('35: a property on 30% of a type\'s subjects is attached at the default confidence and left out at 0.5, named with its confidence', async () => {
    const file = ttl(people(10, { extra: (i) => (i < 3 ? `ex:nick "n${i}"` : '') }));
    const at0 = await rest(id('35'), file, { ...DATA, dryRun: true });
    ok(at0);
    assert.ok(named(inferredOf(at0).properties, p => p.iri === `${EX}nick`), JSON.stringify(inferredOf(at0)));
    const at5 = await rest(id('35'), file, { ...DATA, dryRun: true, inferMinConfidence: 0.5 });
    ok(at5);
    const left = named(inferredOf(at5).notInferred, n => n.iri === `${EX}nick`);
    assert.equal(left?.confidence, 0.3, JSON.stringify(inferredOf(at5)));
  });

  it('36: a column whose majority holds 60% is typed at confidence 0.5 and left out as mixed at 0.7', async () => {
    const file = ttl(people(5, { extra: (i) => (i < 3 ? `ex:code "${i}"^^xsd:decimal` : `ex:code "s${i}"`) }));
    const at5 = await rest(id('36'), file, { ...DATA, dryRun: true, inferMinConfidence: 0.5 });
    ok(at5);
    assert.equal(named(inferredOf(at5).properties, p => p.iri === `${EX}code`)?.datatype, 'number', JSON.stringify(inferredOf(at5)));
    const at7 = await rest(id('36'), file, { ...DATA, dryRun: true, inferMinConfidence: 0.7 });
    ok(at7);
    assert.equal(named(inferredOf(at7).properties, p => p.iri === `${EX}code`), undefined, JSON.stringify(inferredOf(at7)));
    assert.equal(named(inferredOf(at7).notInferred, n => n.iri === `${EX}code`)?.why, 'mixed', JSON.stringify(inferredOf(at7)));
  });

  it('37: every inferred term in the answer carries support and confidence', async () => {
    const r = await rest(id('37'), TICKET_FILE, { ...DATA, dryRun: true });
    ok(r);
    const inf = inferredOf(r);
    const terms = [...(inf.types ?? []), ...(inf.properties ?? []), ...(inf.edges ?? [])];
    assert.equal(terms.length, 3, `a type, a property and an edge label: ${JSON.stringify(inf)}`);
    for (const t of terms) {
      assert.ok(Number.isInteger(t.support) && t.support >= 1, `support: ${JSON.stringify(t)}`);
      assert.ok(typeof t.confidence === 'number' && t.confidence > 0 && t.confidence <= 1, `confidence: ${JSON.stringify(t)}`);
    }
    assert.ok(!JSON.stringify(stepOf(r)).includes(PEOPLE), 'no record address is repeated');
  });
});
