/**
 * The tables of the terms the record mapper writes on its own account (`RDF_MAPPER_PREDICATE_KINDS`, `RDF_MAPPER_CLASS_KINDS` in
 * `rdf/record-triples.ts`) name exactly the record kinds that write each term (bundle-271, Q-756; design §1.1).
 *
 * ## What it prevents
 *
 * The quad source reads, for a pattern whose predicate is a mapper term (`rdfs:label`, `dcterms:created`, `ythril:weight`, ...), only the
 * kinds the table names. A kind missing from a row is a statement the source never finds: the agent's `rdfs:label` is written by every
 * knowledge kind, not only by entities and chrono entries. A kind listed that writes no such term only costs reads; this file refuses both,
 * so the table stays the mapper's own account.
 *
 * ## What is derived
 *
 * The terms come from what `recordTriples` writes over the documents below, in both edge forms; a term counts as the mapper's when it is not
 * a term of the space's vocabulary or schema (`termOfIri` answers `term`). The documents carry every field the mapper reads.
 *
 * ## Seen red
 *
 * On 2bfffd806: the tables do not exist. Mutation (seen red once they exist): `file` dropped from the `schema:keywords` row.
 *
 * Run: node --test testing/standalone/the-mapper-predicate-table-matches-the-mapper.test.js (a prior `npm run build:server`).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { rdfMeta } from './_rdf-export-doors.mjs';

const SPACE = 'mappertable';
const meta = rdfMeta(SPACE, {
  typeSchemas: {
    entity: { Person: { propertySchemas: { age: { type: 'number' } } } },
    fact: { note: {} },
    chrono: { event: {}, milestone: {} },
    edge: { knows: { propertySchemas: { since: { type: 'string' } } } },
  },
});
const AUTHOR = { instanceId: 'inst-1', instanceLabel: 'Instance one' };
const COMMON = { createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-03T03:04:05.000Z', tags: ['a', 'b'], description: 'words', author: AUTHOR, superseded: true, schemaFingerprint: 'fp-1' };

const DOCS = {
  entity: [{ _id: 'e1', name: 'Ada', type: 'Person', properties: { age: 36 }, ...COMMON }, { _id: 'e2', name: 'Untyped one', ...COMMON }],
  fact: [{ _id: 'f1', fact: 'A fact', type: 'note', ...COMMON }, { _id: 'f2', fact: 'Untyped fact', ...COMMON }],
  chrono: [
    { _id: 'c1', title: 'Lecture', type: 'event', startsAt: '2026-06-01T09:00:00Z', endsAt: '2026-06-01T10:00:00Z', status: 'cancelled', confidence: 0.5,
      recurrence: { freq: 'weekly', interval: 2, until: '2027-01-01T00:00:00Z' }, contentRedacted: true, ...COMMON },
    { _id: 'c2', title: 'Launch', type: 'event', startsAt: '2026-09-15', status: 'upcoming', ...COMMON },
    { _id: 'c3', title: 'Moment', type: 'milestone', startsAt: '2026-09-15T00:00:00', ...COMMON },
  ],
  edge: [{ _id: 'g1', from: 'e1', to: 'e2', label: 'knows', weight: 0.5, type: 'friend', properties: { since: '1833' }, ...COMMON }],
  link: [{ _id: 'l1', from: 'f1', fromKind: 'fact', to: 'e1', toKind: 'entity' }],
  file: [{ _id: 'docs/a.txt', path: 'docs/a.txt', sizeBytes: 3, sha256: 'ab'.repeat(32), description: 'a file', tags: ['x'], properties: { owner: 'ada' },
    createdAt: COMMON.createdAt, updatedAt: COMMON.updatedAt }],
};
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

let triples, reverse;

/** Every (term, kind) pair the mapper writes on its own account over DOCS: predicates, and the classes of `rdf:type`. */
function writtenPairs() {
  const names = reverse.mod.addressNames(meta);
  const ownTerm = (address) => reverse.mod.termOfIri(address, names).answer === 'term';
  const predicates = new Set();
  const classes = new Set();
  for (const edgeDetails of ['rdf12', 'reification']) {
    for (const [kind, docs] of Object.entries(DOCS)) {
      for (const doc of docs) {
        const { quads } = triples.mod.recordTriples(meta, kind, doc, { edgeDetails });
        assert.ok(quads.length > 0, `${kind} ${doc._id} has no form: the fixture document is wrong`);
        for (const q of quads) {
          if (!ownTerm(q.predicate.value)) predicates.add(`${q.predicate.value} ${kind}`);
          if (q.predicate.value === RDF_TYPE && q.object.kind === 'iri' && !ownTerm(q.object.value)) classes.add(`${q.object.value} ${kind}`);
        }
      }
    }
  }
  return { predicates, classes };
}

const pairsOf = (table) => new Set(Object.entries(table).flatMap(([term, kinds]) => kinds.map(k => `${term} ${k}`)));

describe('the mapper term tables name exactly the kinds that write each term', () => {
  before(async () => {
    triples = await loadDistModule('../../server/dist/rdf/record-triples.js', import.meta.url);
    reverse = await loadDistModule('../../server/dist/rdf/term-reverse.js', import.meta.url);
  });

  it('the documents give the mapper something to write (a floor)', () => {
    const { predicates, classes } = writtenPairs();
    assert.ok(predicates.size >= 60, `only ${predicates.size} (predicate, kind) pairs`);
    assert.ok(classes.size >= 10, `only ${classes.size} (class, kind) pairs`);
  });

  for (const [table, part] of [['RDF_MAPPER_PREDICATE_KINDS', 'predicates'], ['RDF_MAPPER_CLASS_KINDS', 'classes']]) {
    it(`${table} names every kind that writes each term (a kind missing is a statement never found)`, () => {
      const mod = needModule(triples, [table], 'the mapper term tables');
      const listed = pairsOf(mod[table]);
      const missing = [...writtenPairs()[part]].filter(p => !listed.has(p)).sort();
      assert.deepEqual(missing, [], `${table} lacks these (term kind) pairs the mapper writes`);
    });

    it(`${table} names no kind that never writes its term`, () => {
      const mod = needModule(triples, [table], 'the mapper term tables');
      const written = writtenPairs()[part];
      const padded = [...pairsOf(mod[table])].filter(p => !written.has(p)).sort();
      assert.deepEqual(padded, [], `${table} lists (term kind) pairs the mapper never writes over the documents`);
    });
  }
});
