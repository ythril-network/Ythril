/**
 * The SHACL half of the schema reader: node shapes and property shapes of a file, read to the claims they make on a space's type schemas
 * (bundle-270, slice S8, Q-754). The inverse of the shapes `schema-owl-shacl.ts` writes.
 *
 * ## What it prevents
 *
 * - **A constraint read looser than it was written.** Each constraint is read only in a form whose field holds exactly what it says
 *   (`schema-from-rdf-constraints.ts` holds the table and the rule): a bare `sh:minInclusive` only on a value the shape types as a number, a bare
 *   `sh:pattern` only on text and only where SPARQL and ECMAScript read it alike with no flags, a datatype only where a field is that datatype,
 *   a count of one for required and for a one-only label (never a count of two), an endpoint list only in the guarded form the export writes
 *   (an end that is no entity passes). What is not read is named by the sweep of {@link Ledger}, never passed over.
 * - **An enumeration shorter than the file's.** `sh:in` is read whole or not at all; the integer the export writes beside a whole decimal
 *   is one member.
 * - **A shape guessed into a type.** A node shape is a type only through its target (a class, or the subjects of a property); one that targets
 *   nothing, or both, is named or refused. A class the shape targets may be one the file does not declare, and the entry says so.
 * - **An edge label's properties lost.** The properties of an edge hang on shapes aimed at the label's reifiers, not on its node shape; they
 *   are found by their shape's address or their target, and attached to the label by name.
 *
 * Pure.
 */
import {
  DATE_PASSED_VALUES, MAX_MESSAGE_LENGTH, MAX_PATTERN_LENGTH, MAX_RULE_LENGTH, MERGE_FNS, RULE_NAME_PATTERN, hasReDoSRisk, libraryEntryNameOf,
  type KnowledgeType,
} from '@ythril-network/schema';
import { isObjectPrototypeName } from '@ythril-network/schema/internal';
import type { BlankTerm, IriTerm, Term } from './literals.js';
import { patternReadsAlike } from './portable-pattern.js';
import { shapeOfAddress } from './term-reverse.js';
import {
  OWL, RDF, RDFS, SH, XSD, YTHRIL, isIntegerDatatype, keyOf, literalValue, numberValue, plainText, wholeNumber, type Stmt,
} from './schema-from-rdf-store.js';
import {
  draftOf, nameKey, readTerm, refuseWith, type PropDraft, type ReadContext, type TypeDraft,
} from './schema-from-rdf-drafts.js';

type Subject = IriTerm | BlankTerm;
const NUMBER_DATATYPES: readonly string[] = [XSD('decimal'), XSD('double'), XSD('float')];
const DATE_FAMILY: readonly string[] = [XSD('date'), XSD('dateTime'), XSD('dateTimeStamp')];
const CLASS_TYPES: readonly string[] = [OWL('Class'), RDFS('Class')];
/** The longest a retention is: a hundred years of days (the schema's own bound). */
const RETENTION_DAYS_MAX = 36500;
/** How deep a choice may nest: the export's forms are three deep. */
const ATOM_DEPTH_MAX = 4;
/** A guarded bound has two members (not a number, or the bound); an endpoint choice has a class and the escape at least. */
const GUARD_MEMBERS = 2;

