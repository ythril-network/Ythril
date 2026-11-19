/**
 * What the writers write, independent parsers read back as the same triples, in all four formats (Q-749, design r4 §5.3, §8).
 *
 * ## The defect this prevents
 *
 * A writer is only right if a parser that did not write it reads the same statements back. The writers are tested byte by byte in
 * `the-rdf-writers-escape-compact-and-label.test.js`; this test hands their output to `n3` (Turtle, TriG, N-Quads, RDF 1.2 triple terms)
 * and to `jsonld` (JSON-LD, expanded to N-Quads and read by `n3`), both dev dependencies, offline (a document loader that refuses every
 * address, so no request leaves the test).
 *
 * ## What it holds
 *
 * - **one table of nasty strings** (quotes, backslashes, newlines, control characters, a lone surrogate, `<`, `>`, text that looks like a
 *   language tag, a datatype, a prefix line, a comment or a closing brace) round-trips in EVERY format. A lone surrogate is the one value
 *   no format can carry: it comes back as U+FFFD, exactly as the writer says;
 * - **records**: the mapper's quads for a fixture of every record kind are read back as the same set of triples, with RDF 1.2 reifiers in
 *   the three text formats and classic reification in JSON-LD;
 * - **graphs**: a named graph is the graph of each statement in TriG, N-Quads and JSON-LD;
 * - **collections and blank nodes** keep their structure.
 *
 * Run: node --test testing/standalone/the-rdf-writers-are-read-by-n3.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import jsonld from 'jsonld';

const ser = await import('../../server/dist/rdf/serialize.js').catch(() => ({}));
const mapper = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));
const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const E = 'http://ex.org/';
const iri = (value) => ({ kind: 'iri', value });
const lit = (value, datatype) => (datatype === undefined ? { kind: 'literal', value } : { kind: 'literal', value, datatype });
const q = (s, p, o, g) => ({ subject: typeof s === 'string' ? iri(s) : s, predicate: iri(p), object: typeof o === 'string' ? iri(o) : o, ...(g ? { graph: iri(g) } : {}) });
const PREFIXES = () => ({ rdf: RDF, rdfs: 'http://www.w3.org/2000/01/rdf-schema#', xsd: XSD, schema: 'http://schema.org/', time: 'http://www.w3.org/2006/time#', dcterms: 'http://purl.org/dc/terms/', prov: 'http://www.w3.org/ns/prov#', ythril: vocab.YTHRIL_NS });

async function write(format, batches, edgeDetails = 'reification') {
  assert.equal(typeof ser.serializeRdf, 'function', 'serializeRdf is not exported by server/src/rdf/serialize.ts: there is no writer');
  let out = '';
  for await (const chunk of ser.serializeRdf(format, batches, { prefixes: PREFIXES(), edgeDetails })) out += chunk;
  return out;
}

// -- canonical strings for a term of the model and for a term n3 parsed ----------------------------------------------------------------
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const fromModel = (t) => {
  if (t.kind === 'iri') return `<${t.value}>`;
  if (t.kind === 'literal') return `"${t.value.replace(LONE_SURROGATE, '\u{FFFD}')}"^^<${t.datatype ?? `${XSD}string`}>`;
  if (t.kind === 'triple') return `<<( ${fromModel(t.subject)} ${fromModel(t.predicate)} ${fromModel(t.object)} )>>`;
  throw new Error(`no canonical string for ${t.kind}`);
};
const fromN3 = (t) => {
  if (t.termType === 'NamedNode') return `<${t.value}>`;
  if (t.termType === 'Literal') {
    assert.equal(t.language, '', 'the writers never write a language tag');
    return `"${t.value}"^^<${t.datatype.value}>`;
  }
  if (t.termType === 'Quad') return `<<( ${fromN3(t.subject)} ${fromN3(t.predicate)} ${fromN3(t.object)} )>>`;
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  throw new Error(`no canonical string for ${t.termType}`);
};
const withGraph = (s, p, o, g) => `${s} ${p} ${o} ${g}`;
const modelSet = (batches) => new Set(batches.flatMap((b) => b.quads.map((x) => withGraph(fromModel(x.subject), fromModel(x.predicate), fromModel(x.object), (b.graph ?? x.graph?.value) ? `<${b.graph ?? x.graph.value}>` : '-'))));
const parsedSet = (quads) => new Set(quads.map((x) => withGraph(fromN3(x.subject), fromN3(x.predicate), fromN3(x.object), x.graph.termType === 'DefaultGraph' ? '-' : fromN3(x.graph))));

const refuseRemote = async (url) => { throw new Error(`the test is offline: ${url}`); };

/** The quads an independent parser reads from `text`. */
async function readBack(format, text) {
  if (format === 'jsonld') {
    const nquads = await jsonld.toRDF(JSON.parse(text), { format: 'application/n-quads', documentLoader: refuseRemote });
    return new Parser({ format: 'N-Quads' }).parse(nquads);
  }
  return new Parser({ format: { turtle: 'Turtle', trig: 'TriG', nquads: 'N-Quads' }[format] }).parse(text);
}
const FORMATS = ['turtle', 'trig', 'nquads', 'jsonld'];

