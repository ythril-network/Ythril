/**
 * A schema inferred from the statements of an RDF data file (bundle-270, Q-755): the types its subjects are typed with, the properties their
 * plain values give each type with the column's majority datatype, and the edge labels their node objects give, with their endpoints. Pruned as
 * shape-extraction tools prune (QSE, sheXer): every term carries its support (subjects) and confidence (a share), and a term under the caller's
 * thresholds is named with its numbers, never inferred.
 *
 * ## What it prevents
 *
 * - **An inferred schema the same file's data then breaks.** A predicate the inference cannot type safely (several literals on one subject, both
 *   literals and nodes, an address that is also a class, a reserved or product term, an edge to an address the file does not describe, a column
 *   whose majority is under the confidence threshold) is named under `notInferred` and its (kind, type, predicate) pairs are handed back as the
 *   leave-out set: the translation leaves those statements out (`not-inferred`) instead of refusing them as statements of no term.
 * - **A declared or stored term renamed or overridden.** The inference reads the space's names after the declared answer: a class or
 *   predicate the space or the file's declarations already hold is theirs, and an inferred name never takes one of their names (a clash is
 *   numbered, `_2`, `_3`, and listed under `renamed`). A term under the space's or the source's vocabulary claims its derived name and is never
 *   numbered. The inferred types meet the declared answer by `meetStored` in `expand`, so a held definition is never changed by inference.
 * - **A second reader of the file's meaning.** Subjects are read by the translation's own subject reader (`readSubject`, `classOfType`),
 *   predicates by its own role reader (`predicateRole`), values by its own category reader (`literalCategory`), addresses by the mapping's own
 *   term reader (`readTerm`), names by the mapping's own name checks (`validTypeName`, `validPropertyKey`), definitions by the schema package's
 *   parse: the inference and the import cannot disagree about what a statement is.
 * - **An unbounded read.** The distinct predicates of a file's subjects are counted while it is read and the file is refused past
 *   {@link SCHEMA_INFER_MAX_PREDICATES}; the map of subjects to their classes holds a 128-bit digest and a few class indices per subject, bounded
 *   by the door's own subject bound; every list the answer names is capped at {@link INFERRED_NAMED_MAX} and counted whole.
 *
 * Two passes over the sorted spool, read again for each ({@link gatherClasses}, then {@link inferFromData}'s second pass), at the door.
 */
import { TypeSchemaZ, type KnowledgeType } from '@ythril-network/schema';
import type { Quad } from './literals.js';
import type { RecordKind } from './term-iri.js';
import { recordOfAddress, termOfIri, type AddressNames } from './term-reverse.js';
import { digestOfKey } from './import-count.js';
import type { QuadGroup } from './import-spool.js';
import { classOfType, edgeLabelOf, groupSubjectOf, leaveOutKey, literalCategory, predicateRole, readSubject, type OpKind } from './quads-to-ops.js';
import { localPart, readTerm, validPropertyKey, validTypeName } from './schema-from-rdf-drafts.js';
import type { BuiltType, TypeSchemasByKind } from './schema-from-rdf-modes.js';

/** The most distinct predicates a file's subjects may use for a schema to be inferred from it: wider is a dump to type by hand. */
export const SCHEMA_INFER_MAX_PREDICATES = 1000;
/** The support a term needs by default: a single stray record is not a type (the shape-extraction tools' reason for a support floor). */
export const INFER_MIN_SUPPORT_DEFAULT = 2;
/** The confidence a property needs by default: none, so the column's majority datatype is taken as the ticket asks. */
export const INFER_MIN_CONFIDENCE_DEFAULT = 0;
/** The most entries each list of the answer's `inferred` block names; each is counted whole. */
export const INFERRED_NAMED_MAX = 500;
/** The most types one endpoint side lists (the schema's own bound on `endpoints.from` and `endpoints.to`). */
const ENDPOINT_TYPES_MAX = 50;
/** The longest endpoint member the schema holds. */
const ENDPOINT_MEMBER_MAX = 200;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
/** The endpoint bucket of an entity with no type: a type of that name would be read as the bucket. */
const UNTYPED_MEMBER = 'UNTYPED';
/** The order a tie between datatypes is broken in: the more general first. `other` never wins a column. */
const TIE_ORDER = ['string', 'date', 'number', 'boolean'] as const;
type Datatype = typeof TIE_ORDER[number];
type Category = Datatype | 'other';

