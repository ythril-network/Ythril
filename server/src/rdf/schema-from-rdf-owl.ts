/**
 * The OWL and RDFS half of the schema reader: classes, object properties, datatype properties and the ontology header of a file, read to the
 * claims they make on a space's type schemas (bundle-270, slice S8, Q-754). The inverse of the axioms `schema-owl-shacl.ts` writes.
 *
 * ## What it prevents
 *
 * - **A statement read looser than it was written.** A datatype range is read as a `type` only for the datatypes a field holds exactly (a
 *   string, a boolean, a decimal, a double, a float); `xsd:integer` and the date datatypes are named `looser-field` (a number may be 1.5, a date
 *   field also takes the other date forms), `rdfs:Literal` and a union are named `no-field`. An enumeration is read whole or not at all.
 *   An object property's domain and range are named, never read as endpoints: an endpoint is checked only when the other end is an entity.
 * - **A property with no type.** A datatype property belongs to the type its own address names (a vocabulary address) or whose class its
 *   `rdfs:domain` names and the file declares; one with neither is named `no-owner`, never attached to a guess.
 * - **An edge label's reifier class read as a record type.** `<vocab>edge/<label>` is a class of the reifiers of the label (and, for a label
 *   the vocabulary names, the label's own address, punned), so it belongs to the label and is never a type of its own.
 * - **A class that is also an edge label.** Both statements are kept on the draft; the draft is refused with both.
 * - **The space's words about itself.** The ontology header's version is the export's description of itself; the purpose, the validation mode,
 *   the strict linkage and the space's rules are a space's, and this reader returns type schemas only (amendment A7): each is named
 *   `space-level`.
 *
 * Pure.
 */
import { MERGE_FNS, type KnowledgeType } from '@ythril-network/schema';
import type { Term } from './literals.js';
import {
  OWL, RDF, RDFS, XSD, YTHRIL, isIntegerDatatype, keyOf, literalValue, numberValue, plainText, type NotTakenWhy, type Stmt,
} from './schema-from-rdf-store.js';
import {
  draftOf, nameKey, readTerm, refuseWith, type PropDraft, type ReadContext, type TypeDraft,
} from './schema-from-rdf-drafts.js';

const CLASS_TYPES: readonly string[] = [OWL('Class'), RDFS('Class')];
const NUMBER_DATATYPES: readonly string[] = [XSD('decimal'), XSD('double'), XSD('float')];
const DATE_DATATYPES: readonly string[] = [XSD('date'), XSD('dateTime'), XSD('dateTimeStamp')];

const objectIri = (stmt: Stmt): string | null => (stmt.quad.object.kind === 'iri' ? stmt.quad.object.value : null);

/** The labels of a term as name candidates of `draft`; a label that is no plain text is named. */
function addLabels(ctx: ReadContext, draft: { nameBy: TypeDraft['nameBy'] }, iri: string): void {
  for (const stmt of ctx.store.ofIri(iri, RDFS('label'))) {
    const text = plainText(stmt.quad.object);
    if (text === null) ctx.ledger.name(stmt, 'unreadable-value', 'a name is a plain text: a label with a language tag or a datatype is not read');
    else draft.nameBy(text, 'label', 'declared', stmt);
  }
}

/** Name every statement about `iri` that is not yet named: the term is none a schema holds. */
function rejectTerm(ctx: ReadContext, iri: string, why: NotTakenWhy, message: string): void {
  for (const stmt of ctx.store.ofIri(iri)) if (!ctx.ledger.isUsed(stmt)) ctx.ledger.name(stmt, why, message);
}

/**
 * Find the types the axioms declare: each class and each object property of the file becomes a draft by the address of its term, with the kind
 * and the names the term's address and labels give. A class that is an edge label's reifier is set aside for its label; a term that is none
 * a schema holds is named.
 */
