/**
 * A converge the RDF import states takes nothing away from the stored record (bundle-270, slice S3, Q-752; plan amendment A4).
 *
 * ## The defect this prevents
 *
 * A fact's and a chrono's converge rewrites the record's whole link set, and an entity's converge sets name and type unconditionally. An
 * operation that states only what the file said would, on a converge, delete every field and link the file never mentioned: a file that
 * adds one tag to a stored fact would wipe its text and its links. RDF states what is; absence is not a statement.
 *
 * ## What it holds
 *
 * For each kind that converges (fact, entity, chrono, edge), a group under this space's base whose id is stored, stating one thing:
 * the operation converges onto the stored id and carries every field the file does not state as stored, the union of the stored and the
 * stated tags and links, the stored properties with the stated ones over them, and the stated fields as stated.
 *
 * Run: node --test testing/standalone/a-converge-from-rdf-takes-nothing-away.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, BASE } from './_rdf-writer-fixtures.mjs';
import { fn, reverse, contextFor, assertAccounted, iri, lit, q, RDF, XSD, SCHEMA_ORG } from './_quads-to-ops-doors.mjs';

const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js');
const Y = vocabulary.YTHRIL_NS;
const V = `${BASE}vocab/`;
const TYPE = `${RDF}type`;
const KEYWORDS = `${SCHEMA_ORG}keywords`;
const REFERENCES = 'http://purl.org/dc/terms/references';
const at = (kind, id) => `${BASE}${kind}/${id}`;

/** `elsewhere`: quads of other groups of the same file (an edge's asserted triple sits in its from record's group). */
function converge(quads, storedRows, elsewhere = []) {
  const recordKey = fn('recordKey');
  const stored = new Map(storedRows.map(([kind, doc, links]) => [recordKey(kind, doc._id), { doc, links: links ?? {} }]));
  const names = reverse.addressNames(META);
  const ctx = contextFor({ meta: META, names, quads: [...quads, ...elsewhere], stored });
  const out = fn('quadsToOps')(quads, ctx);
  assertAccounted(quads, out, 'converge');
  assert.deepEqual(out.reasons.map(r => r.code), [], 'a converge group answers no reason');
  assert.equal(out.ops.length, 1, 'one operation');
  assert.equal(out.ops[0].op, 'converge', 'onto the stored record');
  return out.ops[0];
}

const ENDS = [['entity', { _id: 'e1', name: 'E1', type: 'person' }], ['entity', { _id: 'e2', name: 'E2', type: 'person' }], ['entity', { _id: 'e3', name: 'E3', type: 'person' }]];

describe('a converge from RDF takes nothing away', () => {
  it('a fact stated with one tag keeps its text, type, description, properties, tags and links; a stated link is added', () => {
    const f = at('fact', 'f1');
    const op = converge(
      [q(f, TYPE, `${Y}Fact`), q(f, KEYWORDS, lit('c')), q(f, REFERENCES, at('entity', 'e3'))],
      [['fact', { _id: 'f1', fact: 'Stored text', type: 'note', description: 'd', tags: ['b', 'a'], properties: { n: 1 } }, { entity: ['e1', 'e2'] }], ...ENDS],
    );
    assert.equal(op.id, 'f1');
    assert.deepEqual(op.fields, { fact: 'Stored text', type: 'note', description: 'd', tags: ['a', 'b', 'c'], properties: { n: 1 } });
    assert.deepEqual({ entity: [...op.links.entity].sort() }, { entity: ['e1', 'e2', 'e3'] });
  });

  it('an entity stated with one property keeps its name, type, tags and other properties', () => {
    const e = at('entity', 'e1');
    const op = converge(
      [q(e, TYPE, `${Y}Entity`), q(e, TYPE, `${V}entity/person`), q(e, `${V}entity/person#born`, lit('1815-12-10', `${XSD}date`))],
      [['entity', { _id: 'e1', name: 'Ada', type: 'person', tags: ['x'], description: 'kept', properties: { age: 36, born: '1800-01-01' } }]],
    );
    assert.deepEqual(op.fields, { name: 'Ada', type: 'person', description: 'kept', tags: ['x'], properties: { age: 36, born: '1815-12-10' } });
  });

  it('a chrono stated with one recurrence part keeps its title, times, status, other recurrence parts and links', () => {
    const c = at('chrono', 'c1');
    const op = converge(
      [q(c, TYPE, `${V}chrono/event`), q(c, `${Y}recurrenceInterval`, lit('3', `${XSD}integer`))],
      [['chrono', { _id: 'c1', title: 'Launch', type: 'event', startsAt: '2026-03-01', status: 'upcoming', confidence: 0.5, recurrence: { freq: 'weekly', interval: 2 }, tags: ['t'] }, { entity: ['e1'], fact: ['f9'] }]],
    );
    assert.deepEqual(op.fields, { title: 'Launch', type: 'event', startsAt: '2026-03-01', status: 'upcoming', confidence: 0.5, recurrence: { freq: 'weekly', interval: 3 }, tags: ['t'], properties: {} });
    assert.deepEqual(op.links, { entity: ['e1'], fact: ['f9'] });
  });

  it('an edge stated with one tag keeps its weight, type, description and properties', () => {
    const k = at('edge', 'k1');
    const knows = `${V}edge/knows`;
    const op = converge(
      [q(k, TYPE, knows), q(k, `${RDF}reifies`, { kind: 'triple', subject: iri(at('entity', 'e1')), predicate: iri(knows), object: iri(at('entity', 'e2')) }), q(k, KEYWORDS, lit('u'))],
      [['edge', { _id: 'k1', from: 'e1', to: 'e2', label: 'knows', weight: 0.5, type: 'friend', description: 'd', tags: ['t'], properties: { since: '2001-01-01' } }], ...ENDS],
      [q(at('entity', 'e1'), knows, at('entity', 'e2'))],
    );
    assert.deepEqual(op.fields, { from: 'e1', fromKind: 'entity', to: 'e2', toKind: 'entity', label: 'knows', weight: 0.5, type: 'friend', description: 'd', tags: ['t', 'u'], properties: { since: '2001-01-01' } });
  });
});
