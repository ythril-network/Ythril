/**
 * Every RDF address of a space: its types and properties, its records, files and agents, its graph and its schema (Q-748, design r4 §4.3).
 *
 * ## What it prevents
 *
 * A second builder. The record mapper, the schema export and the export doors (slices B to D) all need names; one that wrote
 * `base + 'entity/' + id` would break on the first id holding a space, a `/` or a `>`, and two builders would give one record two addresses.
 * So this module is the ONLY one that joins a base or a vocab to a name, and it encodes every name through the schema package's two
 * encoders (`iriSegment` for a path segment, `iriFragment` for a fragment). `a-term-iri-is-one-rule-for-every-type-and-property.test.js`
 * refuses any other module that does either.
 *
 * ## The rules, inside, so no caller can drop them
 *
 * - **RDF is off until switched on.** Every function throws {@link RdfNotEnabled} for a meta with no `rdf`, `enabled: false` or no base:
 *   nothing is named for a space that did not ask to be.
 * - **An explicit `iri` wins** (a type's or a property's), else the W3C Direct Mapping's shape (owner, 2026-11-19): a type is the document
 *   `<vocab><kind>/<seg(type)>` and its property the fragment `<vocab><kind>/<seg(type)>#<frag(prop)>`. An untyped entity is the class
 *   `ythril:Untyped` and its properties are fragments of the kind's own document (`<vocab>entity#<frag(prop)>`); a file has no type:
 *   `<vocab>file#<frag(prop)>`. A library group's namespace names a type `<ns><seg(type)>` and its property `<ns><seg(type)>#<frag(prop)>`;
 *   a shape is `<base>schema/shape/<kind>/<seg(type)>[#<frag(prop)>]`. An empty name has no address: the encoders throw.
 * - The meta handed in is the RESOLVED one (library `$ref`s inlined), as the fingerprint reads it, so an entry's `iri` is seen.
 *
 * Pure: it reads only what it is handed.
 */
import { KNOWLEDGE_TYPES, RESERVED_PREFIXES, iriFragment, iriSegment, type KnowledgeType, type SpaceMeta } from '@ythril-network/schema';
import { RDF_RESERVED_PREDICATES, STANDARD_PREFIXES, YTHRIL_NS } from './ythril-vocabulary.js';

/** Thrown when a space has RDF off: nothing of it may be named. `code` is the refusal every RDF door answers with (409). */
export class RdfNotEnabled extends Error {
  readonly code = 'rdf_not_enabled';
  constructor() {
    super('RDF is not enabled for this space: set meta.rdf.enabled to true first');
    this.name = 'RdfNotEnabled';
  }
}

/** What a term is named for: a knowledge type, or a file (files have no types, only properties). */
export type TermKind = KnowledgeType | 'file';
/** What a record address is built for. */
export type RecordKind = KnowledgeType | 'file';

/** The base and vocab of a space with RDF on, or a throw. */
function namesOf(meta: Pick<SpaceMeta, 'rdf'> | undefined): { base: string; vocab: string } {
  const rdf = meta?.rdf;
  if (!rdf || rdf.enabled !== true || typeof rdf.base !== 'string' || rdf.base === '') throw new RdfNotEnabled();
  return { base: rdf.base, vocab: rdf.vocab ?? defaultVocabFor(rdf.base) };
}

/** The vocab a base has when none is set: `<base>vocab/`. */
export function defaultVocabFor(base: string): string {
  return base.concat('vocab/');
}

