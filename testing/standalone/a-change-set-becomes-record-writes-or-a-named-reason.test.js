/**
 * An RDF change set (statements removed and inserted) becomes planned record writes or a named reason, by the same rules an import writes
 * by, and never deletes a value it did not name (bundle-272, Q-964; design answer d, challenge F1, F2, F5).
 *
 * ## The defect this prevents
 *
 * SPARQL Update hands the writes a change set, not a file. A translator that built a record's removals as "what the record holds minus what
 * the target states" would delete every value the RDF form never carried (a list or an object under a property, a value that does not fit
 * its declared type): the form skips them, so they look absent. A tag removal written as a merge plus a removal is undone by the merge. A
 * removal of a statement the store does not hold, taken as done, hides that the Update read an older record. A subject spelt two ways would
 * be written twice, and a statement of a file, a time node or the server be removed as if it were a field.
 *
 * ## What it holds
 *
 * `subjectChanges` (`server/src/rdf/subject-changes.ts`), asked over stored records and the statements removed and inserted:
 * - INSERT DATA of a property on a stored entity is a converge that sets it; DELETE DATA of one property is a converge that removes exactly
 *   that key (`deleteFields`); DELETE/INSERT on one property is a converge that replaces it, removing nothing.
 * - Removing one tag of several replaces the tags by the rest (`replaceTags`) and removes no field; a retype is a converge with the new type;
 *   removing every type statement with none inserted is a delete.
 * - Each refusal answers its reason: server-owned-removed, edge-ends-change, not-writable-here, blank-node-subject, field-not-removable (a
 *   key that is not one path segment, a field the record must keep), subject-not-an-address-here; each reason of the Update list has its case.
 * - A stored value the RDF form skips is left alone when other statements change, and a removed statement naming it refuses.
 * - A removed statement the store does not hold is stale, and under DELETE DATA a no-op; an inserted one it already holds is a no-op.
 * - Statements of one record, spelt as its address and as a time node of it, give one operation, and every statement is accounted for.
 *
 * Run: node --test testing/standalone/a-change-set-becomes-record-writes-or-a-named-reason.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, BASE } from './_rdf-writer-fixtures.mjs';
import { fn, reverse, mapper, iri, blank, lit, q, RDF, XSD, SCHEMA_ORG } from './_quads-to-ops-doors.mjs';

const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js');
const termIri = await import('../../server/dist/rdf/term-iri.js');
const changes = await import('../../server/dist/rdf/subject-changes.js').catch(() => ({}));
const reasons = await import('../../server/dist/rdf/import-reasons.js').catch(() => ({}));

const Y = vocabulary.YTHRIL_NS;
const V = `${BASE}vocab/`;
const TYPE = `${RDF}type`;
const DCT = 'http://purl.org/dc/terms/';
const KEYWORDS = `${SCHEMA_ORG}keywords`;
const DESCRIPTION = `${SCHEMA_ORG}description`;
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const at = (kind, id) => `${BASE}${kind}/${id}`;
const WHEN = { createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00Z', author: { instanceId: 'inst-1', instanceLabel: 'Home' } };

const META_ORG = {
  ...META,
  typeSchemas: { ...META.typeSchemas, entity: { ...META.typeSchemas.entity, org: { propertySchemas: {} } } },
};

const DOCS = {
  e1: ['entity', { _id: 'e1', name: 'Ada', type: 'person', tags: ['a', 'b'], description: 'd', properties: { age: 36, born: '1815-12-10', note: 'hi', 'a.b': 'dotted' }, ...WHEN }],
  e2: ['entity', { _id: 'e2', name: 'Bob', type: 'person', tags: [], ...WHEN }],
  e3: ['entity', { _id: 'e3', name: 'Cy', type: 'person', tags: [], properties: { age: 5, blob: [1, 2], nested: { a: 1 } }, ...WHEN }],
  f1: ['fact', { _id: 'f1', fact: 'A fact', type: 'note', tags: [], ...WHEN }],
  c1: ['chrono', { _id: 'c1', title: 'Launch', type: 'event', startsAt: '2026-03-01T09:00:00Z', endsAt: '2026-03-01T17:30:00Z', status: 'upcoming', description: 'old', tags: [], ...WHEN }],
  k1: ['edge', { _id: 'k1', from: 'e1', to: 'e2', label: 'knows', tags: [], properties: {}, ...WHEN }],
  file: ['file', { _id: 'docs/a.pdf', path: 'docs/a.pdf', tags: [], sizeBytes: 10, sha256: 'ab'.repeat(32), createdAt: WHEN.createdAt, updatedAt: WHEN.updatedAt }],
};

function ask(removed, inserted, { meta = META, minted = new Map(), mode = 'strict', stated, docs = Object.values(DOCS), links = {} } = {}) {
  const recordKey = fn('recordKey');
  const stored = new Map(docs.map(([kind, doc]) => [recordKey(kind, doc._id), { doc, links: links[doc._id] ?? {} }]));
  const names = reverse.addressNames(meta);
  assert.equal(typeof changes.subjectChanges, 'function', 'subjectChanges is not exported by server/src/rdf/subject-changes.ts: a change set cannot become record writes');
  const out = changes.subjectChanges({ meta, names, mode, stored, minted }, removed, inserted, stated === undefined ? {} : { stated });
  const placed = out.taken + out.notTaken.length + out.reasons.reduce((n, r) => n + r.quads.length, 0) + out.stale.length + out.noops.length;
  assert.equal(placed, removed.length + inserted.length, `every statement of the change set is in exactly one place (${placed} placed of ${removed.length + inserted.length})`);
  return out;
}

/** The statements the record form writes for a stored record. */
const formOf = (key, meta = META) => mapper.recordTriples(meta, DOCS[key][0], DOCS[key][1], { edgeDetails: 'rdf12' }).quads;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The stored statement of `key` with this predicate (and object value when given). */
function stored(key, predicate, value, meta = META) {
  const hit = formOf(key, meta).find(x => x.predicate.value === predicate && (value === undefined || x.object.value === value));
  assert.ok(hit, `${key} has no stored statement ${predicate}${value === undefined ? '' : ` ${value}`}`);
  return hit;
}
const prop = (kind, type, key) => termIri.resolveTermIri(META, kind, type, key);
const codes = (out) => out.reasons.map(r => r.code);
const writes = (out) => out.ops.map(o => `${o.op} ${o.kind} ${o.id}`);

