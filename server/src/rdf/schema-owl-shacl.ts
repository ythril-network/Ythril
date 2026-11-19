/**
 * A space's schema as an RDF graph: OWL axioms for the terms the space owns and SHACL shapes for every type and property, versioned by the
 * schema's fingerprint (Q-751, design r4 section 6; owner, 2026-11-18: every schema field and every description reaches the export).
 *
 * ## What it prevents
 *
 * - **A field that silently does not reach the export.** {@link SCHEMA_FIELD_EXPORT} places every field of a property definition, a type
 *   definition and the space, each in a standard OWL or SHACL term, a `ythril:` annotation, or "not exported" with the reason.
 *   `every-schema-field-reaches-the-schema-export.test.js` reads the field list from the schema package's own zod shapes and fails on a field
 *   the map does not place, on a row for a field that no longer exists, and on a mapped field that does not produce the terms its row names.
 * - **A shape that says more or less than the server checks.** A consumer validates exported records against these shapes, so each constraint
 *   is the server's own (`spaces/schema-validation.ts`): a range is read only on a number and a pattern only on text (guarded `sh:or`, never a
 *   bare `sh:minInclusive` that would refuse the strings a property of no declared type may hold); `required` also refuses `''`; an enumeration
 *   is read through the one literal function with the property's declared type, so its members are typed exactly as the record form types its
 *   values; an edge's endpoints are checked only when the other end is an entity (an endpoint that is unresolved passes);
 *   `the-exported-shapes-validate-what-the-export-writes.test.js` runs these shapes with an independent validator over slice B's record triples.
 * - **An axiom about a term the space does not own.** OWL axioms (`rdfs:isDefinedBy`, label, comment, domain, range, functional) are written
 *   only for a term under the space's own vocab or an instance group namespace; a type mapped to `schema:Person` never gets a statement about
 *   `schema:Person`. The space's words about ANY term (name, description, merge function, patterns) go on the term's SHACL shape, which is
 *   always the space's own resource, so a description on an outside-mapped term is not lost.
 * - **A text with a language, a number with a guessed type.** Every text is a plain literal (no datatype, no language tag: the stored text
 *   has none); counts are `xsd:integer`; an enumeration member, a default, a range bound is typed by `literalForValue` with the declared type,
 *   and one that does not fit its declared type is left out and NAMED in `leftOut`, as the record form does for a record's value.
 * - **A second, unstable form.** The same schema gives the same quads in the same order whatever order its keys were written in (types and
 *   properties are visited in code-unit order, blank nodes are numbered in that order); the version is the fingerprint the caller hands in,
 *   never recomputed here, so the ontology's version and the records' `dcterms:conformsTo` are one value.
 * - **An unresolved library reference dropped, or a throw.** A type whose `$ref` resolved to nothing is exported with `ythril:unresolvedRef`.
 *
 * ## The forms (design r4 section 6)
 *
 * An entity, fact or chrono type is a class (`owl:Class` when own) and a node shape that targets it; a property is an `owl:DatatypeProperty`
 * and `owl:FunctionalProperty` (a property holds one plain value: decision record 23) and a property shape hung on its type's node shape.
 * An edge type is a PROPERTY, never a class: its node shape targets the subjects of the label, its endpoints are `sh:or` of `sh:class` (the
 * subject side on the node shape, the object side on a property shape of the label), a functional label is `sh:maxCount 1`, and the plain
 * properties of an edge have shapes of their own aimed at the reifier (`sh:targetSubjectsOf` the property): a required one has no Core target,
 * so it is `ythril:requiredEdgeProperty` on the node shape. Shape addresses are `<base>schema/shape/<kind>/<seg(type)>[#<frag(prop)>]`.
 *
 * Pure: it reads only what it is handed (the RESOLVED meta, `inlineResolvableRefs`, and the fingerprint of that schema). It sets no graph;
 * the stream names it. Quads are written by `serialize.ts`.
 */
import { KNOWLEDGE_TYPES, type KnowledgeType, type SpaceMeta } from '@ythril-network/schema';
import { isSchemaFingerprint } from '@ythril-network/schema/internal';
import {
  blank, iri, list, literalForBoolean, literalForInteger, literalForValue, plain, quad, stdIri, xsd,
  type BlankTerm, type DeclaredType, type IriTerm, type LeftOutReason, type LiteralTerm, type Quad, type Term,
} from './literals.js';
import { patternReadsAlike } from './portable-pattern.js';
import { ontologyIri, prefixesFor, resolveTermIri, shapeIri, termOwnerName, versionIri } from './term-iri.js';
import { ythrilIri } from './ythril-vocabulary.js';