const objectIri = (stmt: Stmt): string | null => (stmt.quad.object.kind === 'iri' ? stmt.quad.object.value : null);
const byObject = (a: Stmt, b: Stmt): number => {
  const x = objectIri(a) ?? '';
  const y = objectIri(b) ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The node shapes of the file: a subject that states a target or is typed `sh:NodeShape`, and is no property shape (it has no path). */
function nodeShapes(ctx: ReadContext): Subject[] {
  const typed = ctx.store.withType([SH('NodeShape')]);
  const targeted = ctx.store.withPredicate([SH('targetClass'), SH('targetSubjectsOf'), SH('targetObjectsOf'), SH('targetNode')]);
  const seen = new Set<string>();
  const out: Subject[] = [];
  for (const subject of [...typed, ...targeted]) {
    const key = keyOf(subject);
    if (seen.has(key) || ctx.store.of(subject, SH('path')).length > 0) continue;
    seen.add(key);
    out.push(subject);
  }
  return out;
}

/** A pattern the schema can hold and run: bounded, no risk of a quantified group holding a quantifier, and an expression ECMAScript reads. */
function usablePattern(text: string): boolean {
  if (text.length > MAX_PATTERN_LENGTH || hasReDoSRisk(text)) return false;
  try { new RegExp(text); return true; } catch { return false; }
}

/**
 * Find the types the shapes declare: each node shape that targets a class or the subjects of a property becomes (or joins) the draft of that
 * term, with its kind and names from its target, its address and its `sh:name`. A shape of no target, of two kinds of target, or of a term no
 * schema holds is named or refused.
 */
export function discoverShapes(ctx: ReadContext): void {
  const { store, ledger } = ctx;
  for (const shape of nodeShapes(ctx)) {
    ctx.owned.add(keyOf(shape));
    for (const stmt of store.of(shape)) {
      const p = stmt.quad.predicate.value;
      if (p === SH('targetObjectsOf') || p === SH('targetNode')) ledger.name(stmt, 'no-field', 'a shape aimed at the objects of a property, or at one node, is no type: a type is a class or the subjects of an edge label');
    }
    const classes = store.of(shape, SH('targetClass')).filter(s => s.quad.object.kind === 'iri').sort(byObject);
    const labels = store.of(shape, SH('targetSubjectsOf')).filter(s => s.quad.object.kind === 'iri').sort(byObject);
    for (const stmt of [...store.of(shape, SH('targetClass')), ...store.of(shape, SH('targetSubjectsOf'))]) {
      if (stmt.quad.object.kind !== 'iri') ledger.name(stmt, 'unreadable-value', 'a target is an address');
    }
    if (classes[0] !== undefined && labels[0] !== undefined) {
      refuseWith(ctx, 'contradiction', 'a shape targets a class and the subjects of a property: a type is a record type or an edge label, never both', [classes[0], labels[0]]);
      continue;
    }
    const target = classes[0] ?? labels[0];
    if (target === undefined || ctx.skip.has(objectIri(target) ?? '')) continue;
    const extras = (classes[0] === undefined ? labels : classes).slice(1);
    for (const stmt of extras) ledger.name(stmt, 'second-value', 'a type has one class (or label): this shape\'s other targets are not read');
    const termIri = objectIri(target) ?? '';
    const read = readTerm(ctx, termIri);
    if (read.how === 'rejected') { ledger.name(target, read.why, read.message); continue; }
    if (read.how === 'derived' && (read.prop !== undefined || read.kind === 'file' || (read.kind === 'edge' && classes[0] !== undefined))) {
      ledger.name(target, 'no-field', read.kind === 'file' ? 'a file has no type schema' : read.kind === 'edge' ? 'the class of an edge label\'s reifiers: the label is the type, not this class' : 'it is the address of a property, and a type is targeted here');
      continue;
    }
    const draft = draftOf(ctx, termIri);
    draft.shapes.push(shape);
    if (classes[0] !== undefined) draft.classStmts.push(target); else draft.labelStmts.push(target);
    if (classes[0] === undefined) draft.kinds.push({ kind: 'edge', stmt: target, source: 'shacl' });
    if (read.how === 'derived' && read.type !== null) {
      draft.kinds.push({ kind: read.kind as KnowledgeType, stmt: target, source: 'shacl' });
      draft.nameBy(read.type, 'address', 'shacl');
    }
    if (read.how === 'foreign') {
      draft.claim('iri', termIri, target, 'shacl');
      if (read.stored !== undefined) { draft.kinds.push({ kind: read.stored.kind, stmt: target, source: 'shacl' }); draft.nameBy(read.stored.type, 'stored', 'shacl'); }
    }
    if (shape.kind === 'iri') {
      const at = shapeOfAddress(shape.value, ctx.names);
      if (at.answer === 'shape' && at.prop === undefined) { draft.kinds.push({ kind: at.kind, stmt: target, source: 'shacl' }); draft.nameBy(at.type, 'address', 'shacl'); }
    }
    for (const stmt of store.of(shape, SH('name'))) {
      const text = plainText(stmt.quad.object);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a name is a plain text: a name with a language tag or a datatype is not read');
      else draft.nameBy(text, 'label', 'shacl', stmt);
    }
  }
}

// -- the forms a choice (sh:or) is written in ---------------------------------------------------------------------------------------------

type Atom =
  | { form: 'datatype'; iri: string }
  | { form: 'class'; iri: string }
  | { form: 'minInclusive' | 'maxInclusive'; term: Term }
  | { form: 'pattern'; text: string }
  | { form: 'not'; inner: Atom }
  | { form: 'or'; members: Atom[] };

/** One member of a choice: a node with one statement, in one of the forms the export writes; `null` for anything else. */
function atomOf(ctx: ReadContext, term: Term, depth = 0): Atom | null {
  if (term.kind !== 'blank' || depth > ATOM_DEPTH_MAX) return null;
  const stmts = ctx.store.of(term);
  const only = stmts.length === 1 ? stmts[0]! : undefined;
  if (only === undefined) return null;
  const p = only.quad.predicate.value;
  const o = only.quad.object;
  if (p === SH('datatype') && o.kind === 'iri') return { form: 'datatype', iri: o.value };
  if (p === SH('class') && o.kind === 'iri') return { form: 'class', iri: o.value };
  if (p === SH('minInclusive')) return { form: 'minInclusive', term: o };
  if (p === SH('maxInclusive')) return { form: 'maxInclusive', term: o };
  if (p === SH('pattern')) { const text = plainText(o); return text === null ? null : { form: 'pattern', text }; }
  if (p === SH('not')) { const inner = atomOf(ctx, o, depth + 1); return inner === null ? null : { form: 'not', inner }; }
  if (p === SH('or')) {
    const items = ctx.store.list(o);
    const members = items === null ? null : items.map(m => atomOf(ctx, m, depth + 1));
    return members === null || members.some(m => m === null) ? null : { form: 'or', members: members as Atom[] };
  }
  return null;
}

const datatypesOf = (atoms: readonly Atom[]): string[] | null => (atoms.every(a => a.form === 'datatype') ? atoms.map(a => (a as { iri: string }).iri) : null);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && b.every(x => a.includes(x));
const NOT_A_NUMBER = (a: Atom | undefined): boolean => {
  if (a?.form !== 'not' || a.inner.form !== 'or') return false;
  const types = datatypesOf(a.inner.members);
  return types !== null && sameSet(types, [XSD('decimal'), XSD('integer')]);
};

type OrForm =
  | { form: 'number' } | { form: 'date' } | { form: 'minimum' | 'maximum'; term: Term } | { form: 'pattern'; text: string }
  | { form: 'endpoints'; classes: string[] } | { form: 'unknown' };

/** Which form of the export a choice is: a number's type, a date's, a guarded bound, a guarded pattern, an edge's endpoints. */
function orFormOf(atoms: readonly Atom[]): OrForm {
  const types = datatypesOf(atoms);
  if (types !== null && sameSet(types, [XSD('decimal'), XSD('integer')])) return { form: 'number' };
  if (types !== null && sameSet(types, [XSD('dateTimeStamp'), XSD('dateTime'), XSD('date'), XSD('string')])) return { form: 'date' };
  const [first, second] = atoms;
  if (atoms.length === GUARD_MEMBERS && NOT_A_NUMBER(first) && second?.form === 'minInclusive') return { form: 'minimum', term: second.term };
  if (atoms.length === GUARD_MEMBERS && NOT_A_NUMBER(first) && second?.form === 'maxInclusive') return { form: 'maximum', term: second.term };
  const patterns = atoms.filter(a => a.form === 'pattern');
  const rest = atoms.filter(a => a.form !== 'pattern');
  const restTypes = datatypesOf(rest);
  if (patterns.length === 1 && restTypes !== null && sameSet(restTypes, [XSD('decimal'), XSD('integer'), XSD('boolean')])) return { form: 'pattern', text: (patterns[0] as { text: string }).text };
  const escape = atoms[atoms.length - 1];
  const classes = atoms.slice(0, -1);
  if (atoms.length >= GUARD_MEMBERS && escape?.form === 'not' && escape.inner.form === 'class' && escape.inner.iri === YTHRIL('Entity') && classes.every(a => a.form === 'class')) {
    return { form: 'endpoints', classes: classes.map(a => (a as { iri: string }).iri) };
  }
  return { form: 'unknown' };
}

// -- one side of an edge's endpoints ------------------------------------------------------------------------------------------------------

interface Side { listed?: { stmt: Stmt; members: string[] }; annotations: Array<{ stmt: Stmt; member: string }> }
interface Sides { from: Side; to: Side }
const newSides = (): Sides => ({ from: { annotations: [] }, to: { annotations: [] } });

/** The name of the entity type a class is: the untyped bucket, a type the file declares at that address, or a type the space's vocabulary names. */
function memberOf(ctx: ReadContext, classIri: string): string | null {
  if (classIri === YTHRIL('Untyped')) return 'UNTYPED';
  const draft = ctx.drafts.get(classIri);
  if (draft !== undefined) return draft.kind === 'entity' && !draft.broken && draft.name !== undefined ? draft.name : null;
  const read = readTerm(ctx, classIri);
  return read.how === 'derived' && read.kind === 'entity' && read.type !== null && read.prop === undefined ? read.type : null;
}

/** The members a list of classes names, each once in order; `null` when a class names no entity type. */
function membersOf(ctx: ReadContext, classes: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const c of classes) {
    const member = memberOf(ctx, c);
    if (member === null) return null;
    if (!out.includes(member)) out.push(member);
  }
  return out;
}

