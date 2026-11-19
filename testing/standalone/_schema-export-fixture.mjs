/**
 * What the tests of the schema export (`server/src/rdf/schema-owl-shacl.ts`, Q-751) share: one fixture space, the way to read a graph of
 * quads as a tree, and the builders of what a tree is expected to be.
 *
 * ## The question it answers
 *
 * *"What does the export say about this resource?"* A graph is a flat list of quads, and an assertion over a flat list is either a hand-written
 * search per statement or a count. Here `treeOf(quads, term)` reads one resource as a nested object (each predicate, compact, with its objects
 * sorted; a blank node read through; a list kept in order), so a test states the WHOLE form of a shape or an axiom in one `deepEqual` and a
 * statement the form does not name (an extra, a missing one) fails it.
 *
 * ## What it prevents
 *
 * Two test files (`a-schema-exports-as-owl-and-shacl.test.js`, `the-exported-shapes-validate-what-the-export-writes.test.js`) built their own
 * fixture space and drifted: one asserted a form the other's fixture never produced. One fixture, one reader.
 */
import * as vocab from '../../server/dist/rdf/ythril-vocabulary.js';

export const BASE = 'https://ythril.example.org/ld/space-1/';
export const VOCAB = `${BASE}vocab/`;
export const FP = 'ab12'.repeat(16);
export const ONTOLOGY = `${BASE}schema`;

export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  sh: 'http://www.w3.org/ns/shacl#',
  schema: 'https://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  ythril: vocab.YTHRIL_NS,
  vocab: VOCAB,
  base: BASE,
};

/** A prefixed name as the full address: `iriOf('sh:name')`. */
export function iriOf(name) {
  const at = name.indexOf(':');
  const ns = NS[name.slice(0, at)];
  if (ns === undefined) throw new Error(`no prefix in ${name}`);
  return `${ns}${name.slice(at + 1)}`;
}

// -- reading a graph --------------------------------------------------------------------------------------------------------------------
const PREFIX_ORDER = ['vocab', 'base', 'rdf', 'rdfs', 'xsd', 'owl', 'sh', 'schema', 'dcterms', 'ythril'];
/** An address as its short name (`sh:name`, `vocab:entity/person`), or itself when no prefix of the fixture is its start. */
export const short = (value) => {
  for (const p of PREFIX_ORDER) if (value.startsWith(NS[p])) return `${p}:${value.slice(NS[p].length)}`;
  return value;
};

// -- the shapes an expected tree is built from ------------------------------------------------------------------------------------------
/** An IRI as the tree writes it: a prefixed name stays, a full address is shortened the way a graph's is. */
export const I = (name) => `<${name.includes('://') ? short(name) : name}>`;
export const L = (value) => `"${value}"`;
export const T = (value, datatype) => `"${value}"^^${datatype}`;
export const DEC = (n) => T(String(n), 'xsd:decimal');
export const INT = (n) => T(String(n), 'xsd:integer');
export const BOOL = (b) => T(String(b), 'xsd:boolean');
export const LIST = (...items) => ({ list: items });

const sortKey = (x) => JSON.stringify(x);
/** Sets (arrays) in canonical order, a list (`{ list }`) in the order it was written: so expected and actual compare as the graph means it. */
export function norm(x) {
  if (Array.isArray(x)) return x.map(norm).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  if (x !== null && typeof x === 'object') {
    if ('list' in x) return { list: x.list.map(norm) };
    return Object.fromEntries(Object.keys(x).sort().map(k => [k, norm(x[k])]));
  }
  return x;
}

/** A term as its short text: `<sh:name>`, `"text"`, `"3"^^xsd:decimal`. A blank node and a list are read by `treeOf`. */
export function textOf(term) {
  if (term.kind === 'iri') return `<${short(term.value)}>`;
  if (term.kind === 'literal') return term.datatype === undefined ? `"${term.value}"` : `"${term.value}"^^${short(term.datatype)}`;
  throw new Error(`no text for ${term.kind}`);
}

const sameTerm = (a, b) => a.kind === b.kind && (a.kind === 'blank' ? a.id === b.id : a.value === b.value);

/** The resource `subject` (a term) as a tree: predicate (short) to its objects; a blank object is read through, a list is `{ list }`. */
export function treeOf(quads, subject) {
  const read = (term) => {
    if (term.kind === 'blank') return treeOf(quads, term);
    if (term.kind === 'list') return { list: term.items.map(read) };
    return textOf(term);
  };
  const out = {};
  for (const q of quads) {
    if (!sameTerm(q.subject, subject)) continue;
    const key = short(q.predicate.value);
    (out[key] ??= []).push(read(q.object));
  }
  return norm(out);
}

/** The tree of the resource at `value`. */
export const treeAt = (quads, value) => treeOf(quads, { kind: 'iri', value });

/** The terms that are the objects of `subject predicate`, in the graph. */
export const objectsOf = (quads, subject, predicate) => quads
  .filter(q => q.subject.kind === 'iri' && q.subject.value === subject && q.predicate.value === predicate).map(q => q.object);

/** Every IRI that is the subject of a statement. */
export const subjectsOf = (quads) => [...new Set(quads.filter(q => q.subject.kind === 'iri').map(q => q.subject.value))];

// -- the shape addresses of the design (§6) ----------------------------------------------------------------------------------------------
const seg = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** A node shape `<base>schema/shape/<kind>/<seg(type)>`, a property shape that plus `#<frag(prop)>` (the fixture's names need no encoding beyond `seg`). */
export const shapeAt = (kind, type, prop) => `${BASE}schema/shape/${kind}/${seg(type)}${prop === undefined ? '' : `#${seg(prop)}`}`;
/** The address a type or property has when the space's vocab names it: the type's document, the property a fragment of it. */
export const termAt = (kind, type, prop) => `${VOCAB}${kind}/${seg(type)}${prop === undefined ? '' : `#${seg(prop)}`}`;

/** The fixture space: every kind of type, every property field, an outside type and property, and an explicit address. */
export const META = {
  purpose: 'A space of people and what they know',
  validationMode: 'warn',
  rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 },
  typeSchemas: {
    entity: {
      person: {
        description: 'A person we know',
        namingPattern: '^[A-Z]',
        propertySchemas: {
          name: { type: 'string', required: true, pattern: '^[A-Za-z ]+$', description: 'The full name' },
          age: { type: 'number', minimum: 0, maximum: 150, description: 'Age in years' },
          status: { type: 'string', enum: ['active', 'retired'], default: 'active' },
          level: { type: 'number', enum: [1, 2, 3] },
          born: { type: 'date' },
          active: { type: 'boolean', default: true },
          score: { type: 'number', mergeFn: 'avg' },
          email: { type: 'string', iri: 'https://schema.org/email', description: 'Mail address' },
          loose: { minimum: 5 },
          code: { pattern: '^A' },
        },
      },
      contact: { iri: 'https://schema.org/Person', description: 'Someone to contact' },
      robot: {},
    },
    fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
    chrono: {
      meeting: {
        whenDuePasses: 'nothing',
        retention: { days: 30, contentDays: 7 },
        propertySchemas: { room: { type: 'string', required: true } },
      },
    },
    edge: {
      knows: {
        description: 'One person knows another',
        endpoints: { from: ['person'], to: ['person', 'UNTYPED'] },
        propertySchemas: {
          since: { type: 'date' },
          strength: { type: 'number', minimum: 0, maximum: 1, required: true },
        },
      },
      reports_to: { functional: true },
    },
  },
};