/** A schema-library group's namespace, as the instance holds it (`schemaLibraryNamespaces`): the terms under it are the instance's own. */
export interface SchemaNamespace { prefix: string; iri: string }

export interface SchemaGraphOptions {
  /** The instance's group namespaces: a term under one is an OWN term (axioms are written for it) and its prefix is declared. */
  namespaces?: readonly SchemaNamespace[];
}

/** One schema value the export could not write, named so the operator can find and repair it. */
export interface SchemaLeftOut {
  /** The type or property, as `kind:type` or `kind:type.property` (`termOwnerName`). */
  where: string;
  /** The schema field: `enum`, `default`, `minimum` or `maximum`. */
  field: string;
  reason: LeftOutReason;
}

export interface SchemaGraph {
  quads: Quad[];
  /** What a writer declares: the standard prefixes, the space's vocab and the group prefixes its terms use. */
  prefixes: Record<string, string>;
  /** The ontology, `<base>schema`. */
  ontology: string;
  /** This version of it, `<base>schema/<fingerprint>`. */
  version: string;
  leftOut: SchemaLeftOut[];
}

// -- the map of fields to where they land -------------------------------------------------------------------------------------------------

/**
 * Where one schema field lands. `owl` (own terms only), `shacl` (always, on the space's shapes) and `annotation` (`ythril:` terms) name the
 * terms it reaches: a prefixed name (`rdfs:comment`) is a term a test counts in the graph, any other text describes a term that has no name of
 * its own (the address a field gives a resource). `reason` is why a field is not exported; a row has terms or a reason, never both.
 */
export interface FieldPlacement {
  readonly owl?: readonly string[];
  readonly shacl?: readonly string[];
  readonly annotation?: readonly string[];
  readonly reason?: string;
}

export type SchemaFieldPath = 'property' | 'type' | 'space';

/**
 * The rows of the design's field-by-field tables that are no field of the schema's zod shapes: the key a property is written under, the name of
 * a type, what every property is, and a type whose library reference could not be resolved. A row named like one starts with `(`.
 */
export const SCHEMA_PSEUDO_FIELDS: readonly string[] = Object.freeze(['(key)', '(every property)', '(name)', '(unresolved $ref)']);

/**
 * Every field a schema can state, and where it lands (design r4 section 6). `property` is `PropertySchemaZ.shape`, `type` is
 * `InlineTypeSchemaZ.shape` and `space` is `SpaceMetaBody.shape`, each plus its pseudo-fields. A field added to a schema fails
 * `every-schema-field-reaches-the-schema-export.test.js` until it has a row here.
 */