export function discoverDeclared(ctx: ReadContext): void {
  const { store } = ctx;
  for (const subject of store.withType([OWL('Ontology')])) ctx.owned.add(keyOf(subject));
  const both = store.withType([OWL('DatatypeProperty')]).filter(s => s.kind === 'iri' && store.isA(s.value, [OWL('ObjectProperty')]));
  for (const subject of both) {
    if (subject.kind !== 'iri') continue;
    const [a] = store.ofIri(subject.value, RDF('type')).filter(s => objectIri(s) === OWL('DatatypeProperty'));
    const [b] = store.ofIri(subject.value, RDF('type')).filter(s => objectIri(s) === OWL('ObjectProperty'));
    ctx.owned.add(keyOf(subject));
    ctx.skip.add(subject.value);
    if (a !== undefined && b !== undefined) refuseWith(ctx, 'contradiction', 'a property is declared both a datatype property and an object property', [a, b]);
  }
  for (const subject of store.withType(CLASS_TYPES)) {
    if (subject.kind !== 'iri' || ctx.skip.has(subject.value)) continue;
    const iri = subject.value;
    ctx.owned.add(keyOf(subject));
    const read = readTerm(ctx, iri);
    if (read.how === 'rejected') { rejectTerm(ctx, iri, read.why, read.message); continue; }
    if (read.how === 'derived' && read.prop !== undefined) { rejectTerm(ctx, iri, 'unreadable-value', 'it is the address of a property, and a class is declared here'); continue; }
    if (read.how === 'derived' && read.kind === 'file') { rejectTerm(ctx, iri, 'no-field', 'a file has no type: its properties are the only terms the export writes for one'); continue; }
    if (read.how === 'derived' && read.kind === 'edge') { ctx.reifiers.push(iri); continue; }
    const draft = draftOf(ctx, iri);
    const classStmts = store.ofIri(iri, RDF('type')).filter(s => CLASS_TYPES.includes(objectIri(s) ?? ''));
    draft.classStmts.push(...classStmts);
    if (read.how === 'derived' && read.type !== null && classStmts[0] !== undefined) {
      draft.kinds.push({ kind: read.kind as KnowledgeType, stmt: classStmts[0], source: 'declared' });
      draft.nameBy(read.type, 'address', 'declared');
    }
    if (read.how === 'foreign' && classStmts[0] !== undefined) {
      draft.claim('iri', iri, classStmts[0], 'declared');
      if (read.stored !== undefined) { draft.kinds.push({ kind: read.stored.kind, stmt: classStmts[0], source: 'declared' }); draft.nameBy(read.stored.type, 'stored', 'declared'); }
    }
    addLabels(ctx, draft, iri);
  }
  for (const subject of store.withType([OWL('ObjectProperty')])) {
    if (subject.kind !== 'iri' || ctx.skip.has(subject.value)) continue;
    const iri = subject.value;
    ctx.owned.add(keyOf(subject));
    const read = readTerm(ctx, iri);
    if (read.how === 'rejected') { rejectTerm(ctx, iri, read.why, read.message); continue; }
    if (read.how === 'derived' && read.prop !== undefined) { rejectTerm(ctx, iri, 'unreadable-value', 'it is the address of a property, and an edge label is declared here'); continue; }
    const draft = draftOf(ctx, iri);
    const typeStmt = store.ofIri(iri, RDF('type')).find(s => objectIri(s) === OWL('ObjectProperty'));
    if (typeStmt === undefined) continue;
    draft.labelStmts.push(typeStmt);
    if (read.how === 'derived' && read.type !== null) {
      draft.kinds.push({ kind: read.kind as KnowledgeType, stmt: typeStmt, source: 'declared' });
      draft.nameBy(read.type, 'address', 'declared');
    }
    draft.kinds.push({ kind: 'edge', stmt: typeStmt, source: 'declared' });
    if (read.how === 'foreign') {
      draft.claim('iri', iri, typeStmt, 'declared');
      if (read.stored !== undefined) { draft.kinds.push({ kind: read.stored.kind, stmt: typeStmt, source: 'declared' }); draft.nameBy(read.stored.type, 'stored', 'declared'); }
    }
    addLabels(ctx, draft, iri);
  }
}