// -- one table of nasty values -----------------------------------------------------------------------------------------------------------
const NASTY = [
  'plain', '', ' leading and trailing ', 'a "quote" b', '"', '\\', 'back\\slash', 'trailing backslash\\', '\\n is not a newline', '\\u0041 is not an A',
  'line1\nline2', 'cr\rlf', 'crlf\r\nend', 'tab\there', '\n', '\r', 'ctrl\u0001\u0002\u0007\u0008\u000b\u000c\u001b\u001f\u007f', 'nul\u0000x',
  '<tag a="b">&amp;</tag>', '1 < 2 > 0', '<http://evil.example/> <http://x/p> "y" .', '>', '<', '"@en', 'x"@en', '"x"@en', '@en', 'x@en-GB',
  `x"^^<${XSD}decimal>`, '"x"^^xsd:decimal', '@prefix a: <http://a/> .', '# not a comment', 'closing } brace { open', '] [ ) (', '""" triple """', "''' single '''",
  '{"@id": "http://x/", "@value": "y"}', 'jsonld @value @type @graph', '\u{2028}\u{2029}\u{85} line separators', '\u{a0} no-break', '\u{feff}BOM', '\u{200b} zero width',
  '\u{e9} \u{fc} \u{f1} \u{65e5}\u{672c}\u{8a9e} \u{d55c}\u{ad6d}\u{c5b4} \u{627}\u{644}\u{639}\u{631}\u{628}\u{64a}\u{629}', 'emoji \u{1F600}\u{1F4A9} pair', 'U+FFFF \u{ffff} and \u{fffe}',
  'lone high \uD800 here', 'lone low \uDC00 here', 'two highs \uD800\uD800', 'low then high \uDC00\uD800',
  'a'.repeat(5000),
];

describe('the nasty values round-trip in every format', () => {
  for (const format of FORMATS) {
    it(`${format}: ${NASTY.length} strings as plain and as typed literals come back as the same triples`, async () => {
      const subject = `${E}s`;
      const batches = [{ quads: NASTY.flatMap((v, i) => [
        q(subject, `${E}plain`, lit(v)),
        q(`${E}s${i}`, `${E}typed`, lit(v, `${E}custom`)),
      ]) }];
      const text = await write(format, batches);
      const back = parsedSet(await readBack(format, text));
      const expected = modelSet(batches);
      assert.deepEqual([...back].sort(), [...expected].sort());
    });
    it(`${format}: a nasty-but-legal IRI, in a graph label too, comes back unchanged`, async () => {
      if (format === 'turtle') return; // Turtle holds no graph; its IRIs are read in the record test below
      const legal = `${E}a%20b/%3C%3E%22/c?x=1&y=%23#f`;
      const batches = [{ graph: `${E}g%20h`, quads: [q(legal, `${E}p`, legal), q(`${E}s`, legal, lit('x'))] }];
      const back = parsedSet(await readBack(format, await write(format, batches)));
      assert.deepEqual([...back].sort(), [...modelSet(batches)].sort());
    });
  }
  it('a lone surrogate is counted by the writer, and only the lone ones', async () => {
    const w = ser.createRdfWriter('nquads', { prefixes: PREFIXES() });
    w.write({ quads: [q(`${E}s`, `${E}p`, lit('a\uD800b\uDC00c\u{1F600}d\uD800\uD800'))] });
    assert.equal(w.replacedCharacters, 4);
  });
});

