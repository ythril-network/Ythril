/**
 * What the tests of the RDF import's translator share (bundle-270, slice S3, Q-752): the built modules, the grouping of a document's quads
 * by subject and graph, the context a translation is asked in, and the accounting every answer must hold.
 *
 * ## What it prevents
 *
 * Three test files ask the translator (`server/src/rdf/quads-to-ops.ts`) the same way: group the forward mapping's quads, build the
 * asserted and reified triplet sets, hand in what is stored and what was minted. Three copies of that would drift, and a copy that grouped
 * a chrono's time nodes apart from their record would test another contract than the one the import runs. The grouping and the triplet
 * sets come from the translator's own exports (`groupSubjectOf`, `tripletsOfGroup`), as the import's spool will take them.
 *
 * The modules are the built ones (`server/dist`); a missing build or a missing export fails the caller's assertion, naming what is missing.
 */
import assert from 'node:assert/strict';

export const translator = await import('../../server/dist/rdf/quads-to-ops.js').catch(() => ({}));
export const reasons = await import('../../server/dist/rdf/import-reasons.js').catch(() => ({}));
export const reverse = await import('../../server/dist/rdf/term-reverse.js');
export const mapper = await import('../../server/dist/rdf/record-triples.js');

/** An export of the translator, or a failure that names it. */
export function fn(name) {
  assert.equal(typeof translator[name], 'function', `${name} is not exported by server/src/rdf/quads-to-ops.ts: quads cannot be translated into record operations`);
  return translator[name];
}

/** The reason table, or a failure that names it. */
export function reasonTable() {
  assert.equal(typeof reasons.IMPORT_REASONS, 'object', 'IMPORT_REASONS is not exported by server/src/rdf/import-reasons.ts: an import has no table of reasons');
  return reasons.IMPORT_REASONS;
}

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SCHEMA_ORG = 'http://schema.org/';
export const iri = (value) => ({ kind: 'iri', value });
export const blank = (id) => ({ kind: 'blank', id });
export const lit = (value, datatype) => (datatype === undefined ? { kind: 'literal', value } : { kind: 'literal', value, datatype });
export const tagged = (value, language) => ({ kind: 'literal', value, language });
export const q = (s, p, o, g) => ({
  subject: typeof s === 'string' ? iri(s) : s, predicate: iri(p), object: typeof o === 'string' ? iri(o) : o, ...(g ? { graph: iri(g) } : {}),
});

/** The quads of `docs` (`[kind, doc]`) as the forward mapping writes them, in `edgeDetails` form, each in `graph` when one is given. */
export function forwardQuads(meta, docs, edgeDetails, graph) {
  const agentsSeen = new Set();
  const quads = [];
  const skipped = [];
  for (const [kind, doc] of docs) {
    const out = mapper.recordTriples(meta, kind, doc, { edgeDetails, agentsSeen });
    skipped.push(...out.counts.skippedValues);
    for (const quad of out.quads) quads.push(graph === undefined ? quad : { ...quad, graph: iri(graph) });
  }
  return { quads, skipped };
}

/** The quads grouped as the import groups them: by graph, then by the subject the translator says a quad belongs to. */
export function groupsOf(quads, names) {
  const groupSubjectOf = fn('groupSubjectOf');
  const groups = new Map();
  for (const quad of quads) {
    const key = JSON.stringify([quad.graph?.value ?? null, groupSubjectOf(quad.subject, names)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(quad);
  }
  return [...groups.values()];
}

/**
 * The context of one translation over a whole document: its names, mode and blank-node rule, what is stored and minted, and the triplets the
 * document asserts and reifies, collected from every group by the translator's own `tripletsOfGroup`.
 */
export function contextFor({ meta, names, quads, mode = 'strict', blankNodes = 'refuse', stored = new Map(), minted = new Map() }) {
  const tripletsOfGroup = fn('tripletsOfGroup');
  const asserted = new Set();
  const reified = new Set();
  for (const group of groupsOf(quads, names)) {
    const t = tripletsOfGroup(group);
    t.asserted.forEach(k => asserted.add(k));
    t.reified.forEach(k => reified.add(k));
  }
  return { meta, names, mode, blankNodes, stored, minted, asserted, reified };
}

/** Every quad of the group is in exactly one place: taken into an operation, left out on purpose, or answered by a reason. */
export function assertAccounted(group, out, what) {
  const inReasons = out.reasons.reduce((n, r) => n + r.quads.length, 0);
  assert.equal(typeof out.taken, 'number', `${what}: the answer says how many quads it took`);
  assert.equal(out.taken + out.notTaken.length + inReasons, group.length,
    `${what}: ${out.taken} taken + ${out.notTaken.length} not taken + ${inReasons} in reasons must be the group's ${group.length} quads`);
}