// -- ranges ------------------------------------------------------------------------------------------------------------------------------

interface RangeRead { claims: Array<{ field: string; value: unknown }>; unread: Array<{ why: 'no-field' | 'looser-field' | 'unreadable-value'; message: string }> }

function datatypeClaim(iri: string): RangeRead {
  if (iri === XSD('string')) return { claims: [{ field: 'type', value: 'string' }], unread: [] };
  if (iri === XSD('boolean')) return { claims: [{ field: 'type', value: 'boolean' }], unread: [] };
  if (NUMBER_DATATYPES.includes(iri)) return { claims: [{ field: 'type', value: 'number' }], unread: [] };
  if (iri === RDFS('Literal')) return { claims: [], unread: [{ why: 'no-field', message: 'any literal: a property with no type takes one, and the date type this is written for is stated by the property\'s shape' }] };
  if (isIntegerDatatype(iri)) return { claims: [], unread: [{ why: 'looser-field', message: 'whole numbers only: the type number also takes 1.5, so it would accept what this refuses' }] };
  if (DATE_DATATYPES.includes(iri)) return { claims: [], unread: [{ why: 'looser-field', message: 'one date form: the type date takes all of them, so it would accept what this refuses' }] };
  return { claims: [], unread: [{ why: 'no-field', message: 'a datatype no field holds' }] };
}

function restrictionsRead(ctx: ReadContext, node: Term): RangeRead {
  const out: RangeRead = { claims: [], unread: [] };
  const members = ctx.store.list(node);
  if (members === null) return { claims: [], unread: [{ why: 'unreadable-value', message: 'the restrictions are no list' }] };
  for (const member of members) {
    const facets = member.kind === 'blank' ? ctx.store.of(member) : [];
    const facet = facets.length === 1 ? facets[0]! : undefined;
    const predicate = facet?.quad.predicate.value;
    const bound = facet === undefined ? null : numberValue(facet.quad.object);
    if (predicate === XSD('minInclusive') && bound !== null) out.claims.push({ field: 'minimum', value: bound });
    else if (predicate === XSD('maxInclusive') && bound !== null) out.claims.push({ field: 'maximum', value: bound });
    else if (predicate === XSD('minExclusive') || predicate === XSD('maxExclusive')) out.unread.push({ why: 'looser-field', message: 'a bound the value must pass: a minimum or maximum accepts the bound itself' });
    else out.unread.push({ why: 'no-field', message: 'a facet no field holds' });
  }
  return out;
}

/** The deepest a range may nest its parts: a range that holds itself is no range. */
const RANGE_DEPTH_MAX = 16;

function rangeOf(ctx: ReadContext, range: Term, depth = 0): RangeRead {
  if (range.kind === 'iri') return datatypeClaim(range.value);
  if (range.kind !== 'blank' || depth > RANGE_DEPTH_MAX) return { claims: [], unread: [{ why: 'no-field', message: 'a range no field holds' }] };
  const out: RangeRead = { claims: [], unread: [] };
  const merge = (part: RangeRead): void => { out.claims.push(...part.claims); out.unread.push(...part.unread); };
  for (const stmt of ctx.store.of(range)) {
    const predicate = stmt.quad.predicate.value;
    if (predicate === RDF('type')) continue;
    if (predicate === OWL('oneOf')) {
      const members = ctx.store.list(stmt.quad.object);
      const values = members === null ? null : members.map(literalValue);
      if (values === null || values.some(v => v === null)) merge({ claims: [], unread: [{ why: 'unreadable-value', message: 'an enumeration with a member that is no plain value (or no list) is not read: a shorter list would refuse what the file allows' }] });
      else merge({ claims: [{ field: 'enum', value: values }], unread: [] });
    } else if (predicate === OWL('onDatatype')) {
      const base = stmt.quad.object.kind === 'iri' ? stmt.quad.object.value : '';
      merge(NUMBER_DATATYPES.includes(base) ? { claims: [{ field: 'type', value: 'number' }], unread: [] } : datatypeClaim(base));
    } else if (predicate === OWL('withRestrictions')) {
      merge(restrictionsRead(ctx, stmt.quad.object));
    } else if (predicate === OWL('intersectionOf')) {
      const parts = ctx.store.list(stmt.quad.object);
      if (parts === null) merge({ claims: [], unread: [{ why: 'unreadable-value', message: 'the parts of the range are no list' }] });
      else for (const part of parts) merge(rangeOf(ctx, part, depth + 1));
    } else {
      merge({ claims: [], unread: [{ why: 'no-field', message: 'a range no field holds (a union, a complement)' }] });
    }
  }
  return out;
}

