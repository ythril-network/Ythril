/**
 * The types and properties a schema file declares, as drafts: what each statement claims, before any claim is believed (bundle-270, slice S8).
 *
 * ## What it prevents
 *
 * - **A choice nobody made.** A statement does not set a field, it CLAIMS a value for it; a draft collects every claim, and {@link mergeClaims}
 *   believes a field only when its claims agree. Two claims that differ are a contradiction the caller refuses with both statements, never the
 *   first, never the stricter one.
 * - **A name read from the wrong place.** A type or property is named by the address the space's own rules give it (a vocabulary address, a
 *   shape address), else by its label, else by the local part of its address: {@link chooseName} reads the strongest level that speaks and
 *   refuses two names at that level, so `rdfs:label "Thing"` beside `sh:name "Item"` is a contradiction and a label under a vocabulary address
 *   that names another type is named, not obeyed.
 * - **A name that cannot be a key.** A name must be one a schema can hold (a type name as `isDeclarableTypeName`, a property key as the schema
 *   package reads one); one that is none is no type, never a rewritten one.
 *
 * Pure.
 */
import { isDeepStrictEqual } from 'node:util';
import type { KnowledgeType } from '@ythril-network/schema';
import { isDeclarableTypeName, isObjectInternalKey } from '@ythril-network/schema/internal';
import type { IriTerm, BlankTerm } from './literals.js';
import { recordOfAddress, termOfIri, type AddressNames } from './term-reverse.js';
import { stmtRef, type Ledger, type Place, type SchemaSource, type StatementRef, type Stmt, type Store } from './schema-from-rdf-store.js';

/** One statement's claim on a field of a type or a property (`field` is a path: `minimum`, `retention.days`, `endpoints.from`, `rules.<name>`). */
export interface Claim { field: string; value: unknown; stmt: Stmt; source: SchemaSource; order: number }

/** How strongly a name is stated: by an address the space's rules read, by a label, by the name the space's own schema gives the address, by the local part of an address. */
export type NameLevel = 'address' | 'label' | 'stored' | 'local';
export interface NameCandidate { text: string; level: NameLevel; stmt?: Stmt; source: SchemaSource }

/** A statement that names something rather than sets a field (`(declaration)`, `(owner)`, `(reifier)`): taken once the draft has its name. */
export interface Structural { stmt: Stmt; field: string; source: SchemaSource; value?: unknown; declared?: boolean }

/** Something that collects claims, structural statements and name candidates. */
export class Draft {
  readonly claims: Claim[] = [];
  readonly names: NameCandidate[] = [];
  readonly structure: Structural[] = [];

  claim(field: string, value: unknown, stmt: Stmt, source: SchemaSource): void {
    this.claims.push({ field, value, stmt, source, order: this.claims.length });
  }
  /** `stmt` is read as `field` (a pseudo-field) of this draft. */
  structural(field: string, stmt: Stmt, source: SchemaSource, extra: { value?: unknown; declared?: boolean } = {}): void {
    this.structure.push({ stmt, field, source, ...extra });
  }
  nameBy(text: string, level: NameLevel, source: SchemaSource, stmt?: Stmt): void {
    this.names.push({ text, level, source, ...(stmt === undefined ? {} : { stmt }) });
  }
}

/** A property of a draft type, identified by its term's address within the type. */
export class PropDraft extends Draft {
  name: string | undefined;
  constructor(readonly termIri: string) { super(); }
}

/** A type the file declares: a class, or an edge label, by the address of its term. */
export class TypeDraft extends Draft {
  kind: KnowledgeType | undefined;
  name: string | undefined;
  /** A draft the file contradicts or cannot name: it is read no further. */
  broken = false;
  /** The statements that make the term a class, and those that make it an edge label (a term that is both is a contradiction). */
  readonly classStmts: Stmt[] = [];
  readonly labelStmts: Stmt[] = [];
  readonly kinds: Array<{ kind: KnowledgeType; stmt: Stmt; source: SchemaSource }> = [];
  readonly shapes: Array<IriTerm | BlankTerm> = [];
  readonly props = new Map<string, PropDraft>();
  constructor(readonly termIri: string) { super(); }