export const SCHEMA_FIELD_EXPORT: Readonly<Record<SchemaFieldPath, Readonly<Record<string, FieldPlacement>>>> = Object.freeze({
  property: Object.freeze({
    '(key)': { owl: ['rdfs:label'], shacl: ['sh:name'] },
    '(every property)': { owl: ['owl:FunctionalProperty'], shacl: ['sh:maxCount'] },
    iri: { owl: ['the property term itself'], shacl: ['sh:path'] },
    description: { owl: ['rdfs:comment'], shacl: ['sh:description'] },
    type: { owl: ['rdfs:range'], shacl: ['sh:datatype'] },
    enum: { owl: ['owl:oneOf'], shacl: ['sh:in'] },
    minimum: { owl: ['owl:withRestrictions'], shacl: ['sh:minInclusive'] },
    maximum: { owl: ['owl:withRestrictions'], shacl: ['sh:maxInclusive'] },
    pattern: { shacl: ['sh:pattern'], annotation: ['ythril:pattern'] },
    required: { shacl: ['sh:minCount', 'sh:minLength'], annotation: ['ythril:requiredEdgeProperty'] },
    default: { shacl: ['sh:defaultValue'] },
    mergeFn: { annotation: ['ythril:mergeFn'] },
  }),
  type: Object.freeze({
    '(name)': { owl: ['rdfs:label'], shacl: ['sh:name'] },
    '(unresolved $ref)': { annotation: ['ythril:unresolvedRef'] },
    iri: { owl: ['the class, or the edge label\'s property, itself'], shacl: ['sh:targetClass', 'sh:targetSubjectsOf'] },
    description: { owl: ['rdfs:comment'], shacl: ['sh:description'] },
    namingPattern: { shacl: ['sh:pattern'], annotation: ['ythril:namingPattern'] },
    propertySchemas: { owl: ['the property terms'], shacl: ['sh:property'] },
    endpoints: { shacl: ['sh:or', 'sh:class'], annotation: ['ythril:endpointFrom', 'ythril:endpointTo'] },
    functional: { owl: ['owl:FunctionalProperty'], shacl: ['sh:maxCount'] },
    retention: { annotation: ['ythril:retentionDays', 'ythril:retentionContentDays'] },
    suppressEmbeddings: { annotation: ['ythril:suppressEmbeddings'] },
    whenDuePasses: { annotation: ['ythril:whenDuePasses'] },
    rules: { annotation: ['ythril:rule', 'ythril:ruleName', 'ythril:ruleExpression', 'ythril:ruleMessage'] },
  }),
  space: Object.freeze({
    purpose: { owl: ['rdfs:comment'] },
    validationMode: { annotation: ['ythril:validationMode'] },
    strictLinkage: { annotation: ['ythril:strictLinkage'] },
    rules: { annotation: ['ythril:rule', 'ythril:ruleName', 'ythril:ruleExpression', 'ythril:ruleMessage', 'ythril:ruleKinds'] },
    typeSchemas: { reason: 'Exported type by type: each type is placed by the type table and each property by the property table.' },
    usageNotes: { reason: 'Prose for the settings page, outside the schema and outside the owner\'s list of what the export carries (design r4 section 6).' },
    suppressEmbeddings: { reason: 'A setting of this instance\'s embedding, not the schema; a type\'s own setting is exported (type.suppressEmbeddings).' },
    whenDuePasses: { reason: 'A setting of this instance\'s due-date reading, not the schema; a type\'s own setting is exported (type.whenDuePasses).' },
    stampSkew: { reason: 'A setting of this instance\'s clock check, not the schema.' },
    rdf: { reason: 'The setting that names the export itself: it is the base and the vocab every address is built from, not something the schema says.' },
  }),
});

// -- reading the meta, defensively: it is parsed before it is stored, but one reader never assumes it ---------------------------------------

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);
const bagOf = (v: unknown): Bag => (isBag(v) ? v : {});
/** A non-empty string, or undefined: an empty text states nothing, as the record form's text. */
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The names of a map in code-unit order (the order every export visits them in), `[]` for what is no map. */
function namesOf(map: unknown): string[] {
  if (!isBag(map)) return [];
  const names = Object.keys(map);
  return names.sort(byCode);
}
const own = (bag: Bag, key: string): unknown => (Object.hasOwn(bag, key) ? bag[key] : undefined);
const bagAt = (bag: Bag, key: string): Bag => {
  const v = own(bag, key);
  return isBag(v) ? v : {};
};
const declaredOf = (v: unknown): DeclaredType | undefined => (v === 'string' || v === 'number' || v === 'boolean' || v === 'date' ? v : undefined);

/** A type's `$ref` that no library entry answered: the stamped form, or a reference with no definition beside it (the inlined form). */
function unresolvedRefOf(def: Bag): string | undefined {
  const stamped = textOf(own(def, '_unresolvedRef'));
  if (stamped !== undefined) return stamped;
  const ref = textOf(own(def, '$ref'));
  return ref !== undefined && Object.keys(def).every(k => k === '$ref') ? ref : undefined;
}

// -- the terms ----------------------------------------------------------------------------------------------------------------------------

const RDF_TYPE = stdIri('rdf', 'type');
const RDFS = (local: string): IriTerm => stdIri('rdfs', local);
const OWL = (local: string): IriTerm => stdIri('owl', local);
const SH = (local: string): IriTerm => stdIri('sh', local);
const XSD = (local: string): IriTerm => stdIri('xsd', local);
const YTHRIL = (local: string): IriTerm => iri(ythrilIri(local));

