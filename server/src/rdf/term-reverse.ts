/**
 * An address the RDF export writes, read back to what it names: a record (its kind and id), or a term of a space's schema (a type, a
 * property, an edge label), for this space's base and vocab or for a source space's the caller names (bundle-270, slice S2, Q-752).
 *
 * ## What it prevents
 *
 * - **Two spellings of one address.** The import decides from an address alone whether a quad speaks about a record this space holds, a
 *   record of another space, or something foreign. An address is read as a record only when the forward rule (`recordIri`, `resolveTermIri`,
 *   `edgeClassIri`, in `term-iri.ts`), applied to what was decoded, gives the very address back. `entity/%65%31`, `entity/x%2fy` (lower-case
 *   hex), `entity/e1/`, `Entity/e1`, a raw space: each is "under the base, not an address the export writes", with its reason, never a
 *   record. So the reverse accepts exactly the forward rule's outputs and cannot drift from them: it holds no encoder and joins no base.
 * - **A kind read by the forward rule and not by this one.** The kinds read are one table typed over the forward module's `RecordKind`:
 *   a kind added there does not compile here until it is read.
 * - **The first of several.** A property address one schema gives to several types (an explicit `iri` they share) answers with every owner
 *   and says `shared`, never with the first.
 * - **The wrong base.** Of the bases an address lies under, the longest wins (this space's `.../ld/` and a source's `.../ld/a/`); on a
 *   tie the space's. A base is a whole address ending in `/`, so `.../kb/` is no start of `.../kb2/`.
 *
 * ## The answers
 *
 * `recordOfAddress`: `record` (kind, id), `record-part` (a chrono interval's `#start` and `#end` time nodes, the only fragments the export
 * writes on a record), `other` (an address of the base's own that is no record: the graph, the ontology, a schema version, an agent),
 * `refused` (under a base, not a spelling the export writes, with a `reason` code and a `message` that never repeats the address), or
 * `foreign` (under no base given). `termOfIri`: `term` (the owners, `shared`, and `how`: `schema` when the space's own schema declares the
 * address, `vocabulary` when only the vocab's Direct Mapping reads it, as for a type the schema does not declare or a source's term),
 * `product` (a `ythril:` term, with what it means), `mapper-predicate` (a predicate the record mapper writes on its own account),
 * `refused`, or `foreign`. `shapeOfAddress` reads the address of a SHACL shape the schema export writes
 * (`<base>schema/shape/<kind>/<type>[#<prop>]`) to its kind, type and property by the same rule: `shape`, `refused` with a reason, or `foreign`.
 *
 * ## State
 *
 * None. `addressNames` builds an immutable value from a meta (the space's RESOLVED one, library `$ref`s inlined, so an entry's `iri` is
 * seen) and an optional source; the caller keeps it and passes it to every read. Nothing here reads a store, a file or the network.
 */
import { KNOWLEDGE_TYPES, type KnowledgeType, type SpaceMeta } from '@ythril-network/schema';
import {
  agentIri, defaultVocabFor, namesOf, ontologyIri, recordAddressable, recordIri, resolveTermIri, shapeIri, versionIri,
  type RecordKind, type TermKind, type TermOwner,
} from './term-iri.js';
import { RDF_RESERVED_PREDICATES, YTHRIL_NS, YTHRIL_TERMS } from './ythril-vocabulary.js';

/** The base and vocab a side's addresses are written under. */
export interface RdfNames { base: string; vocab: string }

/** The names of a source space (an export of another space): its base, and its vocab, `<base>vocab/` when none is named. */
export interface SourceNames { base: string; vocab?: string }

/** Which names an address was read against. */
export type ReadOf = 'space' | 'source';

/** One side of a read: its names, and a meta with only those names, which the forward rule is applied to when an address is checked. */
interface Side extends RdfNames { readonly of: ReadOf; readonly derive: SpaceMeta }

/**
 * What the reads need, built once by {@link addressNames} and never changed: the sides (this space's, then the source's), and the terms the
 * space's own schema declares by address (an explicit `iri` included).
 */
export interface AddressNames {
  readonly sides: readonly Side[];
  readonly declared: ReadonlyMap<string, readonly TermOwner[]>;
}