/** Read an endpoint choice into `side`: the members in the order written, or the choice named when it is not the export's form or a class has no name. */
function readEndpointOr(ctx: ReadContext, stmt: Stmt, side: Side): void {
  const items = ctx.store.list(stmt.quad.object);
  const atoms = items === null ? null : items.map(m => atomOf(ctx, m));
  const form = atoms === null || atoms.some(a => a === null) ? { form: 'unknown' as const } : orFormOf(atoms as Atom[]);
  if (form.form !== 'endpoints') {
    ctx.ledger.name(stmt, 'looser-field', 'a choice of classes that is not the guarded form the export writes (classes, and an end that is no entity passes): endpoints would let a fact through');
    return;
  }
  const members = membersOf(ctx, form.classes);
  if (members === null) ctx.ledger.name(stmt, 'unreadable-value', 'a class the file does not declare (and the space\'s names do not read) has no entity type to be an endpoint');
  else side.listed = { stmt, members };
}

/** Put one side's claims on the draft: the list in the order written, held against its annotations; annotations alone give the members in their order. */
function finishSide(ctx: ReadContext, draft: TypeDraft, field: 'endpoints.from' | 'endpoints.to', side: Side): void {
  const { listed, annotations } = side;
  if (listed !== undefined) {
    draft.claim(field, listed.members, listed.stmt, 'shacl');
    for (const a of annotations) {
      if (listed.members.includes(a.member)) draft.structural(field, a.stmt, 'shacl');
      else refuseWith(ctx, 'contradiction', `an edge type's ${field} says ${a.member} in one place and the choice beside it does not`, [a.stmt, listed.stmt], { field });
    }
    const unmarked = listed.members.find(m => !annotations.some(a => a.member === m));
    if (annotations.length > 0 && unmarked !== undefined) refuseWith(ctx, 'contradiction', `an edge type's ${field} lists ${unmarked} in its choice and its annotations do not`, [listed.stmt, annotations[0]!.stmt], { field });
  } else if (annotations.length > 0) {
    draft.claim(field, annotations.map(a => a.member).filter((m, i, all) => all.indexOf(m) === i), annotations[0]!.stmt, 'shacl');
    for (const a of annotations.slice(1)) draft.structural(field, a.stmt, 'shacl');
  }
}