/** The datatypes a date may be written as: a typed temporal value, or text that is no calendar date (`literals.ts`, `literalForTemporal`). */
const DATE_DATATYPES: readonly IriTerm[] = Object.freeze([XSD('dateTimeStamp'), XSD('dateTime'), XSD('date'), XSD('string')]);
const ENTITY_PREFIX = 'entity:';
/** The member of an `endpoints` list that means an entity with no type (`spaces/schema-validation.ts`: a type of `null` is read as this). */
const UNTYPED_MEMBER = 'UNTYPED';
const COUNT_ONE = 1;
/** What the shape of a naming pattern is called: an entity's name is its `rdfs:label`. */
const NAME_OF_AN_ENTITY = 'name';

function integer(n: number): LiteralTerm {
  const literal = literalForInteger(n);
  if (literal === null) throw new RangeError(`${String(n)} is no integer`);
  return literal;
}

type Subject = IriTerm | BlankTerm;

/** What one export builds: the quads, what it left out, and the numbering of its blank nodes (in the order the types and properties are visited). */
class Out {
  readonly quads: Quad[] = [];
  readonly leftOut: SchemaLeftOut[] = [];
  private blanks = 0;

  add(subject: Subject, predicate: IriTerm, object: Term): void {
    this.quads.push(quad(subject, predicate, object));
  }
  node(): BlankTerm {
    return blank(`s${this.blanks++}`);
  }
  /** `subject predicate "value"` as a plain literal, when `value` is a non-empty string. */
  say(subject: Subject, predicate: IriTerm, value: unknown): void {
    const t = textOf(value);
    if (t !== undefined) this.add(subject, predicate, plain(t));
  }
  /** A blank node with one statement: the member of a guard. */
  shapeWith(predicate: IriTerm, object: Term): BlankTerm {
    const n = this.node();
    this.add(n, predicate, object);
    return n;
  }
  /** A literal through the one literal function; what does not fit is left out and named. `undefined` for absent, null or left out. */
  literal(value: unknown, declared: DeclaredType | undefined, where: string, field: string): LiteralTerm | undefined {
    const outcome = literalForValue(value, declared);
    if (outcome.kind === 'literal') return outcome.literal;
    if (outcome.kind === 'left-out') this.leftOut.push({ where, field, reason: outcome.reason });
    return undefined;
  }
}

/** Everything an export reads about the space: its names, its own terms, the shape addresses. */
class Space {
  readonly vocab: string;
  constructor(readonly meta: SpaceMeta, readonly ontology: string, private readonly namespaces: readonly SchemaNamespace[]) {
    this.vocab = prefixesFor(meta, namespaces)['vocab']!;
  }

  /** Is `address` the space's own: under its vocab or under an instance group namespace? */
  isOwn(address: string): boolean {
    return address.startsWith(this.vocab) || this.namespaces.some(ns => address.startsWith(ns.iri));
  }
  /** The term of a type or property, as the record form names it. */
  term(kind: KnowledgeType, type: string, prop?: string): IriTerm {
    return iri(resolveTermIri(this.meta, kind, type, prop));
  }
  /** The shape of a type or property: `<base>schema/shape/<kind>/<seg(type)>[#<frag(prop)>]`, from the resolver (`shapeIri`). */
  shape(kind: KnowledgeType, type: string, prop?: string): IriTerm {
    return iri(shapeIri(this.meta, kind, type, prop));
  }
}

// -- properties ---------------------------------------------------------------------------------------------------------------------------

/** The datatype a declared type is: a number is a decimal, as the record form writes it. A date has no one datatype (see {@link DATE_RANGE}). */
const DATATYPE_OF: Readonly<Record<Exclude<DeclaredType, 'date'>, string>> = Object.freeze({
  string: xsd('string'), number: xsd('decimal'), boolean: xsd('boolean'),
});

/**
 * The OWL range of a date property: `rdfs:Literal`. A date is written as one of {@link DATE_DATATYPES}, but `xsd:date` is not in the OWL 2
 * datatype map (OWL 2 Structural Specification §4), and a union naming it would take the ontology out of OWL 2 DL; the exact four-member
 * check stays in the property's SHACL shape.
 */
const DATE_RANGE = RDFS('Literal');

/** What a property's own fields say, read once: the values are typed here, so the axiom and the shape cannot disagree. */
interface PropertyFacts {
  declared: DeclaredType | undefined;
  /** The members that fit the declared type; `undefined` when the property states no enumeration (an empty one restricts nothing). */
  members: LiteralTerm[] | undefined;
  default: LiteralTerm | undefined;
  minimum: LiteralTerm | undefined;
  maximum: LiteralTerm | undefined;
  pattern: string | undefined;
  required: boolean;
  mergeFn: string | undefined;
}

