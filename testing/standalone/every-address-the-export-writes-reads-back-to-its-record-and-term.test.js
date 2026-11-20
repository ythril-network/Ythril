/**
 * Every address the RDF export writes reads back to the record or term it names, and no other spelling does (bundle-270, slice S2, Q-752).
 *
 * ## The defect this prevents
 *
 * The import decides from an address alone whether a quad speaks about a record this space holds, a record of another space, or something
 * foreign. A reverse rule that accepts a second spelling of one address (`entity/%65%31`, `entity/e1/`, `Entity/e1`) makes two records of
 * one; a reverse that joins a base on its own can drift from the rule that builds addresses; a property address shared by several types
 * answered with the first of them loses the others. `server/src/rdf/term-reverse.ts` is the one reverse: it reads an address by applying
 * the forward rule (`recordIri`, `resolveTermIri`, `edgeClassIri`) to what it decoded and takes the address only when that gives it back.
 *
 * ## What it holds
 *
 * - Every IRI the record mapper writes over a fixture of every record kind (both edge forms, a chrono interval, files, ids that need
 *   encoding) under the base reads back to a record, a part of one, or an address of the base's own; under the vocab, to a term; and the
 *   forward rule applied to the answer gives the address back. The cases are the forward rule's outputs, never a hand list.
 * - Each non-canonical spelling under a base or a vocab is answered `refused` with its reason, never as a record or a term.
 * - An address under no given base is `foreign`; a base that is the start of another reads against the longer; a source base reads its
 *   own addresses and is foreign when not given.
 * - A property address several types share answers with all of them and says so.
 * - Every record kind of the schema package is read: a kind added to the forward rule and not to the reverse fails here.
 * - The reverse module holds no state and reads no store, and builds no address itself.
 *
 * Run: node --test testing/standalone/every-address-the-export-writes-reads-back-to-its-record-and-term.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { SCHEMA_PACKAGE_NAME } from './_relative-specifier.mjs';

const reverse = await import('../../server/dist/rdf/term-reverse.js').catch(() => ({}));
const forward = await import('../../server/dist/rdf/term-iri.js');
const mapper = await import('../../server/dist/rdf/record-triples.js');
const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js');
const schemaPackage = await import('../../schema/dist/index.js');

const fn = (name) => {
  assert.equal(typeof reverse[name], 'function', `${name} is not exported by server/src/rdf/term-reverse.ts: an address the export writes cannot be read back`);
  return reverse[name];
};

const BASE = 'https://ythril.example.org/ld/space-1/';
const VOCAB = `${BASE}vocab/`;
const SCHEMA_ORG = 'http://schema.org/';
const META = {
  rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 },
  typeSchemas: {
    entity: {
      person: { iri: `${SCHEMA_ORG}Person`, propertySchemas: { email: { type: 'string', iri: `${SCHEMA_ORG}email` }, 'nick name': { type: 'string' }, age: { type: 'number' } } },
      org: { propertySchemas: { email: { type: 'string', iri: `${SCHEMA_ORG}email` }, founded: { type: 'date' } } },
      'odd/type': { propertySchemas: { 'a#b': { type: 'number' } } },
      thing: { iri: 'https://lib.example.org/ns/Thing', propertySchemas: { size: { type: 'number' } } },
    },
    fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
    chrono: { event: { propertySchemas: { room: { type: 'string' } } }, deadline: {} },
    edge: {
      knows: { iri: `${SCHEMA_ORG}knows`, propertySchemas: { since: { type: 'date' }, strength: { type: 'number' } } },
      likes: { propertySchemas: { how: { type: 'string' } } },
    },
  },
};
const AUTHOR = { instanceId: 'inst "1"', instanceLabel: 'Home' };
const SHARED = { author: AUTHOR, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00Z', schemaFingerprint: 'ab12 cd' };

/** Ids that need encoding, and the plain ones: what the export writes into an address. */
const IDS = ['e1', 'x y>z', 'ü/é', '100%', 'a?b#c', '..', '.', '%41', 'a%2fb', '日本語', '😀', '"quoted"', 'tab\there', 'a b/c'];
const FILE_PATHS = ['docs/a b/c.pdf', 'docs/../x', 'a.txt', 'dir/ü/日本', 'x%y/z#1'];

