/**
 * A space's schema is exported as OWL axioms (meaning, own terms only) and SHACL shapes (rules, every type and property), versioned by its
 * fingerprint (Q-751, design r4 §6, §8; owner, 2026-11-18: every schema field and every description reaches the export).
 *
 * ## The defect this prevents
 *
 * An RDF consumer validates exported records against the shapes and reads meaning from the axioms. A shape that says MORE than the server
 * checks refuses a record the server accepted; one that says LESS lets through what the server refuses; an axiom stated about a term the
 * space does not own (`schema:Person`, because a type was mapped to it) rewrites someone else's vocabulary; a description dropped because the
 * term it describes is an outside one loses the owner's words. `schemaGraph(meta, fingerprint)` in `server/src/rdf/schema-owl-shacl.ts` is
 * the one pure function that makes the graph, and this file holds its FORM, resource by resource, as a whole tree each (so a statement the
 * form does not name fails as surely as one it lacks).
 *
 * ## What it holds
 *
 * - **The ontology header**: `<base>schema` is an `owl:Ontology` with `owl:versionIRI <base>schema/<fingerprint>`, `owl:versionInfo` the
 *   fingerprint, `rdfs:comment` the purpose, and the space's validation mode, linkage and rules. A schema that differs gives another version;
 *   the same schema gives the same quads and the same bytes whatever the order its keys were written in.
 * - **Own terms versus outside terms**: axioms (`rdfs:isDefinedBy`, label, comment, domain, range, functional) only for a term under the
 *   space's vocab or an instance group namespace; the space's words about ANY term are on the term's SHACL shape. An outside term is never
 *   the subject of a statement.
 * - **A property**: label, comment, `owl:DatatypeProperty`, `owl:FunctionalProperty`, domain, a range from the declared type, an enumeration
 *   or restrictions; and a shape with `sh:name`, `sh:description`, `sh:path`, `sh:maxCount 1`, `sh:datatype` (a date is the four-member union),
 *   `sh:in` typed by the declared type, guarded `sh:minInclusive`, `sh:maxInclusive` and `sh:pattern`, `sh:minCount 1` with `sh:minLength 1` for
 *   a required one, `sh:defaultValue`, and `ythril:mergeFn` on the shape and on an own property.
 * - **A type**: an entity, fact or chrono type is a class and a node shape with the class as its target; an edge type is a PROPERTY (never a
 *   class) with endpoints as `sh:or` of `sh:class`, an unresolved endpoint passing, a functional label as `sh:maxCount 1`, the properties of an
 *   edge on their own shapes aimed at the reifier; a naming pattern is a pattern on `rdfs:label` for an entity and an annotation for every kind;
 *   retention, embedding suppression, the due-date policy and rules are annotations on the node shape.
 * - **Every text is a plain literal** (no datatype, no language), and a number or a boolean is typed by the one literal function.
 * - **A value that does not fit its declared type** is left out and NAMED in the result, never guessed.
 * - **An unresolved `$ref`** is exported as `ythril:unresolvedRef`, never dropped and never a throw.
 * - **The writers can write it**: Turtle, N-Quads and JSON-LD of the graph are read back by independent parsers as the same triples.
 *
 * Run: node --test testing/standalone/a-schema-exports-as-owl-and-shacl.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import jsonld from 'jsonld';
import {
  VOCAB, FP, ONTOLOGY, META, iriOf, I, L, DEC, INT, BOOL, LIST, norm, treeAt, subjectsOf, termAt, shapeAt,
} from './_schema-export-fixture.mjs';

const mod = await import('../../server/dist/rdf/schema-owl-shacl.js').catch(() => ({}));
const ser = await import('../../server/dist/rdf/serialize.js').catch(() => ({}));
const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));

const graph = (meta = META, fingerprint = FP, options) => {
  assert.equal(typeof mod.schemaGraph, 'function', 'schemaGraph is not exported by server/src/rdf/schema-owl-shacl.ts: the schema has no RDF form');
  return mod.schemaGraph(meta, fingerprint, options);
};
const clone = (meta) => structuredClone(meta);
const withTypes = (kind, types, extra = {}) => ({ rdf: META.rdf, ...extra, typeSchemas: { [kind]: types } });

describe('the ontology header', () => {
  it('names the ontology, its version by the fingerprint, the purpose, and what the space says about itself', () => {
    const { quads } = graph(withTypes('entity', {}, {
      purpose: 'A purpose', validationMode: 'strict', strictLinkage: true,
      rules: { cap: { rule: 'size(self.name) < 50', message: 'name too long', kinds: ['entity', 'fact'] }, any: { rule: 'true', message: 'always' } },
    }));
    assert.deepEqual(treeAt(quads, ONTOLOGY), norm({
      'rdf:type': [I('owl:Ontology')],
      'owl:versionIRI': [I(`${ONTOLOGY}/${FP}`)],
      'owl:versionInfo': [L(FP)],
      'rdfs:comment': [L('A purpose')],
      'ythril:validationMode': [L('strict')],
      'ythril:strictLinkage': [BOOL(true)],
      'ythril:rule': [
        { 'ythril:ruleName': [L('cap')], 'ythril:ruleExpression': [L('size(self.name) < 50')], 'ythril:ruleMessage': [L('name too long')], 'ythril:ruleKinds': [L('entity'), L('fact')] },
        { 'ythril:ruleName': [L('any')], 'ythril:ruleExpression': [L('true')], 'ythril:ruleMessage': [L('always')] },
      ],
    }));
  });

  it('says nothing the space did not say: no purpose, no comment; no mode, no annotation', () => {
    const { quads } = graph(withTypes('entity', {}));
    assert.deepEqual(treeAt(quads, ONTOLOGY), norm({ 'rdf:type': [I('owl:Ontology')], 'owl:versionIRI': [I(`${ONTOLOGY}/${FP}`)], 'owl:versionInfo': [L(FP)] }));
  });

  it('the result names the ontology, the version, the prefixes of the space and what it left out', () => {
    const result = graph();
    assert.equal(result.ontology, ONTOLOGY);
    assert.equal(result.version, `${ONTOLOGY}/${FP}`);
    assert.equal(result.prefixes.vocab, VOCAB);
    assert.equal(result.prefixes.ythril, vocab.YTHRIL_NS);
    assert.deepEqual(result.leftOut, []);
    assert.ok(result.quads.every(q => q.graph === undefined), 'the stream names the graph, never the schema graph');
  });

  it('is refused for a space with RDF off, and for what is no fingerprint', () => {
    assert.throws(() => graph({ typeSchemas: META.typeSchemas }), (err) => err?.code === 'rdf_not_enabled');
    assert.throws(() => graph({ ...META, rdf: { ...META.rdf, enabled: false } }), (err) => err?.code === 'rdf_not_enabled');
    for (const bad of ['', 'xyz', 'AB12'.repeat(16), 'ab12'.repeat(15), null]) assert.throws(() => graph(META, bad), /fingerprint/i, `a fingerprint of ${String(bad)} is refused`);
  });

  it('a space with no schema still has its ontology', () => {
    const { quads } = graph({ rdf: META.rdf });
    assert.deepEqual(subjectsOf(quads), [ONTOLOGY]);
  });
});

describe('own terms and outside terms', () => {
  const meta = withTypes('entity', {
    person: { description: 'Own class words', propertySchemas: { nick: { type: 'string', description: 'Own property words' } } },
    contact: {
      iri: 'http://schema.org/Person', description: 'Outside class words',
      propertySchemas: { email: { type: 'string', iri: 'http://schema.org/email', description: 'Outside property words', required: true } },
    },
  });

  it('an own term has its axioms, an outside term has none and is never the subject of a statement', () => {
    const { quads } = graph(meta);
    assert.deepEqual(treeAt(quads, termAt('entity', 'person')), norm({
      'rdf:type': [I('owl:Class')], 'rdfs:label': [L('person')], 'rdfs:comment': [L('Own class words')], 'rdfs:isDefinedBy': [I(ONTOLOGY)],
    }));
    assert.deepEqual(treeAt(quads, termAt('entity', 'person', 'nick')), norm({
      'rdf:type': [I('owl:DatatypeProperty'), I('owl:FunctionalProperty')], 'rdfs:label': [L('nick')], 'rdfs:comment': [L('Own property words')],
      'rdfs:isDefinedBy': [I(ONTOLOGY)], 'rdfs:domain': [I(termAt('entity', 'person'))], 'rdfs:range': [I('xsd:string')],
    }));
    const outside = subjectsOf(quads).filter(s => s.startsWith('http://schema.org/'));
    assert.deepEqual(outside, [], 'nothing is stated about schema:Person or schema:email');
  });

  it('the space\'s words about an outside term reach its shape: name, description, path and target', () => {
    const { quads } = graph(meta);
    const type = treeAt(quads, shapeAt('entity', 'contact'));
    assert.deepEqual(type['sh:description'], [L('Outside class words')]);
    assert.deepEqual(type['sh:name'], [L('contact')]);
    assert.deepEqual(type['sh:targetClass'], [I('http://schema.org/Person')]);
    const prop = treeAt(quads, shapeAt('entity', 'contact', 'email'));
    assert.deepEqual(prop['sh:description'], [L('Outside property words')]);
    assert.deepEqual(prop['sh:name'], [L('email')]);
    assert.deepEqual(prop['sh:path'], [I('http://schema.org/email')]);
    assert.deepEqual(prop['sh:minCount'], [INT(1)]);
  });

  it('an own term has its words on its shape as well', () => {
    const { quads } = graph(meta);
    assert.deepEqual(treeAt(quads, shapeAt('entity', 'person'))['sh:description'], [L('Own class words')]);
    assert.deepEqual(treeAt(quads, shapeAt('entity', 'person', 'nick'))['sh:description'], [L('Own property words')]);
  });

  it('a term under a group namespace is own when the instance\'s namespaces are handed in, and outside when they are not', () => {
    const grouped = withTypes('entity', { thing: { iri: 'https://ns.example.org/lib/entity/thing', description: 'From the library', propertySchemas: { size: { type: 'number', iri: 'https://ns.example.org/lib/entity/thing/size' } } } });
    const without = graph(grouped).quads;
    assert.ok(!subjectsOf(without).includes('https://ns.example.org/lib/entity/thing'), 'unknown namespace: an outside term');
    const { quads, prefixes } = graph(grouped, FP, { namespaces: [{ prefix: 'lib', iri: 'https://ns.example.org/lib/' }] });
    assert.deepEqual(treeAt(quads, 'https://ns.example.org/lib/entity/thing')['rdfs:isDefinedBy'], [I(ONTOLOGY)]);
    assert.deepEqual(treeAt(quads, 'https://ns.example.org/lib/entity/thing/size')['rdfs:domain'], [I('https://ns.example.org/lib/entity/thing')]);
    assert.equal(prefixes.lib, 'https://ns.example.org/lib/', 'the group prefix is declared for the writer');
  });
});

describe('a property: its axioms and its shape, field by field', () => {
  const { quads } = graph();
  const P = (prop) => treeAt(quads, termAt('entity', 'person', prop));
  const S = (prop) => treeAt(quads, shapeAt('entity', 'person', prop));
  const DT = (name) => ({ 'sh:datatype': [I(name)] });
  const NOT_DECIMAL = { 'sh:not': [DT('xsd:decimal')] };
  const owned = (extra) => ({ 'rdf:type': [I('owl:DatatypeProperty'), I('owl:FunctionalProperty')], 'rdfs:isDefinedBy': [I(ONTOLOGY)], 'rdfs:domain': [I(termAt('entity', 'person'))], ...extra });
  const shape = (prop, extra) => ({ 'rdf:type': [I('sh:PropertyShape')], 'sh:path': [I(termAt('entity', 'person', prop))], 'sh:name': [L(prop)], 'sh:maxCount': [INT(1)], ...extra });

  it('a required, patterned string: minimum count and length one, a guarded pattern, a pattern facet on its range', () => {
    assert.deepEqual(P('name'), norm(owned({
      'rdfs:label': [L('name')], 'rdfs:comment': [L('The full name')],
      'rdfs:range': [{ 'rdf:type': [I('rdfs:Datatype')], 'owl:onDatatype': [I('xsd:string')], 'owl:withRestrictions': [LIST({ 'xsd:pattern': [L('^[A-Za-z ]+$')] })] }],
    })));
    assert.deepEqual(S('name'), norm(shape('name', {
      'sh:description': [L('The full name')], 'sh:datatype': [I('xsd:string')], 'sh:minCount': [INT(1)], 'sh:minLength': [INT(1)],
      'sh:or': [LIST(DT('xsd:decimal'), DT('xsd:boolean'), { 'sh:pattern': [L('^[A-Za-z ]+$')] })],
    })));
  });

  it('a number with a range: decimal facets on the range, guarded sh:minInclusive and sh:maxInclusive, each guard its own sh:or', () => {
    assert.deepEqual(P('age'), norm(owned({
      'rdfs:label': [L('age')], 'rdfs:comment': [L('Age in years')],
      'rdfs:range': [{ 'rdf:type': [I('rdfs:Datatype')], 'owl:onDatatype': [I('xsd:decimal')], 'owl:withRestrictions': [LIST({ 'xsd:minInclusive': [DEC(0)] }, { 'xsd:maxInclusive': [DEC(150)] })] }],
    })));
    assert.deepEqual(S('age'), norm(shape('age', {
      'sh:description': [L('Age in years')], 'sh:datatype': [I('xsd:decimal')],
      'sh:or': [LIST(NOT_DECIMAL, { 'sh:minInclusive': [DEC(0)] }), LIST(NOT_DECIMAL, { 'sh:maxInclusive': [DEC(150)] })],
    })));
  });

  it('an enumeration is sh:in and owl:oneOf, its members typed by the declared type; a default is sh:defaultValue, typed alike', () => {
    assert.deepEqual(P('status'), norm(owned({
      'rdfs:label': [L('status')], 'rdfs:range': [{ 'rdf:type': [I('rdfs:Datatype')], 'owl:oneOf': [LIST(L('active'), L('retired'))] }],
    })));
    assert.deepEqual(S('status'), norm(shape('status', { 'sh:datatype': [I('xsd:string')], 'sh:in': [LIST(L('active'), L('retired'))], 'sh:defaultValue': [L('active')] })));
    assert.deepEqual(S('level')['sh:in'], norm([LIST(DEC(1), DEC(2), DEC(3))]));
    assert.deepEqual(P('level')['rdfs:range'], norm([{ 'rdf:type': [I('rdfs:Datatype')], 'owl:oneOf': [LIST(DEC(1), DEC(2), DEC(3))] }]));
  });

  it('a date is rdfs:Literal in OWL (xsd:date is outside OWL 2 DL) and the four types it is written as in SHACL; a boolean is xsd:boolean with its typed default', () => {
    assert.deepEqual(P('born')['rdfs:range'], [I('rdfs:Literal')]);
    assert.deepEqual(S('born'), norm(shape('born', { 'sh:or': [LIST(DT('xsd:dateTimeStamp'), DT('xsd:dateTime'), DT('xsd:date'), DT('xsd:string'))] })));
    assert.deepEqual(P('active')['rdfs:range'], [I('xsd:boolean')]);
    assert.deepEqual(S('active'), norm(shape('active', { 'sh:datatype': [I('xsd:boolean')], 'sh:defaultValue': [BOOL(true)] })));
  });

  it('a merge function is ythril:mergeFn on the shape and on the own property', () => {
    assert.deepEqual(S('score')['ythril:mergeFn'], [L('avg')]);
    assert.deepEqual(P('score')['ythril:mergeFn'], [L('avg')]);
  });

  it('a range or a pattern with no declared type is a guard only: no datatype, and no restriction the server does not apply to every value', () => {
    assert.deepEqual(S('loose'), norm(shape('loose', { 'sh:or': [LIST(NOT_DECIMAL, { 'sh:minInclusive': [DEC(5)] })] })));
    assert.equal(P('loose')['rdfs:range'], undefined);
    assert.deepEqual(S('code'), norm(shape('code', { 'sh:or': [LIST(DT('xsd:decimal'), DT('xsd:boolean'), { 'sh:pattern': [L('^A')] })] })));
    assert.equal(P('code')['rdfs:range'], undefined);
  });

  it('an explicit address is the path of the shape and no own term', () => {
    assert.deepEqual(S('email'), norm({
      'rdf:type': [I('sh:PropertyShape')], 'sh:path': [I('http://schema.org/email')], 'sh:name': [L('email')], 'sh:description': [L('Mail address')],
      'sh:maxCount': [INT(1)], 'sh:datatype': [I('xsd:string')],
    }));
    assert.equal(P('email')['rdf:type'], undefined);
  });

  it('every property shape is hung on its type\'s node shape', () => {
    const owner = treeAt(quads, shapeAt('entity', 'person'));
    const hung = owner['sh:property'].filter(x => typeof x === 'string');
    const props = Object.keys(META.typeSchemas.entity.person.propertySchemas).map(p => I(shapeAt('entity', 'person', p)));
    assert.deepEqual(hung.sort(), props.sort());
  });
});

describe('what does not fit its declared type is left out and named', () => {
  it('an enum member and a default of another type, named once each by where and what', () => {
    const meta = withTypes('entity', { t: { propertySchemas: { p: { type: 'number', enum: [1, 'two', 3], default: 'x' } } } });
    const { quads, leftOut } = graph(meta);
    assert.deepEqual(leftOut, [
      { where: 'entity:t.p', field: 'enum', reason: 'does-not-fit-its-declared-type' },
      { where: 'entity:t.p', field: 'default', reason: 'does-not-fit-its-declared-type' },
    ]);
    const shape = treeAt(quads, shapeAt('entity', 't', 'p'));
    assert.deepEqual(shape['sh:in'], norm([LIST(DEC(1), DEC(3))]));
    assert.equal(shape['sh:defaultValue'], undefined, 'no default is written for a value that is no number');
    assert.deepEqual(treeAt(quads, termAt('entity', 't', 'p'))['rdfs:range'], norm([{ 'rdf:type': [I('rdfs:Datatype')], 'owl:oneOf': [LIST(DEC(1), DEC(3))] }]));
  });

  it('an empty enumeration restricts nothing, as the server reads it', () => {
    const { quads, leftOut } = graph(withTypes('entity', { t: { propertySchemas: { p: { type: 'string', enum: [] } } } }));
    assert.equal(treeAt(quads, shapeAt('entity', 't', 'p'))['sh:in'], undefined);
    assert.deepEqual(leftOut, []);
  });

  it('an enumeration none of whose members fits admits nothing, as the server\'s type check refuses every value first', () => {
    const { quads } = graph(withTypes('entity', { t: { propertySchemas: { p: { type: 'number', enum: ['a'] } } } }));
    assert.deepEqual(treeAt(quads, shapeAt('entity', 't', 'p'))['sh:in'], norm([LIST()]));
  });
});

describe('a type: its class, its node shape and its annotations', () => {
  const { quads } = graph();
  const N = (kind, type) => treeAt(quads, shapeAt(kind, type));

  it('an entity type is a class, and a node shape that targets it, with its properties and its naming pattern', () => {
    assert.deepEqual(treeAt(quads, termAt('entity', 'person')), norm({
      'rdf:type': [I('owl:Class')], 'rdfs:label': [L('person')], 'rdfs:comment': [L('A person we know')], 'rdfs:isDefinedBy': [I(ONTOLOGY)],
    }));
    const node = N('entity', 'person');
    const naming = node['sh:property'].find(x => typeof x === 'object');
    assert.deepEqual(naming, norm({ 'rdf:type': [I('sh:PropertyShape')], 'sh:path': [I('rdfs:label')], 'sh:name': [L('name')], 'sh:pattern': [L('^[A-Z]')] }));
    const { 'sh:property': _hung, ...rest } = node;
    assert.deepEqual(rest, norm({
      'rdf:type': [I('sh:NodeShape')], 'sh:name': [L('person')], 'sh:description': [L('A person we know')],
      'sh:targetClass': [I(termAt('entity', 'person'))], 'ythril:namingPattern': [L('^[A-Z]')],
    }));
  });

  it('a type with nothing to say is a class and a node shape with a name', () => {
    assert.deepEqual(treeAt(quads, termAt('entity', 'robot')), norm({ 'rdf:type': [I('owl:Class')], 'rdfs:label': [L('robot')], 'rdfs:isDefinedBy': [I(ONTOLOGY)] }));
    assert.deepEqual(N('entity', 'robot'), norm({ 'rdf:type': [I('sh:NodeShape')], 'sh:name': [L('robot')], 'sh:targetClass': [I(termAt('entity', 'robot'))] }));
  });

  it('a fact type and a chrono type are classes; a naming pattern is an annotation there, and retention, suppression and the due policy too', () => {
    assert.deepEqual(treeAt(quads, termAt('fact', 'note'))['rdf:type'], [I('owl:Class')]);
    assert.deepEqual(treeAt(quads, termAt('chrono', 'meeting'))['rdf:type'], [I('owl:Class')]);
    assert.deepEqual(N('chrono', 'meeting'), norm({
      'rdf:type': [I('sh:NodeShape')], 'sh:name': [L('meeting')], 'sh:targetClass': [I(termAt('chrono', 'meeting'))],
      'sh:property': [I(shapeAt('chrono', 'meeting', 'room'))],
      'ythril:whenDuePasses': [L('nothing')], 'ythril:retentionDays': [INT(30)], 'ythril:retentionContentDays': [INT(7)],
    }));
    const other = graph(withTypes('fact', { f: { namingPattern: '^x', suppressEmbeddings: true, rules: { r: { rule: 'true', message: 'm' } } } })).quads;
    assert.deepEqual(treeAt(other, shapeAt('fact', 'f')), norm({
      'rdf:type': [I('sh:NodeShape')], 'sh:name': [L('f')], 'sh:targetClass': [I(termAt('fact', 'f'))],
      'ythril:namingPattern': [L('^x')], 'ythril:suppressEmbeddings': [BOOL(true)],
      'ythril:rule': [{ 'ythril:ruleName': [L('r')], 'ythril:ruleExpression': [L('true')], 'ythril:ruleMessage': [L('m')] }],
    }));
  });
});

describe('an edge type: a property, never a class', () => {
  const { quads } = graph();
  const label = termAt('edge', 'knows');
  const isEntity = { 'sh:not': [{ 'sh:class': [I('ythril:Entity')] }] };

  it('the label is an object property with no domain and no range', () => {
    assert.deepEqual(treeAt(quads, label), norm({
      'rdf:type': [I('owl:ObjectProperty')], 'rdfs:label': [L('knows')], 'rdfs:comment': [L('One person knows another')], 'rdfs:isDefinedBy': [I(ONTOLOGY)],
    }));
    assert.deepEqual(treeAt(quads, termAt('edge', 'reports_to'))['rdf:type'], norm([I('owl:ObjectProperty'), I('owl:FunctionalProperty')]));
    assert.ok(!quads.some(q => q.predicate.value === iriOf('sh:targetClass') && q.subject.value === shapeAt('edge', 'knows')), 'an edge label has no class');
  });

  it('endpoints are sh:or of sh:class, a record that is no entity passing; "UNTYPED" is the untyped class and an entity type of that name', () => {
    assert.deepEqual(treeAt(quads, shapeAt('edge', 'knows')), norm({
      'rdf:type': [I('sh:NodeShape')], 'sh:name': [L('knows')], 'sh:description': [L('One person knows another')], 'sh:targetSubjectsOf': [I(label)],
      'sh:or': [LIST({ 'sh:class': [I(termAt('entity', 'person'))] }, isEntity)],
      'ythril:endpointFrom': [I(termAt('entity', 'person'))],
      'ythril:endpointTo': [I(termAt('entity', 'person')), I('ythril:Untyped'), I(termAt('entity', 'UNTYPED'))],
      'ythril:requiredEdgeProperty': [I(termAt('edge', 'knows', 'strength'))],
      'sh:property': [{
        'rdf:type': [I('sh:PropertyShape')], 'sh:path': [I(label)], 'sh:name': [L('knows')],
        'sh:or': [LIST({ 'sh:class': [I(termAt('entity', 'person'))] }, { 'sh:class': [I('ythril:Untyped')] }, { 'sh:class': [I(termAt('entity', 'UNTYPED'))] }, isEntity)],
      }],
    }));
  });

  it('a member written entity:<type> is the type', () => {
    const q = graph(withTypes('edge', { e: { endpoints: { from: ['entity:person'] } } })).quads;
    assert.deepEqual(treeAt(q, shapeAt('edge', 'e'))['sh:or'], norm([LIST({ 'sh:class': [I(termAt('entity', 'person'))] }, isEntity)]));
  });

  it('a functional label is at most one object for a subject', () => {
    assert.deepEqual(treeAt(quads, shapeAt('edge', 'reports_to')), norm({
      'rdf:type': [I('sh:NodeShape')], 'sh:name': [L('reports_to')], 'sh:targetSubjectsOf': [I(termAt('edge', 'reports_to'))],
      'sh:property': [{ 'rdf:type': [I('sh:PropertyShape')], 'sh:path': [I(termAt('edge', 'reports_to'))], 'sh:name': [L('reports_to')], 'sh:maxCount': [INT(1)] }],
    }));
  });

  it('the properties of an edge are on their own shapes, aimed at the reifier, and a required one has no count (nothing to target)', () => {
    const own = (prop) => ({ 'rdf:type': [I('owl:DatatypeProperty'), I('owl:FunctionalProperty')], 'rdfs:isDefinedBy': [I(ONTOLOGY)], 'rdfs:label': [L(prop)] });
    assert.deepEqual(treeAt(quads, termAt('edge', 'knows', 'since')), norm({ ...own('since'), 'rdfs:range': [I('rdfs:Literal')] }));
    assert.deepEqual(treeAt(quads, shapeAt('edge', 'knows', 'since')), norm({
      'rdf:type': [I('sh:PropertyShape')], 'sh:path': [I(termAt('edge', 'knows', 'since'))], 'sh:name': [L('since')], 'sh:targetSubjectsOf': [I(termAt('edge', 'knows', 'since'))],
      'sh:maxCount': [INT(1)], 'sh:or': [LIST({ 'sh:datatype': [I('xsd:dateTimeStamp')] }, { 'sh:datatype': [I('xsd:dateTime')] }, { 'sh:datatype': [I('xsd:date')] }, { 'sh:datatype': [I('xsd:string')] })],
    }));
    const strength = treeAt(quads, shapeAt('edge', 'knows', 'strength'));
    assert.equal(strength['sh:minCount'], undefined);
    assert.deepEqual(strength['sh:minLength'], [INT(1)]);
    assert.deepEqual(strength['sh:targetSubjectsOf'], [I(termAt('edge', 'knows', 'strength'))]);
  });

  it('an outside edge label is the target and the path and never a subject', () => {
    const q = graph(withTypes('edge', { friend: { iri: 'http://schema.org/knows', functional: true, description: 'Mapped' } })).quads;
    assert.deepEqual(subjectsOf(q).filter(s => s.startsWith('http://schema.org/')), []);
    assert.deepEqual(treeAt(q, shapeAt('edge', 'friend'))['sh:targetSubjectsOf'], [I('http://schema.org/knows')]);
    assert.deepEqual(treeAt(q, shapeAt('edge', 'friend'))['sh:description'], [L('Mapped')]);
  });
});

describe('an unresolved library reference is exported, never dropped and never a throw', () => {
  for (const [what, def] of [['a bare $ref (the inlined form)', { $ref: 'library:missing' }], ['the stamped form', { _unresolvedRef: 'library:missing' }]]) {
    it(what, () => {
      const { quads } = graph(withTypes('entity', { broken: def }));
      assert.deepEqual(treeAt(quads, shapeAt('entity', 'broken'))['ythril:unresolvedRef'], [L('library:missing')]);
      assert.deepEqual(treeAt(quads, shapeAt('entity', 'broken'))['sh:name'], [L('broken')]);
      assert.deepEqual(treeAt(quads, termAt('entity', 'broken'))['rdf:type'], [I('owl:Class')]);
    });
  }
  it('an edge reference too, and a resolved definition is no unresolved mark', () => {
    const { quads } = graph(withTypes('edge', { e: { $ref: 'library:missing' }, ok: { $ref: 'library:there', description: 'inlined from the library' } }));
    assert.deepEqual(treeAt(quads, shapeAt('edge', 'e'))['ythril:unresolvedRef'], [L('library:missing')]);
    assert.equal(treeAt(quads, shapeAt('edge', 'ok'))['ythril:unresolvedRef'], undefined);
  });
});

describe('every shape is named, whatever a name holds', () => {
  it('every node shape and every property shape of the fixture has an sh:name, the helper shapes of a naming pattern and an edge label included', () => {
    const { quads } = graph();
    const shapes = quads.filter(q => q.predicate.value === iriOf('rdf:type') && [iriOf('sh:NodeShape'), iriOf('sh:PropertyShape')].includes(q.object.value));
    assert.ok(shapes.length > 20, 'the fixture has many shapes');
    for (const { subject } of shapes) {
      const named = quads.filter(q => q.predicate.value === iriOf('sh:name') && (subject.kind === 'blank' ? q.subject.kind === 'blank' && q.subject.id === subject.id : q.subject.value === subject.value));
      assert.equal(named.length, 1, `${subject.value ?? `blank node ${subject.id}`} has one sh:name`);
    }
  });

  it('a name with a slash, a hash, a space, a quote and a non-ASCII letter is encoded in the address and kept whole in sh:name and the label, and is written', async () => {
    const type = 'odd/type #1 "x" é';
    const prop = 'a#b c/d';
    const { quads, prefixes } = graph(withTypes('entity', { [type]: { propertySchemas: { [prop]: { type: 'string' } } } }));
    const shape = quads.find(q => q.predicate.value === iriOf('sh:path') && q.object.kind === 'iri' && q.object.value.startsWith(`${VOCAB}entity/`));
    assert.ok(shape, 'the property shape names the property term');
    const [document, fragment, ...more] = shape.object.value.slice(VOCAB.length).split('#');
    assert.deepEqual(more, [], 'one "#": the property is a fragment of its type\'s document');
    assert.ok(!/[ "#]/.test(document) && !/[ "#]/.test(fragment), 'no character an address cannot hold is written raw');
    assert.deepEqual(treeAt(quads, shape.subject.value)['sh:name'], [L(prop)]);
    assert.deepEqual(treeAt(quads, shape.object.value)['rdfs:label'], [L(prop)]);
    let out = '';
    for await (const chunk of ser.serializeRdf('turtle', [{ quads }], { prefixes })) out += chunk;
    assert.ok(new Parser({ format: 'Turtle' }).parse(out).length > 10, 'the writer wrote it and a parser read it');
  });
});

describe('every text is a plain literal; every ythril: term is declared', () => {
  const { quads } = graph();
  it('a label, a comment, a name, a description and a pattern are plain literals', () => {
    const textual = ['rdfs:label', 'rdfs:comment', 'sh:name', 'sh:description', 'sh:pattern', 'ythril:namingPattern', 'ythril:mergeFn', 'owl:versionInfo'].map(iriOf);
    const found = quads.filter(q => textual.includes(q.predicate.value));
    assert.ok(found.length > 20, 'the fixture states many texts');
    for (const q of found) assert.deepEqual(q.object, { kind: 'literal', value: q.object.value }, `${q.predicate.value} of ${q.subject.value ?? 'a blank node'} is a plain literal`);
  });
  it('every ythril: address in the graph is a declared term, and rdf:JSON appears nowhere', () => {
    const declared = new Set(vocab.YTHRIL_TERMS.map(t => `${vocab.YTHRIL_NS}${t.name}`));
    const used = quads.flatMap(q => [q.subject, q.predicate, q.object]).filter(t => t.kind === 'iri' && t.value.startsWith(vocab.YTHRIL_NS)).map(t => t.value);
    assert.ok(used.length > 5);
    assert.deepEqual([...new Set(used)].filter(v => !declared.has(v)), []);
    assert.ok(!quads.some(q => [q.subject, q.predicate, q.object].some(t => (t.kind === 'iri' && /JSON$/.test(t.value)) || (t.kind === 'literal' && /JSON$/.test(t.datatype ?? '')))));
  });
});

describe('one schema, one set of bytes', () => {
  it('the same schema gives the same quads, whatever the order its keys were written in, and does not touch what it was handed', () => {
    const frozen = (x) => { Object.freeze(x); for (const v of Object.values(x)) if (v && typeof v === 'object') frozen(v); return x; };
    const a = graph(frozen(clone(META))).quads;
    const reordered = { typeSchemas: Object.fromEntries(Object.entries(META.typeSchemas).reverse().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).reverse())])), rdf: META.rdf, validationMode: 'warn', purpose: META.purpose };
    assert.deepEqual(graph(reordered).quads, a);
    assert.deepEqual(graph(clone(META)).quads, a);
  });

  it('the written bytes are the same on every run, and the fingerprint is the only thing that moves with a version', async () => {
    const text = async (meta, fp) => {
      const { quads, prefixes } = graph(meta, fp);
      let out = '';
      for await (const chunk of ser.serializeRdf('turtle', [{ quads }], { prefixes })) out += chunk;
      return out;
    };
    const one = await text(META, FP);
    assert.equal(await text(clone(META), FP), one);
    const other = await text(META, 'cd34'.repeat(16));
    assert.notEqual(other, one);
    assert.equal(one.replaceAll(FP, 'cd34'.repeat(16)), other, 'a new fingerprint changes the version and nothing else');
  });

  it('a schema change gives a different graph', () => {
    const changed = clone(META);
    changed.typeSchemas.entity.person.propertySchemas.age.maximum = 120;
    assert.notDeepEqual(graph(changed).quads, graph().quads);
  });
});

describe('the writers can write it, and independent parsers read it back', () => {
  const FORMATS = { turtle: 'Turtle', trig: 'TriG', nquads: 'N-Quads' };
  async function written(format) {
    const { quads, prefixes } = graph();
    let out = '';
    for await (const chunk of ser.serializeRdf(format, [{ quads }], { prefixes })) out += chunk;
    return out;
  }
  const key = (q) => `${q.subject.termType === 'BlankNode' ? '_' : q.subject.value} ${q.predicate.value} ${q.object.termType === 'BlankNode' ? '_' : `${q.object.termType}:${q.object.value}${q.object.datatype ? `^^${q.object.datatype.value}` : ''}`}`;

  it('Turtle, TriG and N-Quads are read as the same statements', async () => {
    const read = {};
    for (const [format, name] of Object.entries(FORMATS)) read[format] = new Parser({ format: name }).parse(await written(format));
    assert.ok(read.turtle.length > 200, 'the graph has many statements');
    for (const format of ['trig', 'nquads']) assert.deepEqual(read[format].map(key).sort(), read.turtle.map(key).sort(), `${format} reads as Turtle does`);
  });

  it('JSON-LD is read as the same statements (offline)', async () => {
    const refuse = async (url) => { throw new Error(`the test is offline: ${url}`); };
    const nquads = await jsonld.toRDF(JSON.parse(await written('jsonld')), { format: 'application/n-quads', documentLoader: refuse });
    const fromJson = new Parser({ format: 'N-Quads' }).parse(nquads);
    const fromTurtle = new Parser({ format: 'Turtle' }).parse(await written('turtle'));
    assert.deepEqual(fromJson.map(key).sort(), fromTurtle.map(key).sort());
  });
});