  prop(termIri: string): PropDraft {
    let draft = this.props.get(termIri);
    if (draft === undefined) { draft = new PropDraft(termIri); this.props.set(termIri, draft); }
    return draft;
  }
}

/** Why a file is refused: it contradicts itself, two addresses give one name, the space has a schema already, or the file is too large. */
export type RefusalCode = 'contradiction' | 'name-collision' | 'schema-not-empty' | 'too-large' | 'invalid-schema';

/** A refusal: in words, and the statements it is about (two at least for a contradiction and a collision). */
export interface SchemaRefusal { code: RefusalCode; message: string; statements: StatementRef[]; where?: Place; field?: string }

/** What the two readers share while they read one file. */
export interface ReadContext {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly names: AddressNames;
  /** The types the file declares, by the address of their term. */
  readonly drafts: Map<string, TypeDraft>;
  /** The types by kind and name, once named. */
  readonly byName: Map<string, TypeDraft>;
  /** The subjects (index keys) whose every statement the reader answers for. */
  readonly owned: Set<string>;
  readonly refusals: SchemaRefusal[];
  /** The addresses of classes that are an edge label's reifiers. */
  readonly reifiers: string[];
  /** The addresses the declarations of which contradict each other: read no further. */
  readonly skip: Set<string>;
}

/** What a term's address says of itself under the space's names (and a source's). */
export type TermReading =
  /** Under no name of the space's: its address is its own. `stored` is the type or property the space's own schema gives that explicit address, if it does. */
  | { how: 'foreign'; stored?: { kind: KnowledgeType; type: string; prop?: string } }
  | { how: 'derived'; kind: KnowledgeType | 'file'; type: string | null; prop?: string }
  | { how: 'rejected'; why: 'no-field' | 'unreadable-value'; message: string };

/** The address of a type or property term, read by the space's rules: derived from its vocabulary, foreign, or no term the schema can hold. */
export function readTerm(ctx: Pick<ReadContext, 'names'>, address: string): TermReading {
  const read = termOfIri(address, ctx.names);
  switch (read.answer) {
    case 'foreign':
      // Under the space's base (or a source's) lie its records, its ontology and its agents: no term of a schema has an address there.
      return recordOfAddress(address, ctx.names).answer === 'foreign' ? { how: 'foreign' }
        : { how: 'rejected', why: 'no-field', message: 'it is an address under the space\'s base, where its records, ontology and agents live, so no type or property is mapped to it' };
    case 'refused': return { how: 'rejected', why: 'unreadable-value', message: read.message };
    case 'product': return { how: 'rejected', why: 'no-field', message: 'it is a term of the product\'s own vocabulary, which no type or property of a schema is' };
    case 'mapper-predicate': return { how: 'rejected', why: 'no-field', message: 'it is a predicate the record mapper writes on every record, so no property of a schema is mapped to it' };
    case 'term': {
      const owner = read.owners[0];
      if (owner === undefined) return { how: 'foreign' };
      // An address the space's own schema declares outside its vocabulary is an explicit `iri` of a stored term: it is the file's own address,
      // which the space knows by a name. One under its vocabulary is the derived name, whether the schema declares the term or not.
      if (read.how === 'schema' && !ctx.names.sides.some(side => address.startsWith(side.vocab))) {
        return owner.kind === 'file' || owner.type === null ? { how: 'foreign' }
          : { how: 'foreign', stored: { kind: owner.kind, type: owner.type, ...(owner.prop === undefined ? {} : { prop: owner.prop }) } };
      }
      return { how: 'derived', kind: owner.kind, type: owner.type, ...(owner.prop === undefined ? {} : { prop: owner.prop }) };
    }
  }
}

/** The key of a type by kind and name. */
export const nameKey = (kind: KnowledgeType, name: string): string => `${kind}\u0000${name}`;

/** The draft of the term at `termIri`, made when the file first speaks of it. */
export function draftOf(ctx: ReadContext, termIri: string): TypeDraft {
  let draft = ctx.drafts.get(termIri);
  if (draft === undefined) { draft = new TypeDraft(termIri); ctx.drafts.set(termIri, draft); }
  return draft;
}