function factsOf(out: Out, def: Bag, where: string): PropertyFacts {
  const declared = declaredOf(own(def, 'type'));
  const raw = own(def, 'enum');
  let members: LiteralTerm[] | undefined;
  if (Array.isArray(raw) && raw.length > 0) {
    members = [];
    for (const member of raw) {
      const literal = out.literal(member, declared, where, 'enum');
      if (literal !== undefined) members.push(literal);
    }
  }
  return {
    declared,
    members,
    default: out.literal(own(def, 'default'), declared, where, 'default'),
    minimum: out.literal(own(def, 'minimum'), 'number', where, 'minimum'),
    maximum: out.literal(own(def, 'maximum'), 'number', where, 'maximum'),
    pattern: textOf(own(def, 'pattern')),
    required: own(def, 'required') === true,
    mergeFn: textOf(own(def, 'mergeFn')),
  };
}

/** A datatype that is a restriction of `base` by `facets` (`xsd:minInclusive`, ...): `[a rdfs:Datatype; owl:onDatatype base; owl:withRestrictions (...)]`. */
function restriction(out: Out, base: string, facets: readonly (readonly [IriTerm, LiteralTerm])[]): BlankTerm {
  const n = out.node();
  out.add(n, RDF_TYPE, RDFS('Datatype'));
  out.add(n, OWL('onDatatype'), iri(base));
  out.add(n, OWL('withRestrictions'), list(facets.map(([facet, value]) => out.shapeWith(facet, value))));
  return n;
}

/**
 * The range of an own property. An enumeration is the range (its members already fit the declared type). Facets are written only where the
 * server applies them: a range on a declared number; a range on a property of another type stays a SHACL guard alone, since an axiom would
 * claim every value of the property is a number. A pattern is never an OWL facet: an `xsd:pattern` facet is implicitly anchored and reads
 * `^` and `$` as characters, so it would mean something else than the server's ECMAScript pattern (standards review row 7).
 */
function rangeOf(out: Out, facts: PropertyFacts): Term | undefined {
  const parts: Term[] = [];
  if (facts.members !== undefined) {
    const n = out.node();
    out.add(n, RDF_TYPE, RDFS('Datatype'));
    out.add(n, OWL('oneOf'), list(facts.members));
    parts.push(n);
  }
  const numeric: (readonly [IriTerm, LiteralTerm])[] = [];
  if (facts.declared === 'number' && facts.minimum !== undefined) numeric.push([XSD('minInclusive'), facts.minimum]);
  if (facts.declared === 'number' && facts.maximum !== undefined) numeric.push([XSD('maxInclusive'), facts.maximum]);
  if (numeric.length > 0) parts.push(restriction(out, DATATYPE_OF.number, numeric));
  if (parts.length === 0 && facts.declared !== undefined && facts.members === undefined) {
    return facts.declared === 'date' ? DATE_RANGE : iri(DATATYPE_OF[facts.declared]);
  }
  if (parts.length <= COUNT_ONE) return parts[0];
  const both = out.node();
  out.add(both, RDF_TYPE, RDFS('Datatype'));
  out.add(both, OWL('intersectionOf'), list(parts));
  return both;
}

/** What a property is as the space's own term: a functional datatype property with its label, comment, domain and range. */
function propertyAxioms(out: Out, term: IriTerm, ontology: string, key: string, def: Bag, facts: PropertyFacts, domain: IriTerm | undefined): void {
  out.add(term, RDF_TYPE, OWL('DatatypeProperty'));
  out.add(term, RDF_TYPE, OWL('FunctionalProperty'));
  out.add(term, RDFS('isDefinedBy'), iri(ontology));
  out.add(term, RDFS('label'), plain(key));
  out.say(term, RDFS('comment'), own(def, 'description'));
  if (domain !== undefined) out.add(term, RDFS('domain'), domain);
  const range = rangeOf(out, facts);
  if (range !== undefined) out.add(term, RDFS('range'), range);
  out.say(term, YTHRIL('mergeFn'), facts.mergeFn);
}

/**
 * The guarded constraints: a range is read only on a decimal, a pattern only on what is no decimal and no boolean, and only a pattern SHACL's
 * regular expressions read as the server does ({@link patternReadsAlike}); every pattern's own text is `ythril:pattern` on the shape.
 */
