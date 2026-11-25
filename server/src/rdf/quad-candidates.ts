/**
 * Which finds can produce the statements of one quad pattern in one member space: the planner of the quad source (bundle-271, Q-756;
 * design §0, §1.1, r2 R4.3). Pure: no store call, no mapping.
 *
 * ## Correct by construction, narrowed for speed
 *
 * The walk, every kind of the member read in `_id` order, answers every pattern; it is what {@link quadCandidates} answers with narrowing
 * off and for any pattern no rule below claims. Each rule only narrows the walk and must answer exactly what the walk would: the completeness
 * test (`a-quad-pattern-answers-the-export-db`) holds every rule to the export over all 16 bound/unbound combinations, so a rule that drops a
 * statement fails the build, and a rule that is missing only costs reads.
 *
 * ## The rules, by the first bound term (subject, else predicate, else object)
 *
 * - **Subject.** A record address reads that record, plus the edges and links whose start it is (an edge statement and a link statement have
 *   the record as subject); an edge address reads that edge; a chrono time node (`#start`, `#end`) reads its chrono entry; an agent walks the
 *   knowledge kinds (an agent's statements ride with any record it wrote); anything else under the base, or under no base, has no
 *   statements.
 * - **Predicate.** A term of the space (`termOfIri`: its schema or its vocabulary) reads its owners: a property its type (`{type}`, an edge
 *   property its label), an edge label its edges (with the ends a bound subject or object gives). A term the mapper writes on its own account
 *   walks the kinds the mapper table names (`RDF_MAPPER_PREDICATE_KINDS`), with `rdf:type`, `schema:keywords`, `dcterms:references` and
 *   `rdf:reifies` narrowed by their object. An address under a vocabulary that the reverse rule refuses walks (the forward rule may still
 *   write it); a foreign address no schema declares has no statements.
 * - **Object.** A record address reads the edges and links that end there; a time node its chrono entry; an agent or a schema version walks
 *   the knowledge kinds; a class reads the rows of that type; a triple term the edges of its label and ends; a literal walks.
 * - **Graph.** A bound graph that is not the member's graph reads nothing of the member.
 *
 * Two rules never narrow and are named here so nobody adds them by mistake: `rdfs:label` with a literal also matches an agent's label, which
 * every knowledge kind writes from an unindexed field (`author.instanceLabel`), so it walks; and an agent subject walks for the same reason.
 */
import type { SpaceMeta } from '@ythril-network/schema';
import { RDF_MAPPER_CLASS_KINDS, RDF_MAPPER_PREDICATE_KINDS, type RdfRecordKind } from './record-triples.js';
import { recordOfAddress, termOfIri, addressNames, type AddressNames } from './term-reverse.js';
import { edgeClassIri, graphIri, namesOf, type TermOwner } from './term-iri.js';
import { STANDARD_PREFIXES } from './ythril-vocabulary.js';

/** Every kind a member's statements come from, in walk order. */
export const QUAD_KINDS: readonly RdfRecordKind[] = Object.freeze(['entity', 'fact', 'chrono', 'edge', 'link', 'file']);
/** The kinds that carry an author, so an agent's statements. */
const KNOWLEDGE_KINDS: readonly RdfRecordKind[] = Object.freeze(['entity', 'fact', 'chrono', 'edge']);

const RDF = STANDARD_PREFIXES['rdf']!;
const RDF_TYPE = `${RDF}type`;
const RDF_REIFIES = `${RDF}reifies`;
const SCHEMA_KEYWORDS = `${STANDARD_PREFIXES['schema']!}keywords`;
const DCTERMS_REFERENCES = `${STANDARD_PREFIXES['dcterms']!}references`;

/** A term of a pattern as RDF/JS gives it; `undefined`, `null` and a `Variable` are unbound. */
export interface PatternTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
  subject?: PatternTerm;
  predicate?: PatternTerm;
  object?: PatternTerm;
  graph?: PatternTerm;
}
export type PatternSlot = PatternTerm | undefined | null;
/** Subject, predicate, object, graph. */
export type QuadPattern = readonly [PatternSlot, PatternSlot, PatternSlot, PatternSlot];

/** One find: the rows of `kind` matching `filter`, or (`walk`) every row of the kind in `_id` order. */
export interface CandidateFind { kind: RdfRecordKind; filter: Readonly<Record<string, unknown>>; walk: boolean }

/** What the planner reads of a member: its resolved meta. */
export interface CandidateMember { meta: SpaceMeta }

/** Is a pattern slot bound? */
export const isBound = (t: PatternSlot): t is PatternTerm => t !== undefined && t !== null && t.termType !== 'Variable';