// -- property shapes ---------------------------------------------------------------------------------------------------------------------

/** The members of an enumeration the export wrote: the integer beside a whole decimal of the same value is the same member. */
function membersWithoutTwins(items: readonly Term[]): Term[] {
  const out: Term[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    const twin = prev !== undefined && item.kind === 'literal' && item.datatype === XSD('integer') && prev.kind === 'literal' && prev.datatype === XSD('decimal')
      && numberValue(prev) !== null && numberValue(prev) === numberValue(item);
    if (!twin) out.push(item);
  }
  return out;
}

const WAS_UNREADABLE = 'the value is no plain value a field holds';

/** What one shape of a property says about its own value type, read before its constraints: a bound or a pattern depends on it. */
function typeOfShape(ctx: ReadContext, shape: Subject): { number: boolean; string: boolean } {
  const datatypes = ctx.store.of(shape, SH('datatype')).map(objectIri);
  let number = datatypes.length > 0 && datatypes.every(d => d !== null && NUMBER_DATATYPES.includes(d));
  const string = datatypes.length === 1 && datatypes[0] === XSD('string');
  for (const stmt of ctx.store.of(shape, SH('or'))) {
    const items = ctx.store.list(stmt.quad.object);
    const atoms = items === null ? null : items.map(m => atomOf(ctx, m));
    if (atoms !== null && !atoms.some(a => a === null) && orFormOf(atoms as Atom[]).form === 'number') number = true;
  }
  return { number, string };
}

/** The datatype statement of a property shape: a type, or named looser (a field would accept more) or no field. */
function readDatatype(ctx: ReadContext, stmt: Stmt, prop: PropDraft): void {
  const iri = objectIri(stmt);
  if (iri === null) { ctx.ledger.name(stmt, 'unreadable-value', 'a datatype is an address'); return; }
  if (iri === XSD('string')) prop.claim('type', 'string', stmt, 'shacl');
  else if (iri === XSD('boolean')) prop.claim('type', 'boolean', stmt, 'shacl');
  else if (NUMBER_DATATYPES.includes(iri)) prop.claim('type', 'number', stmt, 'shacl');
  else if (isIntegerDatatype(iri)) ctx.ledger.name(stmt, 'looser-field', 'whole numbers only: the type number also takes 1.5, so it would accept what this refuses');
  else if (DATE_FAMILY.includes(iri)) ctx.ledger.name(stmt, 'looser-field', 'one date form: the type date takes all of them, so it would accept what this refuses');
  else ctx.ledger.name(stmt, 'no-field', 'a datatype no field holds');
}

function readChoice(ctx: ReadContext, stmt: Stmt, prop: PropDraft): void {
  const items = ctx.store.list(stmt.quad.object);
  const atoms = items === null ? null : items.map(m => atomOf(ctx, m));
  const form = atoms === null || atoms.some(a => a === null) ? { form: 'unknown' as const } : orFormOf(atoms as Atom[]);
  if (form.form === 'number') prop.claim('type', 'number', stmt, 'shacl');
  else if (form.form === 'date') prop.claim('type', 'date', stmt, 'shacl');
  else if (form.form === 'minimum' || form.form === 'maximum') {
    const bound = numberValue(form.term);
    if (bound === null) ctx.ledger.name(stmt, 'unreadable-value', 'a bound is a number');
    else prop.claim(form.form, bound, stmt, 'shacl');
  } else if (form.form === 'pattern') {
    if (usablePattern(form.text)) prop.claim('pattern', form.text, stmt, 'shacl');
    else ctx.ledger.name(stmt, 'unreadable-value', 'a pattern the schema cannot run (too long, a quantified group holding a quantifier, or not an expression)');
  } else {
    ctx.ledger.name(stmt, 'no-field', 'a choice that is none of the forms the export writes (a number, a date, a guarded bound or pattern): no field holds it');
  }
}

