/**
 * Every OWL and RDFS statement the schema export writes is read back to the schema field it came from, and every other statement about a term
 * the reader takes is named as not taken (bundle-270, slice S8, Q-754; amendment A13: the OWL mapping is tested).
 *
 * ## The defect this prevents
 *
 * The export writes classes, properties, labels, comments, domains, ranges, enumerations and restrictions as OWL and RDFS. A reader that reads
 * the forms it was written against and leaves the rest unsaid hides what a file states: `rdfs:subClassOf` dropped (design D-75: no inheritance),
 * an `owl:inverseOf` that no field holds, a domain of an object property that the endpoints cannot state without accepting a fact. Here the
 * statements the forward mapping writes are COLLECTED FROM ITS OUTPUT (never from a list this file copied from it), and each must be in the
 * table below as a field it is read as or as a reason it is not; a statement of the export that is in neither fails the file; and each is
 * read through the reader and must be answered as its row says.
 *
 * ## What it holds
 *
 * - **The statements the export writes** (class, property, edge label, reifier class, ontology header), by the role of their subject: each
 *   in the table, none in the table that the export does not write.
 * - **Each statement, read**: taken as its field (`(declaration)`, `(name)`, `(key)`, `description`, `type`, `functional`, `mergeFn`, ...) or
 *   named not taken with the reason, the subject and the constraint.
 * - **What a foreign ontology says beyond the export**: `rdfs:subClassOf`, `owl:equivalentClass`, `owl:inverseOf` and the like are named, an
 *   object property's domain and range are named (a field would accept a record the statement refuses), a datatype property with no
 *   declared domain has no type to belong to.
 * - **A class that is an edge label's reifier** belongs to that label, and with the label's property outside the file it is named, not built.
 *
 * Run: node --test testing/standalone/every-owl-and-rdfs-statement-the-export-writes-is-read-back.test.js (after the server and schema builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, VOCAB, read, exported, Q, N, I, LIT, LIST, DEC, ex, iriOf } from './_schema-from-rdf-doors.mjs';

const OWL_PREFIXES = { rdf: iriOf('rdf:type').replace('type', ''), rdfs: iriOf('rdfs:label').replace('label', ''), owl: iriOf('owl:Class').replace('Class', ''), xsd: iriOf('xsd:string').replace('string', ''), ythril: iriOf('ythril:rule').replace('rule', '') };
const short = (iri) => {
  for (const [name, ns] of Object.entries(OWL_PREFIXES)) if (iri.startsWith(ns)) return `${name}:${iri.slice(ns.length)}`;
  return iri;
};

/** The fixture space with what the plain one lacks: a space's words about itself, and an edge label mapped to an outside property. */
const META_WITH_SPACE = {
  ...structuredClone(META),
  purpose: 'A space of people',
  validationMode: 'strict',
  strictLinkage: true,
  rules: { cap: { rule: 'true', message: 'always', kinds: ['entity'] } },
};
META_WITH_SPACE.typeSchemas.edge.likes = { iri: 'http://schema.org/likes', description: 'One person likes another' };

/**
 * What the export's statements are read as, by the role of their subject. `role statement` is the key: `rdf:type` is keyed with its object
 * (`rdf:type owl:Class`). A row is the field the statement is taken as, or `why` it is named not taken. Written by hand.
 */
const ROWS = {
  'ontology rdf:type owl:Ontology': { why: 'export-description' },
  'ontology owl:versionIRI': { why: 'export-description' },
  'ontology owl:versionInfo': { why: 'export-description' },
  'ontology rdfs:comment': { why: 'space-level' },
  'ontology ythril:validationMode': { why: 'space-level' },
  'ontology ythril:strictLinkage': { why: 'space-level' },
  'ontology ythril:rule': { why: 'space-level' },
  'class rdf:type owl:Class': { field: '(declaration)' },
  'class rdfs:isDefinedBy': { why: 'export-description' },
  'class rdfs:label': { field: '(name)' },
  'class rdfs:comment': { field: 'description' },
  'datatype-property rdf:type owl:DatatypeProperty': { field: '(declaration)' },
  'datatype-property rdf:type owl:FunctionalProperty': { field: '(every property)' },
  'datatype-property rdfs:isDefinedBy': { why: 'export-description' },
  'datatype-property rdfs:label': { field: '(key)' },
  'datatype-property rdfs:comment': { field: 'description' },
  'datatype-property rdfs:domain': { field: '(owner)' },
  'datatype-property rdfs:range': { field: 'type' },
  'datatype-property ythril:mergeFn': { field: 'mergeFn' },
  'object-property rdf:type owl:ObjectProperty': { field: '(declaration)' },
  'object-property rdf:type owl:FunctionalProperty': { field: 'functional' },
  'object-property rdfs:isDefinedBy': { why: 'export-description' },
  'object-property rdfs:label': { field: '(name)' },
  'object-property rdfs:comment': { field: 'description' },
  'reifier-class rdf:type owl:Class': { field: '(reifier)' },
  'reifier-class rdfs:isDefinedBy': { why: 'export-description' },
  'reifier-class rdfs:label': { field: '(reifier)' },
};

