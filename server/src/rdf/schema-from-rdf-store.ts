/**
 * The statements of a schema file, indexed, and the ledger that says what became of each (bundle-270, slice S8, Q-754).
 *
 * ## What it prevents
 *
 * - **A statement lost.** Every statement the schema reader takes is in the ledger as a `taken` entry (the field it set) and every statement it
 *   names is a `notTaken` entry (why); a statement about a term or shape the reader owns that is in neither is found by {@link Ledger.sweep} and
 *   named, so a predicate the reader has no code for is reported, never passed over. The counts (`taken`, `notTaken`, `outside`) are computed
 *   from the entries and sum to the file's statements.
 * - **A list read two ways, or without an end.** {@link Store.list} reads a collection both as the model's list term (what the schema export
 *   writes) and as the `rdf:first` / `rdf:rest` chain the import parser yields, refuses a chain with no end or a cell that says two things, and
 *   is bounded.
 * - **A literal read as a guess.** {@link plainText}, {@link literalValue} and {@link wholeNumber} read a literal as the schema field's value
 *   only when the value is exactly what the literal says (a decimal whose double does not print back is unreadable, a language tag is no
 *   plain text), and answer `null` otherwise.
 *
 * Pure: no store, no file, no network.
 */
import type { KnowledgeType } from '@ythril-network/schema';
import { decimalLexical, temporalKind, type BlankTerm, type IriTerm, type Quad, type Term } from './literals.js';
import { STANDARD_PREFIXES, YTHRIL_NS } from './ythril-vocabulary.js';

/** The most statements a schema file may hold: a schema is a few thousand; above this the reader answers `too-large` and reads nothing. */
export const SCHEMA_RDF_MAX_QUADS = 500_000;
/** The most members of one collection (an enumeration, a choice): a longer list is not read. */
export const SCHEMA_RDF_MAX_LIST = 10_000;
/** The deepest nesting of blank nodes the reader follows when it counts what a statement covers. */
const COVER_MAX_DEPTH = 64;
/** The longest text of an object an entry carries. */
const TEXT_MAX = 200;

const ns = (prefix: string): string => STANDARD_PREFIXES[prefix] ?? '';
export const RDF = (local: string): string => ns('rdf').concat(local);
export const RDFS = (local: string): string => ns('rdfs').concat(local);
export const OWL = (local: string): string => ns('owl').concat(local);
export const SH = (local: string): string => ns('sh').concat(local);
export const XSD = (local: string): string => ns('xsd').concat(local);
export const YTHRIL = (local: string): string => YTHRIL_NS.concat(local);

/** The vocabularies an entry names a term in, so a constraint reads `sh:minCount`. */
const SHORT_PREFIXES: readonly string[] = Object.freeze(['rdf', 'rdfs', 'owl', 'xsd', 'sh']);
/** An address as its prefixed name when a standard vocabulary of the schema's own is its start, else as it is. */
export function short(address: string): string {
  for (const name of SHORT_PREFIXES) if (address.startsWith(ns(name))) return `${name}:${address.slice(ns(name).length)}`;
  return address.startsWith(YTHRIL_NS) ? `ythril:${address.slice(YTHRIL_NS.length)}` : address;
}