function guards(out: Out, shape: Subject, facts: PropertyFacts): void {
  const notDecimal = (): BlankTerm => out.shapeWith(SH('not'), out.shapeWith(SH('datatype'), XSD('decimal')));
  if (facts.minimum !== undefined) out.add(shape, SH('or'), list([notDecimal(), out.shapeWith(SH('minInclusive'), facts.minimum)]));
  if (facts.maximum !== undefined) out.add(shape, SH('or'), list([notDecimal(), out.shapeWith(SH('maxInclusive'), facts.maximum)]));
  out.say(shape, YTHRIL('pattern'), facts.pattern);
  if (facts.pattern !== undefined && patternReadsAlike(facts.pattern)) {
    out.add(shape, SH('or'), list([
      out.shapeWith(SH('datatype'), XSD('decimal')), out.shapeWith(SH('datatype'), XSD('boolean')), out.shapeWith(SH('pattern'), plain(facts.pattern)),
    ]));
  }
}

/**
 * The shape of one property. `edgeProperty` is true for a property of an edge type: its value sits on the edge's reifier, so the shape aims
 * itself at the subjects of the property, and a required one cannot be a count (nothing targets a reifier that lacks the property).
 */
function propertyShape(out: Out, shape: IriTerm, path: IriTerm, key: string, def: Bag, facts: PropertyFacts, edgeProperty: boolean): void {
  out.add(shape, RDF_TYPE, SH('PropertyShape'));
  out.add(shape, SH('path'), path);
  if (edgeProperty) out.add(shape, SH('targetSubjectsOf'), path);
  out.add(shape, SH('name'), plain(key));
  out.say(shape, SH('description'), own(def, 'description'));
  out.add(shape, SH('maxCount'), integer(COUNT_ONE));
  if (facts.declared === 'date') out.add(shape, SH('or'), list(DATE_DATATYPES.map(t => out.shapeWith(SH('datatype'), t))));
  else if (facts.declared !== undefined) out.add(shape, SH('datatype'), iri(DATATYPE_OF[facts.declared]));
  if (facts.members !== undefined) out.add(shape, SH('in'), list(facts.members));
  guards(out, shape, facts);
  if (facts.required) {
    if (!edgeProperty) out.add(shape, SH('minCount'), integer(COUNT_ONE));
    out.add(shape, SH('minLength'), integer(COUNT_ONE));
  }
  if (facts.default !== undefined) out.add(shape, SH('defaultValue'), facts.default);
  out.say(shape, YTHRIL('mergeFn'), facts.mergeFn);
}

// -- types --------------------------------------------------------------------------------------------------------------------------------

/** `ythril:rule [ ythril:ruleName; ythril:ruleExpression; ythril:ruleMessage; ythril:ruleKinds ]` for each rule, by name. */
function rules(out: Out, subject: Subject, map: unknown, withKinds: boolean): void {
  for (const name of namesOf(map)) {
    const rule = bagAt(bagOf(map), name);
    const n = out.node();
    out.add(subject, YTHRIL('rule'), n);
    out.add(n, YTHRIL('ruleName'), plain(name));
    out.say(n, YTHRIL('ruleExpression'), own(rule, 'rule'));
    out.say(n, YTHRIL('ruleMessage'), own(rule, 'message'));
    const kinds = own(rule, 'kinds');
    if (withKinds && Array.isArray(kinds)) for (const kind of kinds) out.say(n, YTHRIL('ruleKinds'), kind);
  }
}

/** The classes an `endpoints` member names: an entity type, or the untyped bucket (which an entity of a type called `UNTYPED` also matches). */
function endpointClasses(space: Space, member: string): IriTerm[] {
  const name = member.startsWith(ENTITY_PREFIX) ? member.slice(ENTITY_PREFIX.length) : member;
  if (name !== UNTYPED_MEMBER) return [space.term('entity', name)];
  return [iri(resolveTermIri(space.meta, 'entity', null)), space.term('entity', UNTYPED_MEMBER)];
}

/** The classes of one side of an edge's endpoints, each once, in the order the schema lists them. */
function endpointSide(space: Space, members: unknown): IriTerm[] {
  const seen = new Set<string>();
  const classes: IriTerm[] = [];
  for (const member of Array.isArray(members) ? members : []) {
    if (typeof member !== 'string') continue;
    for (const c of endpointClasses(space, member)) {
      if (!seen.has(c.value)) { seen.add(c.value); classes.push(c); }
    }
  }
  return classes;
}