function readRange(ctx: ReadContext, stmt: Stmt, props: readonly PropDraft[]): void {
  const read = rangeOf(ctx, stmt.quad.object);
  for (const prop of props) for (const claim of read.claims) prop.claim(claim.field, claim.value, stmt, 'declared');
  if (read.claims.length === 0 && read.unread.length === 0) ctx.ledger.name(stmt, 'no-field', 'a range no field holds');
  for (const part of read.unread) ctx.ledger.name(stmt, part.why, part.message);
}

// -- reading -----------------------------------------------------------------------------------------------------------------------------

/** The statements about a class or an edge label that read as claims: its comment, its one-only mark; the rest named. */
function readTypeAxioms(ctx: ReadContext, draft: TypeDraft): void {
  const { ledger } = ctx;
  const label = draft.kind === 'edge';
  for (const stmt of ctx.store.ofIri(draft.termIri)) {
    if (ledger.isUsed(stmt)) continue;
    const predicate = stmt.quad.predicate.value;
    const object = objectIri(stmt);
    if (predicate === RDF('type')) {
      if (CLASS_TYPES.includes(object ?? '') && !label) draft.structural('(declaration)', stmt, 'declared');
      else if (object === OWL('ObjectProperty') && label) draft.structural('(declaration)', stmt, 'declared');
      else if (object === OWL('FunctionalProperty') && label) draft.claim('functional', true, stmt, 'declared');
    } else if (predicate === RDFS('isDefinedBy')) {
      ledger.name(stmt, 'export-description', 'which ontology a term belongs to is the export\'s own statement about itself: no field holds it');
    } else if (predicate === RDFS('comment')) {
      const text = plainText(stmt.quad.object);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a description is a plain text: a comment with a language tag or a datatype is not read');
      else draft.claim('description', text, stmt, 'declared');
    } else if (label && (predicate === RDFS('domain') || predicate === RDFS('range'))) {
      ledger.name(stmt, 'looser-field', 'the classes at the ends of an edge label: endpoints are checked only when the other end is an entity, so they would accept a fact where this refuses one');
    }
  }
}

/** A class that is an edge label's reifier: taken with its label when the file has the label, named when it has not. */
function readReifier(ctx: ReadContext, iri: string): void {
  const { ledger, store } = ctx;
  const read = readTerm(ctx, iri);
  const draft = read.how === 'derived' && read.type !== null ? ctx.byName.get(nameKey('edge', read.type)) : undefined;
  for (const stmt of store.ofIri(iri)) {
    if (ledger.isUsed(stmt)) continue;
    const predicate = stmt.quad.predicate.value;
    const object = objectIri(stmt);
    if (draft === undefined || draft.broken) {
      if (predicate === RDF('type') || predicate === RDFS('isDefinedBy') || predicate === RDFS('label')) ledger.name(stmt, 'no-owner', 'the class of the reifiers of an edge label the file does not declare: the label is the type, and it is not built from this');
    } else if (predicate === RDF('type') && CLASS_TYPES.includes(object ?? '')) draft.structural('(reifier)', stmt, 'declared');
    else if (predicate === RDFS('isDefinedBy')) ledger.name(stmt, 'export-description', 'which ontology a term belongs to is the export\'s own statement about itself: no field holds it');
    else if (predicate === RDFS('label') && plainText(stmt.quad.object) === draft.name) draft.structural('(reifier)', stmt, 'declared');
  }
}