/** The base a space takes at its first enable: `<publicUrl>/ld/<seg(spaceId)>/`, `publicUrl` without its trailing `/`. */
export function defaultBaseFor(publicUrl: string, spaceId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/ld/${iriSegment(spaceId)}/`;
}

type TypeDef = { iri?: unknown; propertySchemas?: Record<string, { iri?: unknown; type?: unknown } | undefined> };

/** The definition of `type` of `kind` in `meta`, own keys only, or undefined. */
function typeDefOf(meta: SpaceMeta, kind: string, type: string): TypeDef | undefined {
  const kinds = (meta.typeSchemas ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const types = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
  const def = types && Object.hasOwn(types, type) ? types[type] : undefined;
  return def && typeof def === 'object' ? def as TypeDef : undefined;
}

/**
 * The address of a type (no `prop`) or of a property of it. `type` is `null` for an untyped entity and for a file. An explicit `iri` on the
 * type or the property wins; otherwise the vocab names it.
 */
export function resolveTermIri(meta: SpaceMeta, kind: TermKind, type: string | null, prop?: string): string {
  const { vocab } = namesOf(meta);
  const def = kind !== 'file' && type !== null ? typeDefOf(meta, kind, type) : undefined;
  const document = kind === 'file' || type === null ? vocab.concat(kind) : [vocab.concat(kind), iriSegment(type)].join('/');
  if (prop === undefined) {
    if (typeof def?.iri === 'string') return def.iri;
    if (type === null) return YTHRIL_NS.concat('Untyped');
    return document;
  }
  const own = def?.propertySchemas && Object.hasOwn(def.propertySchemas, prop) ? def.propertySchemas[prop] : undefined;
  if (typeof own?.iri === 'string') return own.iri;
  return [document, iriFragment(prop)].join('#');
}

/** A record's address: `<base><kind>/<seg(id)>`; a file's path is encoded segment by segment and joined by `/`. Throws for an id {@link recordAddressable} refuses. */
export function recordIri(meta: SpaceMeta, kind: RecordKind, id: string): string {
  const { base } = namesOf(meta);
  const tail = kind === 'file' ? id.split('/').map(iriSegment).join('/') : iriSegment(id);
  return [base.concat(kind), tail].join('/');
}

/**
 * Can a record of `kind` with `id` be given an address? Not when the id is empty, nor a file path with an empty segment (`a//b`, a leading or
 * trailing `/`): an empty name has no address. The record mapper asks this before {@link recordIri}, so a stored value never makes it throw.
 */
export function recordAddressable(kind: RecordKind, id: string): boolean {
  return kind === 'file' ? id.split('/').every(s => s !== '') : id !== '';
}

/**
 * The class of an edge label's reifiers: the label's own document in the space vocab, `<vocab>edge/<seg(label)>`, whose fragments are the
 * label's derived properties (the Direct Mapping's table and its columns). It ignores an explicit `iri` on the label, so a label mapped to an
 * outside property (`schema:knows`) still gets the space's own class, never a statement about the outside term; for a derived label it is the
 * label's predicate too (OWL 2 punning of a class and an object property). The shapes of the label's own properties target it.
 */
export function edgeClassIri(meta: SpaceMeta, label: string): string {
  return [namesOf(meta).vocab.concat('edge'), iriSegment(label)].join('/');
}

/** The SHACL shape of a type (no `prop`) or of a property of it: `<base>schema/shape/<kind>/<seg(type)>[#<frag(prop)>]`. */
export function shapeIri(meta: SpaceMeta, kind: KnowledgeType, type: string, prop?: string): string {
  const node = [ontologyIri(meta).concat('/shape/', kind), iriSegment(type)].join('/');
  return prop === undefined ? node : [node, iriFragment(prop)].join('#');
}

/** The address of the instance that wrote a record: `<base>agent/<seg(instanceId)>`. */
export function agentIri(meta: SpaceMeta, instanceId: string): string {
  return [namesOf(meta).base.concat('agent'), iriSegment(instanceId)].join('/');
}

/** The named graph a space's triples sit in: its base. */
export function graphIri(meta: SpaceMeta): string {
  return namesOf(meta).base;
}

/** The space's ontology: `<base>schema`. */
export function ontologyIri(meta: SpaceMeta): string {
  return namesOf(meta).base.concat('schema');
}

/** One version of the space's schema: `<base>schema/<seg(fingerprint)>`. */
export function versionIri(meta: SpaceMeta, fingerprint: string): string {
  return [ontologyIri(meta), iriSegment(fingerprint)].join('/');
}

/**
 * The address a schema-library group's namespace gives one of its entries' terms (design r4 §4.2, in the Direct Mapping's shape): the type
 * `<ns><seg(type)>`, a property `<ns><seg(type)>#<frag(prop)>`. Needs no space: the namespace is the instance's, so every space linking the
 * entry names it alike. The kind is not part of it, as in any published vocabulary (`ex:Person`, `ex:knows`): an entity and an edge type
 * of one name in one group share an address, which the term-clash rule refuses in a space that links both.
 */