/** `sh:or` of one `sh:class` per class and a last member that lets a record pass that is no entity (an endpoint the server could not resolve). */
function endpointOr(out: Out, classes: readonly IriTerm[]): Term {
  const members: Term[] = classes.map(c => out.shapeWith(SH('class'), c));
  members.push(out.shapeWith(SH('not'), out.shapeWith(SH('class'), YTHRIL('Entity'))));
  return list(members);
}

interface TypeFacts { node: IriTerm; term: IriTerm; requiredEdgeProperties: IriTerm[] }

/** The class (or, for an edge, the property) the type is, as the space's own term. */
function typeAxioms(out: Out, space: Space, kind: KnowledgeType, type: string, def: Bag, term: IriTerm): void {
  const edge = kind === 'edge';
  out.add(term, RDF_TYPE, edge ? OWL('ObjectProperty') : OWL('Class'));
  if (edge && own(def, 'functional') === true) out.add(term, RDF_TYPE, OWL('FunctionalProperty'));
  out.add(term, RDFS('isDefinedBy'), iri(space.ontology));
  out.add(term, RDFS('label'), plain(type));
  out.say(term, RDFS('comment'), own(def, 'description'));
}

/** The annotations of a node shape that no standard term carries: naming pattern, retention, suppression, the due policy, rules. */
function typeAnnotations(out: Out, node: IriTerm, def: Bag, where: string): void {
  out.say(node, YTHRIL('namingPattern'), own(def, 'namingPattern'));
  const retention = bagAt(def, 'retention');
  for (const [field, term] of [['days', 'retentionDays'], ['contentDays', 'retentionContentDays']] as const) {
    const days = own(retention, field);
    if (days === undefined) continue;
    const literal = typeof days === 'number' ? literalForInteger(days) : null;
    if (literal === null) out.leftOut.push({ where, field: `retention.${field}`, reason: 'does-not-fit-its-declared-type' });
    else out.add(node, YTHRIL(term), literal);
  }
  const suppress = own(def, 'suppressEmbeddings');
  if (typeof suppress === 'boolean') out.add(node, YTHRIL('suppressEmbeddings'), literalForBoolean(suppress));
  out.say(node, YTHRIL('whenDuePasses'), own(def, 'whenDuePasses'));
  rules(out, node, own(def, 'rules'), false);
}

/** An edge's endpoints and its functional mark: on the node shape (the subject side) and a property shape of the label (the object side). */
function edgeConstraints(out: Out, space: Space, node: IriTerm, label: IriTerm, name: string, def: Bag): void {
  const endpoints = bagAt(def, 'endpoints');
  const from = endpointSide(space, own(endpoints, 'from'));
  const to = endpointSide(space, own(endpoints, 'to'));
  if (from.length > 0) {
    out.add(node, SH('or'), endpointOr(out, from));
    for (const c of from) out.add(node, YTHRIL('endpointFrom'), c);
  }
  for (const c of to) out.add(node, YTHRIL('endpointTo'), c);
  const functional = own(def, 'functional') === true;
  if (to.length === 0 && !functional) return;
  const shape = out.node();
  out.add(node, SH('property'), shape);
  out.add(shape, RDF_TYPE, SH('PropertyShape'));
  out.add(shape, SH('path'), label);
  out.add(shape, SH('name'), plain(name));
  if (to.length > 0) out.add(shape, SH('or'), endpointOr(out, to));
  if (functional) out.add(shape, SH('maxCount'), integer(COUNT_ONE));
}

/** The properties of one type: each one's axioms (own terms), its shape, and, for a type that is no edge, its place on the node shape. */
function typeProperties(out: Out, space: Space, kind: KnowledgeType, type: string, def: Bag, facts: TypeFacts): void {
  const edge = kind === 'edge';
  const props = bagAt(def, 'propertySchemas');
  for (const key of namesOf(props)) {
    const pdef = bagAt(props, key);
    const where = termOwnerName({ kind, type, prop: key });
    const f = factsOf(out, pdef, where);
    const term = space.term(kind, type, key);
    if (space.isOwn(term.value)) propertyAxioms(out, term, space.ontology, key, pdef, f, edge ? undefined : facts.term);
    const shape = space.shape(kind, type, key);
    propertyShape(out, shape, term, key, pdef, f, edge);
    if (!edge) out.add(facts.node, SH('property'), shape);
    else if (f.required) facts.requiredEdgeProperties.push(term);
  }
}