export interface InferOptions {
  /** A class, a property of a type or an edge label seen on fewer subjects is not inferred. At least 1. */
  minSupport: number;
  /** A property seen on a smaller share of its type's subjects, or a column whose majority holds a smaller share of its values, is not inferred. */
  minConfidence: number;
  /** An edge label no subject states twice is one-only (`functional`). */
  functional: boolean;
  maxPredicates: number;
}

/** What the inference says of one term it took, or why it took none. */
export interface InferredTerm { kind: KnowledgeType; type: string; prop?: string; iri: string; datatype?: Datatype; support: number; confidence: number }
export interface NotInferred { iri: string; why: string; kind?: KnowledgeType; type?: string; support?: number; confidence?: number }
export interface InferredBlock {
  types: InferredTerm[];
  properties: InferredTerm[];
  edges: InferredTerm[];
  mixed: Array<{ predicate: string; counts: Record<Category, number>; majority: Datatype | null; share: number }>;
  multiValued: Array<{ kind: KnowledgeType; type: string; predicate: string; subjects: number }>;
  renamed: Array<{ iri: string; name: string; wanted: string; kind: KnowledgeType; type?: string }>;
  openEndpoints: Array<{ type: string; side: 'from' | 'to'; why: string }>;
  notInferred: NotInferred[];
  multiTyped: Array<{ iri: string; subjects: number }>;
  /** Every list's whole length; a list names at most {@link INFERRED_NAMED_MAX}. */
  counts: Record<string, number>;
}

/** What the first pass read: the file's own classes, which subjects carry them, their labels, and the predicates the subjects use. */
export interface DataClasses {
  kind: 'classes';
  classes: string[];
  /** A subject address's digest: the indices of its classes. */
  subjects: Map<string, number[]>;
  count: number[];
  markers: Map<number, Set<RecordKind>>;
  /** The plain labels of addresses whose group states only labels and comments, and that group's key (skipped when its address is inferred). */
  labelGroups: Map<string, { key: string; labels: string[] }>;
  predicates: Set<string>;
}

export type DataClassesOrOver = DataClasses | { kind: 'over'; limit: number };

