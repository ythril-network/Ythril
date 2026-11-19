/**
 * Richer content travels in the export as what it is: edges and links, never a property (Q-749; owner, 2026-11-18, decision record 23).
 *
 * ## The defect this prevents
 *
 * The owner: "richer content shall travel on export and be handled ... i just dont allow for arrays in ythril". Several values of one
 * relationship, a reference to another record and a nested thing are held as edges and links, so the export has to carry them as relations
 * between records. A mapper that folded them into a property (a list, a joined string, an id in a string) would make that content invisible
 * to the graph, which edges and links exist to carry.
 *
 * ## What it holds (design r4 §5.2, §8)
 *
 * - one entity with three edges of label `knows` gives `knows` stated three times, one triple each and three reifiers, each reifier its own
 *   record address;
 * - two links give `dcterms:references` twice;
 * - an edge to another record is a relation to that record's address, an edge to a record outside the exported set is named by its address
 *   as well;
 * - a nested thing (a record plus an edge) is its own subject, reached by the edge's predicate;
 * - no property carries any of it.
 *
 * Run: node --test testing/standalone/richer-content-travels-as-edges-and-links.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));
const recordTriples = (...args) => {
  assert.equal(typeof mod.recordTriples, 'function', 'recordTriples is not exported by server/src/rdf/record-triples.ts: richer content has no form');
  return mod.recordTriples(...args);
};

const BASE = 'https://ythril.example.org/ld/space-1/';
const VOCAB = `${BASE}vocab/`;
const REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies';
const REFERENCES = 'http://purl.org/dc/terms/references';
const META = {
  rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 },
  typeSchemas: { entity: { person: {}, address: { propertySchemas: { city: { type: 'string' } } } } },
};
const AUTHOR = { instanceId: 'inst-1', instanceLabel: 'Home' };
const SHARED = { author: AUTHOR, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z' };
const OPTS = { edgeDetails: 'rdf12' };

const edge = (id, from, to, label = 'knows', extra = {}) => ({ _id: id, from, to, label, tags: [], ...SHARED, ...extra });
const link = (id, from, to, fromKind = 'fact', toKind = 'entity') => ({ _id: id, from, fromKind, to, toKind, ...SHARED });
const all = (docs) => docs.flatMap(([kind, doc]) => recordTriples(META, kind, doc, OPTS).quads);

describe('several values of one relationship are several edges, stated as one predicate several times', () => {
  const docs = [
    ['edge', edge('k1', 'ada', 'bob')],
    ['edge', edge('k2', 'ada', 'cy')],
    ['edge', edge('k3', 'ada', 'di', 'knows', { weight: 2 })],
  ];
  const quads = all(docs);
  const knows = `${VOCAB}edge/knows`;

  it('knows is stated three times from the one record, to three records', () => {
    const asserted = quads.filter((q) => q.predicate.value === knows);
    assert.equal(asserted.length, 3);
    assert.deepEqual(new Set(asserted.map((q) => q.subject.value)), new Set([`${BASE}entity/ada`]));
    assert.deepEqual(asserted.map((q) => q.object.value).sort(), [`${BASE}entity/bob`, `${BASE}entity/cy`, `${BASE}entity/di`]);
  });
  it('each of the three has its own reifier, an address of its own edge record', () => {
    const reifiers = quads.filter((q) => q.predicate.value === REIFIES);
    assert.equal(reifiers.length, 3);
    assert.deepEqual(reifiers.map((q) => q.subject.value).sort(), [`${BASE}edge/k1`, `${BASE}edge/k2`, `${BASE}edge/k3`]);
    for (const q of reifiers) assert.equal(q.object.predicate.value, knows);
  });
  it('the edge details sit on the third edge reifier alone', () => {
    const weights = quads.filter((q) => q.predicate.value.endsWith('weight'));
    assert.deepEqual(weights.map((q) => q.subject.value), [`${BASE}edge/k3`]);
  });
  it('no property of anything carries a list, a joined string or an id', () => {
    assert.ok(!quads.some((q) => q.predicate.value.startsWith(`${VOCAB}entity/`)), 'no entity property was written');
  });
});

describe('two links are dcterms:references twice', () => {
  it('both are stated, one triple each, between the records addresses', () => {
    const quads = all([['link', link('l1', 'f1', 'ada')], ['link', link('l2', 'f1', 'bob')]]);
    const refs = quads.filter((q) => q.predicate.value === REFERENCES);
    assert.equal(refs.length, 2);
    assert.deepEqual(refs.map((q) => `${q.subject.value} ${q.object.value}`).sort(), [`${BASE}fact/f1 ${BASE}entity/ada`, `${BASE}fact/f1 ${BASE}entity/bob`]);
  });
  it('a link between other kinds is named by those kinds', () => {
    const quads = all([['link', link('l3', 'p.pdf', 'c1', 'file', 'chrono')]]);
    assert.deepEqual(quads.filter((q) => q.predicate.value === REFERENCES).map((q) => [q.subject.value, q.object.value]), [[`${BASE}file/p.pdf`, `${BASE}chrono/c1`]]);
  });
});

describe('a reference is a relation to the other record address', () => {
  it('an edge to a record that is not exported is still named by its address', () => {
    const quads = all([['edge', edge('k9', 'ada', 'someone-in-another-space')]]);
    const rel = quads.find((q) => q.predicate.value === `${VOCAB}edge/knows`);
    assert.equal(rel.object.kind, 'iri');
    assert.equal(rel.object.value, `${BASE}entity/someone-in-another-space`);
  });
  it('a string property that holds a record id stays a string and states no relation', () => {
    const quads = all([['entity', { _id: 'ada', name: 'Ada', type: 'person', tags: [], properties: { friend: 'bob' }, ...SHARED }]]);
    const prop = quads.find((q) => q.predicate.value === `${VOCAB}entity/person#friend`);
    assert.deepEqual(prop.object, { kind: 'literal', value: 'bob' });
    assert.ok(!quads.some((q) => q.object.kind === 'iri' && q.object.value === `${BASE}entity/bob`), 'no relation to bob');
  });
});

describe('a nested thing is its own subject, reached by the edge predicate', () => {
  it('an address held as a record and joined by an edge: the edge reaches the address record, whose own properties are its own', () => {
    const quads = all([
      ['entity', { _id: 'ada', name: 'Ada', type: 'person', tags: [], ...SHARED }],
      ['entity', { _id: 'home', name: 'Home', type: 'address', tags: [], properties: { city: 'London' }, ...SHARED }],
      ['edge', edge('lives', 'ada', 'home', 'livesAt')],
    ]);
    const reached = quads.find((q) => q.subject.value === `${BASE}entity/ada` && q.predicate.value === `${VOCAB}edge/livesAt`);
    assert.equal(reached.object.value, `${BASE}entity/home`);
    const city = quads.find((q) => q.subject.value === reached.object.value && q.predicate.value === `${VOCAB}entity/address#city`);
    assert.deepEqual(city.object, { kind: 'literal', value: 'London' });
    assert.ok(!quads.some((q) => q.subject.value === `${BASE}entity/ada` && q.predicate.value.startsWith(`${VOCAB}entity/address#`)), 'the address properties are not on the person');
  });
});
