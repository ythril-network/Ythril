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
 *   leave-out set: the translation leaves those statements out (`not-inferred`) instead of refusing them as statements of no term. A class the
 *   inference names and does not take is in that set too, with the label groups that describe it: a subject typed only by it is left out whole.
 * - **A declared or stored term renamed or overridden.** The inference reads the space's names after the declared answer: a class or
 *   predicate the space or the file's declarations already hold is theirs, and an inferred name never takes one of their names (a clash is
 *   numbered, `_2`, `_3`, and listed under `renamed`). A term under the space's or the source's vocabulary claims its derived name and is never
 *   numbered. The inferred types meet the declared answer by `meetStored` in `expand`, so a held definition is never changed by inference.
 * - **A second reader of the file's meaning.** Subjects are read by the translation's own subject reader (`readSubject`, `classOfType`),
 *   predicates by its own role reader (`predicateRole`), values by its own category reader (`literalCategory`), addresses by the mapping's own
 *   term reader (`readTerm`), names by the mapping's own name checks (`validTypeName`, `validPropertyKey`), definitions by the schema package's
 *   parse: the inference and the import cannot disagree about what a statement is.
 * - **An unbounded read.** The distinct predicates and the distinct classes of a file's subjects are counted while it is read and the file is
 *   refused past {@link SCHEMA_INFER_MAX_PREDICATES} and {@link SCHEMA_INFER_MAX_CLASSES}, and the pairs the second pass remembers for subjects
 *   stated by several graphs past {@link SCHEMA_INFER_MAX_PAIRS}, each at the statement that passes it; the map of subjects to their classes holds a 128-bit digest and a few class indices per subject, bounded
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
import { classOfType, edgeLabelOf, groupSubjectOf, leaveOutClassKey, leaveOutKey, literalCategory, predicateRole, readSubject, type OpKind } from './quads-to-ops.js';
import { MAX_TYPES_PER_KIND } from '../spaces/types-added-past-cap.js';
import { localPart, nameKey, readTerm, validPropertyKey, validTypeName, type TermReading } from './schema-from-rdf-drafts.js';
import type { BuiltType, TypeSchemasByKind } from './schema-from-rdf-modes.js';

/** The most distinct predicates a file's subjects may use for a schema to be inferred from it: wider is a dump to type by hand. */
export const SCHEMA_INFER_MAX_PREDICATES = 1000;
/**
 * The most distinct classes a file's subjects may be typed with for a schema to be inferred from it. A space holds at most
 * {@link MAX_TYPES_PER_KIND} types of a kind and the inference builds the kinds `entity` and `fact`, so a schema takes at most twice that many
 * classes; the rest of the bound is room for the classes a threshold prunes (named, never built). Wider is a dump to type by hand, and the
 * refusal comes while the first pass reads, before a map or a step file holds an entry per class.
 */
export const SCHEMA_INFER_MAX_CLASSES = 1000;
/**
 * The most distinct (subject, predicate) pairs of subjects stated by several graphs the second pass remembers, so each is one subject of its
 * pair. The set holds a short string per pair (about 100 bytes with its entry), so the bound is about 100 MB at most; the import's own subject
 * bound (a million) is the number of subjects that can repeat, and a pair is at least one statement of one of them.
 */
export const SCHEMA_INFER_MAX_PAIRS = 1_000_000;
/** The knob (and `bound` a refusal names) of each bound a schema inferred from data is refused at. */
export const INFER_BOUND_KNOB = { predicates: 'schemaInferMaxPredicates', classes: 'schemaInferMaxClasses', pairs: 'schemaInferMaxPairs' } as const;
export type InferBound = keyof typeof INFER_BOUND_KNOB;

/** The door's words for a file over one of the inference's bounds. */
export function inferBoundText(bound: InferBound, limit: number): string {
  const what = bound === 'predicates' ? `use more than ${limit} distinct predicates`
    : bound === 'classes' ? `are typed with more than ${limit} distinct classes`
      : `state more than ${limit} distinct (subject, predicate) pairs in several graphs`;
  return `The file's records ${what}, the most a schema is inferred from; type it by hand (from: declared, shacl); nothing was imported`;
}