/** The role of the subject of a statement of the export, or null when it is no OWL term (a shape, a blank node of a range). */
function roleOf(quads, quad) {
  if (quad.subject.kind !== 'iri') return null;
  const types = quads.filter(q => q.subject.kind === 'iri' && q.subject.value === quad.subject.value && q.predicate.value === iriOf('rdf:type')).map(q => short(q.object.value ?? ''));
  const owl = types.filter(t => t.startsWith('owl:'));
  if (owl.length === 0) return null;
  if (owl.includes('owl:Ontology')) return 'ontology';
  const isReifier = quad.subject.value.startsWith(`${VOCAB}edge/`);
  if (quad.predicate.value === iriOf('rdf:type') && short(quad.object.value) === 'owl:Class' && isReifier) return 'reifier-class';
  if (owl.includes('owl:ObjectProperty')) return 'object-property';
  if (owl.includes('owl:DatatypeProperty')) return 'datatype-property';
  return isReifier ? 'reifier-class' : 'class';
}
const keyOf = (role, quad) => (quad.predicate.value === iriOf('rdf:type') ? `${role} rdf:type ${short(quad.object.value)}` : `${role} ${short(quad.predicate.value)}`);

describe('the statements the export writes, collected from its output', () => {
  const quads = exported(META_WITH_SPACE);
  const written = quads.map(q => ({ q, role: roleOf(quads, q) })).filter(x => x.role !== null).map(x => ({ ...x, key: keyOf(x.role, x.q) }));

  it('are each in the table, and the table has no row the export does not write', () => {
    const keys = new Set(written.map(w => w.key));
    const missing = [...keys].filter(k => !Object.hasOwn(ROWS, k));
    assert.deepEqual(missing, [], `statements the export writes that the table reads as nothing: ${missing.join(', ')}`);
    const stale = Object.keys(ROWS).filter(k => !keys.has(k));
    assert.deepEqual(stale, [], `rows for statements the export does not write: ${stale.join(', ')}`);
  });

  it('are each answered by the reader as its row says, from the OWL axioms and the shapes together', () => {
    const answer = read(quads, { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.refusals, []);
    const wrong = [];
    for (const w of written) {
      const row = ROWS[w.key];
      const object = w.q.object.kind === 'iri' ? short(w.q.object.value) : undefined;
      const same = e => e.subject === w.q.subject.value && e.constraint === short(w.q.predicate.value) && (object === undefined || e.object === object);
      if (row.field !== undefined) {
        // a statement read as a field may be read into several (a range is a type, an enumeration and a restriction): one entry names the field
        const entry = answer.taken.find(e => same(e) && (e.field === row.field || (row.field === 'type' && ['type', 'enum', 'minimum', 'maximum'].includes(e.field))));
        if (entry === undefined) {
          // a date property's rdfs:Literal range states no type: named, with the reason
          const named = answer.notTaken.find(e => same(e) && w.key === 'datatype-property rdfs:range' && e.why === 'no-field');
          if (named === undefined) wrong.push(`${w.key} (${w.q.subject.value}) is not taken as ${row.field}`);
        }
      } else if (!answer.notTaken.some(e => same(e) && e.why === row.why)) {
        wrong.push(`${w.key} (${w.q.subject.value}) is not named not taken as ${row.why}`);
      }
    }
    assert.deepEqual(wrong, []);
    assert.equal(answer.counts.statements, answer.counts.taken + answer.counts.notTaken + answer.counts.outside);
  });

  it('are each answered alike from the OWL axioms alone, where the axioms state a field', () => {
    const answer = read(quads, { from: ['declared'] });
    assert.deepEqual(answer.refusals, []);
    assert.ok(answer.taken.every(t => t.source === 'declared'), 'a statement was taken from a shape that was not asked for');
    assert.deepEqual(answer.typeSchemas.entity.person.propertySchemas.score, { type: 'number', mergeFn: 'avg' });
    assert.equal(answer.typeSchemas.edge.reports_to.functional, true);
  });
});

describe('an edge label\'s reifier class belongs to the label', () => {
  const quads = exported(META_WITH_SPACE);
  const reifier = `${VOCAB}edge/likes`;

  it('a label mapped to an outside property is declared nowhere in OWL: its reifier class is named, no edge type is built from it', () => {
    const answer = read(quads, { from: ['declared'] });
    assert.equal(answer.typeSchemas.edge.likes, undefined);
    assert.ok(answer.notTaken.some(n => n.subject === reifier && n.constraint === 'rdf:type' && n.why === 'no-owner'), 'the reifier class of a label that is not in the file is not named');
  });

  it('with the shapes read too the label is built, and its reifier class is taken with it', () => {
    const answer = read(quads, { from: ['declared', 'shacl'] });
    assert.deepEqual(answer.typeSchemas.edge.likes, { iri: 'http://schema.org/likes', description: 'One person likes another' });
    assert.ok(answer.taken.some(t => t.subject === reifier && t.field === '(reifier)'));
  });
});

describe('what a foreign ontology states beyond the export', () => {
  const A = ex('Person');
  const B = ex('Agent');
  const base = [Q(A, 'rdf:type', 'owl:Class'), Q(B, 'rdf:type', 'owl:Class')];
  const named = (answer, constraint) => answer.notTaken.filter(n => n.constraint === constraint);

  it('a class becomes an entity type named by its label, else by the local part of its address, and keeps its address', () => {
    const answer = read([...base, Q(A, 'rdfs:label', LIT('Human')), Q(A, 'rdfs:comment', LIT('Someone'))], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity, { Human: { iri: A, description: 'Someone' }, Agent: { iri: B } });
  });

  for (const [predicate, object] of [['rdfs:subClassOf', B], ['owl:equivalentClass', B], ['owl:disjointWith', B], ['rdfs:seeAlso', ex('page')]]) {
    it(`${predicate} of a taken class is named, never dropped (no field holds it)`, () => {
      const answer = read([...base, Q(A, predicate, object)], { from: ['declared'] });
      const entries = named(answer, predicate);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].why, 'no-field');
      assert.equal(entries[0].subject, A);
    });
  }

  it('an RDFS class is a type, and an RDFS property whose range is a datatype is a property of its domain\'s type', () => {
    const answer = read([
      Q(A, 'rdf:type', 'rdfs:Class'), Q(ex('title'), 'rdf:type', 'rdf:Property'), Q(ex('title'), 'rdfs:domain', A), Q(ex('title'), 'rdfs:range', 'xsd:string'),
    ], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity, { Person: { iri: A, propertySchemas: { title: { type: 'string', iri: ex('title') } } } });
  });

  it('an RDFS property whose range does not say it holds a plain value is named, not guessed into a property', () => {
    const answer = read([...base, Q(ex('related'), 'rdf:type', 'rdf:Property'), Q(ex('related'), 'rdfs:domain', A), Q(ex('related'), 'rdfs:range', B)], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity.Person, { iri: A });
    assert.ok(answer.notTaken.some(n => n.subject === ex('related') && n.constraint === 'rdf:type' && n.why === 'no-field'));
  });

  it('a datatype property with a declared domain is a property of that type, one per domain', () => {
    const answer = read([...base, Q(ex('name'), 'rdf:type', 'owl:DatatypeProperty'), Q(ex('name'), 'rdfs:domain', A), Q(ex('name'), 'rdfs:domain', B), Q(ex('name'), 'rdfs:range', 'xsd:string')], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity.Person.propertySchemas, { name: { type: 'string', iri: ex('name') } });
    assert.deepEqual(answer.typeSchemas.entity.Agent.propertySchemas, { name: { type: 'string', iri: ex('name') } });
  });

  it('a datatype property with no domain, or a domain the file does not declare, has no type to belong to: named', () => {
    const answer = read([...base, Q(ex('a'), 'rdf:type', 'owl:DatatypeProperty'), Q(ex('b'), 'rdf:type', 'owl:DatatypeProperty'), Q(ex('b'), 'rdfs:domain', ex('Unknown'))], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity.Person, { iri: A });
    const entries = answer.notTaken.filter(n => n.why === 'no-owner');
    assert.deepEqual([...new Set(entries.map(e => e.subject))].sort(), [ex('a'), ex('b')]);
  });

  it('an object property is an edge label; its domain and range are named, because endpoints would accept an end that is no entity', () => {
    const answer = read([...base, Q(ex('knows'), 'rdf:type', 'owl:ObjectProperty'), Q(ex('knows'), 'rdfs:domain', A), Q(ex('knows'), 'rdfs:range', B)], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.edge, { knows: { iri: ex('knows') } });
    assert.deepEqual(named(answer, 'rdfs:domain').map(n => n.why), ['looser-field']);
    assert.deepEqual(named(answer, 'rdfs:range').map(n => n.why), ['looser-field']);
  });

  it('owl:FunctionalProperty on an object property is a one-only label', () => {
    const answer = read([...base, Q(ex('knows'), 'rdf:type', 'owl:ObjectProperty'), Q(ex('knows'), 'rdf:type', 'owl:FunctionalProperty')], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.edge, { knows: { iri: ex('knows'), functional: true } });
  });

  for (const [predicate, object] of [['owl:inverseOf', ex('knownBy')], ['rdfs:subPropertyOf', ex('related')], ['owl:equivalentProperty', ex('related')]]) {
    it(`${predicate} of a taken property is named (no field holds it)`, () => {
      const answer = read([...base, Q(ex('knows'), 'rdf:type', 'owl:ObjectProperty'), Q(ex('knows'), predicate, object)], { from: ['declared'] });
      assert.equal(named(answer, predicate).length, 1);
      assert.equal(named(answer, predicate)[0].why, 'no-field');
    });
  }

  it('a property type that no field holds (inverse-functional, symmetric) is named beside the property that is taken', () => {
    const answer = read([...base, Q(ex('knows'), 'rdf:type', 'owl:ObjectProperty'), Q(ex('knows'), 'rdf:type', 'owl:SymmetricProperty'), Q(ex('knows'), 'rdf:type', 'owl:InverseFunctionalProperty')], { from: ['declared'] });
    assert.deepEqual(named(answer, 'rdf:type').map(n => n.object).sort(), ['owl:InverseFunctionalProperty', 'owl:SymmetricProperty']);
  });

  it('a range that is a restriction of the decimals is read as a number with its bounds', () => {
    const restriction = [
      Q(N('r'), 'rdf:type', 'rdfs:Datatype'), Q(N('r'), 'owl:onDatatype', 'xsd:decimal'),
      Q(N('r'), 'owl:withRestrictions', LIST(N('f1'), N('f2'))), Q(N('f1'), 'xsd:minInclusive', DEC(1)), Q(N('f2'), 'xsd:maxInclusive', DEC(9)),
    ];
    const answer = read([...base, Q(ex('level'), 'rdf:type', 'owl:DatatypeProperty'), Q(ex('level'), 'rdfs:domain', A), Q(ex('level'), 'rdfs:range', N('r')), ...restriction], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity.Person.propertySchemas.level, { type: 'number', minimum: 1, maximum: 9, iri: ex('level') });
  });

  it('a range of a datatype a field would hold looser is named, and a union range likewise', () => {
    const answer = read([
      ...base, Q(ex('count'), 'rdf:type', 'owl:DatatypeProperty'), Q(ex('count'), 'rdfs:domain', A), Q(ex('count'), 'rdfs:range', 'xsd:integer'),
      Q(ex('mixed'), 'rdf:type', 'owl:DatatypeProperty'), Q(ex('mixed'), 'rdfs:domain', A), Q(ex('mixed'), 'rdfs:range', N('u')), Q(N('u'), 'owl:unionOf', LIST(I(iriOf('xsd:string')), I(iriOf('xsd:boolean')))),
    ], { from: ['declared'] });
    assert.deepEqual(answer.typeSchemas.entity.Person.propertySchemas, { count: { iri: ex('count') }, mixed: { iri: ex('mixed') } });
    assert.deepEqual(named(answer, 'rdfs:range').map(n => [n.subject, n.why]).sort(), [[ex('count'), 'looser-field'], [ex('mixed'), 'no-field']]);
  });
});