/** Refuse: answers `message` and names `statements`, which then count as named. */
export function refuseWith(ctx: ReadContext, code: RefusalCode, message: string, statements: readonly Stmt[], extra: { where?: Place; field?: string } = {}): void {
  for (const s of statements) ctx.ledger.refuse(s);
  ctx.refusals.push({ code, message, statements: statements.map(stmtRef), ...extra });
}

/** Can a schema hold a type of this name? */
export const validTypeName = (name: string): boolean => isDeclarableTypeName(name);
/** Can a schema hold a property of this key? */
export const validPropertyKey = (name: string): boolean => name.length >= 1 && name.length <= PROPERTY_KEY_MAX && !isObjectInternalKey(name);
/** The longest property key a schema holds (`PropertySchemas` keys are at most 200 characters). */
const PROPERTY_KEY_MAX = 200;

const LEVELS: readonly NameLevel[] = Object.freeze(['address', 'label', 'stored', 'local']);

export type NameChoice =
  | { ok: true; name: string; agreeing: NameCandidate[]; demoted: NameCandidate[] }
  | { ok: false; reason: 'none' }
  | { ok: false; reason: 'invalid'; text: string }
  | { ok: false; reason: 'conflict'; a: NameCandidate; b: NameCandidate };

/** The name the candidates give: the strongest level that has one, refused when that level has two, and when the name is one `valid` refuses. */
export function chooseName(candidates: readonly NameCandidate[], valid: (name: string) => boolean): NameChoice {
  for (const level of LEVELS) {
    const here = candidates.filter(c => c.level === level);
    const first = here[0];
    if (first === undefined) continue;
    const other = here.find(c => c.text !== first.text);
    if (other !== undefined) return { ok: false, reason: 'conflict', a: first, b: other };
    if (!valid(first.text)) return { ok: false, reason: 'invalid', text: first.text };
    return { ok: true, name: first.text, agreeing: candidates.filter(c => c.text === first.text), demoted: candidates.filter(c => c.text !== first.text) };
  }
  return { ok: false, reason: 'none' };
}

/** What follows the last `#`, `/` or `:` of an address. */
const LOCAL_PART = /[^#/:]*$/;

/** The local part of an address: what follows its last `#`, `/` or `:`, percent-decoded; `''` when there is none or it will not decode. */
export function localPart(address: string): string {
  const tail = LOCAL_PART.exec(address)?.[0] ?? '';
  try { return decodeURIComponent(tail); } catch { return ''; }
}

/** Fields whose value is a set: two claims agree when they hold the same members, whatever order they were written in. */
const SET_FIELDS: ReadonlySet<string> = new Set(['enum', 'endpoints.from', 'endpoints.to']);

/** Do two claims on `field` say the same? */
export function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (SET_FIELDS.has(field) && Array.isArray(a) && Array.isArray(b)) {
    const key = (list: unknown[]): string[] => list.map(m => JSON.stringify(m)).sort();
    return isDeepStrictEqual(key(a), key(b));
  }
  return isDeepStrictEqual(a, b);
}

export interface Merged {
  /** The believed value of each field and the claims that state it, first claim first (a shape before an axiom, then file order). */
  fields: Map<string, { value: unknown; claims: Claim[] }>;
  /** Two claims that differ, one pair per field. */
  conflicts: Array<{ field: string; a: Claim; b: Claim }>;
}

const rank = (c: Claim): number => (c.source === 'shacl' ? 0 : 1);

/** Group the claims by field; a field is believed when all its claims agree. */
export function mergeClaims(claims: readonly Claim[]): Merged {
  const sorted = [...claims].sort((x, y) => rank(x) - rank(y) || x.order - y.order);
  const grouped = new Map<string, Claim[]>();
  for (const claim of sorted) {
    const held = grouped.get(claim.field);
    if (held === undefined) grouped.set(claim.field, [claim]); else held.push(claim);
  }
  const fields: Merged['fields'] = new Map();
  const conflicts: Merged['conflicts'] = [];
  for (const [field, held] of grouped) {
    const first = held[0]!;
    const other = held.find(c => !sameValue(field, first.value, c.value));
    if (other !== undefined) conflicts.push({ field, a: first, b: other });
    else fields.set(field, { value: first.value, claims: held });
  }
  return { fields, conflicts };
}