interface Names { names: AddressNames; graph: string; vocab: string; meta: SpaceMeta }
const namesByMeta = new WeakMap<SpaceMeta, Names>();
function namesOfMember(meta: SpaceMeta): Names {
  let n = namesByMeta.get(meta);
  if (!n) {
    n = { names: addressNames(meta), graph: graphIri(meta), vocab: namesOf(meta).vocab, meta };
    namesByMeta.set(meta, n);
  }
  return n;
}

const walk = (kinds: readonly RdfRecordKind[]): CandidateFind[] => kinds.map(kind => ({ kind, filter: {}, walk: true }));
const find = (kind: RdfRecordKind, filter: Record<string, unknown>): CandidateFind => ({ kind, filter, walk: false });

/**
 * The finds that can produce every statement of `pattern` in `member`, each kind at most once walked and no find twice. `narrow: false` is
 * the walk of every kind, whatever the pattern: the answer every rule is held to.
 */
export function quadCandidates(pattern: QuadPattern, member: CandidateMember, narrow = true): CandidateFind[] {
  if (!narrow) return walk(QUAD_KINDS);
  const n = namesOfMember(member.meta);
  const [s, p, o, g] = pattern;
  if (isBound(g) && !(g.termType === 'NamedNode' && g.value === n.graph)) return [];
  if (isBound(s)) return normalised(subjectFinds(s, p, o, n));
  if (isBound(p)) return normalised(predicateFinds(p, o, n));
  if (isBound(o)) return normalised(objectFinds(o, n));
  return walk(QUAD_KINDS);
}

/** One walk per kind that has one, else each distinct find once; in walk order. */
function normalised(finds: CandidateFind[]): CandidateFind[] {
  const out: CandidateFind[] = [];
  for (const kind of QUAD_KINDS) {
    const mine = finds.filter(f => f.kind === kind);
    if (mine.some(f => f.walk)) { out.push(...walk([kind])); continue; }
    const seen = new Set<string>();
    for (const f of mine) {
      const key = JSON.stringify(f.filter);
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
  }
  return out;
}

/** The record a bound term addresses in this member, or the other thing it names. */
function recordOf(t: PatternTerm, n: Names): ReturnType<typeof recordOfAddress> | null {
  return t.termType === 'NamedNode' ? recordOfAddress(t.value, n.names) : null;
}

/** The id of the record (not an edge) a bound term addresses, for an edge's or a link's end; null when it addresses none. */
function endId(t: PatternSlot, n: Names): string | null | undefined {
  if (!isBound(t)) return undefined;
  const r = recordOf(t, n);
  return r?.answer === 'record' && r.kind !== 'edge' ? r.id : null;
}

function subjectFinds(s: PatternTerm, _p: PatternSlot, _o: PatternSlot, n: Names): CandidateFind[] {
  const r = recordOf(s, n);
  if (r === null) return [];
  if (r.answer === 'record') {
    if (r.kind === 'edge') return [find('edge', { _id: r.id })];
    return [find(r.kind, { _id: r.id }), find('edge', { from: r.id }), find('link', { from: r.id })];
  }
  if (r.answer === 'record-part') return [find('chrono', { _id: r.id })];
  if (r.answer === 'other' && r.what === 'agent') return walk(KNOWLEDGE_KINDS);
  return [];
}

/** The finds of an edge label's statements `<from> <label> <to>`, with the ends a bound subject or object gives. */
function statementFinds(label: string, s: PatternSlot, o: PatternSlot, n: Names): CandidateFind[] {
  const from = endId(s, n);
  const to = endId(o, n);
  if (from === null || to === null) return [];
  return [find('edge', { label, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) })];
}

/** The finds of the statements of a property owner: its type's rows (an edge property its label's edges; an untyped one walks its kind). */
function propertyFinds(owner: TermOwner): CandidateFind[] {
  if (owner.kind === 'file' || owner.type === null) return walk([owner.kind]);
  if (owner.kind === 'edge') return [find('edge', { label: owner.type })];
  return [find(owner.kind, { type: owner.type })];
}