/** The support a term needs by default: a single stray record is not a type (the shape-extraction tools' reason for a support floor). */
export const INFER_MIN_SUPPORT_DEFAULT = 2;
/** The confidence a property needs by default: none, so the column's majority datatype is taken as the ticket asks. */
export const INFER_MIN_CONFIDENCE_DEFAULT = 0;
/** The most entries each list of the answer's `inferred` block names; each is counted whole. */
const INFERRED_NAMED_MAX =500;
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
  /** The most distinct (subject, predicate) pairs of subjects stated by several graphs the second pass remembers ({@link SCHEMA_INFER_MAX_PAIRS}). */
  maxPairs: number;
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
  /**
   * The plain labels of addresses whose groups state only labels and comments (one group per graph), and those groups' keys (skipped when the
   * address is a class that is inferred or one that is not: a label group is no record either way).
   */
  labelGroups: Map<string, { keys: string[]; labels: string[] }>;
  /** The digests of subjects stated by more than one group (a graph each): counted once, not once per group. */
  repeated: Set<string>;
  predicates: Set<string>;
}

/** The first pass's answer: what it read, or the bound (`predicates` or `classes`) the file passed and how far that bound reaches. */
export type DataClassesOrOver = DataClasses | { kind: 'over'; bound: 'predicates' | 'classes'; limit: number };

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
 * them, the labels of addresses described by labels alone, and the distinct predicates the subjects use. A file whose subjects use more distinct
 * predicates than `bounds.predicates`, or are typed with more distinct classes than `bounds.classes`, is `over` at the statement that passed it:
 * nothing after it is read. A subject's own statements are checked for membership through sets, so the work is linear in what the subject states.
 */
