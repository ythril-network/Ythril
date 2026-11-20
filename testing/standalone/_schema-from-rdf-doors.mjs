/**
 * How the tests of the schema reader (`server/src/rdf/schema-from-rdf.ts`, bundle-270 slice S8) hand it a file and read its answer.
 *
 * ## The contract it encodes, written before the reader
 *
 * `schemaFromRdf(quads, { from, mode, names, stored? })` takes the quads of an RDF file (an array of the model's `Quad`s: what `parseRdf` yields
 * and what `schemaGraph` writes), which declarations to read (`from`: `declared` for OWL and RDFS classes and properties, `shacl` for shapes,
 * both allowed), how the answer meets the schema the space already has (`mode`: `generate`, `expand`, `update`), the space's reverse names
 * (`addressNames(meta, source?)`) and, for `expand` and `update`, the stored type schemas. It answers
 * `{ typeSchemas, taken, notTaken, changes, refusals, counts }` and never throws for what a file says.
 *
 * What the helpers decide once: the fixture space is the schema export's own (`_schema-export-fixture.mjs`), so the round trip reads exactly
 * what the forward mapping writes; a quad of a mini graph is spelled in one place; a case asks for the reader inside its own body, so it
 * fails on its own rule when the module is missing and not at import.
 */
import assert from 'node:assert/strict';
import { META, FP, BASE, VOCAB, NS, iriOf } from './_schema-export-fixture.mjs';

export { META, FP, BASE, VOCAB, NS, iriOf };

export const mod = await import('../../server/dist/rdf/schema-from-rdf.js').catch(() => ({}));
export const reverse = await import('../../server/dist/rdf/term-reverse.js').catch(() => ({}));
export const forward = await import('../../server/dist/rdf/schema-owl-shacl.js').catch(() => ({}));
export const serialize = await import('../../server/dist/rdf/serialize.js').catch(() => ({}));
export const parse = await import('../../server/dist/rdf/parse.js').catch(() => ({}));

/** The reader, asked inside a case. */
export function reader() {
  assert.equal(typeof mod.schemaFromRdf, 'function', 'schemaFromRdf is not exported by server/src/rdf/schema-from-rdf.ts: a schema file cannot be read');
  return mod.schemaFromRdf;
}

/** The reverse names of the fixture space (and of a source space when given). */
export function namesOf(meta = META, source) {
  assert.equal(typeof reverse.addressNames, 'function', 'addressNames is not exported by server/src/rdf/term-reverse.ts');
  return reverse.addressNames(meta, source);
}

/** The answer for `quads`, with the fixture space's names and a whole build from shapes unless said otherwise. */
export function read(quads, options = {}) {
  const { meta, source, ...rest } = options;
  return reader()(quads, { from: ['shacl'], mode: 'generate', names: namesOf(meta, source), ...rest });
}

/** The quads the forward mapping writes for `meta`. */
export function exported(meta = META) {
  assert.equal(typeof forward.schemaGraph, 'function', 'schemaGraph is not exported by server/src/rdf/schema-owl-shacl.ts');
  return forward.schemaGraph(meta, FP).quads;
}

/** The export of `meta`, written in `format` and read back by the import parser: the quads a user's file would give. */
export async function throughText(meta, format) {
  assert.equal(typeof serialize.createRdfWriter, 'function', 'createRdfWriter is not exported by server/src/rdf/serialize.ts');
  assert.equal(typeof parse.parseRdf, 'function', 'parseRdf is not exported by server/src/rdf/parse.ts');
  const graph = forward.schemaGraph(meta, FP);
  const writer = serialize.createRdfWriter(format, { prefixes: graph.prefixes });
  const text = writer.open() + writer.write({ quads: graph.quads }) + writer.close();
  const quads = [];
  for await (const q of parse.parseRdf([text], format)) quads.push(q);
  return quads;
}

// -- a quad, spelled once ------------------------------------------------------------------------------------------------------------------
export const I = (value) => ({ kind: 'iri', value });
export const N = (id) => ({ kind: 'blank', id });
export const LIT = (value, datatype) => (datatype === undefined ? { kind: 'literal', value } : { kind: 'literal', value, datatype });
export const LANG = (value, language) => ({ kind: 'literal', value, language });
export const LIST = (...items) => ({ kind: 'list', items });
export const DEC = (n) => LIT(String(n), iriOf('xsd:decimal'));
export const INT = (n) => LIT(String(n), iriOf('xsd:integer'));
export const BOOL = (b) => LIT(String(b), iriOf('xsd:boolean'));
/** A quad of the model from prefixed names (`sh:minCount`) or full addresses, an object that is a string being an IRI. */
export const Q = (s, p, o) => ({
  subject: typeof s === 'string' ? I(s.includes('://') ? s : iriOf(s)) : s,
  predicate: I(p.includes('://') ? p : iriOf(p)),
  object: typeof o === 'string' ? I(o.includes('://') ? o : iriOf(o)) : o,
});
export const EX = 'http://example.org/onto#';
export const ex = (local) => `${EX}${local}`;

/** The taken entries of an answer that set `field` of the type or property named by `where`. */
export const takenFor = (answer, field) => answer.taken.filter(t => t.field === field);
/** The not-taken entries of an answer that name `constraint` (`sh:minExclusive`). */
export const notTakenFor = (answer, constraint) => answer.notTaken.filter(n => n.constraint === constraint);
