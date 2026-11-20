/**
 * The quads of one subject turned into the record operation they state: the inverse of the record form (`record-triples.ts`) for every
 * triple it writes, and the RDF import's only reader of a foreign file's meaning (bundle-270, slice S3, Q-752).
 *
 * ## What it prevents
 *
 * - **A quad lost or taken in silence.** Every quad of a group lands in exactly one place: taken into an operation, left out on purpose
 *   (`notTaken`, a row of `NOT_TAKEN`: server-owned, derived, a file, the export's description), or answered by a reason (a row of
 *   `IMPORT_REASONS`, refused or recorded by the mode). The answer's three counts sum to the group's size; anything else throws.
 * - **A converge that deletes.** A fact's and a chrono's converge rewrites the link set, an entity's sets name and type (plan amendment A4).
 *   So a converge carries every writable field the file does not state as stored, the union of the stored and the stated tags and links,
 *   and the stored properties with the stated ones over them. RDF states what is; absence is not a statement.
 * - **A supplied id made an identity.** An address under this space's base whose record is stored converges onto it; every other subject
 *   is an insert under the id the caller minted for it (`ctx.minted`), with the address as its correlation. Nothing here mints.
 * - **A tagged string read as a plain one.** The reader keeps a literal's language apart from its datatype; a language tag is refused in
 *   strict and kept as the plain text in warn and off only with its reason recorded, never silently.
 * - **A second name rule.** Addresses and terms are read by `term-reverse.ts` (`recordOfAddress`, `termOfIri`), which applies the forward
 *   rule: a property the Direct Mapping names for an undeclared key comes back through it, never through a decoder here.
 *
 * ## The group
 *
 * All quads of one subject in one graph, with the nodes that hang on it: a chrono's `#start` and `#end` time nodes ({@link groupSubjectOf}
 * says which group a quad belongs to). An edge is read from its reifier's group (both forms: `rdf:reifies` of a triple term, and the
 * classic `rdf:Statement`); its asserted triple sits in its from record's group and is taken there when a reifier names it, or is an edge
 * of its own, without details, when none does. A group that mixes two graphs or two subjects is the caller's defect and throws.
 *
 * ## The context
 *
 * What only the whole file and the store know, handed in as data: the names (`addressNames`), the resolved meta, the mode, whether blank
 * subjects mint, the stored records (with their link rows) by {@link recordKey}, the ids minted for new subjects (by subject address,
 * `_:<id>` for a blank node, {@link tripletKey} for an edge without details), and the triplets the file asserts and reifies
 * ({@link tripletsOfGroup} over every group). The module reads no store, makes no request and holds no state.
 */
import type { SpaceMeta } from '@ythril-network/schema';
import { isRefKind, type RefKind } from '../config/types-knowledge.js';
import { IMPORT_REASONS, NOT_TAKEN, reasonOutcome, type ImportMode, type ImportReasonCode, type NotTakenCode } from './import-reasons.js';
import { stdIri, temporalKind, type BlankTerm, type IriTerm, type LiteralTerm, type Quad, type Term } from './literals.js';
import type { RecordKind, TermOwner } from './term-iri.js';
import { recordOfAddress, termOfIri, type AddressNames } from './term-reverse.js';
import { ythrilIri } from './ythril-vocabulary.js';

/** The record kinds an import writes. A file is never imported (its bytes are not in RDF). */
export type OpKind = 'entity' | 'fact' | 'chrono' | 'edge';
export type PropertyValue = string | number | boolean;
export type Properties = Record<string, PropertyValue>;
/** A record's link set, by the kind it points at. */
export type Links = Partial<Record<RefKind, string[]>>;

export interface EntityFields { name?: string; type?: string | null; description?: string; tags: string[]; properties: Properties }
export interface FactFields { fact?: string; type?: string; description?: string; tags: string[]; properties: Properties }
export interface Recurrence { freq?: string; interval?: number; until?: string }
export interface ChronoFields {
  title?: string; type?: string; startsAt?: string; endsAt?: string; status?: string; confidence?: number; recurrence?: Recurrence;
  description?: string; tags: string[]; properties: Properties;
}
export interface EdgeFields {
  from: string; fromKind: RefKind; to: string; toKind: RefKind; label: string;
  type?: string; weight?: number; description?: string; tags: string[]; properties: Properties;
}

interface OpBase {
  op: 'insert' | 'converge';
  /** The stored id (converge) or the id the caller minted (insert). */
  id: string;
  /** What the file calls the record: its subject address, `_:<id>` for a blank node, a triplet key for an edge without details. */
  correlation: string;
  /** The graph the quads came from, `null` for the default graph. */
  graph: string | null;
}
export type RecordOp =
  | (OpBase & { kind: 'entity'; fields: EntityFields })
  | (OpBase & { kind: 'fact'; fields: FactFields; links: Links })
  | (OpBase & { kind: 'chrono'; fields: ChronoFields; links: Links })
  | (OpBase & { kind: 'edge'; fields: EdgeFields });

/** A stored record the caller read: its document and, for a kind that holds links, its link rows by the kind they point at. */
export interface StoredRecord { doc: Readonly<Record<string, unknown>>; links?: Readonly<Partial<Record<RefKind, readonly string[]>>> }
/** The id the caller minted for a new record, and the kind it minted it as. */
export interface MintedRecord { kind: RecordKind; id: string }