/** The constraints of a property shape that are not about the label of an edge: each read as a claim, or named. */
function readConstraints(ctx: ReadContext, shape: Subject, prop: PropDraft, kind: KnowledgeType): void {
  const { ledger, store } = ctx;
  const typed = typeOfShape(ctx, shape);
  const hasCount = store.of(shape, SH('minCount')).some(s => wholeNumber(s.quad.object) === 1);
  const hasFlags = store.of(shape, SH('flags')).length > 0;
  for (const stmt of store.of(shape)) {
    if (ledger.isUsed(stmt)) continue;
    const p = stmt.quad.predicate.value;
    const o = stmt.quad.object;
    if (p === RDF('type')) { if (objectIri(stmt) === SH('PropertyShape')) prop.structural('(declaration)', stmt, 'shacl'); }
    else if (p === SH('description')) {
      const text = plainText(o);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a description is a plain text');
      else prop.claim('description', text, stmt, 'shacl');
    } else if (p === SH('maxCount')) {
      if (wholeNumber(o) === 1) prop.structural('(every property)', stmt, 'shacl');
      else ledger.name(stmt, 'no-field', 'a property holds one value, always: a count of anything else is no field');
    } else if (p === SH('minCount')) {
      const n = wholeNumber(o);
      if (n === 1) prop.claim('required', true, stmt, 'shacl');
      else if (n === 0) prop.structural('required', stmt, 'shacl', { value: false });
      else ledger.name(stmt, 'no-field', 'required means one value present and not empty: a count of anything else is no field');
    } else if (p === SH('minLength')) {
      if (wholeNumber(o) === 1 && hasCount) prop.claim('required', true, stmt, 'shacl');
      else ledger.name(stmt, 'no-field', 'a length of one beside a count of one is what required states; any other length is no field');
    } else if (p === SH('datatype')) readDatatype(ctx, stmt, prop);
    else if (p === SH('in')) {
      const items = store.list(o);
      const values = items === null ? null : membersWithoutTwins(items).map(literalValue);
      if (values === null || values.some(v => v === null)) ledger.name(stmt, 'unreadable-value', 'an enumeration with a member that is no plain value (or that is no list) is not read: a shorter list would refuse what the file allows');
      else prop.claim('enum', values, stmt, 'shacl');
    } else if (p === SH('minInclusive') || p === SH('maxInclusive')) {
      const bound = numberValue(o);
      if (bound === null) ledger.name(stmt, 'unreadable-value', 'a bound is a number');
      else if (typed.number) prop.claim(p === SH('minInclusive') ? 'minimum' : 'maximum', bound, stmt, 'shacl');
      else ledger.name(stmt, 'looser-field', 'a bound on a value that may be another type: the schema reads a range only on a number, so it would let a text through');
    } else if (p === SH('pattern')) {
      const text = plainText(o);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a pattern is a plain text');
      else if (hasFlags) ledger.name(stmt, 'no-field', 'a pattern with flags means something else than the schema\'s pattern, which has none');
      else if (!typed.string) ledger.name(stmt, 'looser-field', 'a pattern on a value that may be another type: the schema reads a pattern only on text, so it would let a number through');
      else if (!patternReadsAlike(text) || !usablePattern(text)) ledger.name(stmt, 'unreadable-value', 'a pattern SPARQL and ECMAScript do not read alike (or one the schema cannot run)');
      else prop.claim('pattern', text, stmt, 'shacl');
    } else if (p === SH('or')) readChoice(ctx, stmt, prop);
    else if (p === YTHRIL('pattern')) {
      const text = plainText(o);
      if (text !== null && usablePattern(text)) prop.claim('pattern', text, stmt, 'shacl');
      else ledger.name(stmt, 'unreadable-value', 'a pattern the schema cannot run (too long, a quantified group holding a quantifier, or not an expression)');
    } else if (p === YTHRIL('mergeFn')) {
      const text = plainText(o);
      if (text !== null && (MERGE_FNS as readonly string[]).includes(text)) prop.claim('mergeFn', text, stmt, 'shacl');
      else ledger.name(stmt, 'unreadable-value', 'a merge function is one of the names the schema knows');
    } else if (p === SH('defaultValue')) {
      const value = literalValue(o);
      if (value === null) ledger.name(stmt, 'unreadable-value', WAS_UNREADABLE);
      else prop.claim('default', value, stmt, 'shacl');
    } else if (p === SH('targetClass') && kind === 'edge' && objectIri(stmt) !== null) prop.structural('(declaration)', stmt, 'shacl');
  }
}