export function libraryTermIri(namespace: string, type: string, prop?: string): string {
  const typeIri = namespace.concat(iriSegment(type));
  return prop === undefined ? typeIri : [typeIri, iriFragment(prop)].join('#');
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The names of a map in code-unit order: the order every member visits a schema's types in (a visiting order, no canonical text). */
function namesInOrder(map: object): string[] {
  const names = Object.keys(map);
  return names.sort(byCode);
}
/** The longest start of a type-named prefix: room for `-<kind>-<n>` within the 50 characters a prefix may have (`PrefixZ`). */
const PREFIX_STEM_MAX = 36;
const FIRST_NUMBERED_PREFIX = 2;
/** A character a prefix name cannot hold (`PrefixZ`, and Turtle's PN_PREFIX as the writer spells it). */
const NOT_A_PREFIX_CHARACTER = /[^A-Za-z0-9_-]/g;

/**
 * The prefix name a type's property document gets (`person:` for `.../Person#`): the type's name, every character a prefix cannot hold an
 * `_`, its first letter lower-case, `t-` before it when it does not start with a letter; if that name is taken, `<name>-<kind>`, then
 * `<name>-<kind>-2`, `-3`, ... A name is taken when it is a standard, reserved or already-declared prefix.
 */
function typePrefixName(type: string, kind: string, taken: ReadonlySet<string>): string {
  let stem = type.replace(NOT_A_PREFIX_CHARACTER, '_');
  stem = stem.charAt(0).toLowerCase().concat(stem.slice(1));
  if (!/^[A-Za-z]/.test(stem)) stem = 't-'.concat(stem);
  stem = stem.slice(0, PREFIX_STEM_MAX);
  if (!taken.has(stem)) return stem;
  const withKind = `${stem}-${kind}`;
  let name = withKind;
  for (let n = FIRST_NUMBERED_PREFIX; taken.has(name); n++) name = `${withKind}-${n}`;
  return name;
}

/**
 * The prefixes a writer declares for a space, so its own terms read as prefixed names: the standard ones; the space's own `vocab`; a prefix
 * per kind whose types the vocab names (`entity:` for `<vocab>entity/`, so `entity:Person`); the prefix of each library group namespace one
 * of the space's resolved terms lies under (`namespaces`, the instance's `schemaLibraryNamespaces` values); and a prefix per type whose
 * properties are fragments of a document the space owns (`person:` for `<vocab>entity/Person#`, so `person:name`), named by
 * {@link typePrefixName}. Types are visited kind by kind (`KNOWLEDGE_TYPES`), then by name in code-unit order, so one schema gives the same
 * prefixes on every member whatever order its keys were written in.
 */
export function prefixesFor(meta: SpaceMeta, namespaces: readonly { prefix: string; iri: string }[] = []): Record<string, string> {
  const { vocab } = namesOf(meta);
  const out: Record<string, string> = { ...STANDARD_PREFIXES, vocab };
  const kinds = (meta.typeSchemas ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const used: string[] = [];
  const documents: { document: string; kind: string; type: string }[] = [];
  for (const kind of KNOWLEDGE_TYPES) {
    const map = Object.hasOwn(kinds, kind) ? kinds[kind] ?? {} : {};
    for (const type of namesInOrder(map)) {
      const raw = map[type];
      const def = raw && typeof raw === 'object' ? raw as TypeDef : {};
      const typeIri = resolveTermIri(meta, kind, type);
      used.push(typeIri);
      if (typeIri.startsWith(vocab.concat(kind, '/')) && !Object.hasOwn(out, kind)) out[kind] = vocab.concat(kind, '/');
      for (const prop of namesInOrder(def.propertySchemas ?? {})) {
        const propIri = resolveTermIri(meta, kind, type, prop);
        used.push(propIri);
        const hash = propIri.indexOf('#');
        if (hash > 0) documents.push({ document: propIri.slice(0, hash + 1), kind, type });
      }
    }
  }
  for (const ns of namespaces) if (!Object.hasOwn(out, ns.prefix) && used.some(iri => iri.startsWith(ns.iri))) out[ns.prefix] = ns.iri;
  const owned = [vocab, ...namespaces.map(ns => ns.iri)];
  const taken = new Set([...Object.keys(out), ...RESERVED_PREFIXES]);
  const declared = new Set(Object.values(out));
  for (const { document, kind, type } of documents) {
    if (declared.has(document) || !owned.some(ns => document.startsWith(ns))) continue;
    const name = typePrefixName(type, kind, taken);
    out[name] = document;
    taken.add(name);
    declared.add(document);
  }
  return out;
}

/** Who holds an address: a type, or a property of one. */
export interface TermOwner { kind: TermKind; type: string | null; prop?: string }

/** Two terms of one space that would share an address, or one term whose explicit address is not its to take. */
export interface TermClash {
  iri: string;
  owners: TermOwner[];
  reason: 'same-iri' | 'property-types-differ' | 'under-vocab' | 'under-base' | 'reserved-predicate';
  /** One sentence naming both owners and the address. */
  message: string;
}

/** A term's owner as a language-neutral name a client words itself: `kind:type`, or `kind:type.property`. */
export const termOwnerName = (o: TermOwner): string => (o.prop === undefined ? `${o.kind}:${o.type}` : `${o.kind}:${o.type}.${o.prop}`);

const ownerText = (o: TermOwner): string => (o.prop === undefined ? `${o.kind} type '${o.type}'` : `property '${o.prop}' of ${o.kind} type '${o.type}'`);

/**
 * Every clash in `meta` (resolved): two types, or a type and a property, with one address; two properties with one address and differing
 * declared types (agreeing types may share one); an explicit `iri` under the space's own vocab, where the derived names live, or under its
 * base, where its records' addresses live; an explicit `iri` equal to a predicate the mapper writes. Empty when there is none. Throws {@link RdfNotEnabled} for a space with RDF off.
 */
export function termClashes(meta: SpaceMeta): TermClash[] {
  const names = namesOf(meta);
  const out: TermClash[] = [];
  const types: { iri: string; owner: TermOwner }[] = [];
  const props: { iri: string; owner: TermOwner; declared: unknown }[] = [];
  for (const [kind, map] of Object.entries((meta.typeSchemas ?? {}) as Record<string, Record<string, unknown> | undefined>)) {
    for (const [type, raw] of Object.entries(map ?? {})) {
      const def = raw && typeof raw === 'object' ? raw as TypeDef : {};
      const k = kind as KnowledgeType;
      if (typeof def.iri === 'string') explicitChecks(out, def.iri, { kind: k, type }, names);
      types.push({ iri: resolveTermIri(meta, k, type), owner: { kind: k, type } });
      for (const [prop, p] of Object.entries(def.propertySchemas ?? {})) {
        if (typeof p?.iri === 'string') explicitChecks(out, p.iri, { kind: k, type, prop }, names);
        props.push({ iri: resolveTermIri(meta, k, type, prop), owner: { kind: k, type, prop }, declared: p?.type });
      }
    }
  }
  const pair = (iri: string, a: TermOwner, b: TermOwner, reason: TermClash['reason'], why: string) =>
    out.push({ iri, owners: [a, b], reason, message: `${ownerText(a)} and ${ownerText(b)} ${why} ${iri}` });
  for (let i = 0; i < types.length; i++) {
    for (let j = i + 1; j < types.length; j++) if (types[i]!.iri === types[j]!.iri) pair(types[i]!.iri, types[i]!.owner, types[j]!.owner, 'same-iri', 'both resolve to');
    for (const p of props) if (p.iri === types[i]!.iri) pair(p.iri, types[i]!.owner, p.owner, 'same-iri', 'both resolve to');
  }
  for (let i = 0; i < props.length; i++) {
    for (let j = i + 1; j < props.length; j++) {
      const a = props[i]!, b = props[j]!;
      if (a.iri === b.iri && a.declared !== b.declared) pair(a.iri, a.owner, b.owner, 'property-types-differ', `declare different types (${String(a.declared ?? 'none')}, ${String(b.declared ?? 'none')}) and both resolve to`);
    }
  }
  return out;
}

/**
 * The checks of an explicit address: not under the space's own vocab, where the derived names live; not under its base, where every record,
 * agent and schema address lives (review finding 11: `<base>entity/Person` would be the address of the record with id `Person`); and not a
 * predicate the mapper writes.
 */
function explicitChecks(out: TermClash[], iri: string, owner: TermOwner, names: { base: string; vocab: string }): void {
  const { base, vocab } = names;
  if (iri.startsWith(vocab)) {
    out.push({ iri, owners: [owner], reason: 'under-vocab', message: `${ownerText(owner)} sets the iri ${iri}, which lies under the space's own vocab ${vocab}, where the derived names live: choose an address outside it, or remove the iri` });
  } else if (iri.startsWith(base)) {
    out.push({ iri, owners: [owner], reason: 'under-base', message: `${ownerText(owner)} sets the iri ${iri}, which lies under the space's base ${base}, where its records' own addresses live: choose an address outside it, or remove the iri` });
  }
  if (RDF_RESERVED_PREDICATES.includes(iri)) {
    out.push({ iri, owners: [owner], reason: 'reserved-predicate', message: `${ownerText(owner)} sets the iri ${iri}, which the record mapper writes on its own account on every record: choose another address` });
  }
}