export interface QuadsToOpsContext {
  names: AddressNames;
  /** The space's RESOLVED meta: the declared type of each property is read from it. */
  meta: SpaceMeta;
  mode: ImportMode;
  blankNodes: 'refuse' | 'mint';
  /** By {@link recordKey}. */
  stored: ReadonlyMap<string, StoredRecord>;
  /** By correlation. */
  minted: ReadonlyMap<string, MintedRecord>;
  /** {@link tripletKey}s the file asserts, and those a reifier in it names: from {@link tripletsOfGroup} over every group. */
  asserted: ReadonlySet<string>;
  reified: ReadonlySet<string>;
}

/** A reason a quad could not be taken. `kept`: recorded, and the value went into the operation in its plain form. */
export interface ReasonEntry { code: ImportReasonCode; message: string; outcome: 'refused' | 'recorded'; kept: boolean; quads: Quad[] }
/** A quad left out on purpose. */
export interface NotTakenEntry { quad: Quad; why: NotTakenCode; message: string }
export interface QuadsToOpsResult { ops: RecordOp[]; reasons: ReasonEntry[]; notTaken: NotTakenEntry[]; taken: number }

/** The key of a stored record in `ctx.stored`. */
export function recordKey(kind: RecordKind, id: string): string {
  return JSON.stringify([kind, id]);
}

const termKey = (t: IriTerm | BlankTerm): string => (t.kind === 'iri' ? t.value : `_:${t.id}`);

/** The key of a triplet (an edge's from, label and to) in `ctx.asserted`, `ctx.reified` and, for an edge without details, `ctx.minted`. */
export function tripletKey(subject: IriTerm | BlankTerm, predicate: IriTerm, object: IriTerm | BlankTerm): string {
  return JSON.stringify([termKey(subject), predicate.value, termKey(object)]);
}

/** The key of the group a quad of `subject` belongs to: a chrono's time node belongs to its record, anything else to itself. */
export function groupSubjectOf(subject: IriTerm | BlankTerm, names: AddressNames): string {
  if (subject.kind === 'blank') return termKey(subject);
  const read = recordOfAddress(subject.value, names);
  return read.answer === 'record-part' ? subject.value.slice(0, subject.value.length - read.part.length - 1) : subject.value;
}

const RDF_TYPE = stdIri('rdf', 'type').value;
const RDF_REIFIES = stdIri('rdf', 'reifies').value;
const RDF_SUBJECT = stdIri('rdf', 'subject').value;
const RDF_PREDICATE = stdIri('rdf', 'predicate').value;
const RDF_OBJECT = stdIri('rdf', 'object').value;
const STATEMENT_PARTS = new Set([RDF_REIFIES, RDF_SUBJECT, RDF_PREDICATE, RDF_OBJECT]);
const REFERENCES = stdIri('dcterms', 'references').value;
const isEdgeObject = (t: Term): t is IriTerm | BlankTerm => t.kind === 'iri' || t.kind === 'blank';