/** The declared owners of a datatype property: the type its own address names, then the classes its domains name that the file declares. */
function ownersOf(ctx: ReadContext, iri: string, derived: { kind: KnowledgeType | 'file'; type: string | null; prop?: string } | undefined): Array<{ draft: TypeDraft; domain?: Stmt }> {
  const owners: Array<{ draft: TypeDraft; domain?: Stmt }> = [];
  const own = derived?.prop !== undefined && derived.kind !== 'file' && derived.type !== null ? ctx.byName.get(nameKey(derived.kind, derived.type)) : undefined;
  if (own !== undefined && !own.broken) owners.push({ draft: own });
  for (const stmt of ctx.store.ofIri(iri, RDFS('domain'))) {
    const object = stmt.quad.object;
    if (object.kind !== 'iri') { ctx.ledger.name(stmt, 'no-field', 'a domain that is no class (a union, a restriction) names no one type'); continue; }
    const draft = ctx.drafts.get(object.value);
    if (draft === undefined || draft.broken || draft.name === undefined || !ctx.store.isA(object.value, CLASS_TYPES)) {
      ctx.ledger.name(stmt, 'no-owner', 'the file does not declare this class, so the property has no type to belong to');
    } else if (owners.length > 0 && own !== undefined) {
      const first = owners[0]!;
      if (first.draft === draft) first.domain = stmt;
      else ctx.ledger.name(stmt, 'second-value', 'the property\'s own address names another type');
    } else if (owners.some(o => o.draft === draft)) {
      ctx.ledger.name(stmt, 'second-value', 'the same domain twice');
    } else owners.push({ draft, domain: stmt });
  }
  return owners;
}

function readDataProperty(ctx: ReadContext, iri: string): void {
  const { ledger, store } = ctx;
  const read = readTerm(ctx, iri);
  if (read.how === 'rejected') { rejectTerm(ctx, iri, read.why, read.message); return; }
  if (read.how === 'derived' && (read.prop === undefined || read.kind === 'file')) {
    rejectTerm(ctx, iri, 'no-field', read.kind === 'file' ? 'a file has no type schema: its properties are no property of one' : 'it is the address of a type, and a property is declared here');
    return;
  }
  const owners = ownersOf(ctx, iri, read.how === 'derived' ? read : undefined);
  if (owners.length === 0) { rejectTerm(ctx, iri, 'no-owner', 'a property belongs to a type, and the file names none this one can be read to (no address of the space\'s, no declared domain)'); return; }
  const props = owners.map(o => {
    const prop = o.draft.prop(iri);
    if (read.how === 'derived' && read.prop !== undefined) prop.nameBy(read.prop, 'address', 'declared');
    if (read.how === 'foreign') {
      const declaration = store.ofIri(iri, RDF('type')).find(s => objectIri(s) === OWL('DatatypeProperty') || objectIri(s) === RDF('Property'));
      if (declaration !== undefined) prop.claim('iri', iri, declaration, 'declared');
      if (read.stored?.prop !== undefined) prop.nameBy(read.stored.prop, 'stored', 'declared');
    }
    for (const stmt of store.ofIri(iri, RDFS('label'))) {
      const text = plainText(stmt.quad.object);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a name is a plain text: a label with a language tag or a datatype is not read');
      else prop.nameBy(text, 'label', 'declared', stmt);
    }
    if (o.domain !== undefined) prop.structural('(owner)', o.domain, 'declared');
    return prop;
  });
  for (const stmt of store.ofIri(iri)) {
    if (ledger.isUsed(stmt)) continue;
    const predicate = stmt.quad.predicate.value;
    const object = objectIri(stmt);
    if (predicate === RDF('type')) {
      if (object === OWL('DatatypeProperty') || object === RDF('Property')) for (const p of props) p.structural('(declaration)', stmt, 'declared');
      else if (object === OWL('FunctionalProperty')) for (const p of props) p.structural('(every property)', stmt, 'declared');
    } else if (predicate === RDFS('isDefinedBy')) {
      ledger.name(stmt, 'export-description', 'which ontology a term belongs to is the export\'s own statement about itself: no field holds it');
    } else if (predicate === RDFS('comment')) {
      const text = plainText(stmt.quad.object);
      if (text === null) ledger.name(stmt, 'unreadable-value', 'a description is a plain text: a comment with a language tag or a datatype is not read');
      else for (const p of props) p.claim('description', text, stmt, 'declared');
    } else if (predicate === RDFS('range')) {
      readRange(ctx, stmt, props);
    } else if (predicate === YTHRIL('mergeFn')) {
      const text = plainText(stmt.quad.object);
      if (text !== null && (MERGE_FNS as readonly string[]).includes(text)) for (const p of props) p.claim('mergeFn', text, stmt, 'declared');
      else ledger.name(stmt, 'unreadable-value', 'a merge function is one of the names the schema knows');
    }
  }
}