export async function gatherClasses(source: DataSource, bounds: { predicates: number; classes: number }): Promise<DataClassesOrOver> {
  const out: DataClasses = { kind: 'classes', classes: [], subjects: new Map(), count: [], markers: new Map(), labelGroups: new Map(), repeated: new Set(), predicates: new Set() };
  const index = new Map<string, number>();
  const seen = new Set<string>();
  for await (const group of source.groups()) {
    if (source.skip.has(group.key)) continue;
    const at = subjectOf(group, source);
    if (at === null) continue;
    const digest = digestOfKey(at.iri);
    if (seen.has(digest)) out.repeated.add(digest); else seen.add(digest);
    const typeStatements = new Set(at.types);
    for (const q of at.own) {
      if (q.predicate.value === RDFS_LABEL || q.predicate.value === RDFS_COMMENT || typeStatements.has(q)) continue;
      if (!out.predicates.has(q.predicate.value)) {
        out.predicates.add(q.predicate.value);
        if (out.predicates.size > bounds.predicates) return { kind: 'over', bound: 'predicates', limit: bounds.predicates };
      }
    }
    const marks = new Set<RecordKind>();
    const mine = new Set<number>();
    for (const q of at.types) {
      const read = classOfType(q.object);
      if (read.as === 'marker') marks.add(read.kind);
      if (read.as !== 'class') continue;
      let n = index.get(read.iri);
      if (n === undefined) {
        n = out.classes.length; index.set(read.iri, n); out.classes.push(read.iri); out.count.push(0);
        if (out.classes.length > bounds.classes) return { kind: 'over', bound: 'classes', limit: bounds.classes };
      }
      mine.add(n);
    }
    if (mine.size === 0) {
      if (at.types.length === 0 && at.own.every(q => q.predicate.value === RDFS_LABEL || q.predicate.value === RDFS_COMMENT)) {
        const labels = at.own.map(plainLabel).filter((l): l is string => l !== null);
        const held = out.labelGroups.get(at.iri);
        if (held === undefined) out.labelGroups.set(at.iri, { keys: [group.key], labels }); else { held.keys.push(group.key); held.labels.push(...labels); }
      }
      continue;
    }
    // A subject is counted once for a class however many groups (graphs) type it with it.
    const have = out.subjects.get(digest) ?? [];
    const haveSet = new Set(have);
    for (const n of mine) {
      if (!haveSet.has(n)) { have.push(n); haveSet.add(n); out.count[n] = (out.count[n] ?? 0) + 1; }
      if (marks.size > 0) { const set = out.markers.get(n) ?? new Set(); marks.forEach(k => set.add(k)); out.markers.set(n, set); }
    }
    out.subjects.set(digest, have);
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
export interface InferResult {
  built: BuiltType[]; inferred: InferredBlock; leaveOut: string[]; labelKeys: string[];
  /** The kind whose types the inference had taken past the cap on type definitions when it stopped (what it had built is not a schema): the proposal refuses. */
  overCap?: KnowledgeType;
  /** The second pass met more distinct pairs than `maxPairs` and stopped: the proposal refuses 413 and nothing it holds is a schema. */
  over?: { bound: 'pairs'; limit: number };
}

interface PairStats { kind: KnowledgeType; type: string; subjects: number; literals: number; multi: number; nodes: number; maxNodes: number; ends: Set<string>; open: Set<string> }

/** The number a clashing name's first renamed spelling takes (`Item_2`): the name itself is the first. */
const FIRST_NUMBER = 2;

/**
 * The names of one scope (a kind's types, a type's property keys) held so far. The one numbering rule of the inference: `wanted`, or the first
 * `wanted_<n>` that is not held, checked again by `valid` (a number can take a name past its length limit). Each base name is numbered from where
 * its last claim left off (a name is released only by {@link NameSet.release}, never reused for another claim of its base, so no spelling before
 * the counter can be free for a later claim to take), which makes a claim cost a constant number of probes however many names of one base were claimed.
 */
class NameSet {
  private readonly held: Set<string>;
  private readonly next = new Map<string, number>();
  /** The held names whose address is not the derived one: a stored name with an explicit `iri`, a reserved name, a name claimed for a foreign address. */
  private readonly foreign = new Set<string>();
  private readonly reserved: number;
  /** `defs`: the stored definitions by name; `reserved`: names held that no schema holds (they do not count toward the type cap). */
  constructor(defs: Record<string, unknown> | undefined, reserved: readonly string[], private readonly onClaim?: (probes: number) => void) {
    this.held = new Set(Object.keys(defs ?? {}));
    for (const name of this.held) if (hasExplicitIri(defs?.[name])) this.foreign.add(name);
    this.reserved = reserved.filter(name => !this.held.has(name)).length;
    for (const name of reserved) { this.held.add(name); this.foreign.add(name); }
  }
  /** How many names the scope holds that a schema holds. */
  get taken(): number { return this.held.size - this.reserved; }
  /**
   * A derived name: held as it is, never numbered (the vocabulary gives it, and a number would name another address). A name a stored or declared
   * term already holds under its derived address is the same term; `false` when another address took it.
   */
  hold(name: string): boolean {
    if (this.foreign.has(name)) return false;
    this.held.add(name);
    return true;
  }
  /** `wanted` or its first free numbered spelling, held now; `null` when that spelling is not valid. */
  claim(wanted: string, valid: (name: string) => boolean): string | null {
    let name = wanted;
    let probes = 1;
    let n = this.held.has(wanted) ? this.next.get(wanted) ?? FIRST_NUMBER : 0;
    while (n > 0) {
      name = `${wanted}_${n}`;
      probes += 1;
      if (!this.held.has(name)) break;
      n += 1;
    }
    this.onClaim?.(probes);
    if (!valid(name)) return null;
    this.held.add(name);
    this.foreign.add(name);
    if (n > 0) this.next.set(wanted, n + 1);
    return name;
  }
  /**
   * Give back a name `claim` returned that no type was built under (its definition turned out invalid), so the scope counts only built names
   * toward the type cap. A numbered name's number stays used: the next claim of its base goes on from there.
   */
  release(name: string): void {
    this.held.delete(name);
    this.foreign.delete(name);
  }
}

/** The names held per kind (stored, declared, inferred so far), and the first kind that holds more types than a kind may. */
class NameBook {
  private readonly sets = new Map<string, NameSet>();
  /** The first kind whose held names now pass the type cap, or `undefined` (a released name no longer counts). */
  get over(): KnowledgeType | undefined {
    for (const [kind, set] of this.sets) if (set.taken > MAX_TYPES_PER_KIND) return kind as KnowledgeType;
    return undefined;
  }
  constructor(typeSchemas: TypeSchemasByKind, private readonly onClaim?: (probes: number) => void) {
    for (const kind of Object.keys(typeSchemas) as KnowledgeType[]) {
      this.sets.set(kind, new NameSet(typeSchemas[kind] as Record<string, unknown> | undefined, kind === 'entity' ? [UNTYPED_MEMBER] : [], onClaim));
    }
  }
  private scope(kind: KnowledgeType): NameSet {
    let set = this.sets.get(kind);
    if (set === undefined) { set = new NameSet(undefined, [], this.onClaim); this.sets.set(kind, set); }
    return set;
  }
  /** A derived name held as it is; `false` when another address took it. */
  hold(kind: KnowledgeType, name: string): boolean {
    return this.scope(kind).hold(name);
  }
  /** `wanted`, or the first `wanted_<n>` free in `kind` that is still a valid name; `null` when none is. */
  claim(kind: KnowledgeType, wanted: string, valid: (name: string) => boolean): string | null {
    return this.scope(kind).claim(wanted, valid);
  }
  /** Give back a name `claim` returned for a type that is not built after all. */
  release(kind: KnowledgeType, name: string): void {
    this.scope(kind).release(name);
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

const capped = <T>(list: T[]): T[] => list.slice(0, INFERRED_NAMED_MAX);

const LISTS = ['types', 'properties', 'edges', 'mixed', 'multiValued', 'renamed', 'openEndpoints', 'notInferred', 'multiTyped'] as const;
/** The block as the answer names it: every list counted whole, then capped. */
function countedBlock(block: InferredBlock): InferredBlock {
  for (const list of LISTS) block.counts[list] = block[list].length;
  const out = { ...block } as InferredBlock;
  for (const list of LISTS) (out as unknown as Record<string, unknown[]>)[list] = capped(block[list] as unknown[]);
  return out;
}

/** The owners of a term the space or the file's declarations hold. */
type Owners = Extract<ReturnType<typeof termOfIri>, { answer: 'term' }>['owners'];

/**
 * What the steps of {@link inferFromData} share: the file, the names, and what each step decides for the next (the types for the second pass,
 * the pairs and columns for the properties and edge labels). Built by `inferFromData` alone; a step reads and fills it, never holds a copy.
 */
interface InferState {
  source: DataSource; classes: DataClasses; first: InferFirst; options: InferOptions;
  block: InferredBlock;
  book: NameBook;
  ctx: { names: AddressNames };
  builtTypes: Map<string, BuiltType>;
  typeOfClass: Map<number, TypeOf>;
  /** The classes the inference named and did not take: their subjects, and the label groups that describe them, are left out of the data. */
  prunedClasses: string[];
  /** The subjects each type (by {@link nameKey}) settled on. */
  typeSubjects: Map<string, number>;
  /** Per predicate, per type (by {@link nameKey}): what the subjects state. */
  pairs: Map<string, Map<string, PairStats>>;
  columns: Map<string, Record<Category, number>>;
  nodesOf: Map<string, number>;
  /** The (kind, type, predicate) pairs the translation leaves out of the data. */
  leaveOut: string[];
  /** The property keys of each type (by {@link nameKey}) held so far. */
  keysHeld: Map<string, NameSet>;
}

/** What the decision on one predicate shares between the checks every predicate meets and the property or edge label it turns out to be. */
interface PredicateCase {
  p: string;
  perType: Map<string, PairStats>;
  support: number;
  /** The owners of `p` that are a property of a type. */
  knownProp: Owners;
  read: Exclude<TermReading, { how: 'rejected' }>;
  column: Record<Category, number>;
  literals: number;
  /** Name the predicate not inferred, and leave its statements out of the data. */
  refuse: (why: string, extra?: Partial<NotInferred>) => void;
}

/** The types the inference built: an edge label, a type with a definition, and a type it named (a type with no definition is still a type). */
function builtOf(st: InferState): BuiltType[] {
  const typed = new Set(st.block.types.map(t => nameKey(t.kind, t.type)));
  return [...st.builtTypes.values()].filter(b => b.kind === 'edge' || Object.keys(b.def).length > 0 || typed.has(nameKey(b.kind, b.name)));
}

/** The inference stopped: a kind holds more types than the cap allows, whatever else the file says, so the proposal refuses and reads nothing more. */
const stoppedAt = (st: InferState, kind: KnowledgeType): InferResult => ({ built: builtOf(st), inferred: countedBlock(st.block), leaveOut: [], labelKeys: [], overCap: kind });

/** The type a subject settles on, as the translation's kind reader settles it: the schema's before the vocabulary's, then the first address. */
function pickOf(st: InferState, digest: string): TypeOf | null {
  const mine = (st.classes.subjects.get(digest) ?? []).map(n => st.typeOfClass.get(n)).filter((t): t is TypeOf => t !== undefined);
  if (mine.length === 0 || new Set(mine.map(t => t.kind)).size > 1) return null;
  return [...mine].sort((a, b) => Number(a.vocabulary) - Number(b.vocabulary) || byCodeUnit(a.iri, b.iri))[0]!;
}

/**
 * Step 1, the types: decide each class of pass 1 against the names after the declared answer, then count the subjects each type settles on and
 * give each type its confidence. `null`, or the answer the inference stopped with (a kind past the type cap).
 */
function inferTypes(st: InferState): InferResult | null {
  const { classes, options, block, book, builtTypes, typeOfClass, ctx, prunedClasses } = st;
  const derivedOf = new Map(classes.classes.map(iri => [iri, readTerm(ctx, iri).how === 'derived'] as const));
  const order = classes.classes.map((iri, n) => ({ iri, n })).sort((a, b) => byCodeUnit(a.iri, b.iri));
  const derivedFirst = [...order].sort((a, b) => Number(derivedOf.get(b.iri)) - Number(derivedOf.get(a.iri)));
  for (const { iri, n } of derivedFirst) {
    // A class the space or the file's declarations hold is theirs; one only the vocabulary reads is inferred under its derived name.
    const t = termOfIri(iri, ctx.names);
    if (t.answer === 'term' && t.how === 'schema' && t.owners.length > 0 && t.owners.every(w => w.prop === undefined)) {
      const owner = t.owners.length === 1 ? t.owners[0]! : undefined;
      if (owner && owner.kind !== 'file' && owner.type !== null) typeOfClass.set(n, { kind: owner.kind, name: owner.type, iri, vocabulary: false });
      continue;
    }
    const support = classes.count[n] ?? 0;
    const marks = classes.markers.get(n) ?? new Set<RecordKind>();
    const notInferred = (why: string): void => { block.notInferred.push({ iri, why, support }); prunedClasses.push(iri); };
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
      if (!book.hold(kind, name)) { notInferred('term-clash'); continue; }
    } else {
      const wanted = wantedName(iri, classes.labelGroups, validTypeName);
      if (wanted === null) { notInferred('no-name'); continue; }
      name = book.claim(kind, wanted, validTypeName);
      if (name === null) { notInferred('no-name'); continue; }
      if (name !== wanted) block.renamed.push({ iri, name, wanted, kind });
    }
    typeOfClass.set(n, { kind, name, iri, vocabulary: false });
    builtTypes.set(nameKey(kind, name), { kind, name, def: read.how === 'foreign' ? { iri } : {} });
    block.types.push({ kind, type: name, iri, support, confidence: 1 });
    if (book.over !== undefined) return stoppedAt(st, book.over);
  }
  const multi = new Map<number, number>();
  for (const [digest, list] of classes.subjects) {
    const pick = pickOf(st, digest);
    if (pick) st.typeSubjects.set(nameKey(pick.kind, pick.name), (st.typeSubjects.get(nameKey(pick.kind, pick.name)) ?? 0) + 1);
    if (list.length > 1) for (const n of list) multi.set(n, (multi.get(n) ?? 0) + 1);
  }
  for (const [n, subjects] of multi) block.multiTyped.push({ iri: classes.classes[n]!, subjects });
  for (const t of block.types) t.confidence = share(st.typeSubjects.get(nameKey(t.kind, t.type)) ?? 0, t.support);
  return null;
}

/**
 * Step 2, pass 2 over the file: per predicate and type, what the subjects state (their count, the literals and node objects, the ends of
 * edges), and per predicate the column of value categories. `null`, or the answer the inference stopped with (more distinct repeated pairs than
 * `maxPairs`).
 */
async function tallyPairs(st: InferState): Promise<InferResult | null> {
  const { source, classes, options, block, pairs, columns, nodesOf } = st;
  // A subject stated by several groups (a graph each) is one subject of a pair: only those subjects are remembered per pair.
  const countedPairs = new Set<string>();
  for await (const group of source.groups()) {
    if (source.skip.has(group.key)) continue;
    const at = subjectOf(group, source);
    if (at === null) continue;
    const digest = digestOfKey(at.iri);
    const pick = pickOf(st, digest);
    if (pick === null || (pick.kind !== 'entity' && pick.kind !== 'fact')) continue;
    const groupNames = source.namesOf(group.graph?.value);
    const byPredicate = new Map<string, Quad[]>();
    for (const q of at.own) {
      if (predicateRole(q.predicate.value, pick.kind as OpKind) !== 'other') continue;
      const list = byPredicate.get(q.predicate.value);
      if (list === undefined) byPredicate.set(q.predicate.value, [q]); else list.push(q);
    }
    for (const [p, qs] of byPredicate) {
      const typeKey = nameKey(pick.kind, pick.name);
      const perType = pairs.get(p) ?? new Map<string, PairStats>();
      pairs.set(p, perType);
      const stats = perType.get(typeKey) ?? { kind: pick.kind, type: pick.name, subjects: 0, literals: 0, multi: 0, nodes: 0, maxNodes: 0, ends: new Set(), open: new Set() };
      perType.set(typeKey, stats);
      if (!classes.repeated.has(digest)) stats.subjects += 1;
      else {
        // The subject settles on one type, so (subject, predicate) names the pair.
        const counted = `${digest}\u0000${p}`;
        if (!countedPairs.has(counted)) {
          countedPairs.add(counted);
          if (countedPairs.size > options.maxPairs) return { built: [], inferred: countedBlock(block), leaveOut: [], labelKeys: [], over: { bound: 'pairs', limit: options.maxPairs } };
          stats.subjects += 1;
        }
      }
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
        const end = pickOf(st, digestOfKey(q.object.value));
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
  return null;
}

/** The (kind, type, `p`) pairs of every type that states `p` are left out of the data. */
function leaveAll(st: InferState, perType: Map<string, PairStats>, p: string): void {
  for (const s of perType.values()) st.leaveOut.push(leaveOutKey(s.kind, s.type, p));
}

/** The definition under construction for a type, creating the type when the inference only now gives it a property. */
function propertiesOf(st: InferState, kind: KnowledgeType, type: string): Record<string, unknown> {
  const key = nameKey(kind, type);
  let built = st.builtTypes.get(key);
  if (built === undefined) { built = { kind, name: type, def: {} }; st.builtTypes.set(key, built); }
  return ((built.def['propertySchemas'] as Record<string, unknown> | undefined) ?? (built.def['propertySchemas'] = {})) as Record<string, unknown>;
}

/** The property keys of one type held so far: the stored ones, then the derived and inferred ones. */
function keysOf(st: InferState, kind: KnowledgeType, type: string): NameSet {
  const key = nameKey(kind, type);
  let held = st.keysHeld.get(key);
  if (held === undefined) {
    const stored = (st.first.typeSchemas[kind]?.[type] as { propertySchemas?: Record<string, unknown> } | undefined)?.propertySchemas ?? {};
    held = new NameSet(stored, [], st.first.onClaim);
    st.keysHeld.set(key, held);
  }
  return held;
}

/**
 * Step 4, one predicate that is an edge label (its objects are nodes): its name, its endpoints, `functional`, and whether the definition is valid.
 * `null`, or the answer the inference stopped with (a kind past the type cap).
 */
function inferEdges(st: InferState, c: PredicateCase): InferResult | null {
  const { classes, options, block, book, builtTypes, typeSubjects } = st;
  const { p, perType, support, knownProp, read, refuse } = c;
  // A predicate the space holds as a property of a type is not also an edge label: the two would share one address.
  if (knownProp.length > 0) { refuse('term-clash'); return null; }
  // An edge label: its ends must be the file's typed subjects, or records the space stores (which leave a side open).
  const all = [...perType.values()];
  if (all.some(s => s.open.has('end-not-described') || s.open.has('end-untyped'))) { refuse('end-not-described'); return null; }
  const subjectsOfTypes = all.reduce((n, s) => n + (typeSubjects.get(nameKey(s.kind, s.type)) ?? 0), 0);
  const confidence = share(support, subjectsOfTypes);
  if (support < options.minSupport) { refuse('support', { confidence }); return null; }
  if (confidence < options.minConfidence) { refuse('confidence', { confidence }); return null; }
  // What the answer says about this edge (its renaming, its open sides) is kept apart until its definition is known valid: a name given back
  // below is taken by a later edge, and an entry left in the block under it would be read as that edge's.
  const renamed: InferredBlock['renamed'] = [];
  const open: InferredBlock['openEndpoints'] = [];
  let name: string | null;
  if (read.how === 'derived') {
    if (read.kind !== 'edge' || read.prop !== undefined || read.type === null) { refuse('not-a-term'); return null; }
    name = read.type;
    if (!book.hold('edge', name)) { refuse('term-clash'); return null; }
  } else {
    const wanted = wantedName(p, classes.labelGroups, validTypeName);
    name = wanted === null ? null : book.claim('edge', wanted, validTypeName);
    if (wanted === null || name === null) { refuse('no-name'); return null; }
    if (name !== wanted) renamed.push({ iri: p, name, wanted, kind: 'edge' });
  }
  const def: Record<string, unknown> = read.how === 'foreign' ? { iri: p } : {};
  const endpoints: Record<string, string[]> = {};
  const side = (which: 'from' | 'to', typesOn: string[], why: string | null): void => {
    const members = typesOn.map(memberOf);
    if (why === null && typesOn.length > ENDPOINT_TYPES_MAX) why = 'too-many-types';
    if (why === null && members.some(m => m === null)) why = 'name-too-long';
    if (why !== null || typesOn.length === 0) { open.push({ type: name!, side: which, why: why ?? 'no-end' }); return; }
    endpoints[which] = (members as string[]).sort(byCodeUnit);
  };
  side('from', [...new Set(all.map(s => s.type))], all.some(s => s.kind !== 'entity') ? 'not-an-entity' : null);
  const toOpen = all.flatMap(s => [...s.open]);
  side('to', [...new Set(all.flatMap(s => [...s.ends]))], toOpen.includes('end-stored') ? 'end-stored' : toOpen.includes('not-an-entity') ? 'not-an-entity' : null);
  if (Object.keys(endpoints).length > 0) def['endpoints'] = endpoints;
  if (options.functional && all.every(s => s.maxNodes <= 1)) def['functional'] = true;
  if (!TypeSchemaZ.safeParse(def).success) {
    // The name was claimed for a type that is not built: it is given back, so the cap counts built names only.
    if (read.how !== 'derived') book.release('edge', name);
    refuse('invalid');
    return null;
  }
  block.renamed.push(...renamed);
  block.openEndpoints.push(...open);
  builtTypes.set(nameKey('edge', name), { kind: 'edge', name, def });
  block.edges.push({ kind: 'edge', type: name, iri: p, support, confidence });
  return book.over !== undefined ? stoppedAt(st, book.over) : null;
}

/** Step 3, one predicate whose objects are plain values: one datatype across every type, and its key and confidence on each type that states it. */
function inferProperties(st: InferState, c: PredicateCase): void {
  const { classes, options, block, first, typeSubjects, leaveOut } = st;
  const { p, perType, knownProp, read, column, literals, refuse } = c;
  // A property: one datatype for the predicate across every type (the term-clash rule holds one address to one declared type).
  const storedType = knownProp.map(w => (first.typeSchemas[w.kind as KnowledgeType]?.[w.type!] as { propertySchemas?: Record<string, { type?: unknown }> } | undefined)?.propertySchemas?.[w.prop!]?.type)[0];
  if (knownProp.length > 0 && (read.how === 'derived' || storedType === undefined)) { refuse('vocabulary-property'); return; }
  const { majority, share: held } = majorityOf(column);
  const kinds = (Object.keys(column) as Category[]).filter(k => column[k] > 0);
  if (kinds.length > 1) block.mixed.push({ predicate: p, counts: { ...column }, majority, share: share(column[majority ?? 'other'] ?? 0, literals) });
  if (majority === null) { refuse('other-only'); return; }
  if (held < options.minConfidence) { refuse('mixed', { confidence: share(column[majority], literals) }); return; }
  const datatype = (typeof storedType === 'string' ? storedType : majority) as Datatype;
  for (const s of [...perType.values()].sort((a, b) => byCodeUnit(a.type, b.type))) {
    const confidence = share(s.subjects, typeSubjects.get(nameKey(s.kind, s.type)) ?? 0);
    const pairNot = (why: string): void => {
      block.notInferred.push({ iri: p, why, kind: s.kind, type: s.type, support: s.subjects, confidence });
      leaveOut.push(leaveOutKey(s.kind, s.type, p));
    };
    // A stored type that is a library reference holds no property of its own: it is kept whole, so nothing is written to it.
    if (isLibraryReference(first.typeSchemas[s.kind]?.[s.type])) { pairNot('library-reference'); continue; }
    if (s.multi > 0) { block.multiValued.push({ kind: s.kind, type: s.type, predicate: p, subjects: s.multi }); pairNot('multi-valued'); continue; }
    if (s.subjects < options.minSupport) { pairNot('support'); continue; }
    if (confidence < options.minConfidence) { pairNot('confidence'); continue; }
    let key: string | null;
    if (read.how === 'derived') {
      if (read.prop === undefined || read.kind !== s.kind || read.type !== s.type) { pairNot('vocabulary-property'); continue; }
      if (!keysOf(st, s.kind, s.type).hold(read.prop)) { pairNot('term-clash'); continue; }
      key = read.prop;
    } else {
      const wanted = wantedName(p, classes.labelGroups, validPropertyKey);
      key = wanted === null ? null : keysOf(st, s.kind, s.type).claim(wanted, validPropertyKey);
      if (wanted === null || key === null) { pairNot('no-name'); continue; }
      if (key !== wanted) block.renamed.push({ iri: p, name: key, wanted, kind: s.kind, type: s.type });
    }
    propertiesOf(st, s.kind, s.type)[key] = { ...(read.how === 'foreign' ? { iri: p } : {}), type: datatype };
    block.properties.push({ kind: s.kind, type: s.type, prop: key, iri: p, datatype, support: s.subjects, confidence });
  }
}

/**
 * Steps 3 and 4: decide each predicate the second pass saw, in an order that gives a derived address its own name before a foreign one asks for it.
 * The checks every predicate meets come first; then it is an edge label ({@link inferEdges}) or a property ({@link inferProperties}).
 * `null`, or the answer the inference stopped with.
 */
function inferPredicates(st: InferState): InferResult | null {
  const { classes, block, pairs, columns, nodesOf, ctx } = st;
  const classSet = new Set(classes.classes);
  // A derived address takes its own name before any foreign address asks for one, so a foreign predicate is the one numbered.
  const derivedPredicate = new Map([...pairs.keys()].map(p => [p, readTerm(ctx, p).how === 'derived'] as const));
  for (const p of [...pairs.keys()].sort((a, b) => Number(derivedPredicate.get(b)) - Number(derivedPredicate.get(a)) || byCodeUnit(a, b))) {
    const perType = pairs.get(p)!;
    // Held terms are the space's or the declarations' (`how: schema`); an address only the vocabulary reads is inferred under its derived name.
    const t = termOfIri(p, ctx.names);
    const holders = t.answer === 'term' && t.how === 'schema' ? t.owners : [];
    const knownProp = holders.filter(w => w.prop !== undefined);
    if (holders.length > 0 && edgeLabelOf(p, ctx.names) !== null) continue;
    for (const [typeKey, s] of perType) if (knownProp.some(w => w.kind === s.kind && w.type === s.type)) perType.delete(typeKey);
    if (perType.size === 0) continue;
    const support = [...perType.values()].reduce((n, s) => n + s.subjects, 0);
    const refuse = (why: string, extra: Partial<NotInferred> = {}): void => { block.notInferred.push({ iri: p, why, support, ...extra }); leaveAll(st, perType, p); };
    if (t.answer === 'mapper-predicate') { refuse('reserved'); continue; }
    if (t.answer === 'product') { refuse('product'); continue; }
    if (t.answer === 'refused') { refuse('not-a-term'); continue; }
    if (classSet.has(p) || holders.some(w => w.prop === undefined)) { refuse('used-as-class'); continue; }
    const read = readTerm(ctx, p);
    if (read.how === 'rejected') { refuse('not-a-term'); continue; }
    const column = columns.get(p)!;
    const literals = TIE_ORDER.reduce((n, k) => n + column[k], column.other);
    const nodes = nodesOf.get(p) ?? 0;
    if (literals > 0 && nodes > 0) { refuse('literal-and-node'); continue; }
    const asked: PredicateCase = { p, perType, support, knownProp, read, column, literals, refuse };
    if (nodes > 0) {
      const stopped = inferEdges(st, asked);
      if (stopped !== null) return stopped;
    } else inferProperties(st, asked);
  }
  return null;
}

/** The answer: the types built, the block, the pairs left out, and the label groups left out with them. */
function answerOf(st: InferState): InferResult {
  const { block, classes, prunedClasses, leaveOut } = st;
  // A class not inferred is left out whole, and the label groups of an address described and not inferred are no record either.
  for (const iri of prunedClasses) leaveOut.push(leaveOutClassKey(iri));
  const leftOutIris = new Set([...block.types, ...block.properties, ...block.edges].map(t => t.iri).concat(prunedClasses));
  const labelKeys = [...classes.labelGroups].filter(([iri]) => leftOutIris.has(iri)).flatMap(([, g]) => g.keys);
  return { built: builtOf(st), inferred: countedBlock(block), leaveOut, labelKeys };
}

/**
 * Decide the types (from pass 1, against the names after the declared answer), read pass 2 (properties and edges per type, the ends of
 * edges), and decide the properties and edge labels: {@link inferTypes}, {@link tallyPairs}, {@link inferPredicates} (which asks
 * {@link inferEdges} or {@link inferProperties} of each predicate), then {@link answerOf}. A step that stops the inference (the type cap, the
 * pair bound) answers at once. Pure but for reading `source` again.
 */
export async function inferFromData(
  source: DataSource, classes: DataClasses, first: InferFirst, options: InferOptions,
): Promise<InferResult> {
  const st: InferState = {
    source, classes, first, options,
    block: { types: [], properties: [], edges: [], mixed: [], multiValued: [], renamed: [], openEndpoints: [], notInferred: [], multiTyped: [], counts: {} },
    book: new NameBook(first.typeSchemas, first.onClaim),
    ctx: { names: first.names },
    builtTypes: new Map(), typeOfClass: new Map(), prunedClasses: [],
    typeSubjects: new Map(), pairs: new Map(), columns: new Map(), nodesOf: new Map(), leaveOut: [], keysHeld: new Map(),
  };
  return inferTypes(st) ?? await tallyPairs(st) ?? inferPredicates(st) ?? answerOf(st);
}

/** Does a stored type or property definition give its term an address of its own (an explicit `iri`) instead of the derived one? */
function hasExplicitIri(def: unknown): boolean {
  return def !== null && typeof def === 'object' && typeof (def as { iri?: unknown }).iri === 'string';
}

/** Is `def`, a stored type definition, a reference to a library entry (kept whole, holding no field of its own)? */
function isLibraryReference(def: unknown): boolean {
  return def !== null && typeof def === 'object' && Object.hasOwn(def, '$ref');
}

