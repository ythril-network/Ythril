/**
 * Ythril's own RDF vocabulary: its namespace, the standard namespaces an export declares, the predicates the record mapper writes itself,
 * and the property rule the published vocabulary page opens with (Q-748, Q-749; owner, 2026-11-18).
 *
 * ## What it prevents
 *
 * - **A namespace written twice.** `YTHRIL_NS` is the one spelling of `https://w3id.org/ythril/ns#`; tests check that it is used, never its
 *   value, so the address can move without a test hunt. Every other namespace an export writes is a row of {@link STANDARD_PREFIXES}.
 * - **A schema term that collides with the mapper.** A property mapped onto `rdfs:label` or `dcterms:created` would be written twice on
 *   every record, and its single-value shape would then fail every record. {@link RDF_RESERVED_PREDICATES} lists what the mapper writes;
 *   the term-clash check refuses a schema `iri` equal to one (`rdf/term-iri.ts`).
 * - **The rule and its page drifting.** {@link PROPERTY_RULE_TEXT} is the one text the generated vocabulary page opens with (slice B).
 *
 * A leaf: it imports nothing.
 */

/** The namespace of Ythril's own terms (owner, 2026-11-18). Redirected by w3id.org to the generated vocabulary; a release step outside the code. */
export const YTHRIL_NS = 'https://w3id.org/ythril/ns#';

/** The standard namespaces an export declares, by prefix. The space's own `vocab` is added per space by `prefixesFor`. */
export const STANDARD_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  sh: 'http://www.w3.org/ns/shacl#',
  // http, not https (owner, 2026-11-19): schema.org's own JSON-LD context and the data already published use it, and a namespace cannot
  // change once an export left an instance.
  schema: 'http://schema.org/',
  time: 'http://www.w3.org/2006/time#',
  dcterms: 'http://purl.org/dc/terms/',
  prov: 'http://www.w3.org/ns/prov#',
  ythril: YTHRIL_NS,
});

/** One term of the `ythril:` vocabulary: its local name, whether it is a class or a property, and what it means. */
export interface YthrilTerm {
  name: string;
  kind: 'class' | 'property';
  comment: string;
}

/**
 * The `ythril:` terms. The record mapper (slice B) may emit only terms listed here; its test holds every emitted `ythril:` IRI to this table
 * and the generated vocabulary files to it.
 */
export const YTHRIL_TERMS: readonly YthrilTerm[] = Object.freeze([
  { name: 'Entity', kind: 'class', comment: 'A Ythril entity record.' },
  { name: 'Fact', kind: 'class', comment: 'A Ythril fact record.' },
  { name: 'Untyped', kind: 'class', comment: 'The class of an entity that declares no type.' },
  { name: 'superseded', kind: 'property', comment: 'The record has been superseded by a later one.' },
  { name: 'status', kind: 'property', comment: 'A chrono record\'s status.' },
  { name: 'confidence', kind: 'property', comment: 'A chrono record\'s confidence.' },
  { name: 'contentRedacted', kind: 'property', comment: 'The record\'s content was removed by a retention schedule.' },
  { name: 'weight', kind: 'property', comment: 'An edge\'s weight, stated on its reifier.' },
  { name: 'edgeType', kind: 'property', comment: 'An edge\'s type, stated on its reifier.' },
  { name: 'path', kind: 'property', comment: 'A file\'s path within its space.' },
  { name: 'sizeBytes', kind: 'property', comment: 'A file\'s size in bytes.' },
  // The chrono recurrence, one property per part (the record form, `server/src/rdf/record-triples.ts`).
  { name: 'recurrenceFreq', kind: 'property', comment: 'How often a chrono record recurs: daily, weekly, monthly or yearly.' },
  { name: 'recurrenceInterval', kind: 'property', comment: 'Every how many periods of its frequency a chrono record recurs.' },
  { name: 'recurrenceUntil', kind: 'property', comment: 'The date or time after which a chrono record no longer recurs.' },
  // What a space's schema says that no standard term carries (design r4 section 6); written by the schema export.
  { name: 'mergeFn', kind: 'property', comment: 'The function that merges two values of a property when two members change it at once.' },
  { name: 'namingPattern', kind: 'property', comment: 'A pattern every entity name of a type must match.' },
  { name: 'pattern', kind: 'property', comment: 'A pattern every text value of a property must match, as Ythril checks it: an ECMAScript regular expression, unanchored. It is also sh:pattern only where SPARQL regular expressions read it alike.' },
  { name: 'endpointFrom', kind: 'property', comment: 'A kind of record an edge type may start at.' },
  { name: 'endpointTo', kind: 'property', comment: 'A kind of record an edge type may end at.' },
  { name: 'retentionDays', kind: 'property', comment: 'How many days a record of a type is kept before it is deleted.' },
  { name: 'retentionContentDays', kind: 'property', comment: 'How many days the content of a record of a type is kept before it is removed and the record stays.' },
  { name: 'suppressEmbeddings', kind: 'property', comment: 'Records of a type are stored but not embedded for similarity search.' },
  { name: 'whenDuePasses', kind: 'property', comment: 'What happens to a chrono record of a type when its time has passed.' },
  { name: 'rule', kind: 'property', comment: 'A rule a record of a type or the space must satisfy, written as a node with a name, an expression and a message.' },
  { name: 'ruleName', kind: 'property', comment: 'The name of a rule.' },
  { name: 'ruleExpression', kind: 'property', comment: 'The expression of a rule, as the space states it.' },
  { name: 'ruleMessage', kind: 'property', comment: 'The message a rule gives when a record breaks it.' },
  { name: 'ruleKinds', kind: 'property', comment: 'The kinds of record a space rule applies to.' },
  { name: 'unresolvedRef', kind: 'property', comment: 'A type refers to a schema library entry this export could not resolve.' },
  { name: 'requiredEdgeProperty', kind: 'property', comment: 'A property every edge of a type must carry.' },
  { name: 'validationMode', kind: 'property', comment: 'How strictly the space checks records against its schema.' },
  { name: 'strictLinkage', kind: 'property', comment: 'Whether the space refuses an edge whose endpoints do not exist.' },
  // The report node a page of a records export ends with (standards review row 10); what it says of its scope and shapes is said in standard
  // terms (dcterms:hasPart, dcterms:isPartOf, sh:shapesGraph), and these name only what no standard term carries: how a page of one export ended.
  { name: 'ExportReport', kind: 'class', comment: 'One page of an RDF export of Ythril records: how many records it holds, whether it is the last, and what it left out.' },
  { name: 'recordCount', kind: 'property', comment: 'How many records a page of an export holds.' },
  { name: 'complete', kind: 'property', comment: 'Whether nothing of the export\'s scope is left after this page: true on its last page.' },
  { name: 'nextAfter', kind: 'property', comment: 'The cursor that continues an export after this page, passed back as its after parameter.' },
  { name: 'leftOutCount', kind: 'property', comment: 'How many property values a page of an export left out because none is one plain value that fits its property.' },
  { name: 'leftOutValue', kind: 'property', comment: 'A property value a page of an export left out, as a node naming its record, its key and why.' },
  { name: 'leftOutRecord', kind: 'property', comment: 'The record a left-out value belongs to.' },
  { name: 'leftOutKey', kind: 'property', comment: 'The property key of a left-out value.' },
  { name: 'leftOutReason', kind: 'property', comment: 'Why a value was left out, in words.' },
  { name: 'fileTriplesWithheld', kind: 'property', comment: 'The export holds no file statements of some space it covers, because its caller may not read files there.' },
]);

