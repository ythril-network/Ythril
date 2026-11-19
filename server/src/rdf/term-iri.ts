/**
 * Every RDF address of a space: its types and properties, its records, files and agents, its graph and its schema (Q-748, design r4 §4.3).
 *
 * ## What it prevents
 *
 * A second builder. The record mapper, the schema export and the export doors (slices B to D) all need names; one that wrote
 * `base + 'entity/' + id` would break on the first id holding a space, a `/` or a `>`, and two builders would give one record two addresses.
 * So this module is the ONLY one that joins a base or a vocab to a segment, and it encodes every segment through the schema package's
 * one encoder (`iriSegment`). `a-term-iri-is-one-rule-for-every-type-and-property.test.js` refuses any other module that does either.
 *
 * ## The rules, inside, so no caller can drop them
 *
 * - **RDF is off until switched on.** Every function throws {@link RdfNotEnabled} for a meta with no `rdf`, `enabled: false` or no base:
 *   nothing is named for a space that did not ask to be.
 * - **An explicit `iri` wins** (a type's or a property's), else `<vocab><kind>/<seg(type)>[/<seg(prop)>]`. An untyped entity is the class
 *   `ythril:Untyped` and its properties sit under the empty type segment (`entity/%00/`); a file has no type: `<vocab>file/<seg(prop)>`.
 * - The meta handed in is the RESOLVED one (library `$ref`s inlined), as the fingerprint reads it, so an entry's `iri` is seen.
 *
 * Pure: it reads only what it is handed.
 */
import { iriSegment, type KnowledgeType, type SpaceMeta } from '@ythril-network/schema';
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
  if (prop === undefined) {
    if (typeof def?.iri === 'string') return def.iri;
    if (type === null) return YTHRIL_NS.concat('Untyped');
    return [vocab.concat(kind), iriSegment(type)].join('/');
  }
  const own = def?.propertySchemas && Object.hasOwn(def.propertySchemas, prop) ? def.propertySchemas[prop] : undefined;
  if (typeof own?.iri === 'string') return own.iri;
  if (kind === 'file') return [vocab.concat('file'), iriSegment(prop)].join('/');
  return [vocab.concat(kind), iriSegment(type ?? ''), iriSegment(prop)].join('/');
}

/** A record's address: `<base><kind>/<seg(id)>`; a file's path is encoded segment by segment and joined by `/`. */
export function recordIri(meta: SpaceMeta, kind: RecordKind, id: string): string {
  const { base } = namesOf(meta);
  const tail = kind === 'file' ? id.split('/').map(iriSegment).join('/') : iriSegment(id);
  return [base.concat(kind), tail].join('/');
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

/** The prefixes a writer declares for a space: the standard ones and the space's own `vocab`. */
export function prefixesFor(meta: SpaceMeta): Record<string, string> {
  return { ...STANDARD_PREFIXES, vocab: namesOf(meta).vocab };
}

/** Who holds an address: a type, or a property of one. */
export interface TermOwner { kind: TermKind; type: string | null; prop?: string }

/** Two terms of one space that would share an address, or one term whose explicit address is not its to take. */
export interface TermClash {
  iri: string;
  owners: TermOwner[];
  reason: 'same-iri' | 'property-types-differ' | 'under-vocab' | 'reserved-predicate';
  /** One sentence naming both owners and the address. */
  message: string;
}

const ownerText = (o: TermOwner): string => (o.prop === undefined ? `${o.kind} type '${o.type}'` : `property '${o.prop}' of ${o.kind} type '${o.type}'`);

/**
 * Every clash in `meta` (resolved): two types, or a type and a property, with one address; two properties with one address and differing
 * declared types (agreeing types may share one); an explicit `iri` under the space's own vocab, where the derived names live; an explicit
 * `iri` equal to a predicate the mapper writes. Empty when there is none. Throws {@link RdfNotEnabled} for a space with RDF off.
 */
export function termClashes(meta: SpaceMeta): TermClash[] {
  const { vocab } = namesOf(meta);
  const out: TermClash[] = [];
  const types: { iri: string; owner: TermOwner }[] = [];
  const props: { iri: string; owner: TermOwner; declared: unknown }[] = [];
  for (const [kind, map] of Object.entries((meta.typeSchemas ?? {}) as Record<string, Record<string, unknown> | undefined>)) {
    for (const [type, raw] of Object.entries(map ?? {})) {
      const def = raw && typeof raw === 'object' ? raw as TypeDef : {};
      const k = kind as KnowledgeType;
      if (typeof def.iri === 'string') explicitChecks(out, def.iri, { kind: k, type }, vocab);
      types.push({ iri: resolveTermIri(meta, k, type), owner: { kind: k, type } });
      for (const [prop, p] of Object.entries(def.propertySchemas ?? {})) {
        if (typeof p?.iri === 'string') explicitChecks(out, p.iri, { kind: k, type, prop }, vocab);
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

/** The two checks of an explicit address: not under the space's own vocab, and not a predicate the mapper writes. */
function explicitChecks(out: TermClash[], iri: string, owner: TermOwner, vocab: string): void {
  if (iri.startsWith(vocab)) {
    out.push({ iri, owners: [owner], reason: 'under-vocab', message: `${ownerText(owner)} sets the iri ${iri}, which lies under the space's own vocab ${vocab}, where the derived names live: choose an address outside it, or remove the iri` });
  }
  if (RDF_RESERVED_PREDICATES.includes(iri)) {
    out.push({ iri, owners: [owner], reason: 'reserved-predicate', message: `${ownerText(owner)} sets the iri ${iri}, which the record mapper writes on its own account on every record: choose another address` });
  }
}