function exportType(out: Out, space: Space, kind: KnowledgeType, type: string, raw: unknown): void {
  const def = isBag(raw) ? raw : {};
  const edge = kind === 'edge';
  const term = space.term(kind, type);
  const node = space.shape(kind, type);
  if (space.isOwn(term.value)) typeAxioms(out, space, kind, type, def, term);
  out.add(node, RDF_TYPE, SH('NodeShape'));
  out.add(node, SH('name'), plain(type));
  out.say(node, SH('description'), own(def, 'description'));
  out.add(node, edge ? SH('targetSubjectsOf') : SH('targetClass'), term);
  const unresolved = unresolvedRefOf(def);
  if (unresolved !== undefined) out.add(node, YTHRIL('unresolvedRef'), plain(unresolved));
  typeAnnotations(out, node, def, termOwnerName({ kind, type }));
  const facts: TypeFacts = { node, term, requiredEdgeProperties: [] };
  typeProperties(out, space, kind, type, def, facts);
  if (edge) edgeConstraints(out, space, node, term, type, def);
  for (const p of facts.requiredEdgeProperties) out.add(node, YTHRIL('requiredEdgeProperty'), p);
  const pattern = textOf(own(def, 'namingPattern'));
  if (kind === 'entity' && pattern !== undefined && patternReadsAlike(pattern)) {
    const label = out.node();
    out.add(node, SH('property'), label);
    out.add(label, RDF_TYPE, SH('PropertyShape'));
    out.add(label, SH('path'), RDFS('label'));
    out.add(label, SH('name'), plain(NAME_OF_AN_ENTITY));
    out.add(label, SH('pattern'), plain(pattern));
  }
}

// -- the space ----------------------------------------------------------------------------------------------------------------------------

function exportOntology(out: Out, space: Space, fingerprint: string): void {
  const ontology = iri(space.ontology);
  const meta = bagOf(space.meta);
  out.add(ontology, RDF_TYPE, OWL('Ontology'));
  out.add(ontology, OWL('versionIRI'), iri(versionIri(space.meta, fingerprint)));
  out.add(ontology, OWL('versionInfo'), plain(fingerprint));
  out.say(ontology, RDFS('comment'), own(meta, 'purpose'));
  out.say(ontology, YTHRIL('validationMode'), own(meta, 'validationMode'));
  const linkage = own(meta, 'strictLinkage');
  if (typeof linkage === 'boolean') out.add(ontology, YTHRIL('strictLinkage'), literalForBoolean(linkage));
  rules(out, ontology, own(meta, 'rules'), true);
}

/**
 * The graph of `meta`'s schema, versioned by `fingerprint`. `meta` is the RESOLVED meta (library `$ref`s inlined) of a space with RDF on, and
 * `fingerprint` the fingerprint of that schema (`schemaFingerprintOf`): the version is never recomputed here, so it is the value every record
 * of the space already names in `dcterms:conformsTo`.
 *
 * @throws `rdf_not_enabled` (from the resolver) for a space with RDF off; a `TypeError` for a fingerprint that is not 64 lower-case hex digits.
 */
export function schemaGraph(meta: SpaceMeta, fingerprint: string, options: SchemaGraphOptions = {}): SchemaGraph {
  const ontology = ontologyIri(meta);
  if (!isSchemaFingerprint(fingerprint)) {
    throw new TypeError('the schema export is versioned by the schema fingerprint (64 lower-case hex digits); it was handed something else');
  }
  const namespaces = options.namespaces ?? [];
  const space = new Space(meta, ontology, namespaces);
  const out = new Out();
  exportOntology(out, space, fingerprint);
  const kinds = bagAt(bagOf(meta), 'typeSchemas');
  for (const kind of KNOWLEDGE_TYPES) {
    const types = bagAt(kinds, kind);
    for (const type of namesOf(types)) exportType(out, space, kind, type, own(types, type));
  }
  return { quads: out.quads, prefixes: prefixesFor(meta, namespaces), ontology, version: versionIri(meta, fingerprint), leftOut: out.leftOut };
}