/** Why an address is refused: it is under a base or a vocab and is not a spelling the export writes. */
export type RefusalReason =
  | 'unknown-kind'
  | 'under-vocabulary'
  | 'trailing-part'
  | 'empty-id'
  | 'empty-name'
  | 'bad-percent-encoding'
  | 'not-the-spelling-the-export-writes'
  | 'not-a-term-the-export-writes';

const REASON_TEXT: Readonly<Record<RefusalReason, string>> = Object.freeze({
  'unknown-kind': 'it is under the base but names no kind of record the export writes (entity, fact, edge, chrono, file)',
  'under-vocabulary': 'it is under the space\'s vocabulary, which names terms, never records',
  'trailing-part': 'it has a part after the id (a slash, a query or a fragment) the export does not write there',
  'empty-id': 'it names a record with no id, or a file path with an empty part',
  'empty-name': 'it names a type or a property with no name',
  'bad-percent-encoding': 'it holds a percent-escape that is not valid UTF-8',
  'not-the-spelling-the-export-writes': 'it is not the spelling the export writes for what it names (another case, an escape the export does not write, or a character it would escape)',
  'not-a-term-the-export-writes': 'it is not a term the export writes',
});

/** An address under a base or a vocab that is not an address the export writes. `message` says why in words and never repeats the address. */
export interface Refused { answer: 'refused'; of: ReadOf | 'ythril'; reason: RefusalReason; message: string }
/** An address under no name given. */
export interface Foreign { answer: 'foreign' }

/** What {@link recordOfAddress} answers. */
export type RecordRead =
  | { answer: 'record'; of: ReadOf; kind: RecordKind; id: string }
  | { answer: 'record-part'; of: ReadOf; kind: 'chrono'; id: string; part: 'start' | 'end' }
  | { answer: 'other'; of: ReadOf; what: 'graph' | 'ontology' | 'schema-version' | 'agent'; name?: string }
  | Refused
  | Foreign;

/** What {@link termOfIri} answers. `owners` holds every type or property that has the address: more than one means `shared`. */
export type TermRead =
  | { answer: 'term'; of: ReadOf; how: 'schema' | 'vocabulary'; owners: TermOwner[]; shared: boolean }
  | { answer: 'product'; name: string; termKind: 'class' | 'property'; meaning: string }
  | { answer: 'mapper-predicate'; iri: string }
  | Refused
  | Foreign;

/** The kinds of record the export gives an address, a table typed over the forward rule's `RecordKind`: a kind added there fails to compile here. */
const READ_KINDS = Object.freeze({ entity: true, fact: true, edge: true, chrono: true, file: true } satisfies Record<RecordKind, true>);
/** The kinds a term is named for, likewise typed over `TermKind`. */
const TERM_KINDS = Object.freeze({ entity: true, fact: true, edge: true, chrono: true, file: true } satisfies Record<TermKind, true>);

const isRecordKind = (s: string): s is RecordKind => Object.hasOwn(READ_KINDS, s);
const isTermKind = (s: string): s is TermKind => Object.hasOwn(TERM_KINDS, s);
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The kinds of record this module reads back: the forward rule's `RecordKind`s. */
export function recordKindsRead(): RecordKind[] {
  return Object.keys(READ_KINDS).filter(isRecordKind);
}

const sideOf = (of: ReadOf, names: RdfNames): Side => ({
  of, base: names.base, vocab: names.vocab, derive: { rdf: { enabled: true, base: names.base, vocab: names.vocab, baseEpoch: 0 } },
});

type DeclaredType = { propertySchemas?: Record<string, unknown> } | undefined;