/** The shape of an entity's name: only its pattern is a field (the naming pattern). */
function readNamePattern(ctx: ReadContext, shape: Subject, draft: TypeDraft): void {
  const { ledger, store } = ctx;
  const hasFlags = store.of(shape, SH('flags')).length > 0;
  for (const stmt of store.of(shape)) {
    if (ledger.isUsed(stmt)) continue;
    const p = stmt.quad.predicate.value;
    if (p === RDF('type') && objectIri(stmt) === SH('PropertyShape')) draft.structural('(declaration)', stmt, 'shacl');
    else if (p === SH('path')) draft.structural('(declaration)', stmt, 'shacl');
    else if (p === SH('name') && plainText(stmt.quad.object) === 'name') draft.structural('(name)', stmt, 'shacl');
    else if (p === SH('pattern')) {
      const text = plainText(stmt.quad.object);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a pattern is a plain text');
      else if (hasFlags) ledger.name(stmt, 'no-field', 'a pattern with flags means something else than the schema\'s pattern, which has none');
      else if (!patternReadsAlike(text) || !usablePattern(text)) ledger.name(stmt, 'unreadable-value', 'a pattern SPARQL and ECMAScript do not read alike (or one the schema cannot run)');
      else draft.claim('namingPattern', text, stmt, 'shacl');
    }
  }
}

/** The property shape of an edge label itself: the object side's endpoints and the one-only mark. */
function readLabelShape(ctx: ReadContext, shape: Subject, draft: TypeDraft, sides: Sides): void {
  const { ledger, store } = ctx;
  for (const stmt of store.of(shape)) {
    if (ledger.isUsed(stmt)) continue;
    const p = stmt.quad.predicate.value;
    if (p === RDF('type') && objectIri(stmt) === SH('PropertyShape')) draft.structural('(declaration)', stmt, 'shacl');
    else if (p === SH('path')) draft.structural('(declaration)', stmt, 'shacl');
    else if (p === SH('name') && plainText(stmt.quad.object) === draft.name) draft.structural('(name)', stmt, 'shacl');
    else if (p === SH('maxCount')) {
      if (wholeNumber(stmt.quad.object) === 1) draft.claim('functional', true, stmt, 'shacl');
      else ledger.name(stmt, 'no-field', 'one-only is a count of one: a label that allows two or more is the label as it is, and no field says so');
    } else if (p === SH('or')) readEndpointOr(ctx, stmt, sides.to);
    else if (p === SH('class')) ledger.name(stmt, 'looser-field', 'the class of the end of an edge label: endpoints are checked only when the other end is an entity, so they would accept a fact where this refuses one');
  }
}

/** Read one property shape of `draft`: the label's own shape of an edge, an entity's name shape, or a property. */
function readPropertyShape(ctx: ReadContext, shape: Subject, draft: TypeDraft, sides: Sides, hung?: Stmt): void {
  const { ledger, store } = ctx;
  ctx.owned.add(keyOf(shape));
  const paths = store.of(shape, SH('path'));
  const path = paths[0];
  const pathIri = path === undefined ? null : objectIri(path);
  if (paths.length !== 1 || path === undefined || pathIri === null) {
    for (const s of paths) ledger.name(s, 'no-field', 'a path that is no single property (a sequence, an inverse, an alternative) names no one property');
    if (hung !== undefined) ledger.name(hung, 'no-field', 'a property shape of no single property');
    return;
  }
  if (draft.kind === 'edge' && pathIri === draft.termIri) {
    if (hung !== undefined) draft.structural('(declaration)', hung, 'shacl');
    readLabelShape(ctx, shape, draft, sides);
    return;
  }
  if (draft.kind === 'entity' && pathIri === RDFS('label')) {
    if (hung !== undefined) draft.structural('(declaration)', hung, 'shacl');
    readNamePattern(ctx, shape, draft);
    return;
  }
  const read = readTerm(ctx, pathIri);
  if (read.how === 'rejected') { ledger.name(path, read.why, read.message); return; }
  if (read.how === 'derived' && (read.prop === undefined || read.kind === 'file' || read.kind !== draft.kind || read.type !== draft.name)) {
    ledger.name(path, 'no-field', read.prop === undefined ? 'it is the address of a type, and a property is stated here' : 'the property\'s own address belongs to another type, and an address under the space\'s vocabulary is its own: it cannot be this type\'s explicit address');
    return;
  }
  if (draft.kind === 'edge' && hung !== undefined) { ledger.name(path, 'no-field', 'a property of the subjects of an edge label: the properties of an edge hang on shapes aimed at its reifiers'); return; }
  const prop = draft.prop(pathIri);
  if (hung !== undefined) prop.structural('propertySchemas', hung, 'shacl');
  if (read.how === 'derived' && read.prop !== undefined) { prop.nameBy(read.prop, 'address', 'shacl'); prop.structural('(declaration)', path, 'shacl'); }
  else { prop.claim('iri', pathIri, path, 'shacl'); if (read.how === 'foreign' && read.stored?.prop !== undefined) prop.nameBy(read.stored.prop, 'stored', 'shacl'); }
  if (shape.kind === 'iri') {
    const at = shapeOfAddress(shape.value, ctx.names);
    if (at.answer === 'shape' && at.prop !== undefined && at.kind === draft.kind && at.type === draft.name) prop.nameBy(at.prop, 'address', 'shacl');
  }
  for (const stmt of store.of(shape, SH('name'))) {
    const text = plainText(stmt.quad.object);
    if (text === null) ledger.name(stmt, 'unreadable-value', 'a name is a plain text: a name with a language tag or a datatype is not read');
    else prop.nameBy(text, 'label', 'shacl', stmt);
  }
  readConstraints(ctx, shape, prop, draft.kind ?? 'entity');
}