/** A term as the text an entry shows: an address short or whole, a literal quoted with its datatype or language, a node by its label. */
export function termText(term: Term): string {
  let text: string;
  switch (term.kind) {
    case 'iri': text = short(term.value); break;
    case 'blank': text = `_:${term.id}`; break;
    case 'literal': text = `"${term.value}"${term.language !== undefined ? '@'.concat(term.language) : term.datatype !== undefined ? '^^'.concat(short(term.datatype)) : ''}`; break;
    case 'list': text = '(a list)'; break;
    case 'triple': text = '(a triple term)'; break;
  }
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}...` : text;
}

/** The text of a subject: an address, or `_:label` for a blank node. */
export const subjectText = (s: IriTerm | BlankTerm): string => (s.kind === 'iri' ? s.value : `_:${s.id}`);
/** The index key of a subject. */
export const keyOf = (s: IriTerm | BlankTerm): string => (s.kind === 'iri' ? `i:${s.value}` : `b:${s.id}`);

/** One statement of the file, numbered in the order it was handed in. */
export interface Stmt { readonly i: number; readonly quad: Quad }

/** Where in the schema a statement was read to: a type, or a property of one. */
export interface Place { kind: KnowledgeType; type: string; prop?: string }
/** Which declarations a statement was read from. */
export type SchemaSource = 'declared' | 'shacl';

/** Why a statement is not taken. */
export type NotTakenWhy =
  | 'no-field' | 'looser-field' | 'unreadable-value' | 'space-level' | 'export-description' | 'second-value' | 'kept-as-stored' | 'no-owner';

/** A statement taken: the field it set (a pseudo-field in parentheses when it names rather than sets), and the value. */
export interface TakenEntry {
  source: SchemaSource; subject: string; constraint: string; object: string; field: string; where: Place; value?: unknown;
  /** For a statement that names a class or a label as a type's address: whether the file itself declares it (an OWL class, an object property). */
  declared?: boolean;
}
/** A statement named, never dropped: the shape or term, the constraint, why, and in words. */
export interface NotTakenEntry { subject: string; constraint: string; object: string; why: NotTakenWhy; message: string; where?: Place }
/** A statement named in a refusal. */
export interface StatementRef { subject: string; constraint: string; object: string }

/** A statement as its subject, constraint and object, in the words an entry and a refusal show. */
export function stmtRef(stmt: { quad: Quad }): StatementRef {
  return { subject: subjectText(stmt.quad.subject), constraint: short(stmt.quad.predicate.value), object: termText(stmt.quad.object) };
}

/** An entry and the numbers of the statements it accounts for (its own and those of the nodes it opens). */
interface Held<T> { entry: T; ids: number[] }

/** The statements of a file by subject, and the readers of what hangs off them. */
export class Store {
  readonly all: Stmt[] = [];
  private readonly bySubject = new Map<string, Stmt[]>();

  constructor(quads: Iterable<Quad>) {
    for (const quad of quads) {
      const stmt: Stmt = { i: this.all.length, quad };
      this.all.push(stmt);
      const key = keyOf(quad.subject);
      const held = this.bySubject.get(key);
      if (held === undefined) this.bySubject.set(key, [stmt]); else held.push(stmt);
    }
  }

  /** The statements about `subject`, of `predicate` (an address) when given. */
  of(subject: IriTerm | BlankTerm, predicate?: string): Stmt[] {
    const held = this.bySubject.get(keyOf(subject)) ?? [];
    return predicate === undefined ? held : held.filter(s => s.quad.predicate.value === predicate);
  }
  /** The statements about the address `subject`. */
  ofIri(subject: string, predicate?: string): Stmt[] {
    return this.of({ kind: 'iri', value: subject }, predicate);
  }
  /** The subjects (addresses and blank nodes) that state one of `types` with `rdf:type`, once each, in file order. */
  withType(types: readonly string[]): Array<IriTerm | BlankTerm> {
    const seen = new Set<string>();
    const out: Array<IriTerm | BlankTerm> = [];
    for (const s of this.all) {
      if (s.quad.predicate.value !== RDF('type') || s.quad.object.kind !== 'iri' || !types.includes(s.quad.object.value)) continue;
      const key = keyOf(s.quad.subject);
      if (!seen.has(key)) { seen.add(key); out.push(s.quad.subject); }
    }
    return out;
  }
  /** The subjects that state `predicate`, once each, in file order. */
  withPredicate(predicates: readonly string[]): Array<IriTerm | BlankTerm> {
    const seen = new Set<string>();
    const out: Array<IriTerm | BlankTerm> = [];
    for (const s of this.all) {
      if (!predicates.includes(s.quad.predicate.value)) continue;
      const key = keyOf(s.quad.subject);
      if (!seen.has(key)) { seen.add(key); out.push(s.quad.subject); }
    }
    return out;
  }
  /** Does the file state `subject rdf:type` any of `types`? */
  isA(subject: string, types: readonly string[]): boolean {
    return this.ofIri(subject, RDF('type')).some(s => s.quad.object.kind === 'iri' && types.includes(s.quad.object.value));
  }

  /**
   * The members of a collection: the model's list term, `rdf:nil`, or a chain of `rdf:first` / `rdf:rest` cells. `null` for what is no list:
   * a cell with no or several firsts or rests, a chain that loops or ends in no `rdf:nil`, or one over {@link SCHEMA_RDF_MAX_LIST}.
   */
  list(term: Term): Term[] | null {
    if (term.kind === 'list') return term.items.length <= SCHEMA_RDF_MAX_LIST ? [...term.items] : null;
    if (term.kind === 'iri') return term.value === RDF('nil') ? [] : null;
    if (term.kind !== 'blank') return null;
    const items: Term[] = [];
    const seen = new Set<string>();
    let cell: Term = term;
    while (cell.kind === 'blank') {
      if (seen.has(cell.id) || items.length >= SCHEMA_RDF_MAX_LIST) return null;
      seen.add(cell.id);
      const first = this.of(cell, RDF('first'));
      const rest = this.of(cell, RDF('rest'));
      if (first.length !== 1 || rest.length !== 1) return null;
      items.push(first[0]!.quad.object);
      cell = rest[0]!.quad.object;
    }
    return cell.kind === 'iri' && cell.value === RDF('nil') ? items : null;
  }

  /** The numbers of the statements a statement's object holds: the nodes it opens (a list, a nested shape), to a bounded depth. */
  covered(object: Term): number[] {
    const out: number[] = [];
    const seen = new Set<string>();
    const walk = (term: Term, depth: number): void => {
      if (depth > COVER_MAX_DEPTH) return;
      if (term.kind === 'list') { for (const item of term.items) walk(item, depth + 1); return; }
      if (term.kind !== 'blank' || seen.has(term.id)) return;
      seen.add(term.id);
      for (const s of this.of(term)) { out.push(s.i); walk(s.quad.object, depth + 1); }
    };
    walk(object, 0);
    return out;
  }
}

/** What became of each statement: taken as a field, named not taken, or in a refusal. */
export class Ledger {
  private readonly takenHeld: Held<TakenEntry>[] = [];
  private readonly namedHeld: Held<NotTakenEntry>[] = [];
  private readonly refusedIds = new Set<number>();
  private readonly used = new Set<number>();
  private readonly idsOf = new Map<number, number[]>();

  constructor(readonly store: Store) {}

  private ids(stmt: Stmt): number[] {
    let ids = this.idsOf.get(stmt.i);
    if (ids === undefined) { ids = [stmt.i, ...this.store.covered(stmt.quad.object)]; this.idsOf.set(stmt.i, ids); }
    return ids;
  }
  private refs(stmt: Stmt): StatementRef {
    return stmtRef(stmt);
  }

  /** `stmt` sets `field` of `where` to `value` (or names it, for a field in parentheses). */
  take(source: SchemaSource, stmt: Stmt, field: string, where: Place, value?: unknown, extra: { declared?: boolean } = {}): void {
    this.used.add(stmt.i);
    this.takenHeld.push({ entry: { source, ...this.refs(stmt), field, where, ...(value === undefined ? {} : { value }), ...extra }, ids: this.ids(stmt) });
  }
  /** `stmt` is named: no field holds it, or no value reads from it, or the like. */
  name(stmt: Stmt, why: NotTakenWhy, message: string, where?: Place): void {
    this.used.add(stmt.i);
    this.namedHeld.push({ entry: { ...this.refs(stmt), why, message, ...(where === undefined ? {} : { where }) }, ids: this.ids(stmt) });
  }
  /** `stmt` is in a refusal: counted as named. */
  refuse(stmt: Stmt): void {
    this.used.add(stmt.i);
    for (const id of this.ids(stmt)) this.refusedIds.add(id);
  }
  /** Is `stmt` already taken or named? */
  isUsed(stmt: Stmt): boolean {
    return this.used.has(stmt.i);
  }

  /**
   * The statements of the subjects the reader owns that nothing took or named, each handed to `why` to be named. This is what keeps a predicate
   * the reader has no code for from being passed over.
   */
  sweep(owned: ReadonlySet<string>, why: (stmt: Stmt) => { why: NotTakenWhy; message: string }): void {
    for (const stmt of this.store.all) {
      if (this.used.has(stmt.i) || !owned.has(keyOf(stmt.quad.subject))) continue;
      const answer = why(stmt);
      this.name(stmt, answer.why, answer.message);
    }
  }

  /** A taken entry that a mode will not apply is named instead, once per statement. */
  keepAsStored(where: Place, field: string, message: string): number {
    let moved = 0;
    for (let n = this.takenHeld.length - 1; n >= 0; n--) {
      const { entry, ids } = this.takenHeld[n]!;
      if (entry.field !== field || entry.where.kind !== where.kind || entry.where.type !== where.type || entry.where.prop !== where.prop) continue;
      this.takenHeld.splice(n, 1);
      this.namedHeld.push({ entry: { subject: entry.subject, constraint: entry.constraint, object: entry.object, why: 'kept-as-stored', message, where: entry.where }, ids });
      moved++;
    }
    return moved;
  }

  entries(): { taken: TakenEntry[]; notTaken: NotTakenEntry[]; counts: { statements: number; taken: number; notTaken: number; outside: number } } {
    const taken = new Set<number>();
    for (const held of this.takenHeld) for (const id of held.ids) taken.add(id);
    const named = new Set<number>();
    for (const held of this.namedHeld) for (const id of held.ids) if (!taken.has(id)) named.add(id);
    for (const id of this.refusedIds) if (!taken.has(id)) named.add(id);
    const statements = this.store.all.length;
    return {
      taken: this.takenHeld.map(held => held.entry),
      notTaken: this.namedHeld.map(held => held.entry),
      counts: { statements, taken: taken.size, notTaken: named.size, outside: statements - taken.size - named.size },
    };
  }
}

// -- literals ----------------------------------------------------------------------------------------------------------------------------

const INTEGER_FAMILY: ReadonlySet<string> = new Set([
  'integer', 'int', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte',
]);
const DECIMAL_LEXICAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DOUBLE_LEXICAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER_LEXICAL = /^[+-]?\d+$/;

/** Is `address` a datatype of the integer family (`xsd:integer` and the types derived from it)? */
export const isIntegerDatatype = (address: string): boolean => address.startsWith(ns('xsd')) && INTEGER_FAMILY.has(address.slice(ns('xsd').length));

/** The text of a plain literal (no language, no datatype or `xsd:string`), else `null`. */
export function plainText(term: Term): string | null {
  return term.kind === 'literal' && term.language === undefined && (term.datatype === undefined || term.datatype === XSD('string')) ? term.value : null;
}

/** A decimal's lexical form with no sign `+`, no leading or trailing zero: the form {@link decimalLexical} prints. */
function canonicalDecimal(lexical: string): string {
  const negative = lexical.startsWith('-');
  const [whole = '', fraction = ''] = lexical.replace(/^[+-]/, '').split('.');
  const w = whole.replace(/^0+(?=\d)/, '') || '0';
  const f = fraction.replace(/0+$/, '');
  const body = f === '' ? w : `${w}.${f}`;
  return negative && body !== '0' ? `-${body}` : body;
}

/**
 * The value a literal states, as a property's enumeration member, default or bound is written: a text, a finite number, a boolean. A decimal
 * is read only when its double prints back as the same decimal; a date literal is its text. `null` for anything else (a language tag, a
 * datatype no field holds, an unreadable lexical form).
 */
export function literalValue(term: Term): string | number | boolean | null {
  if (term.kind !== 'literal') return null;
  const text = plainText(term);
  if (text !== null) return text;
  const datatype = term.datatype;
  if (term.language !== undefined || datatype === undefined || !datatype.startsWith(ns('xsd'))) return null;
  const local = datatype.slice(ns('xsd').length);
  const lexical = term.value;
  if (local === 'boolean') return lexical === 'true' || lexical === '1' ? true : lexical === 'false' || lexical === '0' ? false : null;
  if (local === 'decimal') {
    if (!DECIMAL_LEXICAL.test(lexical)) return null;
    const n = Number(lexical);
    return Number.isFinite(n) && decimalLexical(n) === canonicalDecimal(lexical) ? n : null;
  }
  if (INTEGER_FAMILY.has(local)) {
    const n = INTEGER_LEXICAL.test(lexical) ? Number(lexical) : Number.NaN;
    return Number.isSafeInteger(n) ? n : null;
  }
  if (local === 'double' || local === 'float') {
    const n = DOUBLE_LEXICAL.test(lexical) ? Number(lexical) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }
  if ((local === 'date' || local === 'dateTime' || local === 'dateTimeStamp') && temporalKind(lexical) !== null) return lexical;
  return null;
}

/** The number a literal states, for a bound or a count: a number from {@link literalValue}, else `null`. */
export function numberValue(term: Term): number | null {
  const value = literalValue(term);
  return typeof value === 'number' ? value : null;
}

/** The whole number a literal of the integer family states, else `null`. */
export function wholeNumber(term: Term): number | null {
  return term.kind === 'literal' && term.datatype !== undefined && isIntegerDatatype(term.datatype) ? numberValue(term) : null;
}