/** The address of every type, property and edge label of `meta`, and the owners of each; an address several give lists them all, once each. */
function declaredTerms(meta: SpaceMeta): Map<string, TermOwner[]> {
  const index = new Map<string, TermOwner[]>();
  const add = (address: string, owner: TermOwner): void => {
    const owners = index.get(address) ?? [];
    if (!owners.some(o => o.kind === owner.kind && o.type === owner.type && o.prop === owner.prop)) owners.push(owner);
    index.set(address, owners);
  };
  const kinds = (meta.typeSchemas ?? {}) as Record<string, Record<string, DeclaredType> | undefined>;
  for (const kind of KNOWLEDGE_TYPES) {
    const types = Object.hasOwn(kinds, kind) ? kinds[kind] ?? {} : {};
    for (const [type, def] of Object.entries(types)) {
      if (type === '') continue;
      add(resolveTermIri(meta, kind, type), { kind, type });
      for (const prop of Object.keys(def?.propertySchemas ?? {})) {
        if (prop !== '') add(resolveTermIri(meta, kind, type, prop), { kind, type, prop });
      }
    }
  }
  return index;
}

/**
 * The names to read addresses against: this space's (from `meta`, the RESOLVED one; throws `RdfNotEnabled` for a space with RDF off) and
 * optionally a source's. A source base is an absolute address ending in `/` (throws otherwise); its vocab is `<base>vocab/` unless named.
 */
export function addressNames(meta: SpaceMeta, source?: SourceNames): AddressNames {
  const space = sideOf('space', namesOf(meta));
  const sides: Side[] = [space];
  if (source !== undefined) {
    if (typeof source.base !== 'string' || !ABSOLUTE.test(source.base) || !source.base.endsWith('/')) {
      throw new TypeError('a source base must be an absolute address ending in /');
    }
    if (source.vocab !== undefined && (typeof source.vocab !== 'string' || !ABSOLUTE.test(source.vocab))) {
      throw new TypeError('a source vocab must be an absolute address');
    }
    sides.push(sideOf('source', { base: source.base, vocab: source.vocab ?? defaultVocabFor(source.base) }));
  }
  return Object.freeze({ sides: Object.freeze(sides), declared: declaredTerms(meta) });
}

/** The side whose `key` the address starts with: the longest, the space's on a tie; null when none. */
function longest(address: string, names: AddressNames, key: 'base' | 'vocab'): Side | null {
  let best: Side | null = null;
  for (const side of names.sides) {
    if (address.startsWith(side[key]) && (best === null || side[key].length > best[key].length)) best = side;
  }
  return best;
}

const refuse = (of: ReadOf | 'ythril', reason: RefusalReason): Refused => ({ answer: 'refused', of, reason, message: `Not an address the export writes: ${REASON_TEXT[reason]}.` });

type Decoded = { ok: true; value: string } | { ok: false; reason: RefusalReason };

/** One segment's text, percent-decoded as UTF-8; a malformed escape is a refusal, never a throw. */
function decode(segment: string): string | null {
  try { return decodeURIComponent(segment); } catch { return null; }
}

/** The name an id or a name part of an address holds: its segments decoded and joined by `/` (a file path has several, anything else one). */
function nameOf(tail: string, multi: boolean): Decoded {
  const parts = multi ? tail.split('/') : [tail];
  const decoded: string[] = [];
  for (const part of parts) {
    const text = decode(part);
    if (text === null) return { ok: false, reason: 'bad-percent-encoding' };
    decoded.push(text);
  }
  return { ok: true, value: decoded.join('/') };
}

/** Does `tail` hold a part the export writes after a name: a `#` or `?` anywhere, a `/` where the name is one segment? */
const hasTrailingPart = (tail: string, multi: boolean): boolean => tail.includes('#') || tail.includes('?') || (!multi && tail.includes('/'));

/**
 * What a record address names. `address` is an IRI as the file spells it. An address under the base (or the source's) and not a spelling
 * the forward rule writes is `refused` with its reason; under no base it is `foreign`. Pure.
 */
