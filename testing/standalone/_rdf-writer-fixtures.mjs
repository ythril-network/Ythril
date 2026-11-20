/**
 * What the RDF writers are given and what they write, shared by the tests that read the writers' output back with a parser
 * (`the-rdf-writers-are-read-by-n3.test.js`, `the-rdf-writers-are-read-by-the-import-parser.test.js`).
 *
 * ## What it prevents
 *
 * The table of nasty strings, the fixture of every record kind and the call that writes a document were typed out in the first file; a second
 * reader of the same output needed all three. Two copies would drift: a string added to one table is a string the other reader never meets.
 * One copy here, so every reader of the writers' output reads the same documents.
 *
 * The writers and the mapper are the built ones (`server/dist`); a missing build leaves the exports empty and the caller's own assertion names
 * what is missing.
 */
import assert from 'node:assert/strict';

export const ser = await import('../../server/dist/rdf/serialize.js').catch(() => ({}));
export const mapper = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));
export const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const E = 'http://ex.org/';
export const iri = (value) => ({ kind: 'iri', value });
export const lit = (value, datatype) => (datatype === undefined ? { kind: 'literal', value } : { kind: 'literal', value, datatype });
export const q = (s, p, o, g) => ({ subject: typeof s === 'string' ? iri(s) : s, predicate: iri(p), object: typeof o === 'string' ? iri(o) : o, ...(g ? { graph: iri(g) } : {}) });
export const PREFIXES = () => ({ rdf: RDF, rdfs: 'http://www.w3.org/2000/01/rdf-schema#', xsd: XSD, schema: 'http://schema.org/', time: 'http://www.w3.org/2006/time#', dcterms: 'http://purl.org/dc/terms/', prov: 'http://www.w3.org/ns/prov#', ythril: vocab.YTHRIL_NS });

export const FORMATS = ['turtle', 'trig', 'nquads', 'jsonld'];

/** The document the writer writes for `batches` in `format`. */
export async function write(format, batches, edgeDetails = 'reification') {
  assert.equal(typeof ser.serializeRdf, 'function', 'serializeRdf is not exported by server/src/rdf/serialize.ts: there is no writer');
  let out = '';
  for await (const chunk of ser.serializeRdf(format, batches, { prefixes: PREFIXES(), edgeDetails })) out += chunk;
  return out;
}

/** One table of nasty values: quotes, backslashes, newlines, control characters, lone surrogates, text that looks like syntax. */
export const NASTY = [
  'plain', '', ' leading and trailing ', 'a "quote" b', '"', '\\', 'back\\slash', 'trailing backslash\\', '\\n is not a newline', '\\u0041 is not an A',
  'line1\nline2', 'cr\rlf', 'crlf\r\nend', 'tab\there', '\n', '\r', 'ctrl\u0001\u0002\u0007\u0008\u000b\u000c\u001b\u001f\u007f', 'nul\u0000x',
  '<tag a="b">&amp;</tag>', '1 < 2 > 0', '<http://evil.example/> <http://x/p> "y" .', '>', '<', '"@en', 'x"@en', '"x"@en', '@en', 'x@en-GB',
  `x"^^<${XSD}decimal>`, '"x"^^xsd:decimal', '@prefix a: <http://a/> .', '# not a comment', 'closing } brace { open', '] [ ) (', '""" triple """', "''' single '''",
  '{"@id": "http://x/", "@value": "y"}', 'jsonld @value @type @graph', '\u{2028}\u{2029}\u{85} line separators', '\u{a0} no-break', '\u{feff}BOM', '\u{200b} zero width',
  '\u{e9} \u{fc} \u{f1} \u{65e5}\u{672c}\u{8a9e} \u{d55c}\u{ad6d}\u{c5b4} \u{627}\u{644}\u{639}\u{631}\u{628}\u{64a}\u{629}', 'emoji \u{1F600}\u{1F4A9} pair', 'U+FFFF \u{ffff} and \u{fffe}',
  'lone high \uD800 here', 'lone low \uDC00 here', 'two highs \uD800\uD800', 'low then high \uDC00\uD800',
  'a'.repeat(5000),
];

/** The graph and the space meta of the record fixture. */
export const BASE = 'https://ythril.example.org/ld/space-1/';
export const META = {
  rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 },
  typeSchemas: { entity: { person: { propertySchemas: { age: { type: 'number' }, born: { type: 'date' } } } }, edge: { knows: { propertySchemas: { since: { type: 'date' } } } } },
};
const SHARED = { author: { instanceId: 'inst "1"', instanceLabel: 'Home <main> & "co"' }, createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-02T10:00:00.5+01:00' };
/** A stored record of every kind, as `[kind, document]`. */
export const DOCS = [
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

/** The record fixture as the writer's batches for `format`, in the data graph (Turtle holds none). */
export function recordBatches(format, edgeDetails) {
  assert.equal(typeof mapper.recordTriples, 'function', 'recordTriples is not exported by server/src/rdf/record-triples.ts');
  const agentsSeen = new Set();
  return DOCS.map(([kind, doc]) => ({ graph: format === 'turtle' ? undefined : BASE, quads: mapper.recordTriples(META, kind, doc, { edgeDetails, agentsSeen }).quads }));
}