const records = () => {
  const out = [];
  IDS.forEach((id, i) => {
    out.push(['entity', { _id: id, name: `n${i}`, type: i % 3 === 0 ? 'person' : i % 3 === 1 ? 'odd/type' : undefined, tags: ['t'], properties: { email: 'a@b.c', 'nick name': 'x', 'a#b': 3, colour: 'red', age: 4 }, ...SHARED }]);
    out.push(['fact', { _id: id, fact: `fact ${i}`, type: 'note', properties: { weight: 2 }, ...SHARED }]);
    out.push(['chrono', { _id: id, title: `c${i}`, type: i % 2 ? 'event' : 'deadline', startsAt: '2026-03-01T09:00:00Z', ...(i % 4 < 2 ? { endsAt: '2026-03-01T10:00:00Z' } : {}), status: 'upcoming', properties: { room: 'r1' }, ...SHARED }]);
  });
  IDS.slice(0, 6).forEach((id, i) => {
    const ends = { from: IDS[i], to: IDS[(i + 1) % IDS.length], fromKind: 'entity', toKind: i % 2 ? 'fact' : 'entity' };
    out.push(['edge', { _id: `edge ${id}`, label: i % 2 ? 'knows' : 'likes', ...ends, weight: 0.5, type: 'friend', properties: { since: '2020-01-01', strength: 2, how: 'a lot' }, ...SHARED }]);
  });
  FILE_PATHS.forEach((path) => out.push(['file', { _id: path, path, sizeBytes: 3, sha256: 'ab', properties: { 'camera model': 'x' }, createdAt: '2026-01-01T10:00:00Z' }]));
  out.push(['link', { _id: 'l1', from: 'e1', to: 'docs/a b/c.pdf', fromKind: 'entity', toKind: 'file' }]);
  return out;
};

/** Every IRI of every quad the mapper writes for `records()`, with the edge form used. */
function writtenIris(edgeDetails) {
  const found = new Set();
  const visit = (term) => {
    if (term.kind === 'iri') found.add(term.value);
    else if (term.kind === 'triple') { visit(term.subject); visit(term.predicate); visit(term.object); }
  };
  for (const [kind, doc] of records()) {
    const { quads } = mapper.recordTriples(META, kind, doc, { edgeDetails });
    for (const q of quads) { visit(q.subject); visit(q.predicate); visit(q.object); }
  }
  return [...found];
}

const names = (meta = META, source) => fn('addressNames')(meta, source);
const underBase = (address) => address.startsWith(BASE);
const underVocab = (address) => address.startsWith(VOCAB);