export function recordOfAddress(address: string, names: AddressNames): RecordRead {
  const side = longest(address, names, 'base');
  if (side === null) return { answer: 'foreign' };
  const { of } = side;
  if (names.sides.some(s => s.vocab.length > side.base.length && s.vocab.startsWith(side.base) && address.startsWith(s.vocab))) return refuse(of, 'under-vocabulary');
  const rest = address.slice(side.base.length);
  if (rest === '') return { answer: 'other', of, what: 'graph' };
  const slash = rest.indexOf('/');
  const head = slash < 0 ? rest : rest.slice(0, slash);
  if (slash < 0) return head === 'schema' && ontologyIri(side.derive) === address ? { answer: 'other', of, what: 'ontology' } : refuse(of, 'unknown-kind');
  const tail = rest.slice(slash + 1);
  if (head === 'agent' || head === 'schema') return otherOf(side, address, head, tail);
  if (!isRecordKind(head)) return refuse(of, 'unknown-kind');

  // A chrono interval's time nodes are `#start` and `#end` of the record: the only fragments the export writes on one.
  let part: 'start' | 'end' | null = null;
  let idTail = tail;
  const hash = tail.indexOf('#');
  if (head === 'chrono' && hash >= 0) {
    const fragment = tail.slice(hash + 1);
    if (fragment === 'start' || fragment === 'end') { part = fragment; idTail = tail.slice(0, hash); }
  }
  const multi = head === 'file';
  if (hasTrailingPart(idTail, multi)) return refuse(of, 'trailing-part');
  if (idTail === '') return refuse(of, 'empty-id');
  const named = nameOf(idTail, multi);
  if (!named.ok) return refuse(of, named.reason);
  if (!recordAddressable(head, named.value)) return refuse(of, 'empty-id');
  const spelled = part === null ? address : address.slice(0, address.length - part.length - 1);
  if (recordIri(side.derive, head, named.value) !== spelled) return refuse(of, 'not-the-spelling-the-export-writes');
  return part === null ? { answer: 'record', of, kind: head, id: named.value } : { answer: 'record-part', of, kind: 'chrono', id: named.value, part };
}

/** The addresses of the base's own that are no record: an agent (`agent/<name>`) and a schema version (`schema/<fingerprint>`). */
function otherOf(side: Side, address: string, head: 'agent' | 'schema', tail: string): RecordRead {
  const { of } = side;
  if (hasTrailingPart(tail, false)) return refuse(of, 'trailing-part');
  if (tail === '') return refuse(of, 'empty-id');
  const named = nameOf(tail, false);
  if (!named.ok) return refuse(of, named.reason);
  const written = head === 'agent' ? agentIri(side.derive, named.value) : versionIri(side.derive, named.value);
  if (written !== address) return refuse(of, 'not-the-spelling-the-export-writes');
  return { answer: 'other', of, what: head === 'agent' ? 'agent' : 'schema-version', name: named.value };
}

/** The owner of a derived term: `prop` is left off a type. */
const ownerOf = (kind: TermKind, type: string | null, prop: string | null): TermOwner => (prop === null ? { kind, type } : { kind, type, prop });

/** Reads an address under a vocab by the Direct Mapping's inverse; the forward rule must give the address back. */
function termOfVocabulary(side: Side, address: string): TermRead {
  const { of } = side;
  const rest = address.slice(side.vocab.length);
  const hash = rest.indexOf('#');
  const document = hash < 0 ? rest : rest.slice(0, hash);
  const fragment = hash < 0 ? null : rest.slice(hash + 1);
  const slash = document.indexOf('/');
  const kind = slash < 0 ? document : document.slice(0, slash);
  if (!isTermKind(kind)) return refuse(of, 'unknown-kind');
  if (fragment === '') return refuse(of, 'empty-name');
  let type: string | null = null;
  if (slash >= 0) {
    // A type of a file does not exist: files have properties only.
    if (kind === 'file') return refuse(of, 'not-a-term-the-export-writes');
    const typeText = document.slice(slash + 1);
    if (typeText === '') return refuse(of, 'empty-name');
    if (hasTrailingPart(typeText, false)) return refuse(of, 'trailing-part');
    const named = nameOf(typeText, false);
    if (!named.ok) return refuse(of, named.reason);
    type = named.value;
  } else if (fragment === null || (kind !== 'entity' && kind !== 'file')) {
    // A bare `<vocab>entity` or `<vocab>file` is the document an untyped entity's or a file's properties are fragments of; the forward rule
    // names no term by it (an untyped entity's class is `ythril:Untyped`), and only an entity or a file has properties without a type.
    return refuse(of, 'not-a-term-the-export-writes');
  }
  let prop: string | null = null;
  if (fragment !== null) {
    const named = nameOf(fragment, false);
    if (!named.ok) return refuse(of, named.reason);
    prop = named.value;
  }
  if (resolveTermIri(side.derive, kind, type, prop ?? undefined) !== address) return refuse(of, 'not-the-spelling-the-export-writes');
  return { answer: 'term', of, how: 'vocabulary', owners: [ownerOf(kind, type, prop)], shared: false };
}