/**
 * The address of a declared `ythril:` term: {@link YTHRIL_NS} plus its name. A name that is not a row of {@link YTHRIL_TERMS} throws, so no
 * module can write a term the published vocabulary does not declare (`every-ythril-term-is-declared-in-the-vocabulary.test.js`).
 */
export function ythrilIri(name: string): string {
  if (!YTHRIL_TERMS.some(t => t.name === name)) throw new Error(`ythril:${name} is not declared in YTHRIL_TERMS (server/src/rdf/ythril-vocabulary.ts)`);
  return YTHRIL_NS.concat(name);
}

const RDF = STANDARD_PREFIXES['rdf']!;
const RDFS = STANDARD_PREFIXES['rdfs']!;
const SCHEMA = STANDARD_PREFIXES['schema']!;
const DCTERMS = STANDARD_PREFIXES['dcterms']!;
const PROV = STANDARD_PREFIXES['prov']!;

/**
 * The predicates the record mapper writes on its own account (design r4 §5.2): a schema term mapped onto one of them would be written twice
 * on a record. Full IRIs. The `ythril:` properties are all of them, read from {@link YTHRIL_TERMS}.
 */
export const RDF_RESERVED_PREDICATES: readonly string[] = Object.freeze([
  `${RDF}type`, `${RDF}reifies`,
  `${RDFS}label`,
  `${DCTERMS}created`, `${DCTERMS}modified`, `${DCTERMS}conformsTo`, `${DCTERMS}references`,
  `${PROV}wasAttributedTo`,
  `${SCHEMA}keywords`, `${SCHEMA}description`, `${SCHEMA}text`, `${SCHEMA}startDate`, `${SCHEMA}endDate`, `${SCHEMA}eventStatus`, `${SCHEMA}sha256`,
  ...YTHRIL_TERMS.filter(t => t.kind === 'property').map(t => YTHRIL_NS.concat(t.name)),
]);

/**
 * The property rule (decision record 23, owner, 2026-11-18), the text the generated vocabulary page opens with, so the page and the record
 * cannot drift.
 */
export const PROPERTY_RULE_TEXT = 'Ythril stores no array and no nested object in a property: a property holds one plain value — a string, a number, '
  + 'a boolean or a date. Richer content is held as edges and links, and it travels in this export as what it is. Several values of one '
  + 'relationship are several edges or links and appear here as the same predicate stated several times. A reference to another record is an '
  + 'edge and appears as a relation to that record\'s IRI. A nested thing is a record of its own, joined by an edge. Edges appear as their '
  + 'label\'s property, with a reifier for the edge\'s own details; links appear as `dcterms:references`. Every datatype property in this '
  + 'vocabulary is therefore single-valued.';