/** The door's view of the file: its groups (read again for each pass), the schema groups to skip, and the names each graph is read under. */
export interface DataSource {
  groups: () => AsyncIterable<QuadGroup>;
  skip: ReadonlySet<string>;
  namesOf: (graph: string | undefined) => AddressNames;
  blankNodes: 'refuse' | 'mint';
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plainLabel = (q: Quad): string | null =>
  (q.object.kind === 'literal' && q.object.language === undefined && (q.object.datatype === undefined || q.object.datatype.endsWith('#string')) ? q.object.value : null);

/** The subject a group states records of, read as the translation reads it: a typed address, never a blank node or an edge's reifier. */
function subjectOf(group: QuadGroup, source: DataSource): { iri: string; own: Quad[]; types: Quad[] } | null {
  const head = group.quads[0];
  if (head === undefined) return null;
  const names = source.namesOf(group.graph?.value);
  const at = readSubject(group.quads, groupSubjectOf(head.subject, names), names, source.blankNodes);
  if (at.read !== 'subject' || at.statesStatement || at.subject.term.kind !== 'iri') return null;
  return { iri: at.subject.term.value, own: at.own, types: at.types };
}

/**
 * Pass 1: the classes each subject is typed with (by the translation's class reader), how many subjects carry each, the kind markers beside
 * them, the labels of addresses described by labels alone, and the distinct predicates the subjects use, refused past `maxPredicates`.
 */
export async function gatherClasses(source: DataSource, maxPredicates: number): Promise<DataClassesOrOver> {
  const out: DataClasses = { kind: 'classes', classes: [], subjects: new Map(), count: [], markers: new Map(), labelGroups: new Map(), predicates: new Set() };
  const index = new Map<string, number>();
  for await (const group of source.groups()) {
    if (source.skip.has(group.key)) continue;
    const at = subjectOf(group, source);
    if (at === null) continue;
    for (const q of at.own) {
      if (q.predicate.value === RDFS_LABEL || q.predicate.value === RDFS_COMMENT || at.types.includes(q)) continue;
      if (!out.predicates.has(q.predicate.value)) {
        out.predicates.add(q.predicate.value);
        if (out.predicates.size > maxPredicates) return { kind: 'over', limit: maxPredicates };
      }
    }
    const marks = new Set<RecordKind>();
    const mine: number[] = [];
    for (const q of at.types) {
      const read = classOfType(q.object);
      if (read.as === 'marker') marks.add(read.kind);
      if (read.as !== 'class') continue;
      let n = index.get(read.iri);
      if (n === undefined) { n = out.classes.length; index.set(read.iri, n); out.classes.push(read.iri); out.count.push(0); }
      if (!mine.includes(n)) mine.push(n);
    }
    if (mine.length === 0) {
      if (at.types.length === 0 && at.own.every(q => q.predicate.value === RDFS_LABEL || q.predicate.value === RDFS_COMMENT)) {
        out.labelGroups.set(at.iri, { key: group.key, labels: at.own.map(plainLabel).filter((l): l is string => l !== null) });
      }
      continue;
    }
    for (const n of mine) {
      out.count[n] = (out.count[n] ?? 0) + 1;
      if (marks.size > 0) { const set = out.markers.get(n) ?? new Set(); marks.forEach(k => set.add(k)); out.markers.set(n, set); }
    }
    out.subjects.set(digestOfKey(at.iri), mine);
  }
  return out;
}

/** A type a subject can settle on: its kind, its name after the merge, its class address, and whether only the vocabulary reads it. */
interface TypeOf { kind: KnowledgeType; name: string; iri: string; vocabulary: boolean }

/**
 * What the proposal hands the inference: the declared answer's type schemas and names, and (a test's seam) a call made once per name claimed,
 * with the number of spellings the claim probed.
 */
export interface InferFirst { typeSchemas: TypeSchemasByKind; names: AddressNames; onClaim?: (probes: number) => void }

/** What the inference hands the proposal: the types to meet the declared answer with, the answer's block, the pairs left out, the label groups. */
export interface InferResult { built: BuiltType[]; inferred: InferredBlock; leaveOut: string[]; labelKeys: string[] }

interface PairStats { kind: KnowledgeType; type: string; subjects: number; literals: number; multi: number; nodes: number; maxNodes: number; ends: Set<string>; open: Set<string> }

/** Names held in one kind (stored, declared, inferred so far), numbered past a clash. */
class NameBook {
  private readonly held = new Map<string, Set<string>>();
  constructor(typeSchemas: TypeSchemasByKind, private readonly onClaim?: (probes: number) => void) {
    for (const kind of Object.keys(typeSchemas) as KnowledgeType[]) this.held.set(kind, new Set(Object.keys(typeSchemas[kind] ?? {})));
    this.held.get('entity')?.add(UNTYPED_MEMBER);
  }
  /** A derived name: held as it is, never numbered (the vocabulary gives it, and a number would name another address). */
  hold(kind: string, name: string): void {
    const held = this.held.get(kind) ?? new Set<string>();
    held.add(name);
    this.held.set(kind, held);
  }
  /** `wanted`, or the first `wanted_<n>` free in `kind` that is still a valid name; `null` when none is. */
  claim(kind: string, wanted: string, valid: (name: string) => boolean): string | null {
    const held = this.held.get(kind) ?? new Set<string>();
    this.held.set(kind, held);
    return numbered(held, wanted, valid, this.onClaim);
  }
}

/** The name an inferred term asks for: the smallest valid plain label in code-unit order, else its valid local part, else none. */
function wantedName(iri: string, labels: ReadonlyMap<string, { labels: string[] }>, valid: (name: string) => boolean): string | null {
  const label = [...(labels.get(iri)?.labels ?? [])].filter(valid).sort(byCodeUnit)[0];
  if (label !== undefined) return label;
  const local = localPart(iri);
  return valid(local) ? local : null;
}

/** An endpoint member for a type name: the name, or `entity:<name>` when the name holds a colon (the schema reads a bare prefix as a kind). */
function memberOf(name: string): string | null {
  const member = name.includes(':') ? `entity:${name}` : name;
  return member.length <= ENDPOINT_MEMBER_MAX ? member : null;
}

/** The majority datatype of a column (ties by {@link TIE_ORDER}; `other` never wins) and the share of the column's values it holds. */
function majorityOf(counts: Record<Category, number>): { majority: Datatype | null; share: number } {
  const total = TIE_ORDER.reduce((n, c) => n + counts[c], counts.other);
  let best: Datatype | null = null;
  for (const c of TIE_ORDER) if (counts[c] > 0 && (best === null || counts[c] > counts[best])) best = c;
  return { majority: best, share: best === null || total === 0 ? 0 : counts[best] / total };
}

/** The steps a share is rounded to, so a confidence reads as the share it is (0.3, not 0.30000000000000004). */
const SHARE_STEPS = 1_000_000;
const share = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * SHARE_STEPS) / SHARE_STEPS);