describe('a change set becomes record writes or a named reason', () => {
  it('INSERT DATA of a property on a stored entity is a converge that sets it and keeps the rest', () => {
    const out = ask([], [q(at('entity', 'e2'), prop('entity', 'person', 'age'), lit('41', `${XSD}integer`))]);
    assert.deepEqual(writes(out), ['converge entity e2']);
    const op = out.ops[0];
    assert.equal(op.fields.properties.age, 41);
    assert.equal(op.fields.name, 'Bob', 'the stored name is carried');
    assert.equal(op.fields.type, 'person', 'the stored type is carried');
    assert.deepEqual(op.deleteFields ?? [], [], 'nothing is removed');
    assert.deepEqual(codes(out), []);
  });

  it('DELETE DATA of one property is a converge that removes exactly that key', () => {
    const note = stored('e1', prop('entity', 'person', 'note'));
    const out = ask([note], [], { stated: () => true });
    assert.deepEqual(writes(out), ['converge entity e1']);
    assert.deepEqual(out.ops[0].deleteFields, ['properties.note']);
    assert.equal(out.ops[0].fields.properties.age, 36, 'the other properties are carried');
    assert.equal(out.ops[0].fields.properties.note, undefined, 'the removed one is not stated again');
    assert.equal(out.ops[0].replaceTags, undefined, 'the tags are not touched');
  });

  it('DELETE/INSERT on one property is a converge that replaces it and removes nothing', () => {
    const age = stored('e1', prop('entity', 'person', 'age'));
    const out = ask([age], [q(at('entity', 'e1'), prop('entity', 'person', 'age'), lit('37', `${XSD}integer`))]);
    assert.deepEqual(writes(out), ['converge entity e1']);
    assert.equal(out.ops[0].fields.properties.age, 37);
    assert.deepEqual(out.ops[0].deleteFields ?? [], [], 'a replaced key is not removed');
    assert.deepEqual(codes(out), []);
  });

  it('removing one tag of several replaces the tags by the rest and removes no field', () => {
    const out = ask([stored('e1', KEYWORDS, 'a')], []);
    assert.deepEqual(writes(out), ['converge entity e1']);
    assert.deepEqual(out.ops[0].replaceTags, ['b']);
    assert.ok(!(out.ops[0].deleteFields ?? []).some(p => p === 'tags' || p.startsWith('tags.')), 'tags are a replacement, never a removal path');
    const all = ask([stored('e1', KEYWORDS, 'a'), stored('e1', KEYWORDS, 'b')], []);
    assert.deepEqual(all.ops[0].replaceTags, [], 'every tag removed is an empty replacement');
  });

  it('a retype is a converge with the new type', () => {
    const out = ask([stored('e2', TYPE, `${V}entity/person`)], [q(at('entity', 'e2'), TYPE, `${V}entity/org`)], { meta: META_ORG });
    assert.deepEqual(writes(out), ['converge entity e2']);
    assert.equal(out.ops[0].fields.type, 'org');
    assert.equal(out.ops[0].fields.name, 'Bob');
    assert.deepEqual(codes(out), []);
  });

  it('removing every type statement with none inserted is a delete, and the record\'s own server-owned statements go with it', () => {
    const removed = formOf('e2').filter(x => x.subject.value === at('entity', 'e2') && (x.predicate.value === TYPE || x.predicate.value.startsWith(DCT)));
    assert.ok(removed.some(x => x.predicate.value === `${DCT}created`), 'the case removes a server-owned statement too');
    const out = ask(removed, []);
    assert.deepEqual(writes(out), ['delete entity e2']);
    assert.deepEqual(codes(out), [], 'a statement removed with its record is no refusal');
  });

  it('removing a type while the kind marker stays is refused: a record keeps its type', () => {
    const out = ask([stored('e2', TYPE, `${V}entity/person`)], []);
    assert.deepEqual(out.ops, []);
    assert.deepEqual(codes(out), ['field-not-removable']);
  });

  it('removing a link statement takes that link out of the fact\'s set and keeps the others; a stated link is added', () => {
    const links = { f1: { entity: ['e1', 'e2'] } };
    const toE2 = { subject: iri(at('fact', 'f1')), predicate: iri(`${DCT}references`), object: iri(at('entity', 'e2')) };
    const out = ask([toE2], [], { links, stated: () => true });
    assert.deepEqual(writes(out), ['converge fact f1']);
    assert.deepEqual(out.ops[0].links, { entity: ['e1'] });
    const added = ask([], [q(at('fact', 'f1'), `${DCT}references`, at('entity', 'e3'))], { links });
    assert.deepEqual(added.ops[0].links, { entity: ['e1', 'e2', 'e3'] });
    assert.equal(added.ops[0].fields.fact, 'A fact', 'the stored text is carried');
  });

  describe('each refusal answers its reason and writes nothing', () => {
    const CASES = {
      'server-owned-removed': () => ask([stored('e1', `${DCT}modified`)], []),
      'edge-ends-change': () => ask(
        [stored('k1', `${RDF}reifies`)],
        [q(at('edge', 'k1'), `${RDF}reifies`, { kind: 'triple', subject: iri(at('entity', 'e1')), predicate: iri(`${V}edge/knows`), object: iri(at('entity', 'e3')) }), q(at('entity', 'e1'), `${V}edge/knows`, at('entity', 'e3'))],
      ),
      'not-writable-here': () => ask([stored('file', `${Y}path`)], [q(termIri.recordIri(META, 'file', 'docs/b.pdf'), `${Y}path`, lit('docs/b.pdf'))]),
      'field-not-removable': () => ask([stored('e1', prop('entity', 'person', 'a.b'))], [], { stated: () => true }),
      'subject-not-an-address-here': () => ask([], [q('http://ex.org/x', TYPE, `${Y}Entity`), q('http://ex.org/x', LABEL, lit('X'))]),
    };

    it('the Update reasons of the import list and the cases here are the same codes', () => {
      assert.equal(typeof reasons.UPDATE_REASONS, 'object', 'UPDATE_REASONS is not exported by server/src/rdf/import-reasons.ts');
      assert.deepEqual(Object.keys(reasons.UPDATE_REASONS).sort(), Object.keys(CASES).sort(), 'each Update reason has a case, and each case a reason');
      for (const code of Object.keys(reasons.UPDATE_REASONS)) assert.ok(reasons.IMPORT_REASONS[code], `${code} joins the import's reason list`);
    });

    for (const [code, run] of Object.entries(CASES)) {
      it(`${code}`, () => {
        const out = run();
        assert.deepEqual(out.ops, [], 'no write is planned');
        assert.ok(codes(out).includes(code), `reason ${code} is answered (got ${codes(out).join(', ') || 'none'})`);
        const r = out.reasons.find(x => x.code === code);
        assert.equal(r.outcome, 'refused', 'refused, in every mode');
        assert.ok(r.quads.length > 0, 'the reason holds the statements');
      });
    }

    it('a blank-node subject is refused, removed or inserted', () => {
      for (const [removed, inserted] of [[[], [q(blank('b1'), TYPE, `${Y}Entity`), q(blank('b1'), LABEL, lit('n'))]], [[q(blank('b1'), LABEL, lit('n'))], []]]) {
        const out = ask(removed, inserted, { stated: () => true });
        assert.deepEqual(out.ops, []);
        assert.ok(codes(out).includes('blank-node-subject'), `got ${codes(out).join(', ') || 'none'}`);
      }
    });

    it('a field the record must keep is not removed whatever the predicate maps to', () => {
      for (const [key, pred] of [['e1', LABEL], ['f1', `${SCHEMA_ORG}text`], ['c1', `${SCHEMA_ORG}startDate`], ['c1', `${Y}status`]]) {
        const out = ask([stored(key, pred)], [], { stated: () => true });
        assert.deepEqual(out.ops, [], `${pred}: no write`);
        assert.deepEqual(codes(out), ['field-not-removable'], `${pred}`);
      }
    });

    it('a time node of a chrono and the server\'s statements are never removed as fields', () => {
      const node = formOf('c1').find(x => x.subject.value === `${at('chrono', 'c1')}#start`);
      assert.ok(node, 'the case has a time node');
      const out = ask([node], []);
      assert.deepEqual(out.ops, []);
      assert.deepEqual(codes(out), ['server-owned-removed']);
    });
  });

  describe('a value the RDF form skips is left alone', () => {
    it('is not removed or restated when another statement of the record changes', () => {
      const out = ask([stored('e3', prop('entity', 'person', 'age'))], [q(at('entity', 'e3'), prop('entity', 'person', 'age'), lit('6', `${XSD}integer`))]);
      assert.deepEqual(writes(out), ['converge entity e3']);
      assert.deepEqual(Object.keys(out.ops[0].fields.properties).sort(), ['age'], 'only what the statements state; the skipped values stay stored by the merge');
      assert.deepEqual(out.ops[0].deleteFields ?? [], [], 'a list or an object under a property is not a removal');
    });

    it('is never in the removals of a DELETE of every statement of its record\'s other properties', () => {
      const out = ask([stored('e3', prop('entity', 'person', 'age'))], [], { stated: () => true });
      assert.deepEqual(out.ops[0].deleteFields, ['properties.age'], 'exactly the key removed: the skipped ones are not "stored minus target"');
    });

    it('a removed statement naming it is refused', () => {
      const out = ask([q(at('entity', 'e3'), prop('entity', 'person', 'blob'), lit('1,2'))], [], { stated: () => true });
      assert.deepEqual(out.ops, []);
      assert.deepEqual(codes(out), ['server-owned-removed']);
    });
  });

  describe('a removed statement the store does not hold', () => {
    const absent = () => q(at('entity', 'e1'), prop('entity', 'person', 'note'), lit('never stored'));
    it('is stale, and nothing is written', () => {
      const out = ask([absent()], []);
      assert.deepEqual(out.ops, []);
      assert.equal(out.stale.length, 1, 'named as stale');
      assert.equal(out.noops.length, 0);
    });
    it('is a no-op under DELETE DATA', () => {
      const out = ask([absent()], [], { stated: () => true });
      assert.deepEqual(out.ops, []);
      assert.equal(out.stale.length, 0);
      assert.equal(out.noops.length, 1, 'named as a no-op');
    });
    it('a record that is not stored makes its removals stale', () => {
      const out = ask([q(at('entity', 'gone'), LABEL, lit('x'))], []);
      assert.equal(out.stale.length, 1);
    });
    it('an inserted statement the store already holds is a no-op', () => {
      const out = ask([], [stored('e1', KEYWORDS, 'a')]);
      assert.deepEqual(out.ops, []);
      assert.equal(out.noops.length, 1);
    });
  });

  it('an insert of an unstored subject under an address of this space is an insert under the id minted for it', () => {
    const s = at('entity', 'brand-new');
    const out = ask([], [q(s, TYPE, `${Y}Entity`), q(s, TYPE, `${V}entity/person`), q(s, LABEL, lit('New'))], { minted: new Map([[s, { kind: 'entity', id: 'm-1' }]]) });
    assert.deepEqual(writes(out), ['insert entity m-1']);
    assert.equal(out.ops[0].fields.name, 'New');
  });

  it('statements of one record, spelt as its address and as a time node of it, give one operation', () => {
    const c = at('chrono', 'c1');
    const out = ask(
      [stored('c1', DESCRIPTION)],
      [q(c, DESCRIPTION, lit('new')), q(`${c}#start`, 'http://www.w3.org/2006/time#inXSDDate', lit('2026-03-01', `${XSD}date`))],
    );
    assert.deepEqual(writes(out), ['converge chrono c1']);
    assert.equal(out.ops[0].fields.description, 'new');
    assert.equal(out.notTaken.length, 1, 'the time node\'s statement is derived, left out on purpose');
  });
});