/**
 * What a term address names. An address the space's own schema declares answers with every owner (an explicit `iri` several types share
 * included); a `ythril:` term answers with what it means; a predicate the mapper writes on its own account says so; an address under a vocab
 * (the space's, or the source's) is read by the Direct Mapping's inverse; anything else is `foreign`. Pure.
 */
export function termOfIri(address: string, names: AddressNames): TermRead {
  const declared = names.declared.get(address);
  if (declared !== undefined) return { answer: 'term', of: 'space', how: 'schema', owners: declared.map(o => ({ ...o })), shared: declared.length > 1 };
  if (address.startsWith(YTHRIL_NS)) {
    const name = address.slice(YTHRIL_NS.length);
    const row = YTHRIL_TERMS.find(t => t.name === name);
    return row === undefined ? refuse('ythril', 'not-a-term-the-export-writes') : { answer: 'product', name, termKind: row.kind, meaning: row.comment };
  }
  if (RDF_RESERVED_PREDICATES.includes(address)) return { answer: 'mapper-predicate', iri: address };
  const side = longest(address, names, 'vocab');
  return side === null ? { answer: 'foreign' } : termOfVocabulary(side, address);
}

/** What {@link shapeOfAddress} answers: the kind, type and (for a property shape) property a shape address names. */
export type ShapeRead =
  | { answer: 'shape'; of: ReadOf; kind: KnowledgeType; type: string; prop?: string }
  | Refused
  | Foreign;

const SHAPE_PATH = 'schema/shape/';
const isShapeKind = (s: string): s is KnowledgeType => (KNOWLEDGE_TYPES as readonly string[]).includes(s);

/**
 * What a SHACL shape address names (`<base>schema/shape/<kind>/<seg(type)>[#<frag(prop)>]`, the schema export's). Read only when the forward
 * rule (`shapeIri`) applied to what was decoded gives the very address back, as every read of this module is; an address under a base's
 * `schema/shape/` that is not that spelling is `refused` with its reason (a file has no shape, so `file` is an unknown kind here), and one under
 * no base's shape path is `foreign`. Of the bases an address lies under, the longest wins. Pure.
 */
export function shapeOfAddress(address: string, names: AddressNames): ShapeRead {
  let side: Side | null = null;
  for (const candidate of names.sides) {
    const under = address.startsWith(candidate.base) && address.slice(candidate.base.length).startsWith(SHAPE_PATH);
    if (under && (side === null || candidate.base.length > side.base.length)) side = candidate;
  }
  if (side === null) return { answer: 'foreign' };
  const { of } = side;
  const rest = address.slice(side.base.length + SHAPE_PATH.length);
  const slash = rest.indexOf('/');
  const kind = slash < 0 ? rest : rest.slice(0, slash);
  if (!isShapeKind(kind)) return refuse(of, 'unknown-kind');
  if (slash < 0) return refuse(of, 'empty-name');
  const tail = rest.slice(slash + 1);
  const hash = tail.indexOf('#');
  const typeText = hash < 0 ? tail : tail.slice(0, hash);
  const fragment = hash < 0 ? null : tail.slice(hash + 1);
  if (typeText === '' || fragment === '') return refuse(of, 'empty-name');
  if (hasTrailingPart(typeText, false)) return refuse(of, 'trailing-part');
  const type = nameOf(typeText, false);
  if (!type.ok) return refuse(of, type.reason);
  let prop: string | undefined;
  if (fragment !== null) {
    const named = nameOf(fragment, false);
    if (!named.ok) return refuse(of, named.reason);
    prop = named.value;
  }
  if (shapeIri(side.derive, kind, type.value, prop) !== address) return refuse(of, 'not-the-spelling-the-export-writes');
  return prop === undefined ? { answer: 'shape', of, kind, type: type.value } : { answer: 'shape', of, kind, type: type.value, prop };
}