/** The number a clashing name's first renamed spelling takes (`Item_2`): the name itself is the first. */
const FIRST_NUMBER = 2;
/**
 * The one numbering rule of the inference: `wanted`, or the first `wanted_<n>` that `held` does not hold, checked again by `valid` (a number
 * can take a name past its length limit); `null` when that spelling is not valid. Adds the spelling to `held`.
 */
function numbered(held: Set<string>, wanted: string, valid: (name: string) => boolean, onClaim?: (probes: number) => void): string | null {
  let name = wanted;
  let probes = 1;
  for (let n = FIRST_NUMBER; held.has(name); n++) { name = `${wanted}_${n}`; probes += 1; }
  onClaim?.(probes);
  if (!valid(name)) return null;
  held.add(name);
  return name;
}
const capped = <T>(list: T[]): T[] => list.slice(0, INFERRED_NAMED_MAX);

/**
 * Decide the types (from pass 1, against the names after the declared answer), read pass 2 (properties and edges per type, the ends of
 * edges), and decide the properties and edge labels. Pure but for reading `source` again.
 */
export async function inferFromData(
  source: DataSource, classes: DataClasses, first: InferFirst, options: InferOptions,
): Promise<InferResult> {
  const block: InferredBlock = { types: [], properties: [], edges: [], mixed: [], multiValued: [], renamed: [], openEndpoints: [], notInferred: [], multiTyped: [], counts: {} };
  const book = new NameBook(first.typeSchemas, first.onClaim);
  const names = first.names;
  const builtTypes = new Map<string, BuiltType>();
  const typeOfClass = new Map<number, TypeOf>();
  const ctx = { names };

  // -- the types -----------------------------------------------------------------------------------------------------------------------
  const order = classes.classes.map((iri, n) => ({ iri, n })).sort((a, b) => byCodeUnit(a.iri, b.iri));
  const derivedFirst = [...order].sort((a, b) => Number(readTerm(ctx, b.iri).how === 'derived') - Number(readTerm(ctx, a.iri).how === 'derived'));
  for (const { iri, n } of derivedFirst) {
    // A class the space or the file's declarations hold is theirs; one only the vocabulary reads is inferred under its derived name.
    const t = termOfIri(iri, names);
    if (t.answer === 'term' && t.how === 'schema' && t.owners.length > 0 && t.owners.every(w => w.prop === undefined)) {
      const owner = t.owners.length === 1 ? t.owners[0]! : undefined;
      if (owner && owner.kind !== 'file' && owner.type !== null) typeOfClass.set(n, { kind: owner.kind, name: owner.type, iri, vocabulary: false });
      continue;
    }
    const support = classes.count[n] ?? 0;
    const marks = classes.markers.get(n) ?? new Set<RecordKind>();
    const notInferred = (why: string): void => { block.notInferred.push({ iri, why, support }); };
    if (t.answer === 'term' && t.how === 'schema') { notInferred('term-clash'); continue; }
    if (support < options.minSupport) { notInferred('support'); continue; }
    if (marks.size > 1 || [...marks].some(k => k !== 'entity' && k !== 'fact')) { notInferred('two-kinds'); continue; }
    const kind: KnowledgeType = marks.has('fact') ? 'fact' : 'entity';
    const read = readTerm(ctx, iri);
    if (read.how === 'rejected') { notInferred('not-a-term'); continue; }
    let name: string | null;
    if (read.how === 'derived') {
      if (read.prop !== undefined || read.kind !== kind || read.type === null) { notInferred('not-a-term'); continue; }
      name = read.type;
      book.hold(kind, name);
    } else {
      const wanted = wantedName(iri, classes.labelGroups, validTypeName);
      if (wanted === null) { notInferred('no-name'); continue; }
      name = book.claim(kind, wanted, validTypeName);
      if (name === null) { notInferred('no-name'); continue; }
      if (name !== wanted) block.renamed.push({ iri, name, wanted, kind });
    }
    typeOfClass.set(n, { kind, name, iri, vocabulary: false });
    builtTypes.set(`${kind}\u0000${name}`, { kind, name, def: read.how === 'foreign' ? { iri } : {} });
    block.types.push({ kind, type: name, iri, support, confidence: 1 });
  }

  /** The type a subject settles on, as the translation's kind reader settles it: the schema's before the vocabulary's, then the first address. */
  const pickOf = (digest: string): TypeOf | null => {
    const mine = (classes.subjects.get(digest) ?? []).map(n => typeOfClass.get(n)).filter((t): t is TypeOf => t !== undefined);
    if (mine.length === 0 || new Set(mine.map(t => t.kind)).size > 1) return null;
    return [...mine].sort((a, b) => Number(a.vocabulary) - Number(b.vocabulary) || byCodeUnit(a.iri, b.iri))[0]!;
  };
  const typeSubjects = new Map<string, number>();
  const multi = new Map<number, number>();
  for (const [digest, list] of classes.subjects) {
    const pick = pickOf(digest);
    if (pick) typeSubjects.set(`${pick.kind}\u0000${pick.name}`, (typeSubjects.get(`${pick.kind}\u0000${pick.name}`) ?? 0) + 1);
    if (list.length > 1) for (const n of list) multi.set(n, (multi.get(n) ?? 0) + 1);
  }
  for (const [n, subjects] of multi) block.multiTyped.push({ iri: classes.classes[n]!, subjects });
  for (const t of block.types) {
    const settled = typeSubjects.get(`${t.kind}\u0000${t.type}`) ?? 0;
    t.confidence = share(settled, t.support);
  }

  // -- pass 2: properties and edges, per type --------------------------------------------------------------------------------------------
  const pairs = new Map<string, Map<string, PairStats>>();
  const columns = new Map<string, Record<Category, number>>();
  const nodesOf = new Map<string, number>();
  for await (const group of source.groups()) {
    if (source.skip.has(group.key)) continue;
    const at = subjectOf(group, source);
    if (at === null) continue;
    const pick = pickOf(digestOfKey(at.iri));
    if (pick === null || (pick.kind !== 'entity' && pick.kind !== 'fact')) continue;
    const groupNames = source.namesOf(group.graph?.value);
    const byPredicate = new Map<string, Quad[]>();
    for (const q of at.own) {
      if (predicateRole(q.predicate.value, pick.kind as OpKind) !== 'other') continue;
      const list = byPredicate.get(q.predicate.value);
      if (list === undefined) byPredicate.set(q.predicate.value, [q]); else list.push(q);
    }
    for (const [p, qs] of byPredicate) {
      const typeKey = `${pick.kind}\u0000${pick.name}`;
      const perType = pairs.get(p) ?? new Map<string, PairStats>();
      pairs.set(p, perType);
      const stats = perType.get(typeKey) ?? { kind: pick.kind, type: pick.name, subjects: 0, literals: 0, multi: 0, nodes: 0, maxNodes: 0, ends: new Set(), open: new Set() };
      perType.set(typeKey, stats);
      stats.subjects += 1;
      const column = columns.get(p) ?? { string: 0, number: 0, boolean: 0, date: 0, other: 0 };
      columns.set(p, column);
      let literals = 0;
      let nodes = 0;
      for (const q of qs) {
        const category = literalCategory(q.object);
        if (category !== 'node') { literals += 1; column[category] += 1; continue; }
        nodes += 1;
        nodesOf.set(p, (nodesOf.get(p) ?? 0) + 1);
        if (q.object.kind !== 'iri') { stats.open.add('end-not-described'); continue; }
        const end = pickOf(digestOfKey(q.object.value));
        if (end !== null) { if (end.kind === 'entity') stats.ends.add(end.name); else stats.open.add('not-an-entity'); continue; }
        if (classes.subjects.has(digestOfKey(q.object.value))) { stats.open.add('end-untyped'); continue; }
        stats.open.add(recordOfAddress(q.object.value, groupNames).answer === 'record' ? 'end-stored' : 'end-not-described');
      }
      stats.literals += literals;
      stats.nodes += nodes;
      if (literals > 1) stats.multi += 1;
      stats.maxNodes = Math.max(stats.maxNodes, nodes);
    }
  }

  // -- the properties and edge labels ----------------------------------------------------------------------------------------------------
  const leaveOut: string[] = [];
  const leave = (perType: Map<string, PairStats>, p: string): void => { for (const s of perType.values()) leaveOut.push(leaveOutKey(s.kind, s.type, p)); };
  const classSet = new Set(classes.classes);
  const propertiesOf = (kind: KnowledgeType, type: string): Record<string, unknown> => {
    const key = `${kind}\u0000${type}`;
    let built = builtTypes.get(key);
    if (built === undefined) { built = { kind, name: type, def: {} }; builtTypes.set(key, built); }
    return ((built.def['propertySchemas'] as Record<string, unknown> | undefined) ?? (built.def['propertySchemas'] = {})) as Record<string, unknown>;
  };
  const keysHeld = new Map<string, Set<string>>();
  const claimKey = (kind: KnowledgeType, type: string, wanted: string): string | null => {
    const key = `${kind}\u0000${type}`;
    let held = keysHeld.get(key);
    if (held === undefined) {
      const stored = (first.typeSchemas[kind]?.[type] as { propertySchemas?: Record<string, unknown> } | undefined)?.propertySchemas ?? {};
      held = new Set(Object.keys(stored));
      keysHeld.set(key, held);
    }
    return numbered(held, wanted, validPropertyKey, first.onClaim);
  };

  for (const p of [...pairs.keys()].sort(byCodeUnit)) {
    const perType = pairs.get(p)!;
    // Held terms are the space's or the declarations' (`how: schema`); an address only the vocabulary reads is inferred under its derived name.
    const t = termOfIri(p, names);
    const holders = t.answer === 'term' && t.how === 'schema' ? t.owners : [];
    const knownProp = holders.filter(w => w.prop !== undefined);
    if (holders.length > 0 && edgeLabelOf(p, names) !== null) continue;
    for (const [typeKey, s] of perType) if (knownProp.some(w => w.kind === s.kind && w.type === s.type)) perType.delete(typeKey);
    if (perType.size === 0) continue;
    const support = [...perType.values()].reduce((n, s) => n + s.subjects, 0);
    const notInferred = (why: string, extra: Partial<NotInferred> = {}): void => { block.notInferred.push({ iri: p, why, support, ...extra }); };
    if (t.answer === 'mapper-predicate') { notInferred('reserved'); leave(perType, p); continue; }
    if (t.answer === 'product') { notInferred('product'); leave(perType, p); continue; }
    if (t.answer === 'refused') { notInferred('not-a-term'); leave(perType, p); continue; }
    if (classSet.has(p) || holders.some(w => w.prop === undefined)) { notInferred('used-as-class'); leave(perType, p); continue; }
    const read = readTerm(ctx, p);
    if (read.how === 'rejected') { notInferred('not-a-term'); leave(perType, p); continue; }
    const column = columns.get(p)!;
    const literals = TIE_ORDER.reduce((n, c) => n + column[c], column.other);
    const nodes = nodesOf.get(p) ?? 0;
    if (literals > 0 && nodes > 0) { notInferred('literal-and-node'); leave(perType, p); continue; }

    if (nodes > 0) {
      // An edge label: its ends must be the file's typed subjects, or records the space stores (which leave a side open).
      const all = [...perType.values()];
      if (all.some(s => s.open.has('end-not-described') || s.open.has('end-untyped'))) { notInferred('end-not-described'); leave(perType, p); continue; }
      const subjectsOfTypes = all.reduce((n, s) => n + (typeSubjects.get(`${s.kind}\u0000${s.type}`) ?? 0), 0);
      const confidence = share(support, subjectsOfTypes);
      if (support < options.minSupport) { notInferred('support', { confidence }); leave(perType, p); continue; }
      if (confidence < options.minConfidence) { notInferred('confidence', { confidence }); leave(perType, p); continue; }
      let name: string | null;
      if (read.how === 'derived') {
        if (read.kind !== 'edge' || read.prop !== undefined || read.type === null) { notInferred('not-a-term'); leave(perType, p); continue; }
        name = read.type;
        book.hold('edge', name);
      } else {
        const wanted = wantedName(p, classes.labelGroups, validTypeName);
        name = wanted === null ? null : book.claim('edge', wanted, validTypeName);
        if (wanted === null || name === null) { notInferred('no-name'); leave(perType, p); continue; }
        if (name !== wanted) block.renamed.push({ iri: p, name, wanted, kind: 'edge' });
      }
      const def: Record<string, unknown> = read.how === 'foreign' ? { iri: p } : {};
      const endpoints: Record<string, string[]> = {};
      const side = (which: 'from' | 'to', typesOn: string[], why: string | null): void => {
        const members = typesOn.map(memberOf);
        if (why === null && typesOn.length > ENDPOINT_TYPES_MAX) why = 'too-many-types';
        if (why === null && members.some(m => m === null)) why = 'name-too-long';
        if (why !== null || typesOn.length === 0) { block.openEndpoints.push({ type: name!, side: which, why: why ?? 'no-end' }); return; }
        endpoints[which] = (members as string[]).sort(byCodeUnit);
      };
      side('from', [...new Set(all.map(s => s.type))], all.some(s => s.kind !== 'entity') ? 'not-an-entity' : null);
      const toOpen = all.flatMap(s => [...s.open]);
      side('to', [...new Set(all.flatMap(s => [...s.ends]))], toOpen.includes('end-stored') ? 'end-stored' : toOpen.includes('not-an-entity') ? 'not-an-entity' : null);
      if (Object.keys(endpoints).length > 0) def['endpoints'] = endpoints;
      if (options.functional && all.every(s => s.maxNodes <= 1)) def['functional'] = true;
      if (!TypeSchemaZ.safeParse(def).success) { notInferred('invalid'); leave(perType, p); continue; }
      builtTypes.set(`edge\u0000${name}`, { kind: 'edge', name, def });
      block.edges.push({ kind: 'edge', type: name, iri: p, support, confidence });
      continue;
    }

    // A property: one datatype for the predicate across every type (the term-clash rule holds one address to one declared type).
    const storedType = knownProp.map(w => (first.typeSchemas[w.kind as KnowledgeType]?.[w.type!] as { propertySchemas?: Record<string, { type?: unknown }> } | undefined)?.propertySchemas?.[w.prop!]?.type)[0];
    if (knownProp.length > 0 && (read.how === 'derived' || storedType === undefined)) { notInferred('vocabulary-property'); leave(perType, p); continue; }
    const { majority, share: held } = majorityOf(column);
    const kinds = (Object.keys(column) as Category[]).filter(c => column[c] > 0);
    if (kinds.length > 1) block.mixed.push({ predicate: p, counts: { ...column }, majority, share: share(column[majority ?? 'other'] ?? 0, literals) });
    if (majority === null) { notInferred('other-only'); leave(perType, p); continue; }
    if (held < options.minConfidence) { notInferred('mixed', { confidence: share(column[majority], literals) }); leave(perType, p); continue; }
    const datatype = (typeof storedType === 'string' ? storedType : majority) as Datatype;
    for (const s of [...perType.values()].sort((a, b) => byCodeUnit(a.type, b.type))) {
      const confidence = share(s.subjects, typeSubjects.get(`${s.kind}\u0000${s.type}`) ?? 0);
      const pairNot = (why: string): void => {
        block.notInferred.push({ iri: p, why, kind: s.kind, type: s.type, support: s.subjects, confidence });
        leaveOut.push(leaveOutKey(s.kind, s.type, p));
      };
      if (s.multi > 0) { block.multiValued.push({ kind: s.kind, type: s.type, predicate: p, subjects: s.multi }); pairNot('multi-valued'); continue; }
      if (s.subjects < options.minSupport) { pairNot('support'); continue; }
      if (confidence < options.minConfidence) { pairNot('confidence'); continue; }
      let key: string | null;
      if (read.how === 'derived') {
        if (read.prop === undefined || read.kind !== s.kind || read.type !== s.type) { pairNot('vocabulary-property'); continue; }
        key = read.prop;
      } else {
        const wanted = wantedName(p, classes.labelGroups, validPropertyKey);
        key = wanted === null ? null : claimKey(s.kind, s.type, wanted);
        if (wanted === null || key === null) { pairNot('no-name'); continue; }
        if (key !== wanted) block.renamed.push({ iri: p, name: key, wanted, kind: s.kind, type: s.type });
      }
      propertiesOf(s.kind, s.type)[key] = { ...(read.how === 'foreign' ? { iri: p } : {}), type: datatype };
      block.properties.push({ kind: s.kind, type: s.type, prop: key, iri: p, datatype, support: s.subjects, confidence });
    }
  }

  // -- the answer ------------------------------------------------------------------------------------------------------------------------
  const built = [...builtTypes.values()].filter(b => b.kind === 'edge' || Object.keys(b.def).length > 0 || block.types.some(t => t.kind === b.kind && t.type === b.name));
  const inferredIris = new Set([...block.types, ...block.properties, ...block.edges].map(t => t.iri));
  const labelKeys = [...classes.labelGroups].filter(([iri]) => inferredIris.has(iri)).map(([, g]) => g.key);
  const lists = ['types', 'properties', 'edges', 'mixed', 'multiValued', 'renamed', 'openEndpoints', 'notInferred', 'multiTyped'] as const;
  for (const list of lists) block.counts[list] = block[list].length;
  const cappedBlock = { ...block } as InferredBlock;
  for (const list of lists) (cappedBlock as unknown as Record<string, unknown[]>)[list] = capped(block[list] as unknown[]);
  return { built, inferred: cappedBlock, leaveOut, labelKeys };
}

