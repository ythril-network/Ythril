/**
 * The quads the record form writes translate back into the operation that states what the record's writable fields held (bundle-270, slice
 * S3, Q-752).
 *
 * ## The defect this prevents
 *
 * The import turns a file a stranger made into writes. A quad silently dropped is data lost without a word; a quad wrongly taken is a wrong
 * record; a field read back under another name, a number read back as a string, a tag lost, a link or an edge end read against the wrong
 * base, is a round trip that changes the record. `server/src/rdf/quads-to-ops.ts` is the inverse of `recordTriples`: per subject group, one
 * operation per record (insert under a minted id, or converge onto the stored one), every quad accounted for.
 *
 * ## What it holds
 *
 * - For every record kind and both edge forms, the forward mapping's output over a fixture of every kind (`_rdf-writer-fixtures.mjs` and a
 *   few more here: an untyped entity with a property, an untyped fact, a chrono instant, a link from a chrono) translates back to the
 *   record's WRITABLE PROJECTION. The projection is a list of field names written out below, never imported from the translator (plan
 *   amendment A13): an empty tag list and an empty property bag are the absent ones, the values the forward mapping left out (and counted)
 *   are not expected back, links are the link records that start at the record.
 *   - In this space (every record stored, holding nothing but its id): each operation converges onto the stored id and states exactly the
 *     projection.
 *   - From a source space (its base named, nothing stored): each operation is an insert under the id minted for its address, ends and links
 *     under the minted ids, and a file, an edge to a file and a link to one are left out on purpose, never refused.
 *   - With explicit `iri`s on a type, a property and an edge label, the same.
 * - The two edge forms (the plain triple with a reifier stating `rdf:reifies`, and the classic `rdf:Statement`) yield the same operations.
 * - For every group of every fixture, the quads taken, left out and answered by a reason sum to the group's size.
 * - The export's description (the report node, its left-out nodes, the data graph's own statements) is left out on purpose, never refused,
 *   even with blank nodes refused.
 * - Quads of several graphs are told apart by graph: each operation carries its graph, and a group that mixes two graphs is refused by a throw.
 * - The translator holds no second copy of the address rule (no decoder, no encoder, no vocab joined or split): a predicate the Direct
 *   Mapping writes for a property with no declared term is read back by `term-reverse.ts`. It imports nothing that reads a store.
 *
 * Run: node --test testing/standalone/quads-translate-back-to-what-the-record-form-wrote.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankComments } from './_strip-comments.mjs';
import { SCHEMA_PACKAGE_NAME } from './_relative-specifier.mjs';
import { META as FIXTURE_META, DOCS as FIXTURE_DOCS, BASE } from './_rdf-writer-fixtures.mjs';
import {
  fn, reverse, forwardQuads, groupsOf, contextFor, assertAccounted, iri, blank, lit, q, RDF, XSD, SCHEMA_ORG,
} from './_quads-to-ops-doors.mjs';

const termIri = await import('../../server/dist/rdf/term-iri.js');
const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js');

/** The writable projection of each record kind, written out here (A13): what an import can state of a record. */
const PROJECTION = Object.freeze({
  entity: ['name', 'type', 'description', 'tags', 'properties'],
  fact: ['fact', 'type', 'description', 'tags', 'properties'],
  chrono: ['title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'recurrence', 'description', 'tags', 'properties'],
  edge: ['from', 'fromKind', 'to', 'toKind', 'label', 'type', 'weight', 'description', 'tags', 'properties'],
});
/** The kinds that hold link records, and the kinds they link to (`brain/link-adjacency.ts`); a file is not imported. */
const LINKS_HELD = Object.freeze({ fact: ['entity'], chrono: ['entity', 'fact'] });

const SHARED = { author: { instanceId: 'inst-2', instanceLabel: 'Other' }, createdAt: '2026-02-01T10:00:00Z', updatedAt: '2026-02-02T10:00:00Z', schemaFingerprint: 'fp2' };
const MORE_DOCS = [
  ['entity', { _id: 'u2', name: 'Second untyped', tags: ['b', 'a', 'b'], properties: { colour: 'red', count: 3, ok: false }, ...SHARED }],
  ['fact', { _id: 'f2', fact: 'An untyped fact.', description: 'no type', ...SHARED }],
  ['chrono', { _id: 'c3', title: 'An instant', type: 'deadline', startsAt: '2026-05-01T08:00:00Z', status: 'completed', tags: ['x'], properties: { room: 'r1' }, ...SHARED }],
  ['edge', { _id: 'k3', from: 'u2', to: 'a b>c', label: 'likes', weight: 2, properties: { score: 3 }, ...SHARED }],
  ['link', { _id: 'l2', from: 'c1', fromKind: 'chrono', to: 'f1', toKind: 'fact' }],
  ['link', { _id: 'l3', from: 'c1', fromKind: 'chrono', to: 'u2', toKind: 'entity' }],
];
const DOCS = [...FIXTURE_DOCS, ...MORE_DOCS];

/** The fixture's meta with explicit addresses on a type, a property and an edge label. */
const EXPLICIT_META = {
  ...FIXTURE_META,
  typeSchemas: {
    entity: { person: { iri: `${SCHEMA_ORG}Person`, propertySchemas: { age: { type: 'number', iri: `${SCHEMA_ORG}age` }, born: { type: 'date' } } } },
    edge: { knows: { iri: `${SCHEMA_ORG}knows`, propertySchemas: { since: { type: 'date' } } } },
  },
};
const SOURCE_BASE = 'https://other.example.org/ld/space-a/';
const sourceMeta = (meta) => ({ ...meta, rdf: { enabled: true, base: SOURCE_BASE, vocab: `${SOURCE_BASE}vocab/`, baseEpoch: 0 } });

const recordKey = (kind, id) => fn('recordKey')(kind, id);
const isRecordKind = (kind) => kind !== 'link';
const sortedUnique = (tags) => [...new Set(tags ?? [])].sort();
const dropUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** The projection of one stored record, as the import must state it: ids of ends and links passed through `idOf`. */
function expectedOf(kind, doc, skipped, idOf) {
  const left = new Set(skipped.filter(s => s.recordId === doc._id && s.kind === kind).map(s => s.key));
  const properties = Object.fromEntries(Object.entries(doc.properties ?? {}).filter(([k]) => !left.has(k)));
  const out = {};
  for (const field of PROJECTION[kind]) {
    if (field === 'tags') out.tags = sortedUnique(doc.tags);
    else if (field === 'properties') out.properties = properties;
    else if (field === 'type' && kind === 'entity') out.type = doc.type ?? null;
    else if (field === 'from') out.from = idOf(doc.fromKind ?? 'entity', doc.from);
    else if (field === 'to') out.to = idOf(doc.toKind ?? 'entity', doc.to);
    else if (field === 'fromKind') out.fromKind = doc.fromKind ?? 'entity';
    else if (field === 'toKind') out.toKind = doc.toKind ?? 'entity';
    else if (doc[field] !== undefined) out[field] = doc[field];
  }
  return out;
}

/** The link records that start at a record, by the kind they point at, ids through `idOf`; a link to a file is not expected back. */
function expectedLinks(kind, id, idOf) {
  if (!Object.hasOwn(LINKS_HELD, kind)) return {};
  const links = {};
  for (const [k, d] of DOCS) {
    if (k !== 'link' || d.from !== id || d.fromKind !== kind || !LINKS_HELD[kind].includes(d.toKind)) continue;
    (links[d.toKind] ??= []).push(idOf(d.toKind, d.to));
  }
  for (const k of Object.keys(links)) links[k].sort();
  return links;
}

const normalLinks = (links) => Object.fromEntries(Object.entries(links ?? {}).filter(([, v]) => v.length > 0).map(([k, v]) => [k, [...v].sort()]));

/** Translates every group of `quads`; answers the operations by correlation, and checks the accounting of every group on the way. */
function translateAll(quads, ctx, what) {
  const quadsToOps = fn('quadsToOps');
  const ops = new Map();
  const notTaken = [];
  const reasons = [];
  for (const group of groupsOf(quads, ctx.names)) {
    const out = quadsToOps(group, ctx);
    assertAccounted(group, out, `${what}, group of ${group[0].subject.value ?? group[0].subject.id}`);
    for (const op of out.ops) {
      assert.ok(!ops.has(op.correlation), `${what}: two operations for one correlation`);
      ops.set(op.correlation, op);
    }
    notTaken.push(...out.notTaken);
    reasons.push(...out.reasons);
  }
  return { ops, notTaken, reasons };
}

/** The address the file gives each record of `meta`. */
const addressOf = (meta, kind, id) => termIri.recordIri(meta, kind, id);

function sameSpaceCase(meta, edgeDetails) {
  const { quads, skipped } = forwardQuads(meta, DOCS, edgeDetails, BASE);
  const names = reverse.addressNames(meta);
  const stored = new Map();
  for (const [kind, doc] of DOCS) if (isRecordKind(kind)) stored.set(recordKey(kind, doc.path ?? doc._id), { doc: { _id: doc._id }, links: {} });
  const ctx = contextFor({ meta, names, quads, stored });
  return { quads, skipped, ctx, ...translateAll(quads, ctx, `same space, ${edgeDetails}`) };
}

function sourceCase(meta, edgeDetails) {
  const source = sourceMeta(meta);
  const { quads, skipped } = forwardQuads(source, DOCS, edgeDetails, SOURCE_BASE);
  const names = reverse.addressNames(meta, { base: SOURCE_BASE });
  const minted = new Map();
  for (const [kind, doc] of DOCS) {
    if (kind === 'link' || kind === 'file') continue;
    minted.set(addressOf(source, kind, doc._id), { kind, id: `minted:${kind}:${doc._id}` });
  }
  const ctx = contextFor({ meta, names, quads, minted });
  return { quads, skipped, source, ctx, ...translateAll(quads, ctx, `source space, ${edgeDetails}`) };
}

function assertProjection(run, meta, idOf, opWanted, what) {
  let checked = 0;
  for (const [kind, doc] of DOCS) {
    if (kind === 'link' || kind === 'file') continue;
    const toFile = kind === 'edge' && (doc.toKind === 'file' || doc.fromKind === 'file');
    const op = run.ops.get(addressOf(meta, kind, doc._id));
    if (toFile && opWanted === 'insert') { assert.equal(op, undefined, `${what}: an edge to a file of another space is not imported`); continue; }
    assert.ok(op, `${what}: no operation for ${kind} ${doc._id}`);
    assert.equal(op.kind, kind, `${what}: ${kind} ${doc._id} is translated as a ${op.kind}`);
    assert.equal(op.op, opWanted, `${what}: ${kind} ${doc._id} is a ${op.op}, not a ${opWanted}`);
    assert.equal(op.id, idOf(kind, doc._id), `${what}: ${kind} ${doc._id} is written under the wrong id`);
    assert.deepEqual(dropUndefined(op.fields), expectedOf(kind, doc, run.skipped, idOf), `${what}: ${kind} ${doc._id} does not state its writable projection`);
    assert.deepEqual(normalLinks(op.links), expectedLinks(kind, doc._id, idOf), `${what}: ${kind} ${doc._id} does not state the links that start at it`);
    checked++;
  }
  assert.equal(run.ops.size, checked, `${what}: operations for nothing the fixture holds`);
  assert.deepEqual(run.reasons.map(r => r.code), [], `${what}: the record form's own output answered reasons`);
}

describe('quads translate back to what the record form wrote', () => {
  for (const [metaName, meta] of [['derived terms', FIXTURE_META], ['explicit iris', EXPLICIT_META]]) {
    for (const edgeDetails of ['rdf12', 'reification']) {
      it(`in this space every record converges onto its stored id and states its writable projection (${metaName}, ${edgeDetails})`, () => {
        const run = sameSpaceCase(meta, edgeDetails);
        assertProjection(run, meta, (_kind, id) => id, 'converge', `same space, ${metaName}, ${edgeDetails}`);
      });

      it(`from a source space every record is an insert under its minted id, files left out on purpose (${metaName}, ${edgeDetails})`, () => {
        const run = sourceCase(meta, edgeDetails);
        assertProjection(run, run.source, (kind, id) => `minted:${kind}:${id}`, 'insert', `source space, ${metaName}, ${edgeDetails}`);
        const fileLeft = run.notTaken.filter(n => n.why === 'file');
        const fileQuads = run.quads.filter(x => x.subject.value?.startsWith(`${SOURCE_BASE}file/`)
          || x.object.value?.startsWith(`${SOURCE_BASE}file/`)
          || (x.object.kind === 'triple' && x.object.object.value?.startsWith(`${SOURCE_BASE}file/`)));
        assert.ok(fileQuads.length > 0, 'the fixture holds a file, an edge to it and a link');
        for (const fq of fileQuads) assert.ok(fileLeft.some(n => n.quad === fq), 'a quad of a file, or of an edge to one, is left out on purpose and named as a file');
      });
    }
  }

  it('the two edge forms yield the same operations', () => {
    for (const meta of [FIXTURE_META, EXPLICIT_META]) {
      const a = sameSpaceCase(meta, 'rdf12');
      const b = sameSpaceCase(meta, 'reification');
      assert.deepEqual([...a.ops.entries()].sort(), [...b.ops.entries()].sort(), 'an edge reads back alike from rdf:reifies and from rdf:Statement');
      const c = sourceCase(meta, 'rdf12');
      const d = sourceCase(meta, 'reification');
      assert.deepEqual([...c.ops.entries()].sort(), [...d.ops.entries()].sort(), 'an edge of a source reads back alike in both forms');
    }
  });

  it('what is left out on purpose is named: the server-owned triples, the time nodes, the agent', () => {
    const run = sameSpaceCase(FIXTURE_META, 'rdf12');
    // A file's own statements are left out as a file's, whatever their predicate.
    const why = (pred) => run.notTaken.filter(n => n.quad.predicate.value === pred && !n.quad.subject.value?.startsWith(`${BASE}file/`)).map(n => n.why);
    const ythril = vocabulary.ythrilIri;
    for (const p of ['http://purl.org/dc/terms/created', 'http://purl.org/dc/terms/modified', 'http://purl.org/dc/terms/conformsTo', 'http://www.w3.org/ns/prov#wasAttributedTo', ythril('superseded'), ythril('contentRedacted')]) {
      assert.ok(why(p).length > 0 && why(p).every(w => w === 'server-owned'), `${p} is left out as server-owned`);
    }
    for (const p of ['http://www.w3.org/2006/time#hasBeginning', 'http://www.w3.org/2006/time#inXSDDateTimeStamp', 'http://schema.org/eventStatus']) {
      assert.ok(why(p).length > 0 && why(p).every(w => w === 'derived'), `${p} is left out as derived from a field the operation states`);
    }
    const agentQuads = run.notTaken.filter(n => n.quad.subject.value?.startsWith(`${BASE}agent/`));
    assert.ok(agentQuads.length >= 2 && agentQuads.every(n => n.why === 'server-owned'), 'the agent node is left out as server-owned');
    for (const n of run.notTaken) assert.equal(typeof n.message, 'string', 'a quad left out says why in words');
  });

  it("the export's description is left out on purpose, never refused, with blank nodes refused", () => {
    const report = 'urn:ythril:export-report:abc';
    const Y = vocabulary.YTHRIL_NS;
    const node = blank('left-out-0');
    const quads = [
      q(report, `${RDF}type`, `${Y}ExportReport`), q(report, `${Y}recordCount`, lit('3', `${XSD}integer`)),
      q(report, `${Y}complete`, lit('true', `${XSD}boolean`)), q(report, `${Y}leftOutCount`, lit('1', `${XSD}integer`)),
      q(report, `${Y}leftOutValue`, node), q(report, 'http://purl.org/dc/terms/hasPart', BASE),
      q(node, `${Y}leftOutRecord`, `${BASE}entity/e1`), q(node, `${Y}leftOutKey`, lit('k')), q(node, `${Y}leftOutReason`, lit('a list')),
      q(BASE, 'http://purl.org/dc/terms/isPartOf', report), q(BASE, 'http://www.w3.org/ns/shacl#shapesGraph', `${BASE}schema/fp1`),
    ];
    const names = reverse.addressNames(FIXTURE_META);
    const ctx = contextFor({ meta: FIXTURE_META, names, quads, mode: 'strict', blankNodes: 'refuse' });
    const run = translateAll(quads, ctx, 'description');
    assert.equal(run.ops.size, 0, 'the description is no record');
    assert.deepEqual(run.reasons.map(r => r.code), [], 'the description answers no reason');
    assert.equal(run.notTaken.length, quads.length, 'every quad of the description is left out');
    assert.ok(run.notTaken.every(n => n.why === 'export-description'), 'and named as the export\'s description');
  });

  it('quads of several graphs are told apart by graph, and a group never mixes two', () => {
    const quadsToOps = fn('quadsToOps');
    const names = reverse.addressNames(FIXTURE_META);
    const doc = DOCS.find(([k, d]) => k === 'fact' && d._id === 'f2');
    const f2 = addressOf(FIXTURE_META, 'fact', 'f2');
    const g1 = forwardQuads(FIXTURE_META, [doc], 'rdf12', `${BASE}`).quads.filter(x => x.subject.value === f2);
    const g2 = forwardQuads(FIXTURE_META, [doc], 'rdf12', 'https://elsewhere.example.org/g2').quads.filter(x => x.subject.value === f2);
    const minted = new Map([[addressOf(FIXTURE_META, 'fact', 'f2'), { kind: 'fact', id: 'm-f2' }]]);
    const ctx = contextFor({ meta: FIXTURE_META, names, quads: [...g1, ...g2], minted });
    const groups = groupsOf([...g1, ...g2], names);
    assert.equal(groups.length, 2, 'one subject in two graphs is two groups');
    const graphs = groups.map(g => quadsToOps(g, ctx).ops.map(op => op.graph)).flat().sort();
    assert.deepEqual(graphs, [BASE, 'https://elsewhere.example.org/g2'].sort(), 'each operation carries the graph its quads came from');
    assert.throws(() => quadsToOps([...g1, ...g2], ctx), /graph/, 'a group that mixes two graphs is refused');
  });

  it('a group holds one subject and the nodes that hang on it; anything else is refused', () => {
    const quadsToOps = fn('quadsToOps');
    const names = reverse.addressNames(FIXTURE_META);
    const { quads } = forwardQuads(FIXTURE_META, DOCS.filter(([k, d]) => k === 'chrono' && d._id === 'c1' || k === 'fact' && d._id === 'f2'), 'rdf12', BASE);
    const groupSubjectOf = fn('groupSubjectOf');
    const c1 = addressOf(FIXTURE_META, 'chrono', 'c1');
    assert.equal(groupSubjectOf(iri(`${c1}#start`), names), c1, "a chrono's time node belongs to its record's group");
    assert.equal(groupSubjectOf(blank('b1'), names), '_:b1', 'a blank node is its own group');
    const ctx = contextFor({ meta: FIXTURE_META, names, quads });
    assert.throws(() => quadsToOps(quads.filter(x => x.subject.value !== `${BASE}agent/inst%20%221%22`), ctx), /subject/, 'two subjects in one group are refused');
  });
});

describe('the translator holds no second address rule and reads no store', () => {
  const src = blankComments(readFileSync(new URL('../../server/src/rdf/quads-to-ops.ts', import.meta.url), 'utf8'));
  it('reads addresses and terms through term-reverse.ts', () => {
    assert.match(src, /import\s*\{[^}]*\btermOfIri\b[^}]*\}\s*from\s*'\.\/term-reverse\.js'/, 'termOfIri is how a predicate becomes a term');
    assert.match(src, /import\s*\{[^}]*\brecordOfAddress\b[^}]*\}\s*from\s*'\.\/term-reverse\.js'/, 'recordOfAddress is how an address becomes a record');
    for (const [shape, why] of [
      [/decodeURIComponent|encodeURIComponent|\biriSegment\b|\biriFragment\b/, 'a second decoder or encoder of names'],
      [/\bresolveTermIri\b|\brecordIri\b|\bedgeClassIri\b/, 'the forward rule applied here instead of in term-reverse.ts'],
      [/\.vocab\b|\.base\b/, 'a base or vocab read off a meta and joined or split here'],
      [/split\(\s*'#'\s*\)|indexOf\(\s*'#'\s*\)/, 'a fragment split off by hand'],
    ]) assert.doesNotMatch(src, shape, `quads-to-ops.ts holds ${why}`);
  });
  it('imports nothing that reads a store, the network or a file', () => {
    const specifiers = [...src.matchAll(/from\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(specifiers.length > 0, 'the import lines were read');
    const allowed = new Set(['./term-reverse.js', './literals.js', './ythril-vocabulary.js', './import-reasons.js', './term-iri.js', SCHEMA_PACKAGE_NAME, '../config/types-knowledge.js']);
    for (const s of specifiers) assert.ok(allowed.has(s), `quads-to-ops.ts imports ${s}: the translator is pure and asks nothing`);
  });
});