describe('a space export of every record kind is read back as the same triples', () => {
  const BASE = 'https://ythril.example.org/ld/space-1/';
  const META = {
    rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 },
    typeSchemas: { entity: { person: { propertySchemas: { age: { type: 'number' }, born: { type: 'date' } } } }, edge: { knows: { propertySchemas: { since: { type: 'date' } } } } },
  };
  const SHARED = { author: { instanceId: 'inst "1"', instanceLabel: 'Home <main> & "co"' }, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00.5+01:00' };
  const DOCS = [
    ['entity', { _id: 'a b>c', name: 'Ada "the" Countess\n of Lovelace', type: 'person', tags: ['m', 'x"y'], description: 'line1\nline2 \\ <b>', superseded: true, schemaFingerprint: 'fp1', properties: { age: 36, born: '1815-12-10', note: 'ok', 'odd key "#"': 'v' }, ...SHARED }],
    ['entity', { _id: 'u', name: 'Untyped', tags: [], ...SHARED }],
    ['fact', { _id: 'f1', fact: 'A fact with a "quote".', type: 'note', tags: ['t'], properties: { n: 1.5 }, ...SHARED }],
    ['chrono', { _id: 'c1', title: 'Launch', type: 'event', startsAt: '2026-03-01T09:00:00Z', endsAt: '2026-03-01T17:30:00', status: 'upcoming', confidence: 0.75, tags: [], recurrence: { freq: 'weekly', interval: 2, until: '2026-12-31' }, ...SHARED }],
    ['chrono', { _id: 'c2', title: 'Due', type: 'deadline', startsAt: '2026-04-05', status: 'active', tags: [], contentRedacted: true, ...SHARED }],
    ['edge', { _id: 'k1', from: 'a b>c', to: 'u', label: 'knows', type: 'friend', weight: 0.5, tags: ['t'], description: 'd', properties: { since: '2001-09-01', stray: [1] }, ...SHARED }],
    ['edge', { _id: 'k2', from: 'f1', fromKind: 'fact', to: 'docs/a b.pdf', toKind: 'file', label: 'cites', tags: [], ...SHARED }],
    ['link', { _id: 'l1', from: 'f1', fromKind: 'fact', to: 'u', toKind: 'entity', ...SHARED }],
    ['file', { _id: 'docs/a b.pdf', path: 'docs/a b.pdf', description: 'A scan.', tags: ['scan'], sizeBytes: 1024, sha256: 'ab'.repeat(32), properties: { pages: 4 }, createdAt: SHARED.createdAt, updatedAt: SHARED.updatedAt }],
  ];
  for (const format of FORMATS) {
    it(`${format}: the quads of every kind (${format === 'jsonld' ? 'classic reification' : 'RDF 1.2 reifiers'}) are the triples a parser reads`, async () => {
      assert.equal(typeof mapper.recordTriples, 'function', 'recordTriples is not exported by server/src/rdf/record-triples.ts');
      const agentsSeen = new Set();
      const edgeDetails = format === 'jsonld' ? 'reification' : 'rdf12';
      const batches = DOCS.map(([kind, doc]) => ({ graph: format === 'turtle' ? undefined : BASE, quads: mapper.recordTriples(META, kind, doc, { edgeDetails, agentsSeen }).quads }));
      assert.ok(batches.reduce((n, b) => n + b.quads.length, 0) > 60, 'a real export');
      const text = await write(format, batches, edgeDetails);
      const back = parsedSet(await readBack(format, text));
      const expected = modelSet(batches);
      assert.deepEqual([...back].sort(), [...expected].sort());
    });
  }
});

describe('collections and blank nodes keep their structure', () => {
  const batch = { quads: [
    q(`${E}s`, `${E}p`, { kind: 'list', items: [lit('a'), iri(`${E}b`), lit('1', `${XSD}decimal`)] }),
    q(`${E}s`, `${E}empty`, { kind: 'list', items: [] }),
    q({ kind: 'blank', id: 'n' }, `${RDF}type`, `${E}Node`),
    q(`${E}s`, `${E}has`, { kind: 'blank', id: 'n' }),
  ] };
  for (const format of FORMATS) {
    it(`${format}: the list is an rdf:first/rdf:rest chain, the blank node is one node used twice`, async () => {
      const quads = await readBack(format, await write(format, [batch]));
      const one = (s, p) => {
        const found = quads.filter((x) => x.subject.value === s && x.predicate.value === p);
        assert.equal(found.length, 1, `${s} ${p}`);
        return found[0].object;
      };
      const items = [];
      let node = one(`${E}s`, `${E}p`);
      while (node.value !== `${RDF}nil`) { items.push(one(node.value, `${RDF}first`)); node = one(node.value, `${RDF}rest`); }
      assert.deepEqual(items.map(fromN3), [`"a"^^<${XSD}string>`, `<${E}b>`, `"1"^^<${XSD}decimal>`]);
      assert.equal(one(`${E}s`, `${E}empty`).value, `${RDF}nil`);
      const blankNode = one(`${E}s`, `${E}has`);
      assert.equal(blankNode.termType, 'BlankNode');
      assert.equal(quads.filter((x) => x.subject.value === blankNode.value && x.predicate.value === `${RDF}type`).length, 1);
    });
  }
});