describe('every IRI the mapper writes reads back', () => {
  for (const edgeDetails of ['rdf12', 'reification']) {
    const all = writtenIris(edgeDetails);
    const inBase = all.filter((a) => underBase(a) && !underVocab(a));
    const inVocab = all.filter(underVocab);

    it(`${edgeDetails}: the fixture writes addresses of every kind under the base and terms under the vocab (the scan is not empty)`, () => {
      assert.ok(inBase.length > 40, `only ${inBase.length} record addresses under the base`);
      assert.ok(inVocab.length > 20, `only ${inVocab.length} terms under the vocab`);
      const kinds = new Set(inBase.map((a) => a.slice(BASE.length).split('/')[0]));
      for (const kind of [...schemaPackage.KNOWLEDGE_TYPES, 'file', 'agent', 'schema']) assert.ok(kinds.has(kind), `the fixture wrote no address of ${kind}`);
    });

    it(`${edgeDetails}: each address under the base is a record, a part of one, or an address of the base's own, and the forward rule gives it back`, () => {
      const n = names();
      for (const address of inBase) {
        const read = fn('recordOfAddress')(address, n);
        assert.ok(['record', 'record-part', 'other'].includes(read.answer), `${address} read as ${JSON.stringify(read)}`);
        assert.equal(read.of, 'space', address);
        if (read.answer === 'record') assert.equal(forward.recordIri(META, read.kind, read.id), address);
        else if (read.answer === 'record-part') assert.equal(`${forward.recordIri(META, read.kind, read.id)}#${read.part}`, address);
        else if (read.what === 'agent') assert.equal(forward.agentIri(META, read.name), address);
        else if (read.what === 'schema-version') assert.equal(forward.versionIri(META, read.name), address);
        else assert.equal(forward.ontologyIri(META), address);
      }
    });

    it(`${edgeDetails}: each address under the vocab is a term of the space, and the forward rule gives it back`, () => {
      const n = names();
      for (const address of inVocab) {
        const read = fn('termOfIri')(address, n);
        assert.equal(read.answer, 'term', `${address} read as ${JSON.stringify(read)}`);
        assert.ok(read.owners.length >= 1, address);
        const some = read.owners.some((o) => [
          forward.resolveTermIri(META, o.kind, o.type, o.prop),
          ...(o.kind === 'edge' && o.prop === undefined ? [forward.edgeClassIri(META, o.type)] : []),
        ].includes(address));
        assert.ok(some, `${address} is not the address the forward rule gives its owners ${JSON.stringify(read.owners)}`);
      }
    });
  }

  it('the record ids the fixture writes come back as the ids it was given', () => {
    const n = names();
    const seen = new Map();
    for (const [kind, doc] of records()) {
      if (kind === 'link') continue;
      const id = kind === 'file' ? doc.path : doc._id;
      const read = fn('recordOfAddress')(forward.recordIri(META, kind, id), n);
      assert.deepEqual([read.answer, read.kind, read.id], ['record', kind, id]);
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
    for (const kind of [...schemaPackage.KNOWLEDGE_TYPES, 'file']) assert.ok(seen.get(kind) > 0, `no ${kind} record in the fixture`);
  });

  it('a chrono interval\'s two time nodes are parts of their record; no other fragment of a record is', () => {
    const n = names();
    const s = forward.recordIri(META, 'chrono', 'c 1');
    assert.deepEqual(fn('recordOfAddress')(`${s}#start`, n), { answer: 'record-part', of: 'space', kind: 'chrono', id: 'c 1', part: 'start' });
    assert.deepEqual(fn('recordOfAddress')(`${s}#end`, n), { answer: 'record-part', of: 'space', kind: 'chrono', id: 'c 1', part: 'end' });
    for (const bad of [`${s}#middle`, `${s}#`, `${s}#start#end`, `${forward.recordIri(META, 'entity', 'e1')}#start`]) {
      assert.equal(fn('recordOfAddress')(bad, n).answer, 'refused', bad);
    }
  });
});

describe('every record kind the forward rule names is read', () => {
  it('each kind of the schema package and a file reads back from the address the forward rule gives it', () => {
    const n = names();
    for (const kind of [...schemaPackage.KNOWLEDGE_TYPES, 'file']) {
      const read = fn('recordOfAddress')(forward.recordIri(META, kind, 'x/y'.slice(0, kind === 'file' ? 3 : 1)), n);
      assert.equal(read.answer, 'record', kind);
      assert.equal(read.kind, kind);
    }
  });
  it('the reverse lists exactly the kinds it reads, and they are the schema package\'s and files', () => {
    assert.deepEqual([...fn('recordKindsRead')()].sort(), [...schemaPackage.KNOWLEDGE_TYPES, 'file'].sort());
  });
});

describe('a record address under a base that is not the spelling the export writes is refused, with its reason', () => {
  const E = `${BASE}entity/`;
  const rows = [
    ['another case of the kind', `${BASE}Entity/e1`, 'unknown-kind'],
    ['a kind the export never writes', `${BASE}link/l1`, 'unknown-kind'],
    ['no kind at all', `${BASE}e1`, 'unknown-kind'],
    ['an address of the vocab, which names terms', `${VOCAB}entity/person`, 'under-vocabulary'],
    ['a percent-encoded unreserved character', `${E}%65%31`, 'not-the-spelling-the-export-writes'],
    ['lower-case hex where the export writes upper-case', `${E}x%2fy`, 'not-the-spelling-the-export-writes'],
    ['a character the export encodes, written raw', `${E}x y`, 'not-the-spelling-the-export-writes'],
    ['a raw angle bracket', `${E}x>y`, 'not-the-spelling-the-export-writes'],
    ['a slash in an id of a non-file kind', `${E}a/b`, 'trailing-part'],
    ['a trailing slash', `${E}e1/`, 'trailing-part'],
    ['a trailing part', `${E}e1/more`, 'trailing-part'],
    ['a fragment', `${E}e1#frag`, 'trailing-part'],
    ['a query', `${E}e1?q=1`, 'trailing-part'],
    ['an empty id', E, 'empty-id'],
    ['a kind with nothing after it', `${BASE}entity`, 'unknown-kind'],
    ['a lone percent', `${E}100%`, 'bad-percent-encoding'],
    ['a truncated escape', `${E}a%2`, 'bad-percent-encoding'],
    ['bytes that are no UTF-8', `${E}%FF%FE`, 'bad-percent-encoding'],
    ['an escape of a replacement character written another way', `${E}%EF%BF%BDx%ef%bf%bd`, 'not-the-spelling-the-export-writes'],
    ['a dot segment of a file path written raw', `${BASE}file/a/../b`, 'not-the-spelling-the-export-writes'],
    ['a single dot segment of a file path written raw', `${BASE}file/a/./b`, 'not-the-spelling-the-export-writes'],
    ['an empty segment of a file path', `${BASE}file/a//b`, 'empty-id'],
    ['a trailing slash of a file path', `${BASE}file/a/`, 'empty-id'],
    ['a leading slash of a file path', `${BASE}file//a`, 'empty-id'],
    ['an encoded slash inside a file path segment', `${BASE}file/a%2Fb`, 'not-the-spelling-the-export-writes'],
    ['a fragment of a file path', `${BASE}file/a#b`, 'trailing-part'],
    ['the agent kind with an unwritable name', `${BASE}agent/a b`, 'not-the-spelling-the-export-writes'],
    ['an agent with no name', `${BASE}agent/`, 'empty-id'],
    ['a schema version with a slash', `${BASE}schema/a/b`, 'trailing-part'],
  ];
  const n = names();
  for (const [what, address, reason] of rows) {
    it(`${what}: ${address}`, () => {
      const read = fn('recordOfAddress')(address, n);
      assert.equal(read.answer, 'refused', `read as ${JSON.stringify(read)}`);
      assert.equal(read.reason, reason);
      assert.equal(read.of, 'space');
      assert.equal(typeof read.message, 'string');
      assert.ok(read.message.length > 10, 'the refusal says why in words');
    });
  }
});

describe('an address under no given base is foreign', () => {
  const n = names();
  for (const address of [
    'http://example.org/entity/e1', 'urn:uuid:5f1e', `${SCHEMA_ORG}Person`, '', 'entity/e1', '#frag', '/ld/space-1/entity/e1',
    'HTTPS://YTHRIL.EXAMPLE.ORG/ld/space-1/entity/e1', 'https://ythril.example.org/ld/space-12/entity/e1', 'https://ythril.example.org/ld/space-1entity/e1',
    'https://ythril.example.org/ld/space-1', `${BASE.slice(0, -1)}?x=1/entity/e1`,
  ]) {
    it(`record: ${JSON.stringify(address)}`, () => assert.deepEqual(fn('recordOfAddress')(address, n), { answer: 'foreign' }));
  }
  it('a term outside every vocab, and a record address read as a term, are foreign', () => {
    assert.deepEqual(fn('termOfIri')('http://example.org/vocab/Person', n), { answer: 'foreign' });
    assert.deepEqual(fn('termOfIri')(`${BASE}entity/e1`, n), { answer: 'foreign' });
    assert.deepEqual(fn('termOfIri')('https://ythril.example.org/ld/space-1/vocabulary/entity/x', n), { answer: 'foreign' });
  });
  it('a base that is the start of another reads against the longer one, an address of the shorter against the shorter', () => {
    const outer = { rdf: { enabled: true, base: 'https://h.example/ld/', baseEpoch: 0 } };
    const nested = names(outer, { base: 'https://h.example/ld/a/' });
    assert.deepEqual(fn('recordOfAddress')('https://h.example/ld/a/entity/e1', nested), { answer: 'record', of: 'source', kind: 'entity', id: 'e1' });
    assert.deepEqual(fn('recordOfAddress')('https://h.example/ld/entity/e1', nested), { answer: 'record', of: 'space', kind: 'entity', id: 'e1' });
    const refused = fn('recordOfAddress')('https://h.example/ld/a/nothing/e1', nested);
    assert.deepEqual([refused.answer, refused.of, refused.reason], ['refused', 'source', 'unknown-kind']);
    const near = names({ rdf: { enabled: true, base: 'https://h.example/kb/', baseEpoch: 0 } }, { base: 'https://h.example/kb2/' });
    assert.deepEqual(fn('recordOfAddress')('https://h.example/kb2/fact/f1', near), { answer: 'record', of: 'source', kind: 'fact', id: 'f1' });
    assert.deepEqual(fn('recordOfAddress')('https://h.example/kb/fact/f1', near), { answer: 'record', of: 'space', kind: 'fact', id: 'f1' });
    assert.deepEqual(fn('recordOfAddress')('https://h.example/kb3/fact/f1', near), { answer: 'foreign' });
  });
});

describe('a source base and vocab are read as the export of another space wrote them', () => {
  const SOURCE_BASE = 'https://other.example.net/ld/space-9/';
  const SOURCE_META = { ...META, rdf: { enabled: true, base: SOURCE_BASE, baseEpoch: 0 } };
  it('its records and its terms read as the source\'s, by the vocab it defaults to; without it they are foreign', () => {
    const sourceAddress = forward.recordIri(SOURCE_META, 'entity', 'x y');
    const sourceTerm = forward.resolveTermIri(SOURCE_META, 'entity', 'odd/type', 'a#b');
    assert.ok(sourceTerm.startsWith(`${SOURCE_BASE}vocab/`), 'the fixture\'s source vocab is the default one');
    const withSource = names(META, { base: SOURCE_BASE });
    assert.deepEqual(fn('recordOfAddress')(sourceAddress, withSource), { answer: 'record', of: 'source', kind: 'entity', id: 'x y' });
    const term = fn('termOfIri')(sourceTerm, withSource);
    assert.deepEqual([term.answer, term.of, term.owners], ['term', 'source', [{ kind: 'entity', type: 'odd/type', prop: 'a#b' }]]);
    assert.deepEqual(fn('recordOfAddress')(sourceAddress, names()), { answer: 'foreign' });
    assert.deepEqual(fn('termOfIri')(sourceTerm, names()), { answer: 'foreign' });
  });
  it('a source vocab that is named is the one read', () => {
    const named = names(META, { base: SOURCE_BASE, vocab: 'https://terms.example.net/v/' });
    const term = fn('termOfIri')('https://terms.example.net/v/fact/note#weight', named);
    assert.deepEqual([term.answer, term.of, term.owners], ['term', 'source', [{ kind: 'fact', type: 'note', prop: 'weight' }]]);
    assert.deepEqual(fn('termOfIri')(`${SOURCE_BASE}vocab/fact/note`, named), { answer: 'foreign' });
  });
  it('a source base that is no absolute address is refused when the names are made', () => {
    for (const base of ['', 'ld/space-9/', '/ld/space-9/']) assert.throws(() => names(META, { base }), /source base/, `a source base ${JSON.stringify(base)} is accepted`);
  });
  it('an address the space and the source both claim reads as the space\'s', () => {
    const same = names(META, { base: BASE });
    assert.equal(fn('recordOfAddress')(`${BASE}entity/e1`, same).of, 'space');
  });
});

describe('a term address reads back to the term\'s kind and name', () => {
  const n = names();
  const term = (address) => fn('termOfIri')(address, n);
  const owners = (address) => { const r = term(address); assert.equal(r.answer, 'term', `${address}: ${JSON.stringify(r)}`); return r.owners; };

  it('a type, a property and an edge label, derived or by an explicit iri', () => {
    assert.deepEqual(owners(`${VOCAB}entity/org`), [{ kind: 'entity', type: 'org' }]);
    assert.deepEqual(owners(`${VOCAB}entity/org#founded`), [{ kind: 'entity', type: 'org', prop: 'founded' }]);
    assert.deepEqual(owners(`${VOCAB}entity/person#nick%20name`), [{ kind: 'entity', type: 'person', prop: 'nick name' }]);
    assert.deepEqual(owners(`${VOCAB}entity/odd%2Ftype#a%23b`), [{ kind: 'entity', type: 'odd/type', prop: 'a#b' }]);
    assert.deepEqual(owners(`${VOCAB}fact/note`), [{ kind: 'fact', type: 'note' }]);
    assert.deepEqual(owners(`${VOCAB}chrono/event#room`), [{ kind: 'chrono', type: 'event', prop: 'room' }]);
    assert.deepEqual(owners(`${VOCAB}edge/likes`), [{ kind: 'edge', type: 'likes' }]);
    assert.deepEqual(owners(`${VOCAB}edge/likes#how`), [{ kind: 'edge', type: 'likes', prop: 'how' }]);
    assert.deepEqual(owners(`${SCHEMA_ORG}Person`), [{ kind: 'entity', type: 'person' }]);
    assert.deepEqual(owners('https://lib.example.org/ns/Thing'), [{ kind: 'entity', type: 'thing' }]);
  });
  it('an edge label with an outside address reads back by it, and its reifier class still reads as the label', () => {
    assert.deepEqual(owners(`${SCHEMA_ORG}knows`), [{ kind: 'edge', type: 'knows' }]);
    assert.deepEqual(owners(forward.edgeClassIri(META, 'knows')), [{ kind: 'edge', type: 'knows' }]);
    assert.deepEqual(owners(`${VOCAB}edge/knows#since`), [{ kind: 'edge', type: 'knows', prop: 'since' }]);
  });
  it('a type the schema does not declare is read by the vocab rule alone, and says so', () => {
    const read = term(`${VOCAB}entity/robot`);
    assert.deepEqual([read.answer, read.owners, read.shared], ['term', [{ kind: 'entity', type: 'robot' }], false]);
    assert.equal(read.how, 'vocabulary');
    assert.equal(term(`${SCHEMA_ORG}Person`).how, 'schema');
  });
  it('an untyped entity\'s property and a file\'s property; the bare documents are no term, as the forward rule names none by them', () => {
    assert.deepEqual(owners(`${VOCAB}entity#colour`), [{ kind: 'entity', type: null, prop: 'colour' }]);
    assert.deepEqual(owners(`${VOCAB}file#camera%20model`), [{ kind: 'file', type: null, prop: 'camera model' }]);
    for (const kind of ['entity', 'file']) {
      assert.notEqual(forward.resolveTermIri(META, kind, null), `${VOCAB}${kind}`, `the forward rule names ${kind} by its bare document: the reverse must read it`);
      assert.equal(term(`${VOCAB}${kind}`).reason, 'not-a-term-the-export-writes');
    }
  });
  it('a property address that several types use answers with all of them and says it is shared; never the first', () => {
    const read = term(`${SCHEMA_ORG}email`);
    assert.equal(read.answer, 'term');
    assert.equal(read.shared, true);
    assert.deepEqual([...read.owners].sort((a, b) => a.type.localeCompare(b.type)), [
      { kind: 'entity', type: 'org', prop: 'email' }, { kind: 'entity', type: 'person', prop: 'email' },
    ]);
    assert.equal(term(`${VOCAB}entity/org#founded`).shared, false);
  });
  it('the product\'s own terms read back to what they mean', () => {
    for (const row of vocabulary.YTHRIL_TERMS) {
      const read = term(`${vocabulary.YTHRIL_NS}${row.name}`);
      assert.deepEqual([read.answer, read.name, read.termKind, read.meaning], ['product', row.name, row.kind, row.comment]);
    }
    assert.equal(term(`${vocabulary.YTHRIL_NS}invented`).answer, 'refused');
    assert.equal(term(`${vocabulary.YTHRIL_NS}invented`).reason, 'not-a-term-the-export-writes');
    assert.equal(term(`${vocabulary.YTHRIL_NS}`).answer, 'refused');
  });
  it('the predicates the mapper writes on its own account read as the mapper\'s, never as a term of the schema', () => {
    for (const predicate of vocabulary.RDF_RESERVED_PREDICATES.filter((p) => !p.startsWith(vocabulary.YTHRIL_NS))) {
      assert.deepEqual(term(predicate), { answer: 'mapper-predicate', iri: predicate });
    }
  });
  const refused = [
    ['an unknown kind', `${VOCAB}Entity/person`, 'unknown-kind'],
    ['the link kind, which has no terms', `${VOCAB}link/x`, 'unknown-kind'],
    ['a file type, files have none', `${VOCAB}file/x`, 'not-a-term-the-export-writes'],
    ['the bare entity document, an untyped entity\'s class is ythril:Untyped', `${VOCAB}entity`, 'not-a-term-the-export-writes'],
    ['a type with no name', `${VOCAB}entity/`, 'empty-name'],
    ['a property with no name', `${VOCAB}entity/person#`, 'empty-name'],
    ['an untyped property with no name', `${VOCAB}entity#`, 'empty-name'],
    ['nothing after the vocab', VOCAB, 'unknown-kind'],
    ['a trailing part of a type', `${VOCAB}entity/person/x`, 'trailing-part'],
    ['a query', `${VOCAB}entity/person?x`, 'trailing-part'],
    ['a second fragment', `${VOCAB}entity/person#a#b`, 'not-the-spelling-the-export-writes'],
    ['a percent-encoded unreserved character in a type', `${VOCAB}entity/%70erson`, 'not-the-spelling-the-export-writes'],
    ['lower-case hex in a type', `${VOCAB}entity/odd%2ftype`, 'not-the-spelling-the-export-writes'],
    ['a raw space in a property', `${VOCAB}entity/person#nick name`, 'not-the-spelling-the-export-writes'],
    ['a lone percent', `${VOCAB}entity/a%`, 'bad-percent-encoding'],
    ['bytes that are no UTF-8', `${VOCAB}entity/person#%FF`, 'bad-percent-encoding'],
  ];
  for (const [what, address, reason] of refused) {
    it(`refused, ${what}: ${address}`, () => {
      const read = term(address);
      assert.equal(read.answer, 'refused', `read as ${JSON.stringify(read)}`);
      assert.equal(read.reason, reason);
      assert.equal(read.of, 'space');
      assert.ok(read.message.length > 10);
    });
  }
  it('a property of the derived form that no type declares is still a term of the vocab', () => {
    assert.deepEqual(owners(`${VOCAB}entity/person#brand-new`), [{ kind: 'entity', type: 'person', prop: 'brand-new' }]);
  });
  it('round trip over generated names: the forward address of any type, property and label reads back to the same names', () => {
    const generated = ['a', 'A b', 'ü', '日本', '😀', 'x/y', 'p#q', '%', '%41', '.', '..', '?', 'a?b', '"', '<>', 'tab\t', 'line\nbreak', 'a'.repeat(300)];
    const bare = { rdf: META.rdf };
    for (const kind of schemaPackage.KNOWLEDGE_TYPES) {
      for (const type of generated) {
        const typeIri = forward.resolveTermIri(bare, kind, type);
        assert.deepEqual(owners(typeIri), [{ kind, type }], `${kind} ${JSON.stringify(type)}`);
        for (const prop of generated) assert.deepEqual(owners(forward.resolveTermIri(bare, kind, type, prop)), [{ kind, type, prop }], `${kind} ${JSON.stringify([type, prop])}`);
      }
    }
    for (const prop of generated) {
      assert.deepEqual(owners(forward.resolveTermIri(bare, 'entity', null, prop)), [{ kind: 'entity', type: null, prop }]);
      assert.deepEqual(owners(forward.resolveTermIri(bare, 'file', null, prop)), [{ kind: 'file', type: null, prop }]);
    }
  });
  it('round trip over generated ids: the forward address of any id of any kind reads back to that id', () => {
    const generated = [...IDS, 'a'.repeat(400), ' ', '/', '..', '\u0000', 'é', 'x😀y'];
    for (const kind of schemaPackage.KNOWLEDGE_TYPES) {
      for (const id of generated) assert.deepEqual(fn('recordOfAddress')(forward.recordIri(META, kind, id), names()), { answer: 'record', of: 'space', kind, id }, `${kind} ${JSON.stringify(id)}`);
    }
    for (const path of [...FILE_PATHS, 'a', 'a/b/c', 'a b/.hidden', '..%2e/x']) {
      assert.deepEqual(fn('recordOfAddress')(forward.recordIri(META, 'file', path), names()), { answer: 'record', of: 'space', kind: 'file', id: path }, path);
    }
  });
});

describe('the reverse holds no state, reads no store, and builds no address of its own', () => {
  it('RDF off for the space is refused when the names are made, as every forward function refuses', () => {
    for (const meta of [{ typeSchemas: META.typeSchemas }, { ...META, rdf: { ...META.rdf, enabled: false } }]) {
      assert.throws(() => names(meta), (err) => err?.code === 'rdf_not_enabled');
    }
  });
  it('the answer does not depend on what was asked before', () => {
    const n = names();
    const first = fn('recordOfAddress')(`${BASE}entity/a%20b`, n);
    for (const address of [`${BASE}entity/zzz`, `${BASE}nothing`, 'http://x.example/']) fn('recordOfAddress')(address, n);
    assert.deepEqual(fn('recordOfAddress')(`${BASE}entity/a%20b`, n), first);
    assert.deepEqual(names(), names(), 'the same meta gives the same names');
  });
  it('the names it is handed are not changed by a read', () => {
    const n = names(META, { base: 'https://other.example.net/ld/space-9/' });
    const before = inspect(n, { depth: 10 });
    fn('recordOfAddress')(`${BASE}entity/e1`, n);
    fn('termOfIri')(`${SCHEMA_ORG}email`, n);
    assert.equal(inspect(n, { depth: 10 }), before);
  });
  it('the module imports no store, no file system and no network, and carries no module-level variable that changes', () => {
    const file = 'server/src/rdf/term-reverse.ts';
    const source = blankComments(readFileSync(file, 'utf8'));
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.ok(imports.length >= 2, 'the scan found the module\'s imports');
    for (const from of imports) assert.ok(from === SCHEMA_PACKAGE_NAME || /^\.\/(term-iri|ythril-vocabulary)\.js$/.test(from), `imports ${from}`);
    assert.doesNotMatch(source, /^(?:let|var)\s/m, 'a module-level let or var');
    assert.doesNotMatch(source, /^(?:const\s+\w+\s*=\s*new\s+(?:Map|Set|WeakMap)\b)/m, 'a module-level cache');
  });
  it('it builds no address: no encoder, no base joined, no vocab joined (the one-place gate\'s own scan, on this file)', () => {
    const sources = readTrackedSources([...SERVER_CODE_ROOTS], { untracked: true });
    const mine = sources.find((s) => s.file === 'server/src/rdf/term-reverse.ts');
    assert.ok(mine, 'the reverse module is in the scan');
    const text = blankComments(mine.text);
    assert.doesNotMatch(text, /\biri(?:Segment|Fragment)\b/);
    assert.doesNotMatch(text, /\bencodeURI(?:Component)?\s*\(/);
    assert.doesNotMatch(text, /\.concat\(|\bbase\s*\+|\bvocab\s*\+|\$\{\s*(?:base|vocab)\s*\}/, 'joins a base or a vocab by hand');
  });
});