/** The label whose reifier class `address` is (`<vocab>edge/<label>`, the class even of a label with an explicit address), or null. */
function edgeClassLabel(address: string, n: Names): string | null {
  const head = `${n.vocab}edge/`;
  if (!address.startsWith(head)) return null;
  const tail = address.slice(head.length);
  if (tail === '' || /[/#?]/.test(tail)) return null;
  let label: string;
  try { label = decodeURIComponent(tail); } catch { return null; }
  return edgeClassIri(n.meta, label) === address ? label : null;
}

/** The finds of the rows typed `o` (`?s rdf:type o`, or `o` as an object). */
function classFinds(o: PatternTerm, n: Names): CandidateFind[] {
  if (o.termType !== 'NamedNode') return [];
  const out: CandidateFind[] = [];
  const row = Object.hasOwn(RDF_MAPPER_CLASS_KINDS, o.value) ? RDF_MAPPER_CLASS_KINDS[o.value]! : null;
  if (row) out.push(...walk(row));
  const label = edgeClassLabel(o.value, n);
  if (label !== null) out.push(find('edge', { label }));
  const term = termOfIri(o.value, n.names);
  if (term.answer === 'term') {
    for (const owner of term.owners.filter(w => w.prop === undefined)) {
      if (owner.type === null || owner.kind === 'file') out.push(...walk([owner.kind]));
      else out.push(find(owner.kind, owner.kind === 'edge' ? { label: owner.type } : { type: owner.type }));
    }
  } else if ((term.answer === 'refused' || term.answer === 'product') && row === null && label === null) {
    out.push(...walk(QUAD_KINDS));
  }
  return out;
}

/** The finds of `rdf:reifies <<( s p o )>>`: the edges of the label `p`, with the ends `s` and `o` give. */
function reifiesFinds(o: PatternTerm, n: Names): CandidateFind[] {
  if (o.termType !== 'Quad') return [];
  const p = o.predicate;
  if (!isBound(p)) return walk(['edge']);
  if (p.termType !== 'NamedNode') return [];
  const term = termOfIri(p.value, n.names);
  if (term.answer === 'refused') return walk(['edge']);
  if (term.answer !== 'term') return [];
  return term.owners.filter(w => w.kind === 'edge' && w.prop === undefined && w.type !== null).flatMap(w => statementFinds(w.type!, o.subject, o.object, n));
}

function predicateFinds(p: PatternTerm, o: PatternSlot, n: Names): CandidateFind[] {
  if (p.termType !== 'NamedNode') return [];
  const out: CandidateFind[] = [];
  const term = termOfIri(p.value, n.names);
  if (term.answer === 'term') {
    for (const owner of term.owners) {
      if (owner.prop !== undefined) out.push(...propertyFinds(owner));
      else if (owner.kind === 'edge' && owner.type !== null) out.push(...statementFinds(owner.type, undefined, o, n));
    }
  } else if (term.answer === 'refused') {
    // An address under a vocabulary the reverse rule does not read back (an untyped fact's property, `<vocab>fact#key`) may still be one the
    // forward rule writes: walk, never answer nothing.
    out.push(...walk(QUAD_KINDS));
  }
  const row = Object.hasOwn(RDF_MAPPER_PREDICATE_KINDS, p.value) ? RDF_MAPPER_PREDICATE_KINDS[p.value]! : null;
  if (row) out.push(...mapperFinds(p.value, o, row, n));
  else if (term.answer === 'product') out.push(...walk(QUAD_KINDS));
  return out;
}

/** The finds of a predicate the mapper writes on its own account, narrowed by the object where the object decides the rows. */
function mapperFinds(predicate: string, o: PatternSlot, row: readonly RdfRecordKind[], n: Names): CandidateFind[] {
  if (!isBound(o)) return walk(row);
  switch (predicate) {
    case RDF_TYPE: return classFinds(o, n);
    case RDF_REIFIES: return reifiesFinds(o, n);
    case DCTERMS_REFERENCES: {
      const to = endId(o, n);
      return to ? [find('link', { to })] : [];
    }
    case SCHEMA_KEYWORDS: {
      if (o.termType !== 'Literal') return [];
      // Facts and files carry a `tags` index; the other kinds walk.
      return row.map(kind => (kind === 'fact' || kind === 'file' ? find(kind, { tags: o.value }) : { kind, filter: {}, walk: true }));
    }
    default: return walk(row);
  }
}

function objectFinds(o: PatternTerm, n: Names): CandidateFind[] {
  if (o.termType === 'Literal') return walk(QUAD_KINDS);
  if (o.termType === 'Quad') return reifiesFinds(o, n);
  if (o.termType !== 'NamedNode') return [];
  const r = recordOfAddress(o.value, n.names);
  switch (r.answer) {
    case 'record': return r.kind === 'edge' ? [] : [find('edge', { to: r.id }), find('link', { to: r.id })];
    case 'record-part': return [find('chrono', { _id: r.id })];
    case 'other': return r.what === 'agent' || r.what === 'schema-version' ? walk(KNOWLEDGE_KINDS) : [];
    case 'refused': return walk(QUAD_KINDS);
    default: {
      // Not under the base: a class (the schema's, the vocabulary's or the mapper's), or a value the mapper writes (`schema:EventScheduled`).
      const classes = classFinds(o, n);
      return classes.length > 0 ? classes : walk(QUAD_KINDS);
    }
  }
}
