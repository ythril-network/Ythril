/**
 * Every output in the RDF 1.2 edge form announces its version; an output in the classic reification form carries no label (Q-750, bundle-269
 * slice S; owner, 2026-11-19, standards review row 1, option a).
 *
 * ## The defect this prevents
 *
 * RDF 1.2 stays the default edge form (`rdf:reifies` of a triple term), but a Turtle 1.1 parser fails on `<<(` with no hint why. RDF 1.2
 * Concepts asks a producer to announce the version: RDF 1.2 Turtle (and TriG) define the directive `VERSION "1.2"` (production
 * `sparqlVersion ::= "VERSION" VersionSpecifier`, case-insensitive, "early in the document"), RDF 1.2 N-Quads defines `VERSION "1.2"` too
 * (`versionDirective ::= 'VERSION' versionSpecifier`, case-sensitive, double quotes only), and each media type takes a `version` parameter
 * (`text/turtle; version=1.2`). So:
 *
 * - `rdfVersionOf(format, edgeDetails)` is the label as data, `'1.2'` for Turtle, TriG and N-Quads in the RDF 1.2 form and `undefined`
 *   otherwise (JSON-LD 1.1 has no triple term and no label); the door puts it on the Content-Type (slice D);
 * - a writer opened with `edgeDetails: 'rdf12'` writes `VERSION "1.2"` as its first line and says so in `writer.version`;
 * - the guard is inside: a triple term handed to a writer that was not opened in the RDF 1.2 form is refused, so no caller can write an
 *   unlabelled RDF 1.2 document by forgetting the option;
 * - `n3` (offline) reads the labelled documents back, triple terms included.
 *
 * Run: node --test testing/standalone/an-rdf-1-2-output-announces-its-version.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'n3';

const ser = await import('../../server/dist/rdf/serialize.js').catch(() => ({}));
const mapper = await import('../../server/dist/rdf/record-triples.js').catch(() => ({}));

const TEXT = ['turtle', 'trig', 'nquads'];
const N3_FORMAT = { turtle: 'Turtle', trig: 'TriG', nquads: 'N-Quads' };
const BASE = 'https://ythril.example.org/ld/s/';
const META = { rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 }, typeSchemas: { edge: { knows: { propertySchemas: { since: { type: 'date' } } } } } };
const EDGE = { _id: 'k1', from: 'a', to: 'b', label: 'knows', tags: [], properties: { since: '2001-09-01' } };
const fn = (name) => {
  assert.equal(typeof ser[name], 'function', `${name} is not exported by server/src/rdf/serialize.ts`);
  return ser[name];
};

async function documentOf(format, edgeDetails) {
  const { quads } = mapper.recordTriples(META, 'edge', EDGE, { edgeDetails });
  let out = '';
  for await (const chunk of fn('serializeRdf')(format, [{ graph: format === 'turtle' ? undefined : BASE, quads }], { edgeDetails })) out += chunk;
  return out;
}

describe('the version label is data the door can put on the Content-Type', () => {
  for (const format of TEXT) {
    it(`${format}: 1.2 in the RDF 1.2 form, nothing in the reification form`, () => {
      assert.equal(fn('rdfVersionOf')(format, 'rdf12'), '1.2');
      assert.equal(fn('rdfVersionOf')(format, 'reification'), undefined);
    });
  }
  it('JSON-LD carries no label: JSON-LD 1.1 has no triple term', () => {
    assert.equal(fn('rdfVersionOf')('jsonld', 'rdf12'), undefined);
    assert.equal(fn('rdfVersionOf')('jsonld', 'reification'), undefined);
  });
});

describe('an RDF 1.2 document announces its version first', () => {
  for (const format of TEXT) {
    it(`${format}: VERSION "1.2" is the first line, the writer says so, and n3 reads the document with its triple term`, async () => {
      const w = fn('createRdfWriter')(format, { edgeDetails: 'rdf12', prefixes: { rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' } });
      assert.equal(w.version, '1.2');
      assert.ok(w.open().startsWith('VERSION "1.2"\n'), `${format} opens with the version directive`);
      const text = await documentOf(format, 'rdf12');
      assert.equal(text.split('\n')[0], 'VERSION "1.2"');
      const quads = new Parser({ format: N3_FORMAT[format] }).parse(text);
      assert.ok(quads.some(q => q.object.termType === 'Quad'), 'the triple term is read back');
    });
    it(`${format}: the reification form carries no label`, async () => {
      const w = fn('createRdfWriter')(format, { edgeDetails: 'reification' });
      assert.equal(w.version, undefined);
      const text = await documentOf(format, 'reification');
      assert.ok(!/VERSION/.test(text), 'no version directive');
      assert.ok(new Parser({ format: N3_FORMAT[format] }).parse(text).length > 0);
    });
  }
  it('the guard is inside: a triple term in a document not opened in the RDF 1.2 form is refused, never written unlabelled', () => {
    const { quads } = mapper.recordTriples(META, 'edge', EDGE, { edgeDetails: 'rdf12' });
    for (const format of TEXT) {
      const w = fn('createRdfWriter')(format, {});
      w.open();
      assert.throws(() => w.write({ graph: format === 'turtle' ? undefined : BASE, quads }), (err) => err?.code === 'rdf_unwritable', format);
    }
  });
});