// -- the node shape of a type ---------------------------------------------------------------------------------------------------------------

function readRule(ctx: ReadContext, draft: TypeDraft, stmt: Stmt): void {
  const node = stmt.quad.object;
  const parts = node.kind === 'blank' ? ctx.store.of(node) : [];
  const text = (name: string): string | null => {
    const held = parts.filter(s => s.quad.predicate.value === YTHRIL(name));
    return held.length === 1 ? plainText(held[0]!.quad.object) : null;
  };
  const known = parts.every(s => [YTHRIL('ruleName'), YTHRIL('ruleExpression'), YTHRIL('ruleMessage')].includes(s.quad.predicate.value));
  const name = text('ruleName');
  const rule = text('ruleExpression');
  const message = text('ruleMessage');
  const usable = known && name !== null && rule !== null && message !== null && new RegExp(RULE_NAME_PATTERN).test(name) && !isObjectPrototypeName(name)
    && rule !== '' && rule.length <= MAX_RULE_LENGTH && message !== '' && message.length <= MAX_MESSAGE_LENGTH;
  if (!usable) ctx.ledger.name(stmt, 'unreadable-value', 'a rule is a node with exactly a name the schema allows, an expression and a message (and no part of a space\'s rule, such as its kinds)');
  else draft.claim(`rules.${name}`, { rule, message }, stmt, 'shacl');
}

/** The annotations of a node shape that no standard term carries: naming pattern, retention, suppression, the due policy, rules, an unresolved reference, endpoints. */
function readAnnotation(ctx: ReadContext, draft: TypeDraft, stmt: Stmt, sides: Sides, requiredEdgeProps: Array<{ stmt: Stmt; iri: string }>): void {
  const { ledger } = ctx;
  const p = stmt.quad.predicate.value;
  const o = stmt.quad.object;
  const days = (field: 'retention.days' | 'retention.contentDays'): void => {
    const n = wholeNumber(o);
    if (n === null || n < 1 || n > RETENTION_DAYS_MAX) ledger.name(stmt, 'unreadable-value', 'a retention is a whole number of days from 1 to 36500');
    else if (field === 'retention.contentDays' && draft.kind !== 'chrono') ledger.name(stmt, 'no-field', 'a content window is a chrono type\'s: on another type it names nothing');
    else draft.claim(field, n, stmt, 'shacl');
  };
  if (p === YTHRIL('namingPattern')) {
    const text = plainText(o);
    if (text !== null && usablePattern(text)) draft.claim('namingPattern', text, stmt, 'shacl');
    else ledger.name(stmt, 'unreadable-value', 'a pattern the schema cannot run (too long, a quantified group holding a quantifier, or not an expression)');
  } else if (p === YTHRIL('retentionDays')) days('retention.days');
  else if (p === YTHRIL('retentionContentDays')) days('retention.contentDays');
  else if (p === YTHRIL('suppressEmbeddings')) {
    const value = literalValue(o);
    if (typeof value === 'boolean' && o.kind === 'literal' && o.datatype === XSD('boolean')) draft.claim('suppressEmbeddings', value, stmt, 'shacl');
    else ledger.name(stmt, 'unreadable-value', 'a boolean');
  } else if (p === YTHRIL('whenDuePasses')) {
    const text = plainText(o);
    if (text === null || !(DATE_PASSED_VALUES as readonly string[]).includes(text)) ledger.name(stmt, 'unreadable-value', 'a policy the schema knows (overdue or nothing)');
    else if (draft.kind !== 'chrono') ledger.name(stmt, 'no-field', 'a due policy is a chrono type\'s: on another type it names nothing');
    else draft.claim('whenDuePasses', text, stmt, 'shacl');
  } else if (p === YTHRIL('rule')) readRule(ctx, draft, stmt);
  else if (p === YTHRIL('unresolvedRef')) {
    const text = plainText(o);
    if (text !== null && libraryEntryNameOf(text) !== undefined) draft.claim('$ref', text, stmt, 'shacl');
    else ledger.name(stmt, 'unreadable-value', 'a reference to a schema library entry (library:<name>)');
  } else if (p === YTHRIL('endpointFrom') || p === YTHRIL('endpointTo')) {
    const member = o.kind === 'iri' ? memberOf(ctx, o.value) : null;
    if (draft.kind !== 'edge') ledger.name(stmt, 'no-field', 'endpoints are an edge type\'s: on another type they name nothing');
    else if (member === null) ledger.name(stmt, 'unreadable-value', 'a class the file does not declare (and the space\'s names do not read) has no entity type to be an endpoint');
    else (p === YTHRIL('endpointFrom') ? sides.from : sides.to).annotations.push({ stmt, member });
  } else if (p === YTHRIL('requiredEdgeProperty')) {
    if (draft.kind === 'edge' && o.kind === 'iri') requiredEdgeProps.push({ stmt, iri: o.value });
    else ledger.name(stmt, 'no-field', 'a property every edge of a type must carry: an edge type\'s');
  }
}