/** The triplets a group asserts (every statement whose object is a node) and those its reifier names, in either edge form. */
export function tripletsOfGroup(group: readonly Quad[]): { asserted: string[]; reified: string[] } {
  const asserted: string[] = [];
  const reified: string[] = [];
  const parts = new Map<string, { s: Term[]; p: Term[]; o: Term[] }>();
  for (const q of group) {
    const p = q.predicate.value;
    if (p === RDF_REIFIES && q.object.kind === 'triple' && isEdgeObject(q.object.object)) {
      reified.push(tripletKey(q.object.subject, q.object.predicate, q.object.object));
    } else if (p === RDF_SUBJECT || p === RDF_PREDICATE || p === RDF_OBJECT) {
      const key = termKey(q.subject);
      const entry = parts.get(key) ?? { s: [], p: [], o: [] };
      (p === RDF_SUBJECT ? entry.s : p === RDF_PREDICATE ? entry.p : entry.o).push(q.object);
      parts.set(key, entry);
    } else if (p !== RDF_TYPE && isEdgeObject(q.object)) {
      asserted.push(tripletKey(q.subject, q.predicate, q.object));
    }
  }
  for (const { s, p, o } of parts.values()) {
    const [s0, p0, o0] = [s[0], p[0], o[0]];
    if (s.length === 1 && p.length === 1 && o.length === 1 && s0 && isEdgeObject(s0) && p0?.kind === 'iri' && o0 && isEdgeObject(o0)) reified.push(tripletKey(s0, p0, o0));
  }
  return { asserted, reified };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The vocabulary of the record form, read back

const std = (prefix: Parameters<typeof stdIri>[0], local: string): string => stdIri(prefix, local).value;
const SERVER_OWNED = new Set([
  std('dcterms', 'created'), std('dcterms', 'modified'), std('dcterms', 'conformsTo'), std('prov', 'wasAttributedTo'),
  ythrilIri('superseded'), ythrilIri('contentRedacted'),
]);
const DERIVED = new Set([
  std('time', 'hasBeginning'), std('time', 'hasEnd'), std('time', 'inXSDDateTimeStamp'), std('time', 'inXSDDateTime'), std('time', 'inXSDDate'),
  std('schema', 'eventStatus'),
]);
const DERIVED_CLASSES = new Set([std('time', 'Interval'), std('time', 'Instant'), std('schema', 'Event')]);
const KIND_CLASSES: Readonly<Record<string, RecordKind>> = Object.freeze({
  [ythrilIri('Entity')]: 'entity', [ythrilIri('Fact')]: 'fact', [std('schema', 'MediaObject')]: 'file', [std('rdf', 'Statement')]: 'edge',
});
const UNTYPED = ythrilIri('Untyped');
const AGENT_CLASS = std('prov', 'Agent');
const REPORT_CLASS = ythrilIri('ExportReport');
/** The statements of the export's description graph: its report node, the report's left-out nodes, and what a data graph says of itself. */
const REPORT_PREDICATES = new Set([
  ...['recordCount', 'complete', 'nextAfter', 'leftOutCount', 'leftOutValue', 'leftOutRecord', 'leftOutKey', 'leftOutReason', 'fileTriplesWithheld'].map(ythrilIri),
  std('dcterms', 'hasPart'), std('dcterms', 'isPartOf'), std('sh', 'shapesGraph'),
]);

type Target = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'temporal' | 'any';
interface FieldSpec { field: string; target: Target; multi?: true; part?: keyof Recurrence }
const COMMON_FIELDS: Readonly<Record<string, FieldSpec>> = {
  [std('schema', 'keywords')]: { field: 'tags', target: 'string', multi: true },
  [std('schema', 'description')]: { field: 'description', target: 'string' },
};
/** Per kind, the predicates the record form writes for a writable field, and what the field holds. */
const FIELDS: Readonly<Record<OpKind, Readonly<Record<string, FieldSpec>>>> = Object.freeze({
  entity: { ...COMMON_FIELDS, [std('rdfs', 'label')]: { field: 'name', target: 'string' } },
  fact: { ...COMMON_FIELDS, [std('schema', 'text')]: { field: 'fact', target: 'string' } },
  chrono: {
    ...COMMON_FIELDS,
    [std('rdfs', 'label')]: { field: 'title', target: 'string' },
    [std('schema', 'startDate')]: { field: 'startsAt', target: 'temporal' },
    [std('schema', 'endDate')]: { field: 'endsAt', target: 'temporal' },
    [ythrilIri('status')]: { field: 'status', target: 'string' },
    [ythrilIri('confidence')]: { field: 'confidence', target: 'number' },
    [ythrilIri('recurrenceFreq')]: { field: 'recurrence', target: 'string', part: 'freq' },
    [ythrilIri('recurrenceInterval')]: { field: 'recurrence', target: 'integer', part: 'interval' },
    [ythrilIri('recurrenceUntil')]: { field: 'recurrence', target: 'temporal', part: 'until' },
  },
  edge: { ...COMMON_FIELDS, [ythrilIri('weight')]: { field: 'weight', target: 'number' }, [ythrilIri('edgeType')]: { field: 'type', target: 'string' } },
});
/** The writable fields of each kind, which a converge fills from the stored record when the file does not state them. */
const WRITABLE: Readonly<Record<OpKind, readonly string[]>> = Object.freeze({
  entity: ['name', 'type', 'description'],
  fact: ['fact', 'type', 'description'],
  chrono: ['title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'description'],
  edge: ['type', 'weight', 'description'],
});
/** The kinds that hold link rows and the kinds they link to (`brain/link-adjacency.ts`, `LINK_CLASSES`, files aside: none is imported). */
const LINKS_HELD: Readonly<Partial<Record<OpKind, readonly RefKind[]>>> = Object.freeze({ fact: ['entity'], chrono: ['entity', 'fact'] });

// ---------------------------------------------------------------------------------------------------------------------------------------
// Literals

const XSD = (local: string): string => std('xsd', local);
const DECIMAL_TYPES = new Set(['decimal', 'double', 'float'].map(XSD));
const INTEGER_TYPES = new Set([
  'integer', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger', 'long', 'int', 'short', 'byte',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
].map(XSD));
const TEMPORAL_TYPES: Readonly<Record<string, 'date' | 'dateTime' | 'dateTimeStamp'>> = Object.freeze({
  [XSD('date')]: 'date', [XSD('dateTime')]: 'dateTime', [XSD('dateTimeStamp')]: 'dateTimeStamp',
});
const STRING_TYPE = XSD('string');
const BOOLEAN_TYPE = XSD('boolean');
const DECIMAL_LEXICAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_LEXICAL = /^[+-]?\d+$/;

type Read = { ok: true; value: PropertyValue } | { ok: false; code: ImportReasonCode; lexical?: string };

const isPlain = (l: LiteralTerm): boolean => l.datatype === undefined || l.datatype === STRING_TYPE;
const temporalOf = (l: LiteralTerm): boolean => {
  const kind = l.datatype === undefined ? undefined : TEMPORAL_TYPES[l.datatype];
  return kind !== undefined && temporalKind(l.value) === kind;
};
function numberOf(l: LiteralTerm, integer: boolean): number | null {
  if (l.datatype === undefined) return null;
  const isInteger = INTEGER_TYPES.has(l.datatype);
  if (!isInteger && (integer || !DECIMAL_TYPES.has(l.datatype))) return null;
  if (!(isInteger ? INTEGER_LEXICAL : DECIMAL_LEXICAL).test(l.value.trim())) return null;
  const n = Number(l.value.trim());
  return Number.isFinite(n) && (!isInteger || Number.isSafeInteger(n)) ? n : null;
}

/** One literal as the value of a field or property of `target`. A refusal carries the lexical form a looser mode may keep, where one fits. */
function readLiteral(object: Term, target: Target): Read {
  if (object.kind !== 'literal') return { ok: false, code: 'object-not-a-plain-value' };
  const takesText = target === 'string' || target === 'any';
  if (object.language !== undefined) return takesText ? { ok: false, code: 'language-tagged-literal', lexical: object.value } : { ok: false, code: 'language-tagged-literal' };
  const refused: Read = { ok: false, code: 'datatype-refused', lexical: object.value };
  switch (target) {
    case 'string': return { ok: true, value: object.value };
    case 'temporal': return isPlain(object) || temporalOf(object) ? { ok: true, value: object.value } : { ok: false, code: 'datatype-refused' };
    case 'date': return temporalOf(object) ? { ok: true, value: object.value } : refused;
    case 'number': case 'integer': {
      const n = numberOf(object, target === 'integer');
      return n === null ? refused : { ok: true, value: n };
    }
    case 'boolean': {
      if (object.datatype !== BOOLEAN_TYPE) return refused;
      const v = object.value.trim();
      return v === 'true' || v === '1' ? { ok: true, value: true } : v === 'false' || v === '0' ? { ok: true, value: false } : refused;
    }
    case 'any': {
      if (isPlain(object) || temporalOf(object)) return { ok: true, value: object.value };
      if (object.datatype === BOOLEAN_TYPE) return readLiteral(object, 'boolean');
      const n = numberOf(object, false);
      return n === null ? refused : { ok: true, value: n };
    }
  }
}

const isBag = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The declared type of a property, read from own keys of the resolved meta, or `any` for an undeclared one. */
function declaredTarget(meta: SpaceMeta, kind: OpKind, type: string | null, prop: string): Target {
  if (type === null) return 'any';
  const kinds = (meta.typeSchemas ?? {}) as Record<string, unknown>;
  const types = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
  const def = isBag(types) && Object.hasOwn(types, type) ? types[type] : undefined;
  const props = isBag(def) && isBag(def['propertySchemas']) ? def['propertySchemas'] : undefined;
  const own = props && Object.hasOwn(props, prop) ? props[prop] : undefined;
  const declared = isBag(own) ? own['type'] : undefined;
  return declared === 'string' || declared === 'number' || declared === 'boolean' || declared === 'date' ? declared : 'any';
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The ledger: every quad of a group in exactly one place

class Ledger {
  readonly placed = new Set<Quad>();
  readonly reasons: ReasonEntry[] = [];
  readonly notTaken: NotTakenEntry[] = [];
  taken = 0;
  constructor(readonly group: readonly Quad[], readonly mode: ImportMode) {}

  private place(q: Quad): void {
    if (this.placed.has(q)) throw new Error('quads-to-ops placed one quad twice');
    this.placed.add(q);
  }
  take(q: Quad): void { this.place(q); this.taken++; }
  skip(q: Quad, why: NotTakenCode): void { this.place(q); this.notTaken.push({ quad: q, why, message: NOT_TAKEN[why] }); }
  /** Answers `quads` with a reason; `keepable`: the value can be kept in its plain form when the mode records the reason. Says whether it was kept. */
  reason(code: ImportReasonCode, quads: readonly Quad[], keepable = false): boolean {
    const open = quads.filter(q => !this.placed.has(q));
    if (open.length === 0) return false;
    open.forEach(q => this.place(q));
    const outcome = reasonOutcome(code, this.mode);
    const kept = keepable && outcome === 'recorded';
    this.reasons.push({ code, message: IMPORT_REASONS[code].message, outcome, kept, quads: open });
    return kept;
  }
  open(quads: readonly Quad[]): Quad[] { return quads.filter(q => !this.placed.has(q)); }
  /** Every quad not yet placed, answered by one reason. */
  rest(code: ImportReasonCode): void { this.reason(code, this.open(this.group)); }
  skipRest(why: NotTakenCode): void { this.open(this.group).forEach(q => this.skip(q, why)); }
  result(ops: RecordOp[]): QuadsToOpsResult {
    const inReasons = this.reasons.reduce((n, r) => n + r.quads.length, 0);
    if (this.taken + this.notTaken.length + inReasons !== this.group.length) throw new Error('quads-to-ops left a quad of the group unaccounted for');
    return { ops, reasons: this.reasons, notTaken: this.notTaken, taken: this.taken };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Ends of edges and links

type End = { ref: { kind: RefKind; id: string } } | { file: true } | { code: ImportReasonCode };

/** An edge's or a link's end: a record this space stores, or one the file describes (minted); a file this space does not hold is left out. */
function endOf(term: Term, ctx: QuadsToOpsContext): End {
  if (term.kind === 'blank') {
    const m = ctx.minted.get(termKey(term));
    return m && isRefKind(m.kind) ? { ref: { kind: m.kind, id: m.id } } : { code: 'edge-end-unknown' };
  }
  if (term.kind !== 'iri') return { code: 'object-not-a-plain-value' };
  const read = recordOfAddress(term.value, ctx.names);
  if (read.answer === 'record') {
    const stored = read.of === 'space' && ctx.stored.has(recordKey(read.kind, read.id));
    if (read.kind === 'file') return stored ? { ref: { kind: 'file', id: read.id } } : { file: true };
    if (stored && isRefKind(read.kind)) return { ref: { kind: read.kind, id: read.id } };
  } else if (read.answer !== 'foreign') {
    return { code: 'edge-end-unknown' };
  }
  const m = ctx.minted.get(term.value);
  return m && isRefKind(m.kind) ? { ref: { kind: m.kind, id: m.id } } : { code: 'edge-end-unknown' };
}

/** The edge label a predicate names, `shared` when several labels share its address, or `null` when it is no edge label. */
function edgeLabelOf(predicate: string, names: AddressNames): string | 'shared' | null {
  const t = termOfIri(predicate, names);
  if (t.answer !== 'term' || t.owners.length === 0 || !t.owners.every(o => o.kind === 'edge' && o.prop === undefined && o.type !== null)) return null;
  return t.owners.length > 1 ? 'shared' : t.owners[0]!.type;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The translation of one group

interface Subject { term: IriTerm | BlankTerm; key: string; address: { of: 'space' | 'source'; kind: RecordKind; id: string } | null }
interface TypeCandidate { quad: Quad; owners: TermOwner[]; how: 'schema' | 'vocabulary' }
/** The kind and type a subject's types settle, and the type quads that settle them: taken by the caller only once the record is read. */
interface Decided { kind: RecordKind | null; type: string | null | undefined; settling: Quad[] }

/** Reads the subject's types: its kind and type, or answers the group (two kinds, a contradiction) and says so with `null`. */
function decideKind(L: Ledger, subject: Subject, types: readonly Quad[], statesStatement: boolean, ctx: QuadsToOpsContext): Decided | null {
  const markers = new Set<RecordKind>();
  const markerQuads: Quad[] = [];
  const candidates: TypeCandidate[] = [];
  for (const q of types) {
    const o = q.object;
    if (o.kind !== 'iri') { L.reason('class-without-term', [q]); continue; }
    const kind = Object.hasOwn(KIND_CLASSES, o.value) ? KIND_CLASSES[o.value] : undefined;
    if (kind !== undefined) { markers.add(kind); markerQuads.push(q); continue; }
    if (o.value === UNTYPED) { candidates.push({ quad: q, owners: [{ kind: 'entity', type: null }], how: 'schema' }); continue; }
    if (DERIVED_CLASSES.has(o.value)) { L.skip(q, 'derived'); continue; }
    if (o.value === AGENT_CLASS) { L.skip(q, 'server-owned'); continue; }
    const t = termOfIri(o.value, ctx.names);
    if (t.answer === 'term' && t.owners.every(w => w.prop === undefined)) candidates.push({ quad: q, owners: t.owners, how: t.how });
    else L.reason('class-without-term', [q]);
  }
  if (statesStatement) markers.add('edge');
  const addressKind = subject.address?.kind;
  const kinds = new Set(markers);
  if (addressKind !== undefined) kinds.add(addressKind);
  for (const c of candidates) {
    const ownerKinds = new Set(c.owners.map(w => w.kind));
    if (ownerKinds.size === 1 && (kinds.size === 0 || ![...kinds].some(k => ownerKinds.has(k)))) kinds.add([...ownerKinds][0]!);
  }
  if (kinds.size > 1) {
    L.rest(addressKind !== undefined && [...kinds].some(k => k !== addressKind) ? 'contradicting-kind' : 'types-of-two-kinds');
    return null;
  }
  const kind = kinds.size === 1 ? [...kinds][0]! : null;
  const settling = [...markerQuads];
  if (kind === null) {
    candidates.forEach(c => L.reason('shared-term-unsettled', [c.quad]));
    return { kind, type: undefined, settling };
  }
  const resolved: { quad: Quad; type: string | null; how: 'schema' | 'vocabulary' }[] = [];
  for (const c of candidates) {
    const mine = c.owners.filter(w => w.kind === kind);
    if (mine.length === 1) resolved.push({ quad: c.quad, type: mine[0]!.type, how: c.how });
    else L.reason('shared-term-unsettled', [c.quad]);
  }
  // The type the schema declares wins over one only the vocabulary reads; among equals, the first address in code-unit order.
  const order = (r: { quad: Quad; how: string }): string => `${r.how === 'schema' ? 0 : 1}${r.quad.object.kind === 'iri' ? r.quad.object.value : ''}`;
  resolved.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const first = resolved[0];
  for (const r of resolved) {
    if (r.type === first!.type) settling.push(r.quad);
    else L.reason('several-types-of-one-kind', [r.quad]);
  }
  return { kind, type: first === undefined ? undefined : first.type, settling };
}

/** The values a field or property takes from its quads, with the reasons the rest earn. */
function readValues(L: Ledger, quads: readonly Quad[], target: Target, multi: boolean, keepable: boolean): PropertyValue[] {
  const distinct = new Set(quads.map(q => JSON.stringify(q.object)));
  if (!multi && distinct.size > 1) { L.reason('several-values', quads); return []; }
  const values: PropertyValue[] = [];
  for (const q of quads) {
    const read = readLiteral(q.object, target);
    if (read.ok) { L.take(q); values.push(read.value); continue; }
    const kept = L.reason(read.code, [q], keepable && read.lexical !== undefined);
    if (kept && read.lexical !== undefined) values.push(read.lexical);
  }
  return multi ? values : values.slice(0, 1);
}

/** The writable fields and properties the group's statements give a record of `kind` and `type`. */
function readFields(L: Ledger, kind: OpKind, type: string | null | undefined, quads: readonly Quad[], ctx: QuadsToOpsContext): { fields: Record<string, unknown>; properties: Properties; tags: string[] } {
  const byPredicate = new Map<string, Quad[]>();
  for (const q of quads) {
    const list = byPredicate.get(q.predicate.value);
    if (list === undefined) byPredicate.set(q.predicate.value, [q]); else list.push(q);
  }
  const fields: Record<string, unknown> = {};
  const properties: Properties = {};
  const tags: string[] = [];
  const recurrence: Recurrence = {};
  for (const [p, qs] of byPredicate) {
    if (SERVER_OWNED.has(p)) { qs.forEach(q => L.skip(q, 'server-owned')); continue; }
    if (DERIVED.has(p)) { qs.forEach(q => L.skip(q, 'derived')); continue; }
    const spec = Object.hasOwn(FIELDS[kind], p) ? FIELDS[kind][p] : undefined;
    if (spec !== undefined) {
      const values = readValues(L, qs, spec.target, spec.multi === true, spec.target === 'string');
      if (spec.field === 'tags') tags.push(...values.filter((v): v is string => typeof v === 'string'));
      else if (spec.part !== undefined && values[0] !== undefined) Object.assign(recurrence, { [spec.part]: values[0] });
      else if (values[0] !== undefined) fields[spec.field] = values[0];
      continue;
    }
    const t = termOfIri(p, ctx.names);
    if (t.answer === 'term' && t.owners.some(w => w.prop !== undefined)) {
      const mine = t.owners.filter(w => w.prop !== undefined && w.kind === kind && type !== undefined && w.type === type);
      if (mine.length !== 1) { L.reason(t.owners.length > 1 ? 'shared-term-unsettled' : 'property-of-another-type', qs); continue; }
      const prop = mine[0]!.prop!;
      const values = readValues(L, qs, declaredTarget(ctx.meta, kind, type ?? null, prop), false, true);
      if (values[0] !== undefined) properties[prop] = values[0];
      continue;
    }
    L.reason(t.answer === 'mapper-predicate' || t.answer === 'product' ? 'field-not-of-this-kind' : 'predicate-without-term', qs);
  }
  if (Object.keys(recurrence).length > 0) fields['recurrence'] = recurrence;
  return { fields, properties, tags };
}

const sortedUnion = (...lists: readonly (readonly unknown[] | undefined)[]): string[] =>
  [...new Set(lists.flatMap(l => (l ?? []).filter((v): v is string => typeof v === 'string')))].sort();

/** The operation of a record: insert under the minted id, or converge onto the stored one with every unstated field as stored. */
function finish(kind: OpKind, subject: Subject, graph: string | null, read: { fields: Record<string, unknown>; properties: Properties; tags: string[] }, links: Links, ctx: QuadsToOpsContext): RecordOp {
  const storedKey = subject.address?.of === 'space' ? recordKey(kind, subject.address.id) : null;
  const stored = storedKey === null ? undefined : ctx.stored.get(storedKey);
  let id: string;
  const fields: Record<string, unknown> = { ...read.fields };
  let tags = sortedUnion(read.tags);
  let properties: Properties = { ...read.properties };
  const allLinks: Links = {};
  if (stored !== undefined && subject.address !== null) {
    id = subject.address.id;
    const doc = stored.doc;
    for (const f of WRITABLE[kind]) if (!(f in fields) && doc[f] !== undefined && doc[f] !== null) fields[f] = doc[f];
    if (kind === 'chrono' && isBag(doc['recurrence'])) fields['recurrence'] = { ...doc['recurrence'], ...(isBag(fields['recurrence']) ? fields['recurrence'] : {}) };
    tags = sortedUnion(Array.isArray(doc['tags']) ? doc['tags'] : [], read.tags);
    properties = { ...(isBag(doc['properties']) ? doc['properties'] as Properties : {}), ...read.properties };
    for (const [k, ids] of Object.entries(stored.links ?? {})) if (isRefKind(k) && ids && ids.length > 0) allLinks[k] = [...ids];
  } else {
    const minted = ctx.minted.get(subject.key);
    if (minted === undefined || minted.kind !== kind) throw new TypeError(`quads-to-ops: no id was minted for this new ${kind} (correlation key missing or minted as another kind)`);
    id = minted.id;
  }
  for (const [k, ids] of Object.entries(links)) if (isRefKind(k) && ids) allLinks[k] = sortedUnion(allLinks[k], ids);
  const common = { op: stored !== undefined ? 'converge' as const : 'insert' as const, id, correlation: subject.key, graph };
  const body = { ...fields, tags, properties };
  if (kind === 'entity') return { ...common, kind, fields: body as unknown as EntityFields };
  if (kind === 'fact') return { ...common, kind, fields: body as unknown as FactFields, links: allLinks };
  if (kind === 'chrono') return { ...common, kind, fields: body as unknown as ChronoFields, links: allLinks };
  return { ...common, kind, fields: body as unknown as EdgeFields };
}

/** The triple an edge's details state: one `rdf:reifies` of a triple term, or one each of `rdf:subject`, `rdf:predicate`, `rdf:object`. */
function statementOf(L: Ledger, quads: readonly Quad[]): { s: IriTerm | BlankTerm; p: IriTerm; o: Term } | null {
  const of = (p: string): Quad[] => quads.filter(q => q.predicate.value === p);
  const reifies = of(RDF_REIFIES);
  if (reifies.length > 1) { L.reason('several-values', reifies); return null; }
  const r = reifies[0];
  if (r !== undefined) {
    if (r.object.kind !== 'triple') { L.reason('object-not-a-plain-value', [r]); return null; }
    return { s: r.object.subject, p: r.object.predicate, o: r.object.object };
  }
  const [s, p, o] = [of(RDF_SUBJECT), of(RDF_PREDICATE), of(RDF_OBJECT)];
  if (s.length > 1 || p.length > 1 || o.length > 1) { L.reason('several-values', [...s, ...p, ...o]); return null; }
  const [s0, p0, o0] = [s[0]?.object, p[0]?.object, o[0]?.object];
  if (s0 === undefined || p0 === undefined || o0 === undefined) return null;
  if (!isEdgeObject(s0) || p0.kind !== 'iri') { L.reason('object-not-a-plain-value', [s[0]!, p[0]!]); return null; }
  return { s: s0, p: p0, o: o0 };
}

/** The edge an edge's details state (its reifier's group). */
function edgeOp(L: Ledger, subject: Subject, graph: string | null, classLabel: string | null | undefined, settling: readonly Quad[], quads: readonly Quad[], ctx: QuadsToOpsContext): RecordOp | null {
  const st = statementOf(L, quads.filter(q => STATEMENT_PARTS.has(q.predicate.value)));
  if (st === null) { L.rest('edge-without-statement'); return null; }
  const label = edgeLabelOf(st.p.value, ctx.names);
  if (label === null) { L.rest('predicate-without-term'); return null; }
  if (label === 'shared') { L.rest('shared-term-unsettled'); return null; }
  if (classLabel !== undefined && classLabel !== label) { L.rest('contradicting-kind'); return null; }
  if (!isEdgeObject(st.o)) { L.rest('object-not-a-plain-value'); return null; }
  if (!ctx.asserted.has(tripletKey(st.s, st.p, st.o))) { L.rest('annotation-on-unasserted-triple'); return null; }
  const from = endOf(st.s, ctx);
  const to = endOf(st.o, ctx);
  if ('file' in from || 'file' in to) { L.skipRest('file'); return null; }
  if ('code' in from) { L.rest(from.code); return null; }
  if ('code' in to) { L.rest(to.code); return null; }
  [...settling, ...quads.filter(q => STATEMENT_PARTS.has(q.predicate.value))].forEach(q => L.take(q));
  const read = readFields(L, 'edge', label, L.open(quads), ctx);
  read.fields = { ...read.fields, from: from.ref.id, fromKind: from.ref.kind, to: to.ref.id, toKind: to.ref.kind, label };
  return finish('edge', subject, graph, read, {}, ctx);
}

/**
 * The edges and links a subject asserts (`<subject> <label> <to>`, `<subject> dcterms:references <to>`). An asserted triple a reifier
 * names is carried by that reifier's operation; one no reifier names is an edge of its own, without details.
 */
function relations(L: Ledger, from: End, fromKind: OpKind | null, graph: string | null, edgeQuads: readonly Quad[], linkQuads: readonly Quad[], ctx: QuadsToOpsContext): { ops: RecordOp[]; links: Links } {
  const ops: RecordOp[] = [];
  const links: Links = {};
  for (const q of edgeQuads) {
    const label = edgeLabelOf(q.predicate.value, ctx.names)!;
    if (label === 'shared') { L.reason('shared-term-unsettled', [q]); continue; }
    if (!isEdgeObject(q.object)) { L.reason('object-not-a-plain-value', [q]); continue; }
    const to = endOf(q.object, ctx);
    if ('file' in to) { L.skip(q, 'file'); continue; }
    if (ctx.reified.has(tripletKey(q.subject, q.predicate, q.object))) { L.take(q); continue; }
    if ('code' in to) { L.reason(to.code, [q]); continue; }
    if (!('ref' in from)) { L.reason('file' in from ? 'edge-end-unknown' : from.code, [q]); continue; }
    const key = tripletKey(q.subject, q.predicate, q.object);
    const minted = ctx.minted.get(key);
    if (minted === undefined || minted.kind !== 'edge') throw new TypeError('quads-to-ops: no id was minted for an edge without details (its triplet key)');
    L.take(q);
    ops.push({
      op: 'insert', kind: 'edge', id: minted.id, correlation: key, graph,
      fields: { from: from.ref.id, fromKind: from.ref.kind, to: to.ref.id, toKind: to.ref.kind, label, tags: [], properties: {} },
    });
  }
  for (const q of linkQuads) {
    const to = endOf(q.object, ctx);
    if ('file' in to) { L.skip(q, 'file'); continue; }
    if ('code' in to) { L.reason(to.code, [q]); continue; }
    if (fromKind === null) { L.reason('ref' in from ? 'link-has-no-class' : 'edge-end-unknown', [q]); continue; }
    if (!(LINKS_HELD[fromKind] ?? []).includes(to.ref.kind)) { L.reason('link-has-no-class', [q]); continue; }
    L.take(q);
    (links[to.ref.kind] ??= []).push(to.ref.id);
  }
  return { ops, links };
}

/** Is the group the export's description: its report node, a left-out node of it, or the data graph speaking of itself? */
function isDescription(own: readonly Quad[], subject: Subject, ctx: QuadsToOpsContext): boolean {
  if (subject.term.kind === 'iri') {
    const read = recordOfAddress(subject.term.value, ctx.names);
    if (read.answer === 'other' && read.what === 'graph') return true;
  }
  if (own.some(q => q.predicate.value === RDF_TYPE && q.object.kind === 'iri' && q.object.value === REPORT_CLASS)) return true;
  return own.every(q => REPORT_PREDICATES.has(q.predicate.value));
}

function translate(L: Ledger, group: readonly Quad[], key: string, graph: string | null, ctx: QuadsToOpsContext): RecordOp[] {
  const own = group.filter(q => termKey(q.subject) === key);
  group.filter(q => termKey(q.subject) !== key).forEach(q => L.skip(q, 'derived'));
  const first = own[0];
  if (first === undefined) return [];
  const subject: Subject = { term: first.subject, key, address: null };
  if (isDescription(own, subject, ctx)) { L.skipRest('export-description'); return []; }
  if (first.subject.kind === 'iri') {
    const read = recordOfAddress(first.subject.value, ctx.names);
    if (read.answer === 'other') { L.skipRest('server-owned'); return []; }
    if (read.answer === 'refused') { L.rest('not-an-address-the-export-writes'); return []; }
    if (read.answer === 'record') subject.address = { of: read.of, kind: read.kind, id: read.id };
  }
  const statesStatement = own.some(q => STATEMENT_PARTS.has(q.predicate.value));
  if (first.subject.kind === 'blank' && !statesStatement && ctx.blankNodes !== 'mint') { L.rest('blank-node-subject'); return []; }

  const types = own.filter(q => q.predicate.value === RDF_TYPE);
  const decided = decideKind(L, subject, types, statesStatement, ctx);
  if (decided === null) return [];
  const { kind, type, settling } = decided;
  if (kind === 'file') { L.skipRest('file'); return []; }
  if (kind === 'edge') {
    const op = edgeOp(L, subject, graph, type, settling, own.filter(q => q.predicate.value !== RDF_TYPE), ctx);
    return op === null ? [] : [op];
  }
  settling.forEach(q => L.take(q));
  const rest = L.open(own);
  const edgeQuads = rest.filter(q => edgeLabelOf(q.predicate.value, ctx.names) !== null);
  const linkQuads = rest.filter(q => q.predicate.value === REFERENCES);
  const data = rest.filter(q => !edgeQuads.includes(q) && !linkQuads.includes(q));
  if (kind === null) {
    data.filter(q => SERVER_OWNED.has(q.predicate.value)).forEach(q => L.skip(q, 'server-owned'));
    L.reason('no-kind', L.open(data));
    return relations(L, endOf(first.subject, ctx), null, graph, edgeQuads, linkQuads, ctx).ops;
  }
  const read = readFields(L, kind, type, data, ctx);
  if (kind === 'entity' && type !== undefined) read.fields['type'] = type;
  else if (type !== undefined && type !== null) read.fields['type'] = type;
  const ownRef = (op: RecordOp): End => ({ ref: { kind, id: op.id } });
  // The record's id is known before its relations are read: a converge's stored id, or the id minted for its address.
  const probe = finish(kind, subject, graph, { fields: {}, properties: {}, tags: [] }, {}, ctx);
  const rel = relations(L, ownRef(probe), kind, graph, edgeQuads, linkQuads, ctx);
  return [finish(kind, subject, graph, read, rel.links, ctx), ...rel.ops];
}

/**
 * The record operations the quads of one subject state, with a reason for every quad that cannot be taken and the quads left out on
 * purpose. `group` holds every quad of one subject in one graph and the nodes that hang on it ({@link groupSubjectOf}); a group of two
 * graphs or two subjects throws, and so does a new record the caller minted no id for. Pure.
 */
export function quadsToOps(group: readonly Quad[], ctx: QuadsToOpsContext): QuadsToOpsResult {
  const L = new Ledger(group, ctx.mode);
  const head = group[0];
  if (head === undefined) return L.result([]);
  const graph = head.graph?.value ?? null;
  if (group.some(q => (q.graph?.value ?? null) !== graph)) throw new TypeError('quads-to-ops: a group holds the quads of one graph; this one mixes two');
  const key = groupSubjectOf(head.subject, ctx.names);
  if (group.some(q => groupSubjectOf(q.subject, ctx.names) !== key)) throw new TypeError('quads-to-ops: a group holds the quads of one subject and the nodes that hang on it; this one holds two subjects');
  return L.result(translate(L, group, key, graph, ctx));
}