/** The ontology node: the export's description of itself, and the space's own fields, which this reader leaves to the space. */
function readOntology(ctx: ReadContext): void {
  const { ledger, store } = ctx;
  for (const subject of store.withType([OWL('Ontology')])) {
    for (const stmt of store.of(subject)) {
      if (ledger.isUsed(stmt)) continue;
      const predicate = stmt.quad.predicate.value;
      if (predicate === RDF('type') || predicate === OWL('versionIRI') || predicate === OWL('versionInfo')) {
        ledger.name(stmt, 'export-description', 'the ontology and its version are the export\'s own statement about itself: no field holds them');
      } else if (predicate === RDFS('comment') || predicate === YTHRIL('validationMode') || predicate === YTHRIL('strictLinkage') || predicate === YTHRIL('rule')) {
        ledger.name(stmt, 'space-level', 'a field of the space, not of a type: this reader answers type schemas only, and the space\'s own door sets it');
      }
    }
  }
}

/** Read the declarations: the types' own axioms, the reifier classes, the datatype properties, the ontology. Types must be named and kinded first. */
export function readDeclared(ctx: ReadContext): void {
  for (const draft of ctx.drafts.values()) {
    if (!draft.broken && draft.kind !== undefined && draft.name !== undefined) readTypeAxioms(ctx, draft);
  }
  for (const iri of ctx.reifiers) readReifier(ctx, iri);
  const seen = new Set<string>();
  const declared = ctx.store.withType([OWL('DatatypeProperty')]);
  for (const subject of ctx.store.withType([RDF('Property')])) {
    if (subject.kind !== 'iri' || ctx.store.isA(subject.value, [OWL('DatatypeProperty'), OWL('ObjectProperty')])) continue;
    ctx.owned.add(keyOf(subject));
    if (holdsPlainValues(ctx, subject.value)) declared.push(subject);
    else rejectTerm(ctx, subject.value, 'no-field', 'a property of no declared kind: its range does not say whether it holds a plain value or a record');
  }
  for (const subject of declared) {
    if (subject.kind !== 'iri' || seen.has(subject.value) || ctx.skip.has(subject.value)) continue;
    seen.add(subject.value);
    ctx.owned.add(keyOf(subject));
    readDataProperty(ctx, subject.value);
  }
  readOntology(ctx);
}

/** Does an RDFS property's range say it holds plain values: a datatype of XML Schema, `rdfs:Literal`, or a datatype expression? */
function holdsPlainValues(ctx: ReadContext, iri: string): boolean {
  return ctx.store.ofIri(iri, RDFS('range')).some(s => {
    const range = s.quad.object;
    if (range.kind === 'blank') return ctx.store.of(range, RDF('type')).some(t => t.quad.object.kind === 'iri' && t.quad.object.value === RDFS('Datatype'));
    return range.kind === 'iri' && (range.value === RDFS('Literal') || range.value.startsWith(XSD('')));
  });
}