function readNodeShape(ctx: ReadContext, shape: Subject, draft: TypeDraft, sides: Sides, requiredEdgeProps: Array<{ stmt: Stmt; iri: string }>): void {
  const { ledger, store } = ctx;
  const isOwn = (stmt: Stmt): boolean => draft.classStmts.includes(stmt) || draft.labelStmts.includes(stmt);
  for (const stmt of store.of(shape)) {
    if (ledger.isUsed(stmt)) continue;
    const p = stmt.quad.predicate.value;
    if (p === RDF('type')) { if (objectIri(stmt) === SH('NodeShape')) draft.structural('(declaration)', stmt, 'shacl'); }
    else if (p === SH('targetClass') || p === SH('targetSubjectsOf')) {
      if (isOwn(stmt)) draft.structural('(declaration)', stmt, 'shacl', { declared: stmt.quad.object.kind === 'iri' && store.isA(stmt.quad.object.value, p === SH('targetClass') ? CLASS_TYPES : [OWL('ObjectProperty')]) });
    } else if (p === SH('description')) {
      const text = plainText(stmt.quad.object);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a description is a plain text');
      else draft.claim('description', text, stmt, 'shacl');
    } else if (p === SH('or')) {
      if (draft.kind === 'edge') readEndpointOr(ctx, stmt, sides.from);
    } else if (p === SH('property')) {
      const object = stmt.quad.object;
      if (object.kind === 'iri' || object.kind === 'blank') readPropertyShape(ctx, object, draft, sides, stmt);
      else ledger.name(stmt, 'unreadable-value', 'a property shape is a node');
    } else readAnnotation(ctx, draft, stmt, sides, requiredEdgeProps);
  }
}

/** The property shapes that hang on no node shape: an edge's own, which name their label by address or by the class of its reifiers. */
function readStandaloneShapes(ctx: ReadContext, sidesOf: Map<TypeDraft, Sides>): void {
  const hung = new Set<string>();
  for (const s of ctx.store.all) if (s.quad.predicate.value === SH('property') && s.quad.object.kind !== 'literal' && s.quad.object.kind !== 'list' && s.quad.object.kind !== 'triple') hung.add(keyOf(s.quad.object));
  for (const subject of ctx.store.withPredicate([SH('path')])) {
    if (hung.has(keyOf(subject)) || ctx.owned.has(keyOf(subject))) continue;
    const at = subject.kind === 'iri' ? shapeOfAddress(subject.value, ctx.names) : undefined;
    let draft: TypeDraft | undefined = at?.answer === 'shape' && at.prop !== undefined ? ctx.byName.get(nameKey(at.kind, at.type)) : undefined;
    if (draft === undefined) {
      const target = ctx.store.of(subject, SH('targetClass')).map(objectIri).find(c => c !== null);
      const read = target === undefined || target === null ? undefined : readTerm(ctx, target);
      if (read?.how === 'derived' && read.kind === 'edge' && read.type !== null && read.prop === undefined) draft = ctx.byName.get(nameKey('edge', read.type));
    }
    if (draft === undefined || draft.broken || draft.kind !== 'edge') continue;
    readPropertyShape(ctx, subject, draft, sidesOf.get(draft) ?? newSides());
  }
}

/** Read the shapes: each type's node shape and the property shapes hung on it, then the standalone property shapes of edges. Types must be named and kinded first. */
export function readShapes(ctx: ReadContext): void {
  const sidesOf = new Map<TypeDraft, Sides>();
  const requiredOf = new Map<TypeDraft, Array<{ stmt: Stmt; iri: string }>>();
  for (const draft of ctx.drafts.values()) {
    if (draft.broken || draft.kind === undefined || draft.name === undefined || draft.shapes.length === 0) continue;
    const sides = newSides();
    const required: Array<{ stmt: Stmt; iri: string }> = [];
    sidesOf.set(draft, sides);
    requiredOf.set(draft, required);
    for (const shape of draft.shapes) readNodeShape(ctx, shape, draft, sides, required);
  }
  readStandaloneShapes(ctx, sidesOf);
  for (const [draft, sides] of sidesOf) {
    finishSide(ctx, draft, 'endpoints.from', sides.from);
    finishSide(ctx, draft, 'endpoints.to', sides.to);
    for (const { stmt, iri } of requiredOf.get(draft) ?? []) {
      const prop = draft.props.get(iri);
      if (prop === undefined) ctx.ledger.name(stmt, 'no-owner', 'the property the file says every edge must carry has no shape of its own in the file');
      else prop.claim('required', true, stmt, 'shacl');
    }
  }
}
